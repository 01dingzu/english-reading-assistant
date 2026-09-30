// verify-kokoro.mjs — 验证「本地 AI 音色（Kokoro-82M）」接入
// 覆盖：音色表 → WAV 编码/归一化 → 模型加载与进度 → 合成缓存 → 引擎路由 →
//       逐句跟读（含预取）→ 超时护栏（合成卡死 / 音频僵死）→ 失败熔断与恢复 →
//       设置面板 UI → 持久化 → 首次下载动线 → 不碰 CDN
//
// 为什么用注入式假模型：
//   真模型要下 88MB（沙箱实测十几分钟），不适合做回归。这里把 `globalThis.__KOKORO_TEST_FACTORY__`
//   换成假引擎，从而可以确定性地断言「缓存命中 / 进度上报 / 失败熔断」这些分支；
//   真模型端到端另由 _kokoro_probe.mjs 实测（产出可试听 WAV）。
//
// 运行前提：python -m http.server 8891 常驻于项目根目录
//   node verify-kokoro.mjs                        # 用 Chrome 跑
//   node verify-kokoro.mjs <浏览器exe路径>
import { makeChecker, launchPage, removeGuide, finish, sleep, waitAppReady } from './verify-lib.mjs';

const { t, state } = makeChecker();

// ---------- 注入式假模型 ----------
// 用 evaluateOnNewDocument 安装：每次新文档都在，重载后依然生效，同时挡住任何真实的 CDN 下载。
function installMock() {
  window.__kk = { calls: [], loads: 0, fail: 0, loud: 0, progressSent: 0, hang: 0 };
  globalThis.__KOKORO_TEST_FACTORY__ = async () => ({
    KokoroTTS: {
      from_pretrained: async (id, opt) => {
        window.__kk.loads++;
        window.__kk.modelId = id;
        window.__kk.device = opt && opt.device;
        window.__kk.dtype = opt && opt.dtype;
        const cb = opt && opt.progress_callback;
        if (cb) {
          // 模拟真实下载：分片上报进度，中间留出可观测的时间窗
          cb({ status: 'initiate', file: 'model_q8.onnx', total: 80 * 1048576 });
          await new Promise((r) => setTimeout(r, 150));
          cb({ status: 'progress', file: 'model_q8.onnx', loaded: 20 * 1048576, total: 80 * 1048576 });
          window.__kk.progressSent++;
          await new Promise((r) => setTimeout(r, 300));
          cb({ status: 'progress', file: 'model_q8.onnx', loaded: 50 * 1048576, total: 80 * 1048576 });
          window.__kk.progressSent++;
          await new Promise((r) => setTimeout(r, 150));
          cb({ status: 'done', file: 'model_q8.onnx', total: 80 * 1048576 });
        }
        return {
          voices: Object.fromEntries(['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'bf_emma', 'am_fenrir', 'bm_george']
            .map((v) => [v, {}])),
          generate: async (text, { voice, speed }) => {
            window.__kk.calls.push({ text, voice, speed });
            if (window.__kk.fail) throw new Error('mock 合成失败');
            // 模拟推理卡死：不报错也不返回（真机上 WebGPU 出过这种情况）
            if (window.__kk.hang) await new Promise(() => {});
            const sr = 24000;
            const n = Math.round(0.4 * sr);
            const audio = new Float32Array(n);
            const amp = window.__kk.loud ? 1.0 : 0.6;
            for (let i = 0; i < n; i++) audio[i] = Math.sin(i / 24) * amp;
            return { audio, sampling_rate: sr };
          },
        };
      },
    },
  });
}

const errs = [];
const offsite = [];
const { browser, page } = await launchPage({
  args: ['--autoplay-policy=no-user-gesture-required'],
  viewport: { width: 400, height: 880 },
  collectErrors: errs,
  waitAfter: 2200,
  setup: async (p) => {
    // 装了假模型后不该有任何真实 CDN 请求，这里全程盯着
    p.on('request', (r) => {
      const u = r.url();
      if (/jsdelivr|huggingface|hf\.co/i.test(u)) offsite.push(u);
    });
    await p.evaluateOnNewDocument(installMock);
  },
});
await removeGuide(page);
await sleep(300);

// 等词典与内置书就绪：H 段要靠点开一本真书才能打开语音设置面板
await waitAppReady(page);

console.log(`\n浏览器：${await page.evaluate(() => navigator.userAgent.replace(/^.*(Chrome\/[\d.]+).*$/, '$1'))}`);

const js = (fn, ...args) => page.evaluate(fn, ...args);

// 先确认应用本身起来了：reader.js/tts.js 任何一个模块导入失败，后面所有 UI 断言都会变成「静默无反应」，
// 早查一步能直接定位到模块图问题。
const boot = await js(() => ({
  books: document.querySelectorAll('.book-card').length,
  dict: (document.querySelector('#dict-status')?.textContent || '').slice(0, 20),
}));
t('应用正常启动（书架有内置书）', boot.books > 0, JSON.stringify(boot));

// ---------- A. 音色表与默认状态 ----------
const meta = await js(async () => {
  const tts = await import('./js/tts.js');
  await tts.loadSettings();
  const groups = tts.kokoroVoicesByGroup();
  return {
    enabled: tts.getSettings().kokoro.enabled,
    voice: tts.getSettings().kokoro.voice,
    ready: tts.kokoroIsReady(),
    count: tts.KOKORO_VOICES.length,
    groups: groups.map((g) => ({ key: g.key, n: g.voices.length, first: g.voices[0].id })),
    ids: tts.KOKORO_VOICES.map((v) => v.id),
    grades: tts.KOKORO_VOICES.map((v) => v.grade),
    device: tts.kokoroDevice(),
    dtypes: Object.keys(tts.KOKORO_DTYPES),
    loads: window.__kk.loads,
  };
});
t('默认不启用本地 AI 音色（不偷偷下 88MB）', meta.enabled === false, String(meta.enabled));
t('未加载前 kokoroIsReady() 为 false', meta.ready === false);
t('默认音色为 af_heart（官方 A 级）', meta.voice === 'af_heart', meta.voice);
t('内置 28 个音色', meta.count === 28, String(meta.count));
t('分组为 美音 11 女 / 9 男、英音 4 女 / 4 男',
  JSON.stringify(meta.groups.map((g) => g.n)) === JSON.stringify([11, 9, 4, 4]),
  JSON.stringify(meta.groups));
t('官方评级最高的排在各组首位（af_heart / bf_emma）',
  meta.groups[0].first === 'af_heart' && meta.groups[2].first === 'bf_emma',
  JSON.stringify(meta.groups.map((g) => g.first)));
t('28 个音色都带官方评级（缺一个就说明评级表的 id 写错了）',
  meta.grades.length === 28 && meta.grades.every((g) => g),
  meta.grades.filter((g) => !g).join(',') || '全部有评级');
t('音色 id 前缀与分组一致（11+9+4+4）',
  meta.ids.filter((id) => id.startsWith('af_')).length === 11
  && meta.ids.filter((id) => id.startsWith('am_')).length === 9
  && meta.ids.filter((id) => id.startsWith('bf_')).length === 4
  && meta.ids.filter((id) => id.startsWith('bm_')).length === 4, `${meta.ids.length} 个`);
t('设备探测返回 webgpu / wasm', ['webgpu', 'wasm'].includes(meta.device), meta.device);
t('量化档位含 q8', meta.dtypes.includes('q8'), meta.dtypes.join(','));

// 启用但没就绪时：不许联网抢跑，安静退回浏览器音色
const notReady = await js(async () => {
  const tts = await import('./js/tts.js');
  await tts.saveSettings({ kokoro: { enabled: true }, engine: 'auto' });
  return { prefer: tts.preferKokoro(), usable: tts.kokoroUsable(), loads: window.__kk.loads };
});
t('启用后未就绪时不抢跑（preferKokoro=false，不触发下载）',
  notReady.prefer === false && notReady.loads === 0, JSON.stringify(notReady));

// ---------- B. WAV 编码与峰值归一化（纯函数，确定性）----------
const wav = await js(async () => {
  const { encodeWav } = await import('./js/kokoro.js');
  const read = async (blob) => {
    const dv = new DataView(await blob.arrayBuffer());
    const tag = (o, n) => String.fromCharCode(...new Uint8Array(dv.buffer, o, n));
    const n = dv.getUint32(40, true) / 2;
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(dv.getInt16(44 + i * 2, true)));
    return {
      riff: tag(0, 4), wave: tag(8, 4), fmt: tag(12, 4), data: tag(36, 4),
      sr: dv.getUint32(24, true), bits: dv.getUint16(34, true), ch: dv.getUint16(22, true),
      dataLen: dv.getUint32(40, true), size: blob.size, n, peak,
    };
  };
  const mk = (amp, n = 2400) => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = Math.sin(i / 10) * amp;
    return a;
  };
  return {
    loud: await read(encodeWav(mk(1.0), 24000)),   // 顶到 1.0 → 应被归一化
    quiet: await read(encodeWav(mk(0.3), 24000)),  // 低电平 → 不应被放大
    expectLoud: Math.round(0.98 * 32767),
    expectQuiet: Math.round(0.3 * 32767),
  };
});
t('产出标准 44 字节头的 16-bit PCM WAV',
  wav.loud.riff === 'RIFF' && wav.loud.wave === 'WAVE' && wav.loud.fmt === 'fmt ' && wav.loud.data === 'data'
  && wav.loud.bits === 16 && wav.loud.ch === 1, JSON.stringify(wav.loud));
