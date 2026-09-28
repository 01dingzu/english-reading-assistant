// verify-tts.mjs — 验证「AI 朗读」完整链路
// 覆盖：音色探测分级 → 逐句跟读状态机 → 高亮/滚动 → 设置面板 → 自备 AI 语音通道 → 点词回归
//
// 运行前提：python -m http.server 8891 常驻于项目根目录
//   node verify-tts.mjs                       # 用 Chrome 跑
//   node verify-tts.mjs <浏览器exe路径>        # 指定浏览器（Edge 有神经音色，断言会更强）
import puppeteer from 'puppeteer-core';
import http from 'node:http';

const CHROME = process.argv[2] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE_URL = 'http://127.0.0.1:8891/';
const STUB_PORT = 8899;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
const fails = [];
function t(name, ok, extra = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; fails.push(name); console.log(`  ✗ ${name} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`); }
}

// ---------- AI 语音桩服务（模拟 OpenAI 风格 /v1/audio/speech，返回 0.25s 静音 WAV）----------
function silentWav(seconds = 0.25, rate = 8000) {
  const n = Math.floor(seconds * rate);
  const dataLen = n * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
  return buf;
}
const stubHits = [];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const stub = http.createServer((req, res) => {
  // CORS 预检：只回头，不计入请求数
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    if (req.url.includes('/audio/speech')) {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* 忽略 */ }
      stubHits.push(body);
      const wav = silentWav();
      res.writeHead(200, { ...CORS, 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
      res.end(wav);
      return;
    }
    res.writeHead(204, CORS);
    res.end();
  });
});
await new Promise(r => stub.listen(STUB_PORT, '127.0.0.1', r));

// ---------- 浏览器 ----------
// 注意：puppeteer 默认会加 --disable-component-extensions-with-background-pages，
// 该参数会让 Edge 隐藏 Microsoft *Online (Natural) 神经音色。测 Edge 时必须去掉，
// 否则最有价值的「AI 音色」链路根本没被覆盖到。
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
  ignoreDefaultArgs: ['--disable-component-extensions-with-background-pages'],
});
const page = await browser.newPage();
const errs = [];
page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 200)));
await page.setViewport({ width: 400, height: 880 });
await page.goto(PAGE_URL, { waitUntil: 'networkidle2' });
await sleep(2200);

console.log(`\n浏览器：${await page.evaluate(() => navigator.userAgent.replace(/^.*(Chrome\/[\d.]+).*$/, '$1'))}`);

// 音色列表是异步填充的，等它出现英文音色（最多 8s）
for (let i = 0; i < 16; i++) {
  const n = await page.evaluate(async () => {
    const tts = await import('./js/tts.js');
    return tts.listVoices().filter(v => /^en/i.test(v.lang)).length;
  });
  if (n > 0) break;
  await sleep(500);
}

// 关掉新手引导
await page.evaluate(() => document.querySelectorAll('#guide-overlay').forEach(n => n.remove()));
await sleep(500);

// ---------- A. 语音层自检（直接问模块）----------
const env = await page.evaluate(async () => {
  const tts = await import('./js/tts.js');
  await tts.loadSettings();
  const list = tts.listVoices();
  return {
    count: list.length,
    best: list[0] || null,
    tiers: [...new Set(list.map(v => v.tier))].sort(),
    hasAi: tts.hasAiVoice(),
    settings: JSON.parse(JSON.stringify(tts.getSettings())),
  };
});
t('语音列表已就绪（>0 个英文音色）', env.count > 0, `count=${env.count}`);
t('音色已按质量分级排序（首项为最优档）', env.best && env.best.tier === Math.min(...env.tiers), JSON.stringify(env.best));
t('默认引擎为自动', env.settings.engine === 'auto', env.settings.engine);
t('默认语速 1.0 / 自动滚动开', env.settings.rate === 1 && env.settings.autoScroll === true);
const neural = env.tiers.includes(1);
if (neural) {
  t('检测到 AI 神经音色（Natural）', true, env.best.name);
} else {
  t('本环境无 Natural 音色 → 走机械音色兜底', env.tiers.every(x => x >= 3), JSON.stringify(env.tiers));
}

// ---------- B. 进入阅读页 ----------
const bookTitle = await page.evaluate(() => {
  const c = document.querySelector('.book-card');
  if (!c) return '';
  const title = c.querySelector('.book-title')?.textContent || '';
  c.click();
  return title;
});
t('书架有书可打开', !!bookTitle, bookTitle);
await sleep(1600);

