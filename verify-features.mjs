// verify-features.mjs — 验证「段落翻译 + 词义表译句 + 书签」完整流程
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

// 0. 关新手引导，等书架渲染
await page.evaluate(() => {
  document.querySelectorAll('#guide-overlay, [class*=guide]').forEach(n => n.remove());
});
await sleep(800);

// 1. 打开书架第一本书
const firstCard = await page.evaluate(() => {
  const c = document.querySelector('.book-card');
  if (!c) return '';
  const title = c.querySelector('.book-title')?.textContent || '';
  c.click();
  return title;
});
t('书架有书可打开', !!firstCard, firstCard);
await sleep(1500);

// 2. 段落结构：每段都有「译」按钮
const trBtnCount = await page.evaluate(() => document.querySelectorAll('#reader-content .para-block .btn-tr').length);
const paraCount = await page.evaluate(() => document.querySelectorAll('#reader-content .para-block').length);
t('每段都有译按钮', trBtnCount === paraCount && paraCount > 0, `${trBtnCount}/${paraCount}`);

// 3. 点第一个「译」→ 译文出现（在线或离线回退，只要非空中文）
await page.evaluate(() => {
  document.querySelector('#reader-content .para-block .btn-tr').click();
});
let trDone = false, trText = '';
for (let i = 0; i < 30; i++) {
  await sleep(500);
  trText = await page.evaluate(() => {
    const rows = document.querySelectorAll('#reader-content .para-block .tr-row');
    const last = rows[rows.length - 1];
    return last ? last.querySelector('.tr-dst').textContent.trim() : '';
  });
  if (trText && trText !== '…') { trDone = true; break; }
}
t('段落翻译完成且非空', trDone, `「${trText.slice(0, 60)}」`);
t('译文为中文', /[\u4e00-\u9fff]/.test(trText), trText.slice(0, 60));

// 4. 词义表「译句」按钮
await page.evaluate(() => {
  const tok = document.querySelector('#reader-content .tok');
  if (tok) tok.click();
});
await sleep(800);
const sheetShown = await page.evaluate(() => document.querySelector('#sheet')?.hidden === false);
t('点词弹出释义面板', sheetShown);
const hasCtxBtn = await page.evaluate(() => !!document.querySelector('#sheet-body .w-ctx-tr-btn'));
t('词义表有「译句」按钮', hasCtxBtn);
if (hasCtxBtn) {
  await page.evaluate(() => { document.querySelector('#sheet-body .w-ctx-tr-btn').click(); });
  let ctxDone = false;
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    ctxDone = await page.evaluate(() => {
      const t = document.querySelector('#sheet-body .w-ctx-tr');
      return !!t && t.textContent.trim().length > 0;
    });
    if (ctxDone) break;
  }
  t('语境句翻译出现', ctxDone);
}
// 关闭释义面板
await page.evaluate(() => {
  const bd = document.querySelector('#sheet-backdrop');
  if (bd) bd.click();
});
await sleep(400);

// 5. 加书签：点 🔖
await page.evaluate(() => { document.querySelector('#btn-bookmark').click(); });
await sleep(600);
const bmAdded = await page.evaluate(() => {
  const toast = document.querySelector('#toast');
  return toast && !toast.hidden && toast.textContent.includes('书签');
});
t('点击 🔖 弹出已加书签提示', bmAdded, await page.evaluate(() => document.querySelector('#toast')?.textContent || ''));

// 6. 书签列表
await page.evaluate(() => { document.querySelector('#btn-bookmark-list').click(); });
await sleep(600);
const listShown = await page.evaluate(() => {
  const sheet = document.querySelector('#sheet');
  if (!sheet || sheet.hidden) return 'sheet-hidden';
  const rows = document.querySelectorAll('#sheet-body .bm-row');
  return rows.length ? `rows:${rows.length}` : 'no-rows';
});
t('书签列表显示', listShown.startsWith('rows:'), listShown);
const bmFirstText = await page.evaluate(() => document.querySelector('#sheet-body .bm-row .bm-text')?.textContent || '');

// 7. 点击书签 → 跳转（sheet 关闭）
await page.evaluate(() => { document.querySelector('#sheet-body .bm-row').click(); });
await sleep(1000);
const jumped = await page.evaluate(() => document.querySelector('#sheet')?.hidden === true);
t('点击书签跳转并关闭面板', jumped);

// 8. 删除书签
await page.evaluate(() => { document.querySelector('#btn-bookmark-list').click(); });
await sleep(500);
await page.evaluate(() => { document.querySelector('#sheet-body .bm-row .bm-del').click(); });
await sleep(500);
const afterDel = await page.evaluate(() => {
  const rows = document.querySelectorAll('#sheet-body .bm-row');
  return rows.length === 0 ? 'empty' : `rows:${rows.length}`;
});
t('删除书签后列表为空', afterDel === 'empty', afterDel);

// 9. 防重复：再加一次书签后点 🔖 应提示已有
await page.evaluate(() => {
  const bd = document.querySelector('#sheet-backdrop');
  if (bd) bd.click();
});
await sleep(300);
await page.evaluate(() => { document.querySelector('#btn-bookmark').click(); });
await sleep(500);
await page.evaluate(() => { document.querySelector('#btn-bookmark').click(); });
await sleep(500);
const dupTip = await page.evaluate(() => document.querySelector('#toast')?.textContent || '');
t('重复位置加书签有提示', dupTip.includes('已有书签'), dupTip);

// 10. 备份导出含书签（直接调用导出函数验证数据结构）
const backupOk = await page.evaluate(async () => {
  try {
    // 触发导出，拦截 blob URL 下载 -> 无法直接读；改为验证书签存储
    const { bookmarks } = await import('./js/db.js');
    const list = await bookmarks.all();
    return list.length >= 1;
  } catch (e) { return 'err:' + e.message; }
});
t('书签已持久化到 IndexedDB', backupOk === true, String(backupOk));

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