t('采样率沿用模型输出（24kHz）', wav.loud.sr === 24000, String(wav.loud.sr));
t('data 段长度 = 样本数 × 2（头 44 字节）',
  wav.loud.dataLen === wav.loud.n * 2 && wav.loud.size === 44 + wav.loud.dataLen,
  `${wav.loud.dataLen} / n=${wav.loud.n} / size=${wav.loud.size}`);
t('峰值顶到 1.0 时做归一化（避免削顶失真）',
  wav.loud.peak === wav.expectLoud && wav.loud.peak < 32767, `peak=${wav.loud.peak} 期望=${wav.expectLoud}`);
t('低电平不放大（避免底噪被抬起来）',
  wav.quiet.peak === wav.expectQuiet, `peak=${wav.quiet.peak} 期望=${wav.expectQuiet}`);

// ---------- C. 模型加载 + 进度上报 ----------
const load = await js(async () => {
  const tts = await import('./js/tts.js');
  await tts.ensureKokoro({ model: 'q8' });
  await tts.ensureKokoro({ model: 'q8' });   // 幂等：不应再 load 一次
  return { ready: tts.kokoroIsReady(), info: tts.kokoroInfo(), loads: window.__kk.loads, dtype: window.__kk.dtype, progressSent: window.__kk.progressSent };
});
t('模型加载成功且标记为就绪', load.ready === true);
t('按设置请求量化档位（q8）', load.dtype === 'q8', String(load.dtype));
t('并发/重复调用只加载一次（幂等）', load.loads === 1, `loads=${load.loads}`);
t('下载期间有进度上报', load.progressSent >= 2, `progressSent=${load.progressSent}`);
t('加载完成后状态收敛为 ready', load.info.progress.phase === 'ready', load.info.progress.phase);

