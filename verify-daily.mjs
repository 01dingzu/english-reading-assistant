// verify-daily.mjs — 每日共读页：点词即入库（与 App 共用 IndexedDB）
//
// 运行前提：python -m http.server 8891 --bind 127.0.0.1 常驻在项目根目录
// 关注点不是「页面能打开」，而是「点一下之后，App 的 words store 里真的多了一条」。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeChecker, launchPage, finish, sleep } from './verify-lib.mjs';

const URL_DAILY = process.env.DAILY_URL || 'http://127.0.0.1:8891/daily/';
const SHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '_shots');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

const { t, state } = makeChecker();
const errors = [];

// 读 engreader 库里的全部生词（不带版本号 open，避免与已升级的库冲突抛 VersionError）
const readWords = () => new Promise((res, rej) => {
  const r = indexedDB.open('engreader');
  r.onsuccess = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains('words')) { res([]); return; }
    const q = db.transaction('words', 'readonly').objectStore('words').getAll();
    q.onsuccess = () => res(q.result || []);
    q.onerror = () => rej(q.error);
  };
  r.onerror = () => rej(r.error);
});

const { browser, page } = await launchPage({ cleanProfile: true, collectErrors: errors, goto: false });
await page.setViewport({ width: 430, height: 900 });
await page.goto(URL_DAILY, { waitUntil: 'networkidle2' });
await page.waitForSelector('#d-article .tok', { timeout: 30000 }).catch(() => {});
await sleep(600);

// ---- 1. 渲染 ----
const info = await page.evaluate(() => ({
  title: document.querySelector('#d-title')?.textContent || '',
  day: document.querySelector('#d-day')?.textContent || '',
  sub: document.querySelector('#d-sub')?.textContent || '',
  toks: document.querySelectorAll('#d-article .tok').length,
  paras: document.querySelectorAll('#d-article p').length,
  before: !document.querySelector('#d-before')?.hidden,
  after: !document.querySelector('#d-after')?.hidden,
  err: document.querySelector('#d-error')?.hidden === false
    ? document.querySelector('#d-error').textContent.slice(0, 120) : '',
  fs: getComputedStyle(document.querySelector('#d-article')).fontSize,
}));

t('没有加载错误', !info.err, info.err);
t('标题渲染', info.title === 'Where City Birds Find Their Food', info.title);
t('Day 标记', /Day 1/.test(info.day), info.day);
t('7 个段落', info.paras === 7, info.paras);
t('词元切成可点（> 380）', info.toks > 380, info.toks);
t('读前预测有内容', info.before);
t('读后任务有内容', info.after);
t('正文字号 ≥ 20px', parseFloat(info.fs) >= 20, info.fs);
await page.screenshot({ path: path.join(SHOT_DIR, 'daily-1-initial.png') });

// ---- 2. 单击 = 入库 ----
// 单击延后 250ms 才执行（为了识别双击），所以要等够。
//
// 注意：这里必须用**真实坐标点击**（page.mouse.click），不能用 el.click()。
// el.click() 直接派发事件，绕过浏览器的命中测试，会把「有遮罩层盖在正文上」这种
// 致命 bug 全部放过去 —— 2026-10-19 就踩过一次：#d-sheet 的 `display:flex` 压过
// `[hidden]`，全屏弹层一直盖着文章，人点不动，而 el.click() 版本 35/35 全绿。
const clickTok = async (surface, count = 1) => {
  const found = await page.evaluate((w) => {
    const el = [...document.querySelectorAll('#d-article .tok')]
      .find((x) => x.dataset.w.toLowerCase() === w);
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    return true;
  }, surface);
  if (!found) return { found: false, blocked: false };

  await sleep(150);
  const pos = await page.evaluate((w) => {
    const el = [...document.querySelectorAll('#d-article .tok')]
      .find((x) => x.dataset.w.toLowerCase() === w);
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return { cx, cy, blocked: !(hit === el || el.contains(hit)) };
  }, surface);

  for (let i = 0; i < count; i++) await page.mouse.click(pos.cx, pos.cy);
  return { found: true, blocked: pos.blocked };
};

const c0 = await clickTok('scavengers');
t('找到 scavengers', c0.found);
t('词没被遮挡层盖住（真实点击能命中）', c0.found && !c0.blocked);
await sleep(500);

let list = await page.evaluate(readWords);
const rec = list.find((r) => r.word === 'scavenger');
t('点一下：库里多了一条', !!rec, `words=${list.length}`);
t('存的是原形不是复数', !!rec && rec.word === 'scavenger', rec?.word);
t('带音标', !!rec?.ph, rec?.ph);
t('带释义', !!rec?.tr && rec.tr !== '（词典未收录）', (rec?.tr || '').slice(0, 30));
t('带原句语境', !!rec?.contexts?.[0]?.sentence, rec?.contexts?.[0]?.sentence?.slice(0, 40));
t('来源标记 source=daily', rec?.source === 'daily', rec?.source);
t('没有伪造 srs（应进新词队列）', rec ? rec.srs === null : false, rec?.srs);
t('页面词条变黄（tapped）', await page.evaluate(() =>
  document.querySelector('.tok.tapped')?.dataset.k === 'scavenger'));

const n1 = await page.evaluate(() => document.querySelector('#d-n').textContent);
t('底栏计数 1', n1 === '1', n1);
await page.screenshot({ path: path.join(SHOT_DIR, 'daily-2-tapped.png') });

