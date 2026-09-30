// kokoro.js — 本地神经语音引擎（Kokoro-82M，Apache-2.0，浏览器内推理）
//
// 为什么要有这一层：
//   浏览器内置的 speechSynthesis 只有 Edge 能给出 3 个神经音色（Aria / Guy / Libby），
//   Chrome 全是机械音，Windows 本机只有 Microsoft Zira（最机械）。都不够好听。
//   Kokoro-82M 是 8200 万参数的轻量 TTS 模型，Apache-2.0、免费、无需 Key，
//   可以直接在浏览器里跑（WebGPU 优先，退 WebAssembly），一次下载后离线可用，
//   音色有 28 个（美音 11 女 9 男 / 英音 4 女 4 男）。
//
// 成本与边界：
//   - 首次启用要下载约 88MB 模型（q8 量化）+ 每个音色 510KB 权重。之后走浏览器缓存。
//   - 音色权重是「用到哪个拉哪个」，所以换新音色第一次要联网。
//   - 模型文件走 CDN（jsdelivr / HuggingFace），因此**必须在联网状态下首次启用**；
//     下载完成后模型进 CacheStorage，离线也能继续用。
//   - WebGPU 首次合成要编译 shader，第一句可能十几秒 → 提供 warmup() 预热。

export const KOKORO_CDN = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const DEFAULT_VOICE = 'af_heart';

/** 量化档位 → 体积（官方仓库实测体积，用于给用户一个心理预期） */
export const DTYPES = {
  q8: '约 88 MB',
  q8f16: '约 82 MB',
  fp16: '约 156 MB',
  fp32: '约 310 MB',
};

export const VOICE_GROUPS = [
  { key: 'us-f', label: '美音 · 女声' },
  { key: 'us-m', label: '美音 · 男声' },
  { key: 'uk-f', label: '英音 · 女声' },
  { key: 'uk-m', label: '英音 · 男声' },
];

// 官方 VOICES.md 里给过音质评级的几个（A / A- / B-），其余为可用音色。
// 不做过度包装：只标「推荐」，不编造具体等级。
export const VOICES = [
  ['af_heart', 'Heart', 'us-f', 1],
  ['af_bella', 'Bella', 'us-f', 1],
  ['af_nicole', 'Nicole', 'us-f', 1],
  ['af_aoede', 'Aoede', 'us-f', 0],
  ['af_kore', 'Kore', 'us-f', 0],
  ['af_sarah', 'Sarah', 'us-f', 0],
  ['af_alloy', 'Alloy', 'us-f', 0],
  ['af_jessica', 'Jessica', 'us-f', 0],
  ['af_nova', 'Nova', 'us-f', 0],
  ['af_river', 'River', 'us-f', 0],
  ['af_sky', 'Sky', 'us-f', 0],
  ['am_michael', 'Michael', 'us-m', 0],
  ['am_fenrir', 'Fenrir', 'us-m', 0],
  ['am_puck', 'Puck', 'us-m', 0],
  ['am_echo', 'Echo', 'us-m', 0],
  ['am_eric', 'Eric', 'us-m', 0],
  ['am_liam', 'Liam', 'us-m', 0],
  ['am_onyx', 'Onyx', 'us-m', 0],
  ['am_santa', 'Santa', 'us-m', 0],
  ['am_adam', 'Adam', 'us-m', 0],
  ['bf_emma', 'Emma', 'uk-f', 1],
  ['bf_isabella', 'Isabella', 'uk-f', 0],
  ['bf_alice', 'Alice', 'uk-f', 0],
  ['bf_lily', 'Lily', 'uk-f', 0],
  ['bm_george', 'George', 'uk-m', 0],
  ['bm_fable', 'Fable', 'uk-m', 0],
  ['bm_lewis', 'Lewis', 'uk-m', 0],
  ['bm_daniel', 'Daniel', 'uk-m', 0],
].map(([id, name, group, rec]) => ({ id, name, group, rec: !!rec }));

const VOICE_IDS = new Set(VOICES.map((v) => v.id));

export function getVoice(id) {
  return VOICES.find((v) => v.id === id) || null;
}

/** 按分组返回音色（推荐音色排在组内最前，其余保持官方顺序） */
export function voicesByGroup() {
  return VOICE_GROUPS.map((g) => ({
    ...g,
    voices: VOICES.filter((v) => v.group === g.key).sort((a, b) => b.rec - a.rec),
  }));
}

// ---------- 运行状态 ----------