// ---------- D. 合成与缓存 ----------
const synth = await js(async () => {
  const { synthesize, clearAudioCache } = await import('./js/kokoro.js');
  clearAudioCache();
  window.__kk.calls.length = 0;
  const a = await synthesize('Alpha sentence.', { voice: 'af_heart', speed: 1 });
  const b = await synthesize('Alpha sentence.', { voice: 'af_heart', speed: 1 });  // 缓存命中
  await synthesize('Beta sentence.', { voice: 'af_bella', speed: 1 });             // 换音色/换文本
  await synthesize('Gamma.', { voice: 'not_a_voice', speed: 5 });                  // 非法音色 + 语速越界
  await synthesize('Delta.', { voice: 'af_heart', speed: 0.1 });
  return {
    urlScheme: String(a.url).slice(0, 5),
    duration: +a.duration.toFixed(2),
    sameUrl: a.url === b.url,
    bytes: a.bytes,
    calls: window.__kk.calls.map((x) => ({ text: x.text, voice: x.voice, speed: x.speed })),
  };
});
t('合成返回可播放的 blob: 地址', synth.urlScheme === 'blob:', synth.urlScheme);
t('时长与样本数一致（0.4s @24k）', Math.abs(synth.duration - 0.4) < 0.02, String(synth.duration));
t('同一句重复合成命中缓存（不重复推理）',
  synth.sameUrl && synth.calls.filter((c) => c.text === 'Alpha sentence.').length === 1,
  JSON.stringify(synth.calls));
