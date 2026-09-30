// tts.js — 语音引擎层：AI 神经音色优先 + 逐句跟读朗读
//
// 为什么不用第三方「朗读插件」：
//   浏览器内置的 speechSynthesis 在 Edge 上会暴露 `Microsoft *Online (Natural)` 音色，
//   那其实就是 Azure 神经语音（免费、无需 key、无需授权）。Chrome 只给 Google 机械音。
//   所以正确做法是自己做一层引擎抽象：自动挑最优音色，并为 Chrome 保留「自备 AI 语音
//   API」通道（默认关闭，key 只存本机 IndexedDB，不上传任何地方）。
//
// 引擎优先级：
//   音色分级 Natural(1) > Online(2) > 本机(3) > 其他云端(4)
//   engine='auto'   → 启用了本地 Kokoro 就用它（离线可用、28 音色）；否则有 1/2 档音色就
//                     用它；再没有且配了云端 key 才走云端；最后退本机音色
//   engine='kokoro' → 只用本地 Kokoro（未就绪时退回浏览器音色，不会自动联网下载）
//   engine='system' → 一律用浏览器内置音色
//   engine='cloud'  → 一律走自备 AI 语音 API
import { kv } from './db.js';
import {
  ensure as kokoroLoad, warmup as kokoroWarmup, synthesize as kokoroSynth, prefetch as kokoroPrefetch,
  isReady as kokoroReady, isSupported as kokoroSupported, status as kokoroState,
  DEFAULT_VOICE as KOKORO_DEFAULT_VOICE,
} from './kokoro.js';

// 让上层（reader.js）只 import tts.js 就能管全语音层
export {
  VOICES as KOKORO_VOICES, VOICE_GROUPS as KOKORO_GROUPS, DTYPES as KOKORO_DTYPES,
  DEFAULT_VOICE as KOKORO_DEFAULT_VOICE,
  voicesByGroup as kokoroVoicesByGroup, getVoice as kokoroVoice, detectDevice as kokoroDevice,
  onProgress as onKokoroProgress, status as kokoroStatus, isReady as kokoroIsReady,
  isSupported as kokoroSupported, clearAudioCache as clearKokoroAudio,
  ensure as ensureKokoro, warmup as warmKokoro,
} from './kokoro.js';

const SETTINGS_KEY = 'tts.settings.v1';

export const DEFAULT_SETTINGS = {
  engine: 'auto',      // auto | kokoro | system | cloud
  voiceName: '',       // '' = 自动挑最优（浏览器音色）
  rate: 1,             // 0.6 ~ 1.5
  autoScroll: true,
  // 本地神经语音（Kokoro-82M）：默认关闭，用户点「下载并启用」才联网下载
  kokoro: {
    enabled: false,
    voice: KOKORO_DEFAULT_VOICE,
    model: 'q8',
    warm: false,       // 是否已成功加载过（下次进站可在后台恢复，不产生下载）
  },
  cloud: {
    enabled: false,
    endpoint: 'https://api.openai.com/v1',
    key: '',
    model: 'tts-1',
    voice: 'alloy',
  },
};


let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
let settingsLoaded = false;
let disabled = false;        // 浏览器完全没有 speechSynthesis
let runtimeVoice = '';       // 运行期回退音色（不写回用户设置）
let cloudBroken = false;     // 自备 AI 语音接口本次会话不可用
let kokoroBroken = false;    // 本地模型本次会话不可用（加载/合成失败后不再反复重试）
let activeSpeaker = null;    // 正在跟读的播放器，供 speakOnce 暂停用
const failedVoices = new Set();   // 合成失败的音色（本次会话内不再尝试）
const voiceAttempts = new Map();  // 音色 → 失败次数，用于「冷启动重试一次」

export function getSettings() { return settings; }

export async function loadSettings() {
  if (settingsLoaded) return settings;
  try {
    const saved = await kv.get(SETTINGS_KEY);
    if (saved && typeof saved === 'object') {
      settings = {
        ...settings,
        ...saved,
        kokoro: { ...DEFAULT_SETTINGS.kokoro, ...(saved.kokoro || {}) },
        cloud: { ...DEFAULT_SETTINGS.cloud, ...(saved.cloud || {}) },
      };
    }
  } catch (e) { /* 读不到就用默认值 */ }
  settingsLoaded = true;
  return settings;
}