let instance = null;          // KokoroTTS 实例（常驻内存）
let loading = null;           // 正在进行的加载 Promise（并发调用只下载一次）
let deviceUsed = '';          // 'webgpu' | 'wasm'
let lastError = '';
let progress = { phase: 'idle', pct: 0, mb: 0, file: '', error: '' };
let listeners = [];
let lastEmit = 0;

export function status() {
  return {
    ready: !!instance,
    loading: !!loading,
    device: deviceUsed,
    error: lastError,
    progress: { ...progress },
  };
}

export function isReady() {
  return !!instance;
}

/** 进度订阅（只保留最后一个订阅者：面板会重渲染，用 id 查节点即可） */
export function onProgress(fn) {
  listeners = fn ? [fn] : [];
}

function emit(force) {
  const now = Date.now();
  if (!force && now - lastEmit < 250) return;
  lastEmit = now;
  const snap = { ...progress };
  for (const fn of listeners) {
    try { fn(snap); } catch (e) { /* 订阅方异常不影响引擎 */ }
  }
}

/** 设备能力探测：WebGPU 明显更快，没有就退 WebAssembly */
export function detectDevice() {
  try {
    return (typeof navigator !== 'undefined' && navigator.gpu) ? 'webgpu' : 'wasm';
  } catch (e) {
    return 'wasm';
  }
}

/** 浏览器是否具备跑本地模型的基本条件 */
export function isSupported() {
  return typeof WebAssembly === 'object'
    && typeof fetch === 'function'
    && typeof Audio === 'function';
}

// ---------- 加载 ----------

const fileStats = new Map();  // 文件 → { total, loaded }，用于算总进度

function trackFile(p) {
  if (!p || !p.file) return;
  const rec = fileStats.get(p.file) || { total: 0, loaded: 0 };
  if (p.total) rec.total = p.total;
  if (typeof p.loaded === 'number') rec.loaded = Math.max(rec.loaded, p.loaded);
  if (p.status === 'done') rec.loaded = rec.total || rec.loaded;
  fileStats.set(p.file, rec);

  let total = 0, loaded = 0;
  for (const r of fileStats.values()) { total += r.total; loaded += r.loaded; }
  progress = {
    phase: 'loading-model',
    pct: total ? Math.min(99, Math.round((loaded / total) * 100)) : -1,  // -1 = 大小未知，只能显示已下体积
    mb: +(loaded / 1048576).toFixed(1),
    file: p.file,
    error: '',
  };
  emit(false);
}

/**
 * 加载模型（幂等：并发调用共用同一次下载）。
 * onProgress 只是把订阅接上，真正的进度广播走 onProgress()。
 */
export async function ensure({ model = 'q8', onProgress: sub } = {}) {
  if (sub) onProgress(sub);
  if (instance) return instance;
  if (loading) return loading;

  if (!isSupported()) {
    lastError = '当前浏览器不支持本地语音模型（需要 WebAssembly + Audio）';
    progress = { phase: 'error', pct: 0, mb: 0, file: '', error: lastError };
    emit(true);
    throw new Error(lastError);
  }

  progress = { phase: 'loading-lib', pct: 0, mb: 0, file: '', error: '' };
  emit(true);
  fileStats.clear();

  loading = (async () => {
    // 测试注入点：单元测试用假模型替换 CDN 下载，避免每个用例都拉 88MB。
    const factory = globalThis.__KOKORO_TEST_FACTORY__;
    const mod = factory ? await factory() : await import(/* webpackIgnore: true */ KOKORO_CDN);
    const KokoroTTS = mod && (mod.KokoroTTS || (mod.default && mod.default.KokoroTTS));
    if (!KokoroTTS) throw new Error('语音模型入口异常（未导出 KokoroTTS）');

    const device = detectDevice();
    progress = { phase: 'loading-model', pct: 0, mb: 0, file: '', error: '' };
    emit(true);

    const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, {
      dtype: model,
      device,
      progress_callback: trackFile,
    });
    instance = tts;
    deviceUsed = device;
    lastError = '';
    progress = { phase: 'ready', pct: 100, mb: 0, file: '', error: '' };
    emit(true);
    return tts;
  })();

  try {
    return await loading;
  } catch (e) {
    lastError = String((e && e.message) || e);
    progress = { phase: 'error', pct: 0, mb: 0, file: '', error: lastError };
    emit(true);
    instance = null;
    loading = null;   // 失败要允许重试：不能把拒绝的 Promise 一直挂在加载状态上
    throw e;
  } finally {
    // 成功也要清掉「加载中」标记：否则面板会一直显示「正在下载模型…」、
    // 按钮永远停在「下载中…」——状态显示必须真实。
    if (instance) loading = null;
  }
}