t('换文本 / 换音色会重新推理', synth.calls.length === 4, `calls=${synth.calls.length}`);
t('非法音色回退到默认 af_heart', synth.calls[2] && synth.calls[2].voice === 'af_heart', JSON.stringify(synth.calls[2] || {}));
t('语速越界被夹到 1.5 / 0.6',
  synth.calls[2] && synth.calls[2].speed === 1.5 && synth.calls[3] && synth.calls[3].speed === 0.6,
  JSON.stringify([synth.calls[2], synth.calls[3]]));

// ---------- E. 引擎路由 ----------
const route = await js(async () => {
  const tts = await import('./js/tts.js');
  const out = {};
  await tts.saveSettings({ engine: 'auto', kokoro: { enabled: true }, cloud: { enabled: true, key: 'x', endpoint: 'https://x/v1' } });
  out.autoKokoro = tts.preferKokoro();
  out.autoCloud = tts.preferCloud();
  out.label = tts.engineLabel();
  await tts.saveSettings({ engine: 'system' });
  out.systemKokoro = tts.preferKokoro();
  await tts.saveSettings({ engine: 'kokoro' });
  out.kokoroOnlyCloud = tts.preferCloud();
  out.kokoroOnly = tts.preferKokoro();
  await tts.saveSettings({ engine: 'auto', cloud: { enabled: false, key: '' } });
  return out;
});
t('auto：已就绪的本地模型优先于浏览器 / 云端音色',
  route.autoKokoro === true && route.autoCloud === false, JSON.stringify(route));
t('仅本机音色：不走本地模型', route.systemKokoro === false);
t('点名本地模型时不偷偷发云端请求', route.kokoroOnly === true && route.kokoroOnlyCloud === false);
t('顶栏标签显示「本地 AI · 音色id」', /本地 AI · af_heart/.test(route.label), route.label);

// ---------- F. 逐句跟读（走本地模型）----------
const speak = await js(async () => {
  const tts = await import('./js/tts.js');
  await tts.saveSettings({ engine: 'auto', kokoro: { enabled: true, voice: 'af_bella' }, rate: 0.8 });
  window.__kk.calls.length = 0;
  const { Speaker } = await import('./js/tts.js');
  const sp = new Speaker();
  sp.setItems([
    { text: 'First sentence here.', node: null },
    { text: 'Second sentence here.', node: null },
    { text: 'Third sentence here.', node: null },
  ]);
  const done = sp.play(0);
  await new Promise((r) => setTimeout(r, 260));
  const mid = { index: sp.index, state: sp.state, calls: window.__kk.calls.map((c) => c.text) };
  await new Promise((r) => setTimeout(r, 2400));
  await done;
  return {
    mid,
    final: { state: sp.state, index: sp.index, calls: window.__kk.calls.map((c) => c.text) },
    first: window.__kk.calls[0],
  };
});
t('跟读走本地模型：三句各合成一次', speak.final.calls.length === 3, JSON.stringify(speak.final.calls));
t('句间不干等：播第 1 句时已预取第 2 句',
  speak.mid.index === 0 && speak.mid.calls.includes('Second sentence here.'), JSON.stringify(speak.mid));
t('整章读完后队列自动归位', speak.final.state === 'idle' && speak.final.index === -1, JSON.stringify(speak.final));
t('音色取自设置项', speak.first && speak.first.voice === 'af_bella', JSON.stringify(speak.first || {}));
t('语速按设置传入模型（rate 0.8 → speed 0.8）', speak.first && speak.first.speed === 0.8, JSON.stringify(speak.first || {}));

// 暂停 / 停止不残留
const ctl = await js(async () => {
  const { Speaker } = await import('./js/tts.js');
  window.__kk.calls.length = 0;
  const sp = new Speaker();
  sp.setItems([{ text: 'A.', node: null }, { text: 'B.', node: null }]);
  const p = sp.play(0);
  await new Promise((r) => setTimeout(r, 120));
  sp.pause();
  const paused = sp.state;
  sp.stop();
  await p.catch(() => {});
  return { paused, after: sp.state, index: sp.index };
});
t('暂停状态可识别（音频型播放器支持原地续播）', ctl.paused === 'paused', ctl.paused);
t('停止后回到 idle 并清空位置', ctl.after === 'idle' && ctl.index === -1, JSON.stringify(ctl));