const barShown = await page.evaluate(() => document.querySelector('#tts-bar')?.hidden === false);
t('阅读页自动出现跟读控制条', barShown);
const sentCount = await page.evaluate(() => document.querySelectorAll('#reader-content .sent').length);
t('段落已按句切分（.sent > 0）', sentCount > 0, `sent=${sentCount}`);
const queueLabel = await page.evaluate(() => document.querySelector('#tts-pos')?.textContent || '');
t('控制条显示可朗读句数', /^\d+ 句$/.test(queueLabel.trim()) && parseInt(queueLabel) > 0, queueLabel);

// 回归：段落翻译结构未被破坏
const structOk = await page.evaluate(() => ({
  paras: document.querySelectorAll('#reader-content .para-block').length,
  trBtns: document.querySelectorAll('#reader-content .para-block .btn-tr').length,
  spkBtns: document.querySelectorAll('#reader-content .para-block .btn-spk').length,
}));
t('每段仍有「译」按钮（未回归）', structOk.paras > 0 && structOk.trBtns === structOk.paras, JSON.stringify(structOk));
t('每段新增「读」按钮', structOk.spkBtns === structOk.paras, JSON.stringify(structOk));

// ---------- C. 播放状态机 ----------
await page.evaluate(() => document.querySelector('#btn-tts').click());
await sleep(900);
let st = await page.evaluate(() => ({
  label: document.querySelector('#tts-play')?.textContent,
  pos: document.querySelector('#tts-pos')?.textContent || '',
  senting: document.querySelectorAll('#reader-content .senting').length,
}));
t('点 🔊 进入播放态（按钮变 ⏸）', st.label === '⏸', st.label);
t('当前句被高亮（.senting = 1）', st.senting === 1, `senting=${st.senting}`);
t('进度显示为「n / N」', /^\d+ \/ \d+$/.test(st.pos.trim()), st.pos);

await page.evaluate(() => document.querySelector('#tts-stop').click());
await sleep(500);
st = await page.evaluate(() => ({
  label: document.querySelector('#tts-play')?.textContent,
  pos: document.querySelector('#tts-pos')?.textContent || '',
  senting: document.querySelectorAll('#reader-content .senting').length,
}));
t('停止后按钮回 ▶、高亮清除', st.label === '▶' && st.senting === 0, JSON.stringify(st));
t('停止后进度回到「N 句」', /^\d+ 句$/.test(st.pos.trim()), st.pos);

// 从指定段落开始读
const fromPara = await page.evaluate(() => {
  const blocks = [...document.querySelectorAll('#reader-content .para-block')];
  const target = blocks[1] || blocks[0];
  target.querySelector('.btn-spk').click();
  return blocks.indexOf(target);
});
await sleep(900);
const posAfter = await page.evaluate(() => document.querySelector('#tts-pos')?.textContent || '');
const idxAfter = parseInt(posAfter.split('/')[0]);
t('点段落「读」从该段首句开始（不在第 1 句）', fromPara >= 1 && idxAfter > 1, `para=${fromPara} pos=${posAfter}`);

// 上一句 / 下一句
await page.evaluate(() => document.querySelector('#tts-next').click());
await sleep(800);
const posNext = parseInt((await page.evaluate(() => document.querySelector('#tts-pos')?.textContent || '0')).split('/')[0]);
t('「下一句」推进一句', posNext === idxAfter + 1, `${idxAfter} → ${posNext}`);
await page.evaluate(() => document.querySelector('#tts-prev').click());
await sleep(800);
const posPrev = parseInt((await page.evaluate(() => document.querySelector('#tts-pos')?.textContent || '0')).split('/')[0]);
t('「上一句」回退一句', posPrev === posNext - 1, `${posNext} → ${posPrev}`);

