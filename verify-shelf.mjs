// verify-shelf.mjs — 验证书架 / 阅读合并后的导航
// 运行前提：python -m http.server 8891 常驻于项目根目录；脚本在 node workspace 下运行（有 puppeteer-core）
//
// 覆盖：
//   底部标签收敛为 3 个（书架 / 生词本 / 复习），「阅读」不再是平行标签
//   书架点书 → 正文（底部高亮「书架」）→「← 书架」返回
//   书架顶部「继续阅读」卡：首次不显示 → 读过后出现 → 记住章节 → 点它回到书里 → 换章跟着更新 → 删书自动收起
//   #/read（无书号）不再是一条死路
import { makeChecker, launchPage, removeGuide, finish, sleep, waitAppReady } from './verify-lib.mjs';

const { t, state } = makeChecker();

// 干净档案：不带上一次跑测试残留的 lastRead / 已导入书籍
const errors = [];
const { browser, page, profile } = await launchPage({
  cleanProfile: true,
  profileName: 'engreader-shelf-',
  collectErrors: errors,
  acceptDialogs: true,
});
await removeGuide(page);

// 等内置书预载完（词典加载 + 导入，需要几秒）
await waitAppReady(page);
const bookCount = await page.evaluate(() => document.querySelectorAll('.book-card').length);
t('书架已预装书', bookCount > 0, `${bookCount} 本`);

// ---------- A. 底部标签 ----------
const nav = await page.evaluate(() => ({
  tabs: [...document.querySelectorAll('#tabbar a')].map(a => a.dataset.tab),
  labels: [...document.querySelectorAll('#tabbar a')].map(a => a.lastElementChild.textContent.trim()),
  readLinks: [...document.querySelectorAll('#tabbar a')].filter(a => a.getAttribute('href') === '#/read').length,
}));
t('底部只剩 3 个标签', nav.tabs.length === 3, nav.tabs.join(' / '));
t('标签是 书架 / 生词本 / 复习', nav.labels.join(' / ') === '书架 / 生词本 / 复习', nav.labels.join(' / '));
t('不再有指向 #/read 的标签（那个死路入口已移除）', !nav.tabs.includes('reader') && nav.readLinks === 0, JSON.stringify(nav));

// ---------- B. 没读过任何书时不显示「继续阅读」 ----------
const fresh = await page.evaluate(() => {
  const box = document.querySelector('#shelf-continue');
  return { hidden: box.hidden, has: !!box.querySelector('.continue-card') };
});
t('没读过书时不显示「继续阅读」', fresh.hidden === true && !fresh.has, JSON.stringify(fresh));

// ---------- C. 点书卡 → 正文 ----------
// 挑一本有多章的书，方便后面验证「换章后卡片跟着更新」
const opened = await page.evaluate(async () => {
  const { books } = await import('./js/db.js');
  const list = await books.all();
  const target = list.find(b => (b.chCount || 1) >= 2) || list[0];
  const card = [...document.querySelectorAll('.book-card')]
    .find(c => c.querySelector('.book-title').textContent === target.title);
  card.click();
  return { title: target.title, chCount: target.chCount };
});
await sleep(1600);
const inReader = await page.evaluate(() => ({
  readerActive: document.querySelector('#view-reader').classList.contains('active'),
  shelfActive: document.querySelector('#view-shelf').classList.contains('active'),
  rdTitle: document.querySelector('#rd-title').textContent,
  chPos: document.querySelector('#ch-pos').textContent,
  activeTab: document.querySelector('#tabbar a.active')?.dataset.tab || '',
  pageTitle: document.querySelector('#page-title').textContent,
  hash: location.hash,
}));
t('点书卡直接进入正文（不需要先切「阅读」标签）', inReader.readerActive && !inReader.shelfActive, JSON.stringify(inReader));
t('正文显示的就是点的那本书', inReader.rdTitle === opened.title, `${inReader.rdTitle} ≠ ${opened.title}`);
t('正文页底部高亮「书架」（下钻关系，不是平行标签）', inReader.activeTab === 'shelf', inReader.activeTab);
t('顶栏标题切到「阅读」', inReader.pageTitle === '阅读', inReader.pageTitle);

// ---------- D. 「← 书架」返回 → 出现继续阅读卡 ----------
await page.evaluate(() => document.querySelector('#btn-back').click());
await sleep(1000);
const cont = await page.evaluate(() => {
  const box = document.querySelector('#shelf-continue');
  const card = box.querySelector('.continue-card');
  return {
    hidden: box.hidden,
    title: card?.querySelector('.continue-title')?.textContent || '',
    kicker: card?.querySelector('.continue-k')?.textContent || '',
    meta: card?.querySelector('.continue-meta')?.textContent || '',
    hash: location.hash,
    shelfActive: document.querySelector('#view-shelf').classList.contains('active'),
    pageTitle: document.querySelector('#page-title').textContent,
  };
});
t('「← 书架」真的回到书架（hash 与视图都对了）',
  cont.shelfActive && cont.hash === '#/shelf' && cont.pageTitle === '书架', JSON.stringify(cont));
