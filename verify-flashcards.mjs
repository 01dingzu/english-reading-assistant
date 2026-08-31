// verify-flashcards.mjs — 端到端验证闪卡完整交互流程
// 前置：在仓库根目录启动静态服务器：python -m http.server 8734 --bind 127.0.0.1
//       并全局安装 puppeteer-core：npm install -g puppeteer-core
// 脚本会写入几条测试生词到 IndexedDB，然后走：列表→闪卡→翻面→自评→下一张→完成退出。
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://127.0.0.1:8734/';
let pass = 0, fail = 0;
const t = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844 });
page.on('console', m => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 120)); });
page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 150)));

// 1. 打开首页，等词典加载
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
await page.waitForFunction(() => document.querySelector('#dict-status')?.textContent.includes('就绪'), { timeout: 60000 }).catch(() => {});

// 2. 直接向 IndexedDB 写入测试生词（绕过 UI，快速造数据）
await page.evaluate(async () => {
  const words = [
    { word: 'perceive', ph: 'pə\'siːv', tr: 'vt. 察觉，理解', createdAt: Date.now() - 86400000, contexts: [{ sentence: 'We perceive the world through our senses.', bookTitle: '示例书' }] },
    { word: 'famished', ph: '\'fæmɪʃt', tr: 'adj. 极饿的', createdAt: Date.now() - 86400000, contexts: [{ sentence: 'After the long hike we were famished.', bookTitle: '示例书' }] },
    { word: 'bleat', ph: 'bliːt', tr: 'vi. 咩咩叫', createdAt: Date.now(), contexts: [{ sentence: 'The lamb began to bleat.', bookTitle: '示例书' }] },
  ];
  const req = indexedDB.open('engreader', 1);
  await new Promise((res, rej) => { req.onsuccess = res; req.onerror = () => rej(req.error); });
  const db = req.result;
  await new Promise((res, rej) => {
    const tx = db.transaction('words', 'readwrite');
    words.forEach(w => tx.objectStore('words').put(w));
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  db.close();
  return true;
});

// 3. 跳转生词本页
await page.evaluate(() => { location.hash = '#/words'; });
await new Promise(r => setTimeout(r, 800));

// 4. 模式切换按钮存在
const hasModeBtns = await page.evaluate(() => {
  const list = document.querySelector('#btn-mode-list');
  const flash = document.querySelector('#btn-mode-flash');
  return !!(list && flash && list.classList.contains('active'));
});
t('生词本页有「列表/闪卡」切换且默认列表激活', hasModeBtns);

// 5. 点击「闪卡」
await page.click('#btn-mode-flash');
await new Promise(r => setTimeout(r, 600));

const frontState = await page.evaluate(() => {
  const card = document.querySelector('#flash-card');
  const counter = document.querySelector('#fc-counter');
  const word = document.querySelector('.fc-word');
  return {
    cardVisible: card && !card.hidden,
    counter: counter?.textContent || '',
    word: word?.textContent || '',
    listPanelHidden: document.querySelector('#words-panel-list').hidden,
    flashPanelVisible: !document.querySelector('#words-panel-flash').hidden,
  };
});
t('闪卡面板显示、列表面板隐藏', frontState.flashPanelVisible && frontState.listPanelHidden);
t('卡片正面显示单词', frontState.cardVisible && frontState.word === 'bleat' || /^[a-z]+$/i.test(frontState.word || ''));
t('计数器格式 x / 3', /^\d+ \/ 3$/.test(frontState.counter));

// 6. 点击卡片翻面
await page.click('#flash-card');
await new Promise(r => setTimeout(r, 400));
const flippedState = await page.evaluate(() => {
  const card = document.querySelector('#flash-card');
  const tr = document.querySelector('.fc-tr');
  const ctx = document.querySelector('.fc-ctx');
  const rateBtns = document.querySelectorAll('.fc-rate-btn');
  return {
    flipped: card.classList.contains('flipped'),
    frontHidden: getComputedStyle(document.querySelector('.flash-front')).display === 'none',
    backVisible: getComputedStyle(document.querySelector('.flash-back')).display !== 'none',
    tr: tr?.textContent || '',
    ctx: ctx?.textContent || '',
    rateCount: rateBtns.length,
    frontWord: document.querySelector('.fc-word')?.textContent || '',
  };
});
t('翻面后 flipped 类生效、正面隐藏背面显示', flippedState.flipped && flippedState.frontHidden && flippedState.backVisible);
t('背面显示释义', (flippedState.tr || '').length > 0);
t('背面显示语境句子', (flippedState.ctx || '').length > 0);
t('背面有 3 个自评按钮（忘了/模糊/认识）', flippedState.rateCount === 3);

// 7. 点「认识」，应进入下一张且正面重置
const wordBefore = flippedState.frontWord;
await page.click('#flash-card .fc-rate-btn:last-child');
await new Promise(r => setTimeout(r, 500));
const afterState = await page.evaluate(() => {
  const card = document.querySelector('#flash-card');
  const word = document.querySelector('.fc-word');
  return {
    flipped: card.classList.contains('flipped'),
    word: word?.textContent || '',
    counter: document.querySelector('#fc-counter')?.textContent || '',
  };
});
t('自评后进入下一张（单词变化）', afterState.word !== '' && afterState.word !== wordBefore);
t('自评后卡片翻回正面', !afterState.flipped);
t('计数器前进', afterState.counter !== frontState.counter);

// 8. 连刷 3 张直到队列空，应退出闪卡回列表
for (let i = 0; i < 4; i++) {
  const cardVisible = await page.evaluate(() => !document.querySelector('#flash-card').hidden);
  if (!cardVisible) break;
  await page.click('#flash-card');
  await new Promise(r => setTimeout(r, 300));
  const rateVisible = await page.evaluate(() => document.querySelectorAll('.fc-rate-btn').length > 0);
  if (rateVisible) {
    await page.click('.fc-rate-btn:first-child');
    await new Promise(r => setTimeout(r, 400));
  }
}
const finalState = await page.evaluate(() => {
  const list = document.querySelector('#btn-mode-list');
  const flashPanel = document.querySelector('#words-panel-flash');
  return { listActive: list.classList.contains('active'), flashPanelHidden: flashPanel.hidden };
});
t('队列刷完自动回到列表模式', finalState.listActive && finalState.flashPanelHidden);

// 截图留档
await page.evaluate(() => { location.hash = '#/words'; });
await page.click('#btn-mode-flash');
await new Promise(r => setTimeout(r, 500));
await page.click('#flash-card');
await new Promise(r => setTimeout(r, 400));
await page.screenshot({ path: 'C:/Users/liusiying/WorkBuddy/2026-08-31-13-27-39/english-reading-assistant/.verify-flash-back.png' });

await browser.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