// ---------- F2. 播放护栏：音频僵死不能把跟读挂死 ----------
// 真机实测：媒体元素进入 playing 后再也不回 ended，跟读循环挂了 30 分钟。
// 这里用一个「永不 ended、时间轴也不推进」的假 Audio 复现，断言循环照样走完。
const playGuard = await js(async () => {
  const tts = await import('./js/tts.js');
  await tts.saveSettings({ engine: 'auto', kokoro: { enabled: true, voice: 'af_heart' } });
  window.__kk.calls.length = 0;
  tts.setTimeoutForTest({ playIdle: 250, playMin: 200, playSlack: 100 });
  const OrigAudio = window.Audio;
  window.Audio = class {
    constructor(u) { this.src = u; this.paused = false; this.duration = NaN; }
    play() { return Promise.resolve(); }
    pause() { this.paused = true; }
  };
  const msgs = [];
  let timedOut = false;
  const sp = new tts.Speaker();
  sp.onerror = (m) => msgs.push(m);
  sp.setItems([{ text: 'Wedge one.', node: null }, { text: 'Wedge two.', node: null }]);
  const t0 = performance.now();
  const p = sp.play(0);
  await Promise.race([p, new Promise((r) => setTimeout(() => { timedOut = true; r(); }, 8000))]);
  const out = {
    timedOut, ms: Math.round(performance.now() - t0), state: sp.state, index: sp.index,
    calls: window.__kk.calls.length, msgs, broken: tts.isKokoroBroken(),
  };
  sp.stop();
  window.Audio = OrigAudio;
  tts.setTimeoutForTest({ playIdle: 12000, playMin: 20000, playSlack: 10000 });
  return out;
});
t('音频僵死（永不 ended）时跟读不会挂死', playGuard.timedOut === false && playGuard.state === 'idle', JSON.stringify(playGuard));
t('音频僵死时两句照样读下去（不丢内容）', playGuard.calls === 2 && playGuard.index === -1, `calls=${playGuard.calls}`);
t('播放失败只跳过这一句，不停用本地模型',
  playGuard.broken === false && playGuard.msgs.some((m) => /没能播放/.test(m)), playGuard.msgs.join(' | '));

// ---------- F3. 合成护栏：推理卡死不能让人干等 ----------
const synthGuard = await js(async () => {
  const tts = await import('./js/tts.js');
  await tts.saveSettings({ engine: 'auto', kokoro: { enabled: true, voice: 'af_heart' } });
  window.__kk.hang = 1;
  window.__kk.calls.length = 0;
  tts.setTimeoutForTest({ synth: 300 });
  // 记录浏览器音色通道实际读到的文本，用来证明「卡死的这句被重读了」
  const orig = speechSynthesis.speak.bind(speechSynthesis);
  window.__spoken = [];
  speechSynthesis.speak = (u) => { window.__spoken.push(u.text); return orig(u); };

  const msgs = [];
  let timedOut = false;
  const sp = new tts.Speaker();
  sp.onerror = (m) => msgs.push(m);
  sp.setItems([{ text: 'Hang one.', node: null }, { text: 'Hang two.', node: null }]);
  const t0 = performance.now();
  await Promise.race([sp.play(0), new Promise((r) => setTimeout(() => { timedOut = true; r(); }, 8000))]);
  const out = {
    timedOut, ms: Math.round(performance.now() - t0), state: sp.state,
    kokoroCalls: window.__kk.calls.length, spoken: window.__spoken.slice(0, 3),
    msgs, broken: tts.isKokoroBroken(), usable: tts.kokoroUsable(),
  };
  sp.stop();
  speechSynthesis.speak = orig;
  window.__kk.hang = 0;
  tts.setTimeoutForTest({ synth: 120000 });
  await tts.saveSettings({ kokoro: { voice: 'af_bella' } });   // 解除熔断，不影响后续段
  return out;
});
t('本地合成卡死时不会永远干等（超时熔断 + 明确提示）',
  synthGuard.timedOut === false && synthGuard.broken === true
  && synthGuard.msgs.some((m) => /本地 AI 音色不可用/.test(m)),
  JSON.stringify({ t: synthGuard.timedOut, ms: synthGuard.ms, broken: synthGuard.broken, msgs: synthGuard.msgs }));
