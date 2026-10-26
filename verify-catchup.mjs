// verify-catchup.mjs — 验证「补齐生词」页面：统计 → 导入 → 落库 → 幂等
// 前置：仓库根目录常驻 python -m http.server 8891
import { makeChecker, launchPage, PAGE_URL, sleep, finish } from './verify-lib.mjs';

const { t, state } = makeChecker();
const CATCHUP = new URL('./catchup/', PAGE_URL).href;

const { browser, page } = await launchPage({ goto: false });

await page.goto(CATCHUP, { waitUntil: 'networkidle2', timeout: 30000 });
await page.waitForFunction(() => !document.querySelector('#c-body')?.hidden, { timeout: 15000 }).catch(() => {});

const initial = await page.evaluate(() => ({
  bodyVisible: !document.querySelector('#c-body')?.hidden,
  err: document.querySelector('#c-error')?.hidden === false
    ? document.querySelector('#c-error').textContent : '',
  total: Number(document.querySelector('#c-total')?.textContent),
  fresh: Number(document.querySelector('#c-new')?.textContent),
  have: Number(document.querySelector('#c-have')?.textContent),
  groups: document.querySelectorAll('.c-group').length,
  btn: document.querySelector('#c-go')?.textContent || '',
  btnDisabled: document.querySelector('#c-go')?.disabled,
}));

t('页面读到了补词包', initial.bodyVisible && initial.total > 0, initial.err || `total=${initial.total}`);
t('空库里全部计入「将新增」', initial.fresh === initial.total && initial.have === 0,
  `fresh=${initial.fresh} have=${initial.have}`);
t('按篇分组渲染（6 篇）', initial.groups === 6, initial.groups);
t('按钮文案带数量', /导入 \d+ 个词/.test(initial.btn), initial.btn);

// 点导入
await page.click('#c-go');
await page.waitForFunction(() => !document.querySelector('#c-done')?.hidden, { timeout: 30000 }).catch(() => {});
await sleep(400);

const done = await page.evaluate(() => ({
  doneVisible: !document.querySelector('#c-done')?.hidden,
  added: Number(document.querySelector('#c-added')?.textContent),
  bodyHidden: document.querySelector('#c-body')?.hidden,
}));
t('导入完成页出现', done.doneVisible && done.bodyHidden);
t('完成页数量与将新增一致', done.added === initial.fresh, `added=${done.added} fresh=${initial.fresh}`);

const stored = await page.evaluate(async () => {
  const req = indexedDB.open('engreader');
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const all = await new Promise((res, rej) => {
    const rq = db.transaction('words', 'readonly').objectStore('words').getAll();
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
  });
  db.close();
  return {
    count: all.length,
    hasHydrophone: all.some(w => w.word === 'hydrophone'),
    hasContext: all.filter(w => (w.contexts || []).length).length,
    hasPh: all.filter(w => w.ph).length,
    noSrs: all.filter(w => !w.srs).length,
  };
});
t('全部词落进 IndexedDB', stored.count === initial.total, stored.count);
t('抽查 hydrophone 命中', stored.hasHydrophone);
t('每条都带语境句', stored.hasContext === stored.count, `${stored.hasContext}/${stored.count}`);
t('都带音标', stored.hasPh === stored.count, `${stored.hasPh}/${stored.count}`);
t('补词包里的词都是「未复习」状态（srs 为空）', stored.noSrs === stored.count, stored.noSrs);

// 幂等：重新打开，应全部显示「已有」且按钮禁用
await page.reload({ waitUntil: 'networkidle2' });
await page.waitForFunction(() => !document.querySelector('#c-body')?.hidden, { timeout: 15000 }).catch(() => {});
const again = await page.evaluate(() => ({
  fresh: Number(document.querySelector('#c-new')?.textContent),
  have: Number(document.querySelector('#c-have')?.textContent),
  btnDisabled: document.querySelector('#c-go')?.disabled,
  btn: document.querySelector('#c-go')?.textContent || '',
}));
t('重复进入：新增 0、全部标为已有', again.fresh === 0 && again.have === initial.total,
  `fresh=${again.fresh} have=${again.have}`);
t('重复进入：按钮禁用并说明', again.btnDisabled && /都已经在词库/.test(again.btn), again.btn);

await page.screenshot({ path: './.verify-catchup.png', fullPage: true });
await finish({ browser, state });
