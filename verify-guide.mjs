// verify-guide.mjs — 验证「句子翻译 + 书签」功能指引
// 运行前提：python -m http.server 8891 常驻于项目根目录；脚本在 node workspace 下运行（有 puppeteer-core）
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://127.0.0.1:8891/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function t(name, ok, extra = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 160)); });
page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 220)));
await page.setViewport({ width: 390, height: 844 });
await page.goto(URL, { waitUntil: 'networkidle2' });
await sleep(2000);

// 0. 关掉首次欢迎引导（点「开始阅读」，顺带写入 guideShown），等书架渲染
await page.evaluate(() => { document.querySelector('#guide-close')?.click(); });
await sleep(600);
const bookCount = await page.evaluate(() => document.querySelectorAll('.book-card').length);
t('书架有书可打开', bookCount > 0, `${bookCount} 本`);

// 1. 首次打开书 → feature-tip 出现且文案覆盖两个功能
const tipText = await page.evaluate(() => {
  const c = document.querySelector('.book-card');
  c.click();
  return '';
});
await sleep(1500);
const tipShown = await page.evaluate(() => {
  const tip = document.querySelector('#feature-tip');
  return tip && !tip.hidden;
});
t('首次打开书显示功能提示条', tipShown);
const tipTxt = await page.evaluate(() => document.querySelector('#feature-tip')?.innerText || '');
t('提示条提到句子翻译', /译/.test(tipTxt), tipTxt.slice(0, 50));
t('提示条提到书签', /书签|🔖|📑/.test(tipTxt), tipTxt.slice(0, 50));

// 2. 点「知道了」→ 提示条隐藏
await page.evaluate(() => { document.querySelector('#feature-tip-close').click(); });
await sleep(400);
const tipHidden = await page.evaluate(() => document.querySelector('#feature-tip').hidden);
t('点「知道了」后提示条隐藏', tipHidden);

// 3. 回书架，打开另一本书 → 不再自动弹出
await page.evaluate(() => { location.hash = '#/shelf'; });
await sleep(1000);
const titles = await page.evaluate(() =>
  [...document.querySelectorAll('.book-card .book-title')].map(n => n.textContent));
t('书架有多本可换书', titles.length >= 2, titles.join(' / '));
const second = await page.evaluate(() => {
  const cards = document.querySelectorAll('.book-card');
  cards[1].click();
});
await sleep(1200);
const tipAgain = await page.evaluate(() => document.querySelector('#feature-tip').hidden);
t('再次开书不重复弹出提示条', tipAgain);

// 4. 顶栏「?」→ 欢迎引导包含翻译与书签步骤
const clickRes = await page.evaluate(() => {
  const b = document.querySelector('#btn-guide');
  if (!b) {
    return {
      ok: false,
      hash: location.hash,
      navType: performance.getEntriesByType('navigation')[0]?.type,
      len: document.body.innerHTML.length,
      head: document.body.innerHTML.slice(0, 200),
    };
  }
  b.click();
  return { ok: true };
});
console.log('  [diag]', JSON.stringify(clickRes));
await sleep(500);
const guideTxt = clickRes.ok
  ? await page.evaluate(() => document.querySelector('#guide-overlay')?.innerText || '')
  : '';
t('「?」可打开完整指引', clickRes.ok && !!guideTxt, JSON.stringify(clickRes));
t('指引含翻译步骤', /点「译」|整段/.test(guideTxt), guideTxt.slice(0, 40));
t('指引含书签步骤', /书签收藏位置/.test(guideTxt), guideTxt.slice(0, 40));
await page.evaluate(() => { document.querySelector('#guide-close')?.click(); });

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
await browser.close();
process.exit(failed ? 1 : 0);