/**
 * 预热：WebGPU 首次合成要编译 shader，第一句可能十几秒。
 * 加载完成后主动合成一个短句，把这段等待挪到「下载中」那一步。
 */
export async function warmup(voice = DEFAULT_VOICE) {
  try {
    await synthesize('Hello.', { voice, speed: 1 });
    return true;
  } catch (e) {
    return false;
  }
}

// ---------- 合成 ----------

const cache = new Map();      // key → Promise<{ url, duration, bytes }>
const MAX_CACHE = 6;          // 只留最近几句音频，避免 blob 堆积

function cacheKey(text, voice, speed) {
  return `${voice}|${speed}|${text}`;
}

function evict() {
  while (cache.size > MAX_CACHE) {
    const k = cache.keys().next().value;
    const p = cache.get(k);
    cache.delete(k);
    // 复用时音频地址仍可能在被播放，等它不再被引用再回收
    Promise.resolve(p).then((r) => {
      if (r && r.url && !cache.has(k)) {
        try { URL.revokeObjectURL(r.url); } catch (e) { /* 忽略 */ }
      }
    }).catch(() => {});
  }
}

/**
 * 合成一句 → { url(blob:), duration, bytes }
 * 结果按「音色+语速+文本」缓存，重复朗读同一句不会重复推理。
 * timeout>0 时超时即失败，并且**不把卡死的 promise 留在缓存里**（否则下次拿到同一个死结）。
 */
export async function synthesize(text, { voice = DEFAULT_VOICE, speed = 1, signal, timeout = 0 } = {}) {
  const v = VOICE_IDS.has(voice) ? voice : DEFAULT_VOICE;
  const sp = Math.min(1.5, Math.max(0.6, Number(speed) || 1));
  const key = cacheKey(text, v, sp);

  let p = cache.get(key);
  if (!p) {
    p = synth(text, { voice: v, speed: sp, signal });
    cache.set(key, p);
    evict();
  }
  try {
    if (timeout > 0) return await withTimeout(p, timeout, '本地语音合成超时');
    return await p;
  } catch (e) {
    if (cache.get(key) === p) cache.delete(key);   // 失败结果不留缓存
    throw e;
  }
}

function withTimeout(p, ms, msg) {
  let timer;
  return Promise.race([
    p,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(msg)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** 预合成下一句（跟读时边播边算下一句，减少句间空档）。失败静默，回头正式合成时再报错。 */
export function prefetch(text, opts) {
  synthesize(text, opts).catch(() => {});
}

async function synth(text, { voice, speed, signal }) {
  const tts = await ensure();
  if (signal && signal.aborted) throw new Error('已取消');
  const raw = await tts.generate(text, { voice, speed });
  const samples = samplesOf(raw);
  if (!samples || !samples.length) throw new Error('语音模型返回空音频');
  const sr = (raw && raw.sampling_rate) || 24000;
  const blob = encodeWav(samples, sr);
  return { url: URL.createObjectURL(blob), duration: samples.length / sr, bytes: blob.size };
}

/** 不同版本的 kokoro-js 返回结构不同：RawAudio 的样本可能在 audio / data 字段上 */
function samplesOf(a) {
  if (!a) return null;
  if (a.audio) return a.audio;
  if (a.data) return a.data;
  if (a instanceof Float32Array) return a;
  return null;
}

/**
 * Float32 → 16-bit PCM WAV（44 字节头）+ 一次峰值归一化。
 * 归一化的必要性：af_heart 等音色峰值会顶到 1.0，直接量化就是削顶失真。
 */
export function encodeWav(samples, sr) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  const gain = peak > 0.99 ? 0.98 / peak : 1;

  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] * gain));
    pcm[i] = Math.round(s * 32767);
  }

  const hdr = new ArrayBuffer(44);
  const dv = new DataView(hdr);
  const wr = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
  wr(0, 'RIFF'); dv.setUint32(4, 36 + pcm.byteLength, true); wr(8, 'WAVE');
  wr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wr(36, 'data'); dv.setUint32(40, pcm.byteLength, true);

  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(new Uint8Array(hdr), 0);
  out.set(new Uint8Array(pcm.buffer), 44);
  return new Blob([out], { type: 'audio/wav' });
}

/** 丢掉已合成的音频缓存（释放内存 / 测试用） */
export function clearAudioCache() {
  for (const p of cache.values()) {
    Promise.resolve(p).then((r) => {
      if (r && r.url) { try { URL.revokeObjectURL(r.url); } catch (e) { /* 忽略 */ } }
    }).catch(() => {});
  }
  cache.clear();
}