export async function saveSettings(patch) {
  settings = {
    ...settings,
    ...patch,
    kokoro: { ...settings.kokoro, ...((patch && patch.kokoro) || {}) },
    cloud: { ...settings.cloud, ...((patch && patch.cloud) || {}) },
  };
  // 用户显式改过音色/引擎 → 清掉运行期自愈状态，按新设置重新试
  if (patch && 'voiceName' in patch) {
    runtimeVoice = '';
    failedVoices.clear();
    voiceAttempts.clear();
  }
  if (patch && ('engine' in patch || 'cloud' in patch)) {
    cloudBroken = false;
    failedVoices.clear();
    voiceAttempts.clear();
  }
  // 动过本地模型设置 → 解除熔断，让它按新配置再试一次
  if (patch && 'kokoro' in patch) kokoroBroken = false;
  try { await kv.set(SETTINGS_KEY, settings); } catch (e) { /* 忽略持久化失败 */ }
  return settings;
}

// ---------- 音色探测与分级 ----------

const TIER = { NEURAL: 1, ONLINE: 2, LOCAL: 3, OTHER: 4 };
export const TIER_LABEL = {
  1: 'AI 神经音色',
  2: '云端音色',
  3: '本机音色',
  4: '其他云端',
};

export function voiceTier(v) {
  const n = v.name || '';
  if (/\(natural\)/i.test(n)) return TIER.NEURAL;
  if (/\bonline\b/i.test(n)) return TIER.ONLINE;
  if (v.localService) return TIER.LOCAL;
  return TIER.OTHER;
}

function langRank(lang) {
  const s = String(lang || '').toLowerCase().replace('_', '-');
  if (s.startsWith('en-us')) return 0;
  if (s.startsWith('en-gb')) return 1;
  if (s.startsWith('en')) return 2;
  return 3;
}

function rawVoices() {
  if (disabled || typeof speechSynthesis === 'undefined') return [];
  try { return speechSynthesis.getVoices() || []; } catch (e) { return []; }
}

function normalize(v) {
  const tier = voiceTier(v);
  return {
    name: v.name,
    lang: v.lang,
    tier,
    local: !!v.localService,
    tierLabel: TIER_LABEL[tier],
  };
}

/** 全部音色（含非英文），按质量排序 —— 换音色自愈时要用到这个全集 */
export function allVoices() {
  return rawVoices()
    .map(normalize)
    .sort((a, b) =>
      a.tier - b.tier || langRank(a.lang) - langRank(b.lang) || a.name.localeCompare(b.name));
}

/** 界面展示用：英文音色优先（这台设备没有英文音色时退化为全部） */
export function listVoices() {
  const all = allVoices();
  const en = all.filter(v => langRank(v.lang) < 3);
  return en.length ? en : all;
}

/** 最佳音色（运行期回退 > 用户指定 > 排序第一） */
export function resolveVoice() {
  const all = allVoices();
  if (!all.length) return null;
  const pick = (name) => all.find(v => v.name === name);
  if (runtimeVoice) {
    const hit = pick(runtimeVoice);
    if (hit) return hit;
  }
  if (settings.voiceName) {
    const hit = pick(settings.voiceName);
    if (hit) return hit;
  }
  const pref = listVoices();
  if (settings.engine === 'system') {
    const sys = pref.filter(v => v.tier >= TIER.LOCAL);
    if (sys.length) return sys[0];
  }
  return pref[0] || all[0];
}

/** 设备自带 AI 音色（Natural / Online）？ */
export function hasAiVoice() {
  return listVoices().some(v => v.tier <= TIER.ONLINE);
}
/** 自备 AI 语音 API 是否已配好？ */
export function hasCloudVoice() {
  const c = settings.cloud;
  return !!(c.enabled && c.key && c.endpoint);
}
/** 用户是否启用了本地神经语音（不代表模型已加载到内存） */
export function hasKokoroVoice() {
  return !!(settings.kokoro && settings.kokoro.enabled);
}
/** 本地模型此刻可直接用？ */
export function kokoroUsable() {
  return hasKokoroVoice() && !kokoroBroken && kokoroReady();
}

/**
 * 本句是否走本地模型。
 * 只在「用户启用过 + 模型已加载 + 本次会话没熔断」时成立：
 * 没就绪时不联网抢跑，安静地退回浏览器音色，等用户点开设置自己下载。
 */
export function preferKokoro() {
  if (kokoroBroken) return false;
  if (!hasKokoroVoice() || !kokoroReady()) return false;
  if (settings.engine === 'kokoro') return true;
  if (settings.engine === 'auto') return true;   // 本地神经模型音色最多、离线可用 → auto 首选
  return false;
}