t('卡死的这一句不跳过（换音色后重读同一句）',
  synthGuard.spoken[0] === 'Hang one.', JSON.stringify(synthGuard.spoken));

// ---------- G. 失败熔断与恢复 ----------
const fail = await js(async () => {
  const tts = await import('./js/tts.js');
  await tts.saveSettings({ engine: 'auto', kokoro: { enabled: true } });
  window.__kk.fail = 1;
  window.__kk.calls.length = 0;
  const { Speaker } = await import('./js/tts.js');
  const sp = new Speaker();
  const msgs = [];
  sp.onerror = (m) => msgs.push(m);
  sp.setItems([{ text: 'Fail one.', node: null }, { text: 'Fail two.', node: null }, { text: 'Fail three.', node: null }]);
  const p = sp.play(0);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (sp.state === 'idle' && sp.index === -1) break;
  }
  sp.stop();
  await p.catch(() => {});
  return { msgs, calls: window.__kk.calls.length, usable: tts.kokoroUsable(), broken: tts.isKokoroBroken() };
});
t('本地模型失败时给出明确提示（不静默）',
  fail.msgs.some((m) => /本地 AI 音色不可用/.test(m)), fail.msgs.join(' | ') || '(无提示)');
t('失败后本次会话熔断，不再反复重试本地模型',
  fail.calls === 1 && fail.broken === true && fail.usable === false, `calls=${fail.calls} broken=${fail.broken}`);
await js(() => { window.__kk.fail = 0; });
const recover = await js(async () => {
  const tts = await import('./js/tts.js');
  await tts.saveSettings({ kokoro: { voice: 'af_nicole' } });   // 动过设置 → 解除熔断
  return { usable: tts.kokoroUsable(), broken: tts.isKokoroBroken() };
});
t('改动设置后熔断解除（可再次使用）', recover.usable === true && recover.broken === false, JSON.stringify(recover));

// ---------- H. 设置面板 ----------
await js(() => { document.querySelector('.book-card')?.click(); });
await sleep(1200);
await js(() => document.querySelector('#tts-set').click());
await sleep(500);

const panel = await js(() => ({
  open: document.querySelector('#sheet')?.hidden === false,
  chips: [...document.querySelectorAll('#tts-engine-chips .tts-chip')].map((c) => c.dataset.engine),
  hasBlock: !!document.querySelector('#tts-kokoro'),
  blockLabel: document.querySelector('#tts-kokoro .tts-label')?.textContent || '',
  status: document.querySelector('#kk-status')?.textContent || '',
  // 音色选择：本地 AI 与浏览器已合并成一张表，默认只铺精选
  voices: document.querySelectorAll('#tts-voices .tts-voice').length,
  kids: [...document.querySelectorAll('#tts-voices .tts-voice')].map((n) => n.dataset.kvoice || n.dataset.voice),
  grades: [...document.querySelectorAll('#tts-voices .tts-grade')].map((g) => g.textContent),
  auditions: document.querySelectorAll('#tts-voices .tts-audition').length,
  toggle: document.querySelector('#tts-voices-toggle')?.textContent || '',
  hasPreview: !!document.querySelector('#kk-preview'),
  hasToggle: !!document.querySelector('#kk-toggle'),
}));
t('引擎多了「仅本地 AI 音色」一项',
  JSON.stringify(panel.chips) === JSON.stringify(['auto', 'kokoro', 'system', 'cloud']), JSON.stringify(panel.chips));
t('设置面板有独立的本地 AI 音色区块', panel.hasBlock && /Kokoro/.test(panel.blockLabel), panel.blockLabel);
t('已就绪状态如实展示设备', /已就绪/.test(panel.status), panel.status);
t('提供试听与启用开关', panel.hasPreview && panel.hasToggle);
t('音色表默认只铺 6 个（不再一次列 28 个）', panel.voices === 6, `${panel.voices} 个`);
t('精选 6 个 = 官方评级最高的 3 女 3 男',
  panel.kids.join(',') === 'af_heart,af_bella,bf_emma,am_michael,am_fenrir,bm_george', panel.kids.join(','));
t('每个音色带官方评级徽标（A / A- / B- / C+ / C+ / C）',
  panel.grades.join(',') === 'A,A-,B-,C+,C+,C', panel.grades.join(','));