t('书架顶部出现「继续阅读」卡', cont.hidden === false && !!cont.title, JSON.stringify(cont));
t('卡片指向刚才读的那本书', cont.title === opened.title, `${cont.title} ≠ ${opened.title}`);
t('卡片标出章节位置', /^第 \d+ \/ \d+ 章/.test(cont.meta), cont.meta);

const aboveGrid = await page.evaluate(() => {
  const box = document.querySelector('#shelf-continue');
  const grid = document.querySelector('#shelf-grid');
  return box.getBoundingClientRect().bottom <= grid.getBoundingClientRect().top + 1;
});
t('卡片在书卡网格之前（书架最顶部）', aboveGrid);

// ---------- E. 点卡片回到书里 → 换章 → 卡片跟着更新 ----------
await page.evaluate(() => document.querySelector('#continue-card').click());
await sleep(1500);
const beforeCh = await page.evaluate(() => document.querySelector('#ch-pos').textContent);
await page.evaluate(() => document.querySelector('#btn-next-ch').click());
await sleep(1000);
const afterCh = await page.evaluate(() => document.querySelector('#ch-pos').textContent);
await page.evaluate(() => document.querySelector('#btn-back').click());
await sleep(1000);
const cont2 = await page.evaluate(() => ({
  meta: document.querySelector('.continue-meta')?.textContent || '',
}));
t('点卡片能从书架回到书里', /^\d+ \/ \d+$/.test(beforeCh), beforeCh);
t('「下一章」切章成功', afterCh !== beforeCh, `${beforeCh} → ${afterCh}`);
t('换章后卡片章号同步更新',
  cont2.meta.startsWith(`第 ${afterCh.split('/')[0].trim()} /`), `${cont2.meta} ← 当前 ${afterCh}`);

// ---------- F. 刷新后位置还在 ----------
await page.reload({ waitUntil: 'networkidle2' });
await sleep(2200);
await page.evaluate(() => document.querySelectorAll('#guide-overlay').forEach(n => n.remove()));
const afterReload = await page.evaluate(() => ({
  has: !!document.querySelector('#continue-card'),
  meta: document.querySelector('.continue-meta')?.textContent || '',
}));
t('刷新后「继续阅读」仍在（位置已持久化）',
  afterReload.has && afterReload.meta === cont2.meta, JSON.stringify(afterReload));

// ---------- G. #/read 无书号不再落进死路 ----------
await page.evaluate(() => { location.hash = '#/read'; });
await sleep(1000);
const dangling = await page.evaluate(() => ({
  hash: location.hash,
  shelfActive: document.querySelector('#view-shelf').classList.contains('active'),
  readerActive: document.querySelector('#view-reader').classList.contains('active'),
  pageTitle: document.querySelector('#page-title').textContent,
  activeTab: document.querySelector('#tabbar a.active')?.dataset.tab || '',
}));
t('#/read（无书号）落到书架，不再是「亮着阅读、显示书架」的死路',
  dangling.shelfActive && !dangling.readerActive && dangling.activeTab === 'shelf', JSON.stringify(dangling));
t('hash 被纠正为 #/shelf', dangling.hash === '#/shelf' && dangling.pageTitle === '书架', JSON.stringify(dangling));

// ---------- H. 打开不存在的书不崩 ----------
await page.evaluate(() => { location.hash = '#/read/999999'; });
await sleep(1200);
const bogus = await page.evaluate(() => ({
  alive: !!document.querySelector('#tabbar'),
  hash: location.hash,
  toast: document.querySelector('#toast')?.hidden === false
    ? document.querySelector('#toast').textContent : '',
}));
t('打开不存在的书号不会崩（提示后页面仍可交互）',
  bogus.alive && /不存在/.test(bogus.toast), JSON.stringify(bogus));
await page.evaluate(() => { location.hash = '#/shelf'; });
await sleep(900);

// ---------- I. 删掉那本书 → 卡片自动收起 ----------
const deleted = await page.evaluate(() => {
  const title = document.querySelector('.continue-title')?.textContent || '';
  const card = [...document.querySelectorAll('.book-card')]
    .find(c => c.querySelector('.book-title').textContent === title);
  card.querySelector('.book-del').click();
  return title;
});
await sleep(1400);
const gone = await page.evaluate(() => {
  const box = document.querySelector('#shelf-continue');
  return { hidden: box.hidden, has: !!box.querySelector('.continue-card') };
});
t('删掉那本书后「继续阅读」卡自动收起',
  gone.hidden === true && !gone.has, `${deleted} → ${JSON.stringify(gone)}`);

t('整个过程没有脚本报错', errors.length === 0, errors.slice(0, 3).join(' | '));

await finish({ browser, state, profile });
