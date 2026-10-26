// verify-weekly.mjs — 周回顾 / 周开始 两种模式
// 前置：仓库根目录常驻 python -m http.server 8891
import { makeChecker, launchPage, PAGE_URL, sleep, finish } from './verify-lib.mjs';

const { t, state } = makeChecker();
const BASE = new URL('./weekly/', PAGE_URL).href;

const { browser, page } = await launchPage({ goto: false });

// 先造一点「她这周的数据」，否则统计全是 0/—，断言没有区分度
await page.goto(PAGE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
await page.waitForFunction(() => document.querySelector('#dict-status')?.textContent.includes('就绪'), { timeout: 60000 }).catch(() => {});
await page.evaluate(async () => {
  for (let i = 0; i < 60; i++) {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('engreader');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const ok = db.objectStoreNames.contains('words');
    if (ok) {
      await new Promise((res, rej) => {
        const tx = db.transaction(['words', 'kv'], 'readwrite');
        const ws = tx.objectStore('words');
        ws.put({ word: 'adapt', tr: '适应', day: 3, createdAt: Date.now(), contexts: [] });
        ws.put({ word: 'thrive', tr: '繁荣', day: 3, createdAt: Date.now(), contexts: [] });
        ws.put({ word: 'pigeon', tr: '鸽子', day: 1, createdAt: Date.now(), contexts: [] });
        const kv = tx.objectStore('kv');
        kv.put({ key: 'read.timer.1', value: { day: 1, words: 434, ms: 300000, wpm: 87, at: Date.now() } });
        kv.put({ key: 'read.timer.3', value: { day: 3, words: 491, ms: 192000, wpm: 153, at: Date.now() } });
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      db.close();
      return;
    }
    db.close();
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('words store 没出现');
});

// ---------- 周回顾 ----------
await page.goto(BASE + '?week=1', { waitUntil: 'networkidle2' });
await page.waitForFunction(() => !document.querySelector('#w-review')?.hidden, { timeout: 15000 }).catch(() => {});

const review = await page.evaluate(() => ({
  visible: !document.querySelector('#w-review').hidden,
  err: document.querySelector('#w-error')?.hidden === false ? document.querySelector('#w-error').textContent : '',
  kicker: document.querySelector('#r-kicker')?.textContent || '',
  theme: document.querySelector('#r-theme')?.textContent || '',
  sub: document.querySelector('#r-sub')?.textContent || '',
  stats: document.querySelectorAll('#r-stats .w-stat').length,
  items: document.querySelectorAll('.r-item').length,
  firstHref: document.querySelector('.r-item')?.getAttribute('href') || '',
  wpms: [...document.querySelectorAll('.r-item .meta b')].map(x => x.textContent),
  chips: document.querySelectorAll('#r-words .r-chip').length,
  chipsHave: document.querySelectorAll('#r-words .r-chip.have').length,
  closing: document.querySelectorAll('#r-closing li').length,
  nextHref: document.querySelector('#r-next')?.getAttribute('href') || '',
  nextTitle: document.querySelector('#r-next-title')?.textContent || '',
}));

t('周回顾渲染成功', review.visible, review.err);
t('标题含周号与主题', /W01/.test(review.kicker) && /城市里的鸟/.test(review.theme), `${review.kicker} / ${review.theme}`);
t('副标题含篇数与词数', /6 篇/.test(review.sub) && /词/.test(review.sub), review.sub);
t('统计卡 4 个', review.stats === 4, review.stats);
t('文章行 6 条', review.items === 6, review.items);
t('文章行链到对应 daily 页', /daily\/\?day=\d+/.test(review.firstHref), review.firstHref);
t('已计时的篇显示 wpm（87 / 153）', review.wpms.includes('87 wpm') && review.wpms.includes('153 wpm'), review.wpms.join(','));
t('词汇场渲染出词条', review.chips >= 12, review.chips);
t('已收的词被高亮（adapt/thrive/pigeon）', review.chipsHave >= 2, review.chipsHave);
t('收尾问题有内容', review.closing >= 1, review.closing);
t('下周入口指向 ?week=3 且带 mode=start', review.nextHref === '?week=3&mode=start' && /大型哺乳动物/.test(review.nextTitle),
  `${review.nextHref} / ${review.nextTitle}`);

// ---------- 周开始 ----------
await page.goto(BASE + '?week=2', { waitUntil: 'networkidle2' });
await page.waitForFunction(() => !document.querySelector('#w-preview')?.hidden, { timeout: 15000 }).catch(() => {});

const preview = await page.evaluate(() => ({
  visible: !document.querySelector('#w-preview').hidden,
  err: document.querySelector('#w-error')?.hidden === false ? document.querySelector('#w-error').textContent : '',
  opts: document.querySelectorAll('.p-opt').length,
  chosenId: document.querySelector('.p-opt.on')?.dataset.id || '',
  angles: document.querySelectorAll('.p-angle').length,
  words: document.querySelectorAll('#p-words .r-chip').length,
  btn: document.querySelector('#p-confirm')?.textContent || '',
}));
t('周开始渲染成功', preview.visible, preview.err);
t('三个候选主题', preview.opts === 3, preview.opts);
t('默认选中原定主题 migration', preview.chosenId === 'migration', preview.chosenId);
t('展开五个切口', preview.angles === 5, preview.angles);
t('显示该主题的核心词', preview.words >= 10, preview.words);

// 换一个：点第二个候选（城市的夜）
await page.evaluate(() => { document.querySelectorAll('.p-opt')[1].click(); });
await sleep(300);
const switched = await page.evaluate(() => ({
  chosenId: document.querySelector('.p-opt.on')?.dataset.id || '',
  angles: document.querySelectorAll('.p-angle').length,
  btnDisabled: document.querySelector('#p-confirm')?.disabled,
}));
t('点击可切换候选', switched.chosenId === 'citynight', switched.chosenId);
t('切换后切口跟着换（仍是 5 条）', switched.angles === 5, switched.angles);
t('切换后确认按钮可用', switched.btnDisabled === false);

// 确认
await page.click('#p-confirm');
await sleep(700);
const saved = await page.evaluate(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('engreader'); r.onsuccess = () => res(r.result); });
  const rec = await new Promise((res) => {
    const rq = db.transaction('kv', 'readonly').objectStore('kv').get('week.choice.W02');
    rq.onsuccess = () => res(rq.result);
  });
  db.close();
  return { id: rec?.value?.id || '', hint: document.querySelector('#p-hint')?.textContent || '' };
});
t('选择写入 kv（week.choice.W02）', saved.id === 'citynight', saved.id);
t('页面给出确认反馈', /下周按/.test(saved.hint), saved.hint);

// 刷新回显
await page.reload({ waitUntil: 'networkidle2' });
await page.waitForFunction(() => !document.querySelector('#w-preview')?.hidden, { timeout: 15000 }).catch(() => {});
const echo = await page.evaluate(() => ({
  chosenId: document.querySelector('.p-opt.on')?.dataset.id || '',
  hint: document.querySelector('#p-hint')?.textContent || '',
}));
t('重新打开回显上次选择', echo.chosenId === 'citynight' && /上次选的是/.test(echo.hint), `${echo.chosenId} / ${echo.hint}`);

// ---------- 提醒用的两个强制模式 ----------
// 周一 10:00 提醒走 mode=start；即使这周还没开工也必须出预告
await page.goto(BASE + '?week=2&mode=start', { waitUntil: 'networkidle2' });
await page.waitForFunction(() => !document.querySelector('#w-preview')?.hidden || !document.querySelector('#w-error')?.hidden, { timeout: 15000 }).catch(() => {});
const forcedStart = await page.evaluate(() => ({
  preview: !document.querySelector('#w-preview').hidden,
  err: document.querySelector('#w-error')?.hidden === false ? document.querySelector('#w-error').textContent : '',
  opts: document.querySelectorAll('.p-opt').length,
}));
t('mode=start 强制走预告', forcedStart.preview, forcedStart.err);
t('W02 有三个候选（本周开始）', forcedStart.opts === 3, forcedStart.opts);

// 周五 14:00 提醒走 mode=review；这周一篇没读也要给回顾页，不能跳成预告
await page.goto(BASE + '?week=2&mode=review', { waitUntil: 'networkidle2' });
await page.waitForFunction(() => !document.querySelector('#w-review')?.hidden || !document.querySelector('#w-error')?.hidden, { timeout: 15000 }).catch(() => {});
const forcedReview = await page.evaluate(() => ({
  review: !document.querySelector('#w-review').hidden,
  err: document.querySelector('#w-error')?.hidden === false ? document.querySelector('#w-error').textContent : '',
  sub: document.querySelector('#r-sub')?.textContent || '',
  theme: document.querySelector('#r-theme')?.textContent || '',
}));
t('mode=review 强制走回顾', forcedReview.review, forcedReview.err);
t('零篇时给出平实文案而不是崩掉',
  /还没有阅读记录/.test(forcedReview.sub), forcedReview.sub);
t('零篇时主题仍在（W02 迁徙）', /迁徙/.test(forcedReview.theme), forcedReview.theme);

// ---------- 没有详细文件的周：退化成 52 周地图 ----------
await page.goto(BASE + '?week=9&mode=start', { waitUntil: 'networkidle2' });
await page.waitForFunction(() => !document.querySelector('#w-preview')?.hidden || !document.querySelector('#w-error')?.hidden, { timeout: 15000 }).catch(() => {});
const fallback = await page.evaluate(() => ({
  preview: !document.querySelector('#w-preview').hidden,
  err: document.querySelector('#w-error')?.hidden === false ? document.querySelector('#w-error').textContent : '',
  ttl: document.querySelector('.p-opt .ttl')?.textContent || '',
  note: document.querySelector('#p-intro')?.textContent || '',
}));
t('W09 没有详解文件也不 404', fallback.preview && !fallback.err, fallback.err);
t('回落到 52 周地图的主题（板块 · 地震与山脉）',
  /板块/.test(fallback.ttl) && /地震与山脉/.test(fallback.ttl), fallback.ttl);
t('明确说明详细预告还没写', /详细预告还没写/.test(fallback.note), fallback.note);

// ---------- 不带参数默认走 current ----------
await page.goto(BASE, { waitUntil: 'networkidle2' });
await page.waitForFunction(
  () => !document.querySelector('#w-preview')?.hidden || !document.querySelector('#w-error')?.hidden,
  { timeout: 15000 }).catch(() => {});
const dflt = await page.evaluate(() => ({
  preview: !document.querySelector('#w-preview').hidden,
  kicker: document.querySelector('#p-kicker')?.textContent || '',
}));
t('不带参数时默认打开 current 周（W02）', dflt.preview && /W02/.test(dflt.kicker), dflt.kicker);

await page.screenshot({ path: 'C:/Users/liusiying/WorkBuddy/2026-10-19-14-26-33/_shot-week.png', fullPage: true });
await finish({ browser, state });