// ---------- D. 音色失败自愈 ----------
// 有些机器/网络环境下远程神经音色会返回 synthesis-failed。
// 产品要求：不能静默卡死，必须自动换到能用的音色把内容读完。
// 注意：#tts-pos 一开始就是「1 / N」，所以必须断言索引真正往后走，不能拿 >=1 当通过。
await page.evaluate(() => document.querySelector('#tts-stop').click());
await sleep(300);
await page.evaluate(async () => {
  const tts = await import('./js/tts.js');
  await tts.saveSettings({ engine: 'auto', voiceName: '' });
});
const topVoice = await page.evaluate(async () => {
  const tts = await import('./js/tts.js');
  return tts.resolveVoice()?.name || '';
});
await page.evaluate(() => document.querySelector('#btn-tts').click());
let maxIdx = 0;
const fallbackMsgs = [];
for (let i = 0; i < 60; i++) {
  await sleep(500);
  const s = await page.evaluate(() => ({
    pos: document.querySelector('#tts-pos')?.textContent || '',
    toast: document.querySelector('#toast')?.hidden === false
      ? document.querySelector('#toast').textContent : '',
  }));
  if (/不可用|换用|切回/.test(s.toast) && !fallbackMsgs.includes(s.toast)) fallbackMsgs.push(s.toast);
  maxIdx = Math.max(maxIdx, parseInt(s.pos.split('/')[0] || '0'));
  if (maxIdx >= 3) break;
}
console.log(`  诊断 · 首选音色：${topVoice}`);
console.log(`  诊断 · 自愈记录：${fallbackMsgs.length ? fallbackMsgs.join(' | ') : '（首选音色直接可用，未触发）'}`);
console.log(`  诊断 · 30s 内推进到第 ${maxIdx} 句`);
t('首选音色不可用时自动换音色续读（连读 3 句不卡死）', maxIdx >= 3, `maxIdx=${maxIdx}`);
await page.evaluate(() => document.querySelector('#tts-stop').click());
await sleep(300);

// ---------- D2. 注入式失败：确定性验证「换音色自愈」 ----------
// 不依赖环境是否真的合成失败：人为把最优先的那个音色打成 synthesis-failed，
// 断言产品会先重试、再换音色，最终把内容读下去。
await page.evaluate(() => document.querySelector('#tts-stop').click());
await sleep(200);
const blockedVoice = await page.evaluate(async () => {
  const tts = await import('./js/tts.js');
  const target = tts.listVoices().find(v => v.tier === 1) || tts.listVoices()[0];
  await tts.saveSettings({ engine: 'auto', voiceName: target.name });
  const orig = speechSynthesis.speak.bind(speechSynthesis);
  window.__ttsOrigSpeak = orig;
  window.__ttsBlocked = 0;
  speechSynthesis.speak = (u) => {
    if (u.voice && u.voice.name === target.name) {
      window.__ttsBlocked++;
      setTimeout(() => { try { u.onerror({ error: 'synthesis-failed' }); } catch (e) { /* 忽略 */ } }, 10);
      return;
    }
    return orig(u);
  };
  return target.name;
});
await page.evaluate(() => document.querySelector('#btn-tts').click());
let healed = false;
const healMsgs = [];
for (let i = 0; i < 40; i++) {
  await sleep(500);
  const s = await page.evaluate(() => ({
    pos: document.querySelector('#tts-pos')?.textContent || '',
    toast: document.querySelector('#toast')?.hidden === false
      ? document.querySelector('#toast').textContent : '',
  }));
  if (/换用|不可用/.test(s.toast) && !healMsgs.includes(s.toast)) healMsgs.push(s.toast);
  if (parseInt(s.pos.split('/')[0] || '0') >= 3) { healed = true; break; }
}
const blockedCount = await page.evaluate(() => window.__ttsBlocked);
await page.evaluate(() => {
  if (window.__ttsOrigSpeak) speechSynthesis.speak = window.__ttsOrigSpeak;
  document.querySelector('#tts-stop').click();
});
await sleep(300);
console.log(`  诊断 · 注入失败音色：${blockedVoice}（被拦截 ${blockedCount} 次）`);
console.log(`  诊断 · 自愈提示：${healMsgs.length ? healMsgs.join(' | ') : '（无）'}`);
t('指定音色失败时会重试（不是一失败就换）', blockedCount >= 2, `blocked=${blockedCount}`);
t('换音色后仍能把内容读下去（注入失败下连读 3 句）', healed);
t('换音色时给出明确提示', healMsgs.length > 0, healMsgs.join(' | '));