/** 是否因为 AI 音色合成失败而降级到了别的音色（运行期状态） */
export function isDegraded() {
  return !!runtimeVoice;
}

/** 本句该走云端还是浏览器音色 */
export function preferCloud() {
  if (cloudBroken) return false;      // 本次会话已确认云端不可用
  if (!hasCloudVoice()) return false;
  if (settings.engine === 'cloud') return true;
  if (settings.engine === 'system') return false;
  if (settings.engine === 'kokoro') return false;  // 用户点名要本地的，别偷偷发请求
  if (preferKokoro()) return false;
  return !hasAiVoice();
}

/** 当前引擎的显示名（顶栏/设置面板用） */
export function engineLabel() {
  if (preferKokoro()) return `本地 AI · ${settings.kokoro.voice || KOKORO_DEFAULT_VOICE}`;
  if (preferCloud()) return `AI 语音 · ${settings.cloud.voice || 'alloy'}`;
  const v = resolveVoice();
  return v ? v.name.replace(/^Microsoft\s+/i, '') : '无可用音色';
}

/**
 * 加载本地模型（幂等）。用于 initTts 的后台恢复和设置面板的「下载并启用」。
 * 失败会把本地模型标记为本次会话不可用，避免每次朗读都卡一次。
 */
export async function prepareKokoro({ onProgress, markBroken = true } = {}) {
  if (kokoroReady()) return true;
  try {
    await kokoroLoad({ model: settings.kokoro.model || 'q8', onProgress });
    return true;
  } catch (e) {
    if (markBroken) kokoroBroken = true;
    throw e;
  }
}

/** 预热（合成一个短句）。加载完成后调用，把首次 shader 编译的等待提前消化掉。 */
export async function warmKokoroVoice(voice) {
  return kokoroWarmup(voice || settings.kokoro.voice || KOKORO_DEFAULT_VOICE);
}

/** 本地模型本轮会话是否已熔断（设置面板要如实告知，不能假装还能用） */
export function isKokoroBroken() {
  return kokoroBroken;
}

/** 设备/加载状态快照，透传给设置面板 */
export function kokoroInfo() {
  return { ...kokoroState(), supported: kokoroSupported() };
}

/** 语音列表就绪：等到出现英文音色为止（远程音色常常晚于本地音色到达） */
export function ready(timeout = 3000) {
  return new Promise((resolve) => {
    if (typeof speechSynthesis === 'undefined') { disabled = true; return resolve([]); }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(listVoices());
    };
    const check = () => {
      if (listVoices().some(v => langRank(v.lang) < 3)) finish();
    };
    check();
    if (settled) return;
    try { speechSynthesis.addEventListener('voiceschanged', check); } catch (e) { /* 老浏览器无此事件 */ }
    setTimeout(finish, timeout);
  });
}

// ---------- 播放器 ----------

/**
 * 逐句朗读播放器。
 * items: [{ text, node }] —— node 用于高亮跟读，可为 null。
 * 事件：onchange(state, sp) / onindex(i, item, sp) / onerror(msg)
 */
export class Speaker {
  constructor() {
    this.items = [];
    this.index = -1;
    this.state = 'idle';   // idle | playing | paused
    this.token = 0;
    this.audio = null;
    this.onchange = null;
    this.onindex = null;
    this.onerror = null;
    this.onend = null;
  }

  get current() { return this.items[this.index] || null; }
  get total() { return this.items.length; }

  setItems(items) {
    this.stop();
    this.items = (items || []).filter(it => it && it.text && it.text.trim());
    return this.items.length;
  }

  _set(state) {
    if (this.state === state) return;
    this.state = state;
    if (this.onchange) this.onchange(state, this);
  }

  _select(i) {
    this.index = i;
    if (this.onindex) this.onindex(i, this.items[i] || null, this);
  }

  /** play() 续播；play(n) 从第 n 句开始 */
  async play(i) {
    if (!this.items.length) { this.stop(); return; }
    if (typeof i === 'number') {
      this.token++;
      this._killAudio();
      this._select(Math.max(0, Math.min(i, this.items.length - 1)));
      await this._loop(this.token);
      return;
    }
    if (this.state === 'playing') return;
    // 云端音频暂停后可原地续播（省一次请求）
    if (this.state === 'paused' && this.audio && this.audio.paused) {
      try { await this.audio.play(); this._set('playing'); return; } catch (e) { /* 落到重读 */ }
    }
    this.token++;
    if (this.index < 0) this._select(0);
    await this._loop(this.token);
  }