// 同形词应该一起变色（scavengers 只出现一次，用另一个多次出现的词验）
await clickTok('food');
await sleep(400);
const multi = await page.evaluate(() => {
  const ns = [...document.querySelectorAll('.tok.tapped')].filter((x) => x.dataset.k === 'food');
  return { tapped: ns.length, total: document.querySelectorAll('.tok[data-k="food"]').length };
});
t('同一个词的所有出现位置同步标黄', multi.tapped === multi.total && multi.total > 3, multi);

// ---- 3. 双击 = 查义（不新增词条）----
const before = (await page.evaluate(readWords)).length;
await clickTok('scavengers', 2);
await sleep(400);
const sh = await page.evaluate(() => ({
  open: document.querySelector('#d-sheet')?.hidden === false,
  word: document.querySelector('.sh-word')?.textContent || '',
  ph: document.querySelector('.sh-ph')?.textContent || '',
  tr: (document.querySelector('.sh-tr')?.textContent || '').slice(0, 24),
  ctx: (document.querySelector('.sh-ctx')?.textContent || '').slice(0, 30),
}));
t('双击打开释义弹层', sh.open, JSON.stringify(sh));
t('弹层显示原形', sh.word === 'scavenger', sh.word);
t('弹层有音标', !!sh.ph, sh.ph);
t('弹层有释义', !!sh.tr, sh.tr);
t('弹层有原句', !!sh.ctx, sh.ctx);
t('双击不新增词条', (await page.evaluate(readWords)).length === before);
await page.screenshot({ path: path.join(SHOT_DIR, 'daily-3-sheet.png') });
await page.evaluate(() => document.querySelector('#d-sheet').click());
await sleep(200);

// ---- 4. 再单击 = 取消（仅限当天自加、未复习的）----
await clickTok('food');
await sleep(500);
list = await page.evaluate(readWords);
t('再点一下移出生词本', !list.some((r) => r.word === 'food'), `words=${list.length}`);

// ---- 5. 已复习过的词不允许点掉（保护复习进度）----
await page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('engreader');
  r.onsuccess = () => {
    const db = r.result;
    const tx = db.transaction('words', 'readwrite');
    tx.objectStore('words').put({
      word: 'pigeon', ph: "'pidʒin", tr: 'n. 鸽子', contexts: [{ sentence: 'A pigeon that finds bread.', bookTitle: 'x' }],
      createdAt: Date.now(), status: 'learning', srs: { ef: 2.5, interval: 6, reps: 2, next: Date.now(), lapses: 0 },
    });
    tx.oncomplete = () => res(true);
  };
}));
await page.reload({ waitUntil: 'networkidle2' });
await page.waitForSelector('#d-article .tok');
await sleep(500);
t('刷新后旧生词仍有绿色标记', await page.evaluate(() =>
  !!document.querySelector('.tok.saved[data-k="pigeon"]')));
await clickTok('pigeons');
await sleep(450);
list = await page.evaluate(readWords);
t('复习中的词不会被点掉', list.some((r) => r.word === 'pigeon' && r.srs?.reps === 2));

// ---- 6. 清单与复制 ----
await page.evaluate(() => document.querySelector('#d-open-list').click());
await sleep(300);
const lg = await page.evaluate(() => ({
  open: document.querySelector('#d-sheet')?.hidden === false,
  rows: document.querySelectorAll('.lg-row').length,
  hasCopy: [...document.querySelectorAll('.lg-tools button')].some((b) => /复制/.test(b.textContent)),
}));
t('清单能打开', lg.open);
t('清单列出今天的词', lg.rows >= 1, lg.rows);
t('有复制按钮', lg.hasCopy);
await page.screenshot({ path: path.join(SHOT_DIR, 'daily-4-list.png') });

// ---- 7. 字号记忆 ----
await page.evaluate(() => document.querySelector('#d-sheet').click());
await sleep(150);
const fs0 = await page.evaluate(() => getComputedStyle(document.querySelector('#d-article')).fontSize);
await page.evaluate(() => document.querySelector('#d-fp').click());
await sleep(200);
const fs1 = await page.evaluate(() => getComputedStyle(document.querySelector('#d-article')).fontSize);
t('A+ 放大字号', parseFloat(fs1) > parseFloat(fs0), `${fs0} → ${fs1}`);
await page.reload({ waitUntil: 'networkidle2' });
await page.waitForSelector('#d-article .tok');
await sleep(400);
const fs2 = await page.evaluate(() => getComputedStyle(document.querySelector('#d-article')).fontSize);
t('字号跨刷新记住', fs2 === fs1, `${fs1} → ${fs2}`);

// ---- 8. 首页联动：App 里能看到这批词 ----
await page.goto('http://127.0.0.1:8891/', { waitUntil: 'networkidle2' });
await page.waitForSelector('#dict-status', { timeout: 30000 });
await sleep(800);
const appSees = await page.evaluate(async () => {
  const { words } = await import('./js/db.js');
  const all = await words.all();
  return all.map((r) => r.word);
});
t('App 侧能读到 daily 加的词', appSees.includes('scavenger'), appSees.slice(0, 8).join(','));

t('没有 JS 报错', errors.length === 0, errors.join(' | '));

await finish({ browser, state });