t('每行都能单独试听', panel.auditions === panel.voices, `${panel.auditions} 个试听按钮`);
t('其余音色没被删掉，收在「显示全部音色」里',
  /显示全部音色（共 \d+ 个）/.test(panel.toggle), panel.toggle);

// 换音色 → 落库 → 控制条同步
await js(() => {
  [...document.querySelectorAll('#tts-voices .tts-voice')].find((n) => n.dataset.kvoice === 'am_michael').click();
});
await sleep(700);
const picked = await js(async () => (await import('./js/tts.js')).getSettings().kokoro.voice);
t('点选音色后写入设置（am_michael）', picked === 'am_michael', picked);
const pickedVoice = await js(() => document.querySelector('#sheet-body .tts-active-v')?.textContent || '');
t('面板「当前音色」同步为新音色', /am_michael/.test(pickedVoice), pickedVoice);
const barLabel = await js(() => document.querySelector('#tts-voice')?.textContent || '');
t('跟读控制条同步显示本地 AI 音色', /本地 AI · am_michael/.test(barLabel), barLabel);

// 单条试听：点 ▶ 要真的用那个音色合成，且不能顺手改掉当前选择
await js(() => document.querySelector('#tts-voices [data-audition="af_bella"]').click());
await sleep(1800);
const aud = await js(async () => {
  const tts = await import('./js/tts.js');
  return { calls: window.__kk.calls.map((c) => c.voice), cur: tts.getSettings().kokoro.voice };
});
t('试听用的是被点的那个音色（af_bella）', aud.calls.includes('af_bella'), aud.calls.join(','));
t('试听不改动当前音色设置（仍是 am_michael）', aud.cur === 'am_michael', aud.cur);

// 展开「显示全部音色」→ 28 个本地音色按 4 组回来
await js(() => document.querySelector('#tts-voices-toggle').click());
await sleep(500);
const expanded = await js(() => ({
  kk: document.querySelectorAll('#tts-voices [data-kvoice]').length,
  groupLabels: [...document.querySelectorAll('#tts-voices .tts-group')].map((g) => g.textContent),
  toggle: document.querySelector('#tts-voices-toggle')?.textContent || '',
}));
const localGroups = expanded.groupLabels.filter((g) => /本地 AI/.test(g));
t('展开后 28 个本地音色全在（美英音 / 男女 4 组）',
  expanded.kk === 28 && localGroups.length === 4, `${expanded.kk} 个 / ${localGroups.join('、')}`);
t('展开后可以再收起', /收起/.test(expanded.toggle), expanded.toggle);
await js(() => document.querySelector('#tts-voices-toggle').click());
await sleep(400);

// ---------- I. 持久化与刷新恢复 ----------
await js(() => document.querySelector('#sheet-backdrop').click());
await sleep(200);
const beforeReload = await js(async () => {
  const tts = await import('./js/tts.js');
  // warm 的真实写入方是「下载并启用」（J 段验证）；这里手工置位，单测「后台恢复」分支
  await tts.saveSettings({ kokoro: { enabled: true, warm: true } });
  return { enabled: tts.getSettings().kokoro.enabled, voice: tts.getSettings().kokoro.voice };
});
await page.reload({ waitUntil: 'networkidle2' });
await sleep(2600);

// 引导文案：#guide-overlay 是静态节点，读文案要在 remove 之前（移除后按钮就点不动了）
const guide = await js(() => document.querySelector('#guide-overlay')?.textContent || '');
t('使用指引提到本地 AI 音色 / Kokoro', /Kokoro|本地 AI 音色/.test(guide), guide.slice(0, 40));
t('功能提示条提到可下载本地音色',
  await js(() => /Kokoro|本地 AI 音色/.test(document.querySelector('#feature-tip')?.textContent || '')));
await js(() => document.querySelectorAll('#guide-overlay').forEach((n) => n.remove()));

const afterReload = await js(async () => {
  const tts = await import('./js/tts.js');
  await tts.loadSettings();
  return {
    enabled: tts.getSettings().kokoro.enabled,
    warm: tts.getSettings().kokoro.warm,
    voice: tts.getSettings().kokoro.voice,
    ready: tts.kokoroIsReady(),
    loads: window.__kk.loads,
    prefer: tts.preferKokoro(),
  };
});
t('刷新后设置仍在（启用状态 / 音色）',
  afterReload.enabled === true && afterReload.voice === beforeReload.voice, JSON.stringify(afterReload));