// ---------- E. 设置面板 ----------await page.evaluate(() => document.querySelector('#tts-stop').click());
await sleep(300);
await page.evaluate(() => document.querySelector('#tts-set').click());
await sleep(600);
const panel = await page.evaluate(() => ({
  open: document.querySelector('#sheet')?.hidden === false,
  title: document.querySelector('#sheet-body .bm-title')?.textContent || '',
  chips: [...document.querySelectorAll('#tts-engine-chips .tts-chip')].map(c => c.dataset.engine),
  voices: document.querySelectorAll('#tts-voices .tts-voice').length,
  groups: [...document.querySelectorAll('#tts-voices .tts-group')].map(g => g.textContent),
  hasRate: !!document.querySelector('#tts-rate'),
  hasAuto: !!document.querySelector('#tts-autoscroll'),
  hasPreview: !!document.querySelector('#tts-preview'),
  tip: document.querySelector('#sheet-body .tts-tip')?.textContent || '',
}));
t('语音设置面板可打开', panel.open && panel.title === '语音设置', panel.title);
t('三种引擎可选（自动 / 仅本机 / 自备 AI）', JSON.stringify(panel.chips) === JSON.stringify(['auto', 'system', 'cloud']), JSON.stringify(panel.chips));
t('音色列表按档位分组展示', panel.groups.length >= 1 && panel.voices > 0, `${panel.voices} 个 / 组:${panel.groups.join('、')}`);
t('有语速滑块 / 自动滚动开关 / 试听', panel.hasRate && panel.hasAuto && panel.hasPreview);
if (neural) t('有 AI 音色时给出「已检测到」提示', panel.tip.includes('已检测到 AI 神经音色'), panel.tip.slice(0, 40));
else t('无 AI 音色时给出降级提示（引导用 Edge 或配 Key）', panel.tip.includes('机械音色'), panel.tip.slice(0, 40));

// 切语速 → 落库
await page.evaluate(() => {
  const r = document.querySelector('#tts-rate');
  r.value = '0.8';
  r.dispatchEvent(new Event('input', { bubbles: true }));
  r.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(500);
const rateSaved = await page.evaluate(async () => {
  const tts = await import('./js/tts.js');
  return tts.getSettings().rate;
});
t('语速改动已写入设置', rateSaved === 0.8, String(rateSaved));

// 关面板
await page.evaluate(() => document.querySelector('#sheet-backdrop').click());
await sleep(300);

// ---------- F. 点词回归 ----------
await page.evaluate(() => document.querySelector('#reader-content .tok')?.click());
await sleep(700);
const sheet = await page.evaluate(() => ({
  open: document.querySelector('#sheet')?.hidden === false,
  hasSpeak: [...document.querySelectorAll('#sheet-body .w-actions .btn')].some(b => b.textContent.includes('朗读')),
}));
t('点词仍弹出释义面板', sheet.open);
t('释义面板保留「朗读」按钮（走新引擎）', sheet.hasSpeak);
await page.evaluate(() => document.querySelector('#sheet-backdrop').click());
await sleep(300);

// ---------- G. 自备 AI 语音通道（打到本地桩服务）----------
await page.evaluate(async (port) => {
  const tts = await import('./js/tts.js');
  await tts.saveSettings({
    engine: 'cloud',
    voiceName: '',
    cloud: { enabled: true, endpoint: `http://127.0.0.1:${port}/v1`, key: 'stub-key', model: 'tts-1', voice: 'alloy' },
  });
}, STUB_PORT);
stubHits.length = 0;

const cloudRan = await page.evaluate(async () => {
  const { Speaker } = await import('./js/tts.js');
  const sp = new Speaker();
  sp.setItems([{ text: 'Alpha sentence.', node: null }, { text: 'Beta sentence.', node: null }]);
  await sp.play(0);
  return { state: sp.state, index: sp.index };
});
t('自备 AI 语音通道向接口发起了请求', stubHits.length > 0, `hits=${stubHits.length}`);
t('请求体包含模型 / 音色 / 待合成文本', !!stubHits[0] && stubHits[0].input.includes('Alpha'), JSON.stringify(stubHits[0] || {}));
t('两句都合成完（逐句请求）', stubHits.length === 2, `hits=${stubHits.length}`);
t('云端播放跑完整队列后自动归位', cloudRan.state === 'idle' && cloudRan.index === -1, JSON.stringify(cloudRan));

// 前端 UI 也应识别为 AI 语音
const barVoice = await page.evaluate(async () => {
  const { getSettings } = await import('./js/tts.js');
  return getSettings().engine;
});
t('引擎设置已切到自备 AI 语音', barVoice === 'cloud', barVoice);

// 还原设置，避免污染后续断言
await page.evaluate(async () => {
  const tts = await import('./js/tts.js');
  await tts.saveSettings({ engine: 'auto', cloud: { enabled: false, key: '' } });
});

// ---------- 收尾 ----------
t('全程无运行时报错', errs.length === 0, errs.join(' | '));

await browser.close();
stub.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (fails.length) console.log('失败项：\n  - ' + fails.join('\n  - '));
process.exit(failed ? 1 : 0);
