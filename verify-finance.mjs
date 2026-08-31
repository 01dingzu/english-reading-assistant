// verify-finance.mjs — 验证「财经英语书库」完整流程（点击导入 → 书架 → 阅读）
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://127.0.0.1:8899/';
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
page.on('console', m => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 150)); });
page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 200)));
await page.setViewport({ width: 390, height: 844 });
await page.goto(URL, { waitUntil: 'networkidle2' });
await sleep(1500);

// 1. 只关新手引导遮罩（不要动 sheet-backdrop）
await page.evaluate(() => {
  document.querySelectorAll('.guide-overlay, [class*=guide], [class*=onboard], .intro-js, #guide-overlay').forEach(n => n.remove());
});
await sleep(500);

// 2. 书架入口存在
const entryExists = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.book-card')];
  return cards.some(c => c.textContent.includes('财经英语书库'));
});
t('书架有「财经英语书库」入口', entryExists);

// 3. 点击入口 → 动态加载并导入（给足 60s，JSON 450KB）
await page.evaluate(() => {
  [...document.querySelectorAll('.book-card')].find(c => c.textContent.includes('财经英语书库')).click();
});
// 导入完成的标志：书架卡片数增加（toast 出现窗口短，直接等卡片）
let importDone = false;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('.book-title')].map(e => e.textContent.trim()));
  if (cards.includes('The Richest Man in Babylon') && cards.includes('Reminiscences of a Stock Operator')) { importDone = true; break; }
}
t('点击入口后 3 本书导入', importDone);

// 4. 书架出现 3 本财经书 + 难度标签
const titles = await page.evaluate(() =>
  [...document.querySelectorAll('.book-title')].map(e => e.textContent.trim()));
t('书架有 The Richest Man in Babylon', titles.includes('The Richest Man in Babylon'), titles.join(' | '));
t('书架有 Reminiscences of a Stock Operator', titles.includes('Reminiscences of a Stock Operator'));
t('书架有 The Wealth of Nations', titles.some(x => x.includes('The Wealth of Nations')));
const lvLabels = await page.evaluate(() =>
  [...document.querySelectorAll('.book-level')].map(e => e.textContent.trim()));
t('书架显示难度标签', lvLabels.length >= 3, lvLabels.join(' | '));

// 5. 打开 Babylon → 阅读页
await page.evaluate(() => {
  [...document.querySelectorAll('.book-card')].find(c => c.textContent.includes('The Richest Man in Babylon')).click();
});
await sleep(1200);
const chPos = await page.evaluate(() => document.querySelector('#ch-pos')?.textContent || '');
t(`章节位置显示 "1 / 12"`, chPos.trim() === '1 / 12', `got: "${chPos}"`);

const firstPara = await page.evaluate(() => {
  const ps = document.querySelectorAll('#reader-content p');
  return ps.length ? ps[0].textContent.trim().slice(0, 90) : '';
});
t('正文有段落', firstPara.length > 30, `para: "${firstPara}"`);
t('正文是 Babylon 内容', /Babylon|chariot|gold|prosperity|nation/i.test(firstPara), firstPara);

// 6. 点词查义（点第一个词 → 弹出释义面板；异步渲染需等待）
const sheetOpens = await page.evaluate(async () => {
  const tok = document.querySelector('#reader-content .tok');
  if (!tok) return 'no-token';
  tok.click();
  await new Promise(r => setTimeout(r, 600));
  return document.querySelector('#sheet')?.hidden === false ? 'sheet-shown' : 'not-shown';
});
t('点词弹出释义面板', sheetOpens === 'sheet-shown', sheetOpens);
await page.evaluate(() => { location.hash = '#/shelf'; });
await sleep(800);

// 7. 入口已消失（防重复导入）
const entryAgain = await page.evaluate(() =>
  [...document.querySelectorAll('.book-card')].some(c => c.textContent.includes('财经英语书库')));
t('导入后入口消失（防重复）', !entryAgain);

// 8. 打开 Stock Operator 检查股市词汇
await page.evaluate(() => {
  [...document.querySelectorAll('.book-card')].find(c => c.textContent.includes('Reminiscences of a Stock Operator')).click();
});
await sleep(1000);
const soPara = await page.evaluate(() => {
  const ps = document.querySelectorAll('#reader-content p');
  return ps.length ? ps[0].textContent.trim().slice(0, 90) : '';
});
t('Stock Operator 正文可读', /stock|market|figures|broker|quotation/i.test(soPara), soPara);

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