  pause() {
    if (this.state !== 'playing') return;
    if (this.audio && !this.audio.paused) {
      this.audio.pause();
      this._set('paused');
      return;
    }
    // 浏览器引擎的「暂停」= 取消当前句；恢复时从本句开头重读
    this.token++;
    try { speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
    this._set('paused');
  }

  async next() {
    if (this.index + 1 >= this.items.length) return;
    await this.play(this.index + 1);
  }

  async prev() {
    await this.play(Math.max(0, this.index - 1));
  }

  stop() {
    this.token++;
    if (activeSpeaker === this) activeSpeaker = null;
    try { speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
    this._killAudio();
    this._select(-1);
    this._set('idle');
  }

  _killAudio(revoke = true) {
    // 关键：音频被中途掐掉时 onended / onerror 都不会来，必须主动让等待方收尾，
    // 否则跟读循环会永远挂在这一句上（用户看到的是「停止键失灵」）。
    const done = this._clipDone;
    this._clipDone = null;
    if (this.audio) {
      const src = this.audio.src;
      try { this.audio.pause(); } catch (e) { /* 忽略 */ }
      this.audio = null;
      // 本地模型的音频地址是缓存复用的，不能在播放结束时回收（交给缓存自己淘汰）
      if (revoke && src && src.startsWith('blob:')) {
        try { URL.revokeObjectURL(src); } catch (e) { /* 忽略 */ }
      }
    }
    if (done) done.resolve();
  }

  async _loop(my) {
    activeSpeaker = this;
    this._set('playing');
    while (my === this.token && this.index >= 0 && this.index < this.items.length) {
      const item = this.items[this.index];
      let route = 'browser';
      try {
        if (preferKokoro()) {
          route = 'kokoro';
          await this._speakKokoro(item.text);
        } else if (preferCloud()) {
          route = 'cloud';
          await this._speakCloud(item.text);
        } else {
          await this._speakBrowser(item.text);
        }
      } catch (e) {
        if (my !== this.token) return;
        const msg = String((e && e.message) || e);
        if (route === 'kokoro') {
          // 本地模型失败（内存不足 / 加载被清 / 合成异常）→ 本次会话不再尝试，
          // 同一句交给后面的音色重读，用户不会卡在这里等
          kokoroBroken = true;
          if (this.onerror) this.onerror(`本地 AI 音色不可用（${msg}），已切回其他音色`);
        } else {
          if (route === 'cloud') cloudBroken = true;
          await this._handleFailure(e, my, route === 'cloud');
        }
        if (my !== this.token) return;
      }
      if (my !== this.token) return;
      this._select(this.index + 1);
    }
    if (my !== this.token) return;
    this._select(-1);
    if (activeSpeaker === this) activeSpeaker = null;
    this._set('idle');
    if (this.onend) this.onend(this);
  }

  async _handleFailure(err, my, usedCloud) {
    const msg = String((err && err.message) || err);

    // 自备 AI 语音接口挂了 → 本次会话切回浏览器音色，重读同一句
    if (usedCloud) {
      if (this.onerror) this.onerror(`自备 AI 语音不可用（${msg}），已切回浏览器音色`);
      const fallback = this._nextVoice();
      if (fallback) { runtimeVoice = fallback.name; return; }
    }

    const cur = resolveVoice();
    if (cur) {
      const tries = (voiceAttempts.get(cur.name) || 0) + 1;
      voiceAttempts.set(cur.name, tries);
      // 首次失败多半是远程合成冷启动 → 原音色重试一次再判死
      if (tries <= 1) {
        await new Promise(r => setTimeout(r, 300));
        return;
      }
      failedVoices.add(cur.name);
    }
    const next = this._nextVoice();
    if (next) {
      // 逐级降档换音色，重读同一句：不静默失败，也不跳过内容
      runtimeVoice = next.name;
      if (this.onerror) {
        this.onerror(`「${cur ? cur.name : '当前音色'}」不可用（${msg}），已换用「${next.name}」`);
      }
      return;
    }
    if (this.onerror) this.onerror(`朗读失败：${msg}`);
    this.token++;
    if (activeSpeaker === this) activeSpeaker = null;
    this._set('idle');
  }

  /** 找一个没失败过的音色（先英文，再退到全部音色） */
  _nextVoice() {
    const pools = [...listVoices(), ...allVoices()];
    return pools.find(v => !failedVoices.has(v.name)) || null;
  }

  _speakBrowser(text) {
    return new Promise((resolve, reject) => {
      if (disabled || typeof speechSynthesis === 'undefined') {
        reject(new Error('当前浏览器不支持朗读'));
        return;
      }
      const v = resolveVoice();
      const u = new SpeechSynthesisUtterance(text);
      if (v) {
        u.lang = v.lang;
        const raw = findRawVoice(v.name);
        if (raw) u.voice = raw;
      } else {
        u.lang = 'en-US';
      }
      u.rate = settings.rate;
      let started = false;
      const guard = setTimeout(() => {
        if (started) return;
        try { speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
        reject(new Error('语音引擎无响应'));
      }, 12000);
      u.onstart = () => { started = true; clearTimeout(guard); };
      u.onend = () => { clearTimeout(guard); resolve(); };
      u.onerror = (ev) => {
        clearTimeout(guard);
        const kind = (ev && ev.error) || 'error';
        // cancel() 引发的 interrupted/canceled 属于正常中断
        if (kind === 'interrupted' || kind === 'canceled') resolve();
        else reject(new Error(kind));
      };
      try { speechSynthesis.speak(u); } catch (e) { clearTimeout(guard); reject(e); }
    });
  }

  async _speakCloud(text) {
    const c = settings.cloud;
    const base = String(c.endpoint || '').replace(/\/+$/, '');
    const res = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.key}`,
      },
      body: JSON.stringify({
        model: c.model || 'tts-1',
        voice: c.voice || 'alloy',
        input: text,
        response_format: 'mp3',
      }),
    });
    if (!res.ok) throw new Error(`AI 语音接口 ${res.status}`);
    const blob = await res.blob();
    if (!blob.size) throw new Error('AI 语音返回空音频');
    await this._playClip(URL.createObjectURL(blob));
  }

  /** 本地神经语音：浏览器内推理 → WAV → 播放 */
  async _speakKokoro(text) {
    const voice = settings.kokoro.voice || KOKORO_DEFAULT_VOICE;
    const speed = Math.min(1.5, Math.max(0.6, Number(settings.rate) || 1));
    const clip = await kokoroSynth(text, { voice, speed });
    // 边播边算下一句：整章跟读不再句句干等推理
    const next = this.items[this.index + 1];
    if (next && next.text && preferKokoro()) kokoroPrefetch(next.text, { voice, speed });
    await this._playClip(clip.url, { keepUrl: true });
  }

  _playClip(url, { keepUrl = false } = {}) {
    const audio = new Audio(url);
    audio.preload = 'auto';
    this.audio = audio;
    return new Promise((resolve, reject) => {
      // 交给实例保存，供 _killAudio 在「被停止/被打断」时收尾
      this._clipDone = { resolve, reject };
      audio.onended = () => { this._clipDone = null; resolve(); };
      audio.onerror = () => { this._clipDone = null; reject(new Error('音频播放失败')); };
      const p = audio.play();
      if (p && p.catch) {
        p.catch(e => { this._clipDone = null; reject(new Error((e && e.message) || '播放被拦截')); });
      }
    }).then(
      () => { this._killAudio(!keepUrl); },
      (e) => { this._killAudio(!keepUrl); throw e; },
    );
  }
}

function findRawVoice(name) {
  try {
    return (speechSynthesis.getVoices() || []).find(v => v.name === name) || null;
  } catch (e) { return null; }
}

/** 单句朗读（点词、闪卡、复习用）：不干扰跟读播放器，只让它就地暂停 */
export function speakOnce(text, { rate, onError } = {}) {
  if (activeSpeaker && activeSpeaker.state === 'playing') activeSpeaker.pause();
  try {
    // 本地模型 / 自备接口都是异步合成，交给一次性播放器；失败要说出来，不能静默
    if (preferKokoro() || preferCloud()) {
      const one = new Speaker();
      one.onerror = (m) => { if (onError) onError(m); };
      one.setItems([{ text, node: null }]);
      one.play(0).catch((e) => { if (onError) onError(String((e && e.message) || e)); });
      return true;
    }
    if (disabled || typeof speechSynthesis === 'undefined') return false;
    speechSynthesis.cancel();
    const v = resolveVoice();
    const u = new SpeechSynthesisUtterance(text);
    if (v) {
      u.lang = v.lang;
      const raw = findRawVoice(v.name);
      if (raw) u.voice = raw;
    } else {
      u.lang = 'en-US';
    }
    u.rate = rate || settings.rate;
    speechSynthesis.speak(u);
    return true;
  } catch (e) {
    return false;
  }
}
