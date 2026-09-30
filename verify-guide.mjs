// verify-guide.mjs — 验证「句子翻译 + 书签」功能指引
// 运行前提：python -m http.server 8891 常驻于项目根目录；脚本在 node workspace 下运行（有 puppeteer-core）
import { makeChecker, launchPage, finish, sleep } from './verify-lib.mjs';

const { t, state } = makeChecker();

// 这个脚本本身要验证「指引」，所以不能移除 #guide-overlay，只在下面点「开始阅读」
const { browser, page } = await launchPage({ waitAfter: 2000 });

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
t('提示条提到朗读', /🔊|朗读/.test(tipTxt), tipTxt.slice(0, 50));

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
t('指引含朗读步骤', /听全文|朗读/.test(guideTxt), guideTxt.slice(0, 40));
await page.evaluate(() => { document.querySelector('#guide-close')?.click(); });

await finish({ browser, state });