t('刷新后自动恢复本地模型（走缓存，只加载一次）', afterReload.loads === 1, `loads=${afterReload.loads}`);
t('恢复后即生效（无需用户再操作）', afterReload.ready === true && afterReload.prefer === true, JSON.stringify(afterReload));

// ---------- J. 首次下载动线（模拟新用户）----------
// 清掉启用状态并刷新：模型实例随页面消失，回到「从没下过」的界面
await js(async () => {
  const tts = await import('./js/tts.js');
  await tts.saveSettings({ kokoro: { enabled: false, warm: false } });
});
await page.reload({ waitUntil: 'networkidle2' });
await sleep(2200);
await js(() => document.querySelectorAll('#guide-overlay').forEach((n) => n.remove()));
await js(() => document.querySelector('#tts-set').click());
await sleep(500);
const fresh = await js(() => ({
  ready: document.querySelector('#kk-status')?.textContent || '',
  btn: document.querySelector('#kk-download')?.textContent || '',
  progressHidden: document.querySelector('#kk-progress')?.hidden,
  note: [...document.querySelectorAll('#tts-kokoro .tts-note')].map((p) => p.textContent).join(' '),
  // 注意别用 `#tts-voices .tts-voice` 判空：那张表在模型没就绪时会退到浏览器音色，
  // 行数不为 0。要判的是「有没有本地模型的音色」。
  kkVoices: document.querySelectorAll('#tts-voices [data-kvoice]').length,
  rows: document.querySelectorAll('#tts-voices .tts-voice').length,
  hint: document.querySelector('.tts-voice-hint')?.textContent || '',
}));
t('新用户看到「未启用 + 下载入口」而不是本地音色列表',
  /未启用/.test(fresh.ready) && fresh.btn.includes('下载并启用') && fresh.kkVoices === 0, JSON.stringify(fresh));
t('模型没就绪时精选表退到本机音色，并说明启用后能拿到更好的 6 个',
  fresh.rows > 0 && /官方评级最高的 6 个/.test(fresh.hint), `${fresh.rows} 行 / ${fresh.hint.slice(0, 36)}`);
t('下载前说明体积与「不再联网」', /88 MB|88MB/.test(fresh.note) && /不再联网|离线/.test(fresh.note), fresh.note.slice(0, 60));
t('未下载时不显示进度条', fresh.progressHidden === true);

await js(() => document.querySelector('#kk-download').click());
let sawProgress = '';
for (let i = 0; i < 40; i++) {
  await sleep(80);
  const txt = await js(() => {
    const p = document.querySelector('#kk-progress');
    return p && p.hidden === false ? (document.querySelector('#kk-progress-text')?.textContent || '') : '';
  });
  if (/下载模型/.test(txt)) { sawProgress = txt; break; }
}
console.log(`  诊断 · 下载中文案：${sawProgress || '(未捕获)'}`);
t('下载时显示进度（百分比 / 已获取体积）', /下载模型 .*(%|MB)/.test(sawProgress), sawProgress);
await sleep(1400);
const afterDl = await js(async () => {
  const tts = await import('./js/tts.js');
  return {
    enabled: tts.getSettings().kokoro.enabled,
    warm: tts.getSettings().kokoro.warm,
    prefer: tts.preferKokoro(),
    status: document.querySelector('#kk-status')?.textContent || '',
    kkVoices: document.querySelectorAll('#tts-voices [data-kvoice]').length,
  };
});
t('下载完成即启用（并记住已成功加载过）',
  afterDl.enabled === true && afterDl.warm === true && afterDl.prefer === true, JSON.stringify(afterDl));
t('下载完成后精选表就地换成 6 个本地音色',
  afterDl.kkVoices === 6 && /已就绪/.test(afterDl.status), `${afterDl.kkVoices} 个 / ${afterDl.status}`);

// ---------- K. 边界 ----------
t('全程没有向 CDN / HuggingFace 发请求（注入生效，未真下载）', offsite.length === 0,
  offsite.slice(0, 2).join(' | '));
t('全程无运行时报错', errs.length === 0, errs.slice(0, 3).join(' | '));

await finish({ browser, state });
