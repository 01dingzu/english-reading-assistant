// verify-finance.mjs — 验证「财经英语书库」完整流程（点击导入 → 书架 → 阅读）
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://127.0.0.1:8891/';
const EXPECTED = ['The Richest Man in Babylon', 'Reminiscences of a Stock Operator', 'The Wealth of Nations', 'How to Invest Money', 'The Stock Exchange from Within'];
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

// 3. 点击入口 → 动态加载并导入（给足 60s，JSON 640KB）
await page.evaluate(() => {
  [...document.querySelectorAll('.book-card')].find(c => c.textContent.includes('财经英语书库')).click();
});
// 导入完成的标志：5 本财经书都出现在书架上
let importDone = false;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('.book-title')].map(e => e.textContent.trim()));
  if (EXPECTED.every(x => cards.some(c => c.includes(x)))) { importDone = true; break; }
}
t('点击入口后 5 本书导入', importDone);

// 4. 书架出现 5 本财经书 + 难度标签
const titles = await page.evaluate(() =>
  [...document.querySelectorAll('.book-title')].map(e => e.textContent.trim()));
for (const exp of EXPECTED) {
  t(`书架有 ${exp}`, titles.some(x => x.includes(exp)), titles.join(' | '));
}
const lvLabels = await page.evaluate(() =>
  [...document.querySelectorAll('.book-level')].map(e => e.textContent.trim()));
t('书架显示难度标签', lvLabels.length >= 5, lvLabels.join(' | '));

// 5. 打开新增的 How to Invest Money → 阅读页
await page.evaluate(() => {
  [...document.querySelectorAll('.book-card')].find(c => c.textContent.includes('How to Invest Money')).click();
});
await sleep(1200);
const hFirstPara = await page.evaluate(() => {
  const ps = document.querySelectorAll('#reader-content p');
  return ps.length ? ps[0].textContent.trim().slice(0, 120) : '';
});
t('How to Invest Money 正文可读', /investment|bond|interest|capital|wealth|security/i.test(hFirstPara), `para: "${hFirstPara}"`);

// 5b. 打开 The Stock Exchange from Within 校验股市词汇
await page.evaluate(() => { location.hash = '#/shelf'; });
await sleep(800);
await page.evaluate(() => {
  [...document.querySelectorAll('.book-card')].find(c => c.textContent.includes('The Stock Exchange from Within')).click();
});
await sleep(1200);
const sePara = await page.evaluate(() => {
  const ps = document.querySelectorAll('#reader-content p');
  return ps.length ? ps[0].textContent.trim().slice(0, 240) : '';
});
t('Stock Exchange 正文可读', /exchange|stock|speculation|market|broker|real use/i.test(sePara), `para: "${sePara}"`);
await page.evaluate(() => { location.hash = '#/shelf'; });
await sleep(800);

// 6. 点词查义（点第一个词 → 弹出释义面板；异步渲染需等待）
await page.evaluate(() => {
  [...document.querySelectorAll('.book-card')].find(c => c.textContent.includes('The Richest Man in Babylon')).click();
});
await sleep(1200);
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
