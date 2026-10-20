// verify-review.mjs — 端到端验证「复习」入口：点开始 → 出题 → 判分 → 自评 → 下一题 → 结束
//
// 为什么要专门有一个：`#btn-start-review` 曾经完全点不动——`review.js` 的 startSession()
// 里残留了一句 `answered = false;`，而这个变量在重构后只存在于 app.js。赋值一个未声明的
// 标识符直接抛 ReferenceError，`startSession()` 半途中断，按钮看起来"没反应"（没有报错框、
// 没有 toast，只有控制台里一行）。整个复习功能因此静默失效，而当时所有 verify 脚本都不覆盖它。
//
// 前置：项目根目录常驻 `python -m http.server 8891 --bind 127.0.0.1`
import { fileURLToPath } from 'node:url';
import { makeChecker, launchPage, removeGuide, waitAppReady, finish, sleep } from './verify-lib.mjs';

const { t, state } = makeChecker();
const errors = [];

const { browser, page } = await launchPage({ goto: false, collectErrors: errors });
await page.goto(process.env.PAGE_URL || 'http://127.0.0.1:8891/', { waitUntil: 'networkidle2', timeout: 30000 });
await waitAppReady(page, { needBooks: false });
await removeGuide(page);
await sleep(300);

// ---- 1. 造 10 个未复习词（比单轮 8 个上限多，顺带验证截断）----
const SEED = 10;
await page.evaluate(async (n) => {
  const req = indexedDB.open('engreader');       // 不带版本号，避免 VersionError
  await new Promise((res, rej) => { req.onsuccess = res; req.onerror = () => rej(req.error); });
  const db = req.result;
  await new Promise((res, rej) => {
    const tx = db.transaction('words', 'readwrite');
    const store = tx.objectStore('words');
    for (let i = 0; i < n; i++) {
      store.put({
        word: ['perceive', 'famished', 'bleat', 'glisten', 'quarry', 'moor', 'thicket', 'ford', 'sedge', 'loam'][i],
        ph: '', tr: '测试释义', createdAt: Date.now() - i * 1000,
        contexts: [{ sentence: `This is a test sentence for word number ${i}.`, bookTitle: '测试书' }],
        status: 'new', srs: null,
      });
    }
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  db.close();
  return true;
}, SEED);

// ---- 2. 进复习页，统计应显示待复习数 ----
await page.evaluate(() => { location.hash = '#/review'; });
await sleep(700);
const home = await page.evaluate(() => ({
  stats: document.querySelector('#review-stats')?.textContent || '',
  disabled: document.querySelector('#btn-start-review')?.disabled,
}));
t('复习页显示「今日待复习」统计', /今日待复习/.test(home.stats), home.stats);
t('有词时「开始复习」按钮可用', home.disabled === false, { disabled: home.disabled });

// ---- 3. 真实坐标点击「开始复习」（核心回归）----
const btnRect = await page.evaluate(() => {
  const r = document.querySelector('#btn-start-review').getBoundingClientRect();
  const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return { w: r.width, h: r.height, hitId: el?.id, hitCls: el?.className };
});
t('按钮没有被遮挡层盖住', btnRect.hitId === 'btn-start-review' || String(btnRect.hitCls).includes('btn'), btnRect);

await page.click('#btn-start-review');
await sleep(900);

const started = await page.evaluate(() => ({
  homeHidden: document.querySelector('#review-home').hidden,
  sessionHidden: document.querySelector('#review-session').hidden,
  hasInput: !!document.querySelector('#review-card .rv-input'),
  counter: document.querySelector('#rv-counter')?.textContent || '',
  mode: document.querySelector('#review-card .rv-mode')?.textContent || '',
}));
t('点击后会话区显示、首页隐藏', started.homeHidden === true && started.sessionHidden === false, started);
t('出了第一道题（有输入框）', started.hasInput === true);
t('计数器为 1 / N', /^1 \/ \d+$/.test(started.counter), started.counter);
t('题型只出语境填空（听音拼写已移除）', /语境填空|释义提示/.test(started.mode) && !/听音|拼写/.test(started.mode), started.mode);
t('新词超过 8 个时单轮被截断（N ≤ 20）', Number(started.counter.split('/')[1].trim()) <= 20, started.counter);

// ---- 4. 故意答错 → 应显示正确答案 + 三个自评键 ----
await page.click('#review-card .rv-input');
await page.type('#review-card .rv-input', 'zzzzwrong');
await page.click('#rv-submit');
await sleep(500);
const graded = await page.evaluate(() => ({
  wrongShown: (document.querySelector('.rv-result')?.textContent || ''),
  isBad: !!document.querySelector('.rv-result.bad'),
  rateBtns: document.querySelectorAll('#review-card .review-actions .btn').length,
  trShown: (document.querySelector('.rv-result .ans-tr')?.textContent || '').length > 0,
}));
t('答错后显示「正确答案」', graded.isBad && /正确答案/.test(graded.wrongShown), graded.wrongShown.slice(0, 40));
t('答错后带出释义', graded.trShown);
t('出现三个自评键（忘了/犹豫/记得）', graded.rateBtns === 3, { n: graded.rateBtns });

// ---- 5. 自评「记得」→ 下一题 ----
const counterBefore = started.counter;
await page.click('#review-card .review-actions .btn:last-child');
await sleep(700);
const next = await page.evaluate(() => ({
  counter: document.querySelector('#rv-counter')?.textContent || '',
  hasInput: !!document.querySelector('#review-card .rv-input'),
  hasResult: !!document.querySelector('.rv-result'),
}));
t('自评后进入下一题（计数器前进）', next.counter !== counterBefore && next.counter.startsWith('2 /'), next.counter);
t('新一题是干净的（无上题判分残留）', next.hasInput && !next.hasResult);

// ---- 6. 已评分词写入了 srs ----
const srsWritten = await page.evaluate(async () => {
  const req = indexedDB.open('engreader');
  await new Promise((res, rej) => { req.onsuccess = res; req.onerror = () => rej(req.error); });
  const db = req.result;
  const rows = await new Promise((res) => {
    const rq = db.transaction('words').objectStore('words').getAll();
    rq.onsuccess = () => res(rq.result);
  });
  db.close();
  return rows.filter(r => r.srs && r.srs.reps > 0).length;
});
t('自评后词条写入了 SM-2 进度（srs.reps > 0）', srsWritten >= 1, { srsWritten });

// ---- 7. 一路「跳过」到队列空 → 回到复习首页 ----
for (let i = 0; i < 25; i++) {
  const inSession = await page.evaluate(() => !document.querySelector('#review-session').hidden);
  if (!inSession) break;
  await page.click('#rv-skip');
  await sleep(250);
}
const ended = await page.evaluate(() => ({
  homeHidden: document.querySelector('#review-home')?.hidden,
  sessionHidden: document.querySelector('#review-session')?.hidden,
}));
t('队列走完后自动退回复习首页', ended.homeHidden === false && ended.sessionHidden === true, ended);

// ---- 8. 全程无 JS 异常（这条才是那个 bug 的真正捕获点）----
t('全程无 pageerror / console.error', errors.length === 0, errors.slice(0, 4));

await page.screenshot({ path: fileURLToPath(new URL('./_shots/review-verify.png', import.meta.url)) }).catch(() => {});
await finish({ browser, state });
