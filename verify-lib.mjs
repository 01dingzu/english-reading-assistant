// verify-lib.mjs — 所有 verify-*.mjs 的公共骨架
//
// 为什么要抽这一层：
//   7 个 verify 脚本此前各自复制了同一套开端与结尾——解析 Chrome 路径 / 端口、
//   puppeteer.launch 参数、setViewport、goto、关掉新手引导遮罩、打印结果、收尾退出。
//   后果是「改一处要动七个文件」，而且「必须移除 #guide-overlay，否则 fixed 全屏遮罩
//   会吃掉所有点击」这类坑要在七个地方各写一遍注释，漏一处就是一次静默的假绿。
//
// 用法：
//   import { makeChecker, launchPage, removeGuide, finish } from './verify-lib.mjs';
//   const { t, state } = makeChecker();
//   const { browser, page, profile } = await launchPage({ collectErrors: errors });
//   await removeGuide(page);
//   t('某断言', true);
//   await finish({ browser, state, profile });
//
// 运行前提：python -m http.server 8891 常驻于项目根目录（或用 PAGE_URL 覆盖）；
//   脚本放在项目内、node_modules 为指向工作区依赖的目录联接时可直接 node verify-xxx.mjs。
//   可用环境变量覆盖：CHROME_PATH / PAGE_URL。
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 兼容三种传参习惯：环境变量 > 位置参数（node verify-x.mjs <chrome> <url>）> 默认值
export const CHROME = process.env.CHROME_PATH || process.argv[2]
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export const PAGE_URL = process.env.PAGE_URL || process.argv[3] || 'http://127.0.0.1:8891/';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 断言计数器。
 * @returns {{t: (name: string, ok: any, extra?: any) => void, state: {passed: number, failed: number, fails: string[]}}}
 */
export function makeChecker() {
  const state = { passed: 0, failed: 0, fails: [] };
  function t(name, ok, extra = '') {
    if (ok) { state.passed++; console.log(`  ✓ ${name}`); return; }
    state.failed++; state.fails.push(name);
    // extra 允许直接传对象：以前写 `${extra}` 会打出 [object Object]，排查时等于没有信息
    console.log(`  ✗ ${name} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
  }
  return { t, state };
}

/**
 * 起浏览器 + 打开被测页面，并装好页面前置。
 * @param {object} [opt]
 * @param {string[]} [opt.args]                追加的 Chromium 参数（与 --no-sandbox --disable-gpu 合并）
 * @param {string[]} [opt.ignoreDefaultArgs]   传给 puppeteer（例如测 Edge 神经音色要放开
 *                                             --disable-component-extensions-with-background-pages）
 * @param {boolean} [opt.cleanProfile]         true → 每次用全新临时档案目录，不带上一次跑的 IndexedDB
 * @param {string} [opt.profileName]           临时档案目录前缀
 * @param {{width:number,height:number}} [opt.viewport]  默认 390×844（手机竖屏）
 * @param {string[]} [opt.collectErrors]       传入数组 → 把 console.error / pageerror 收进数组；
 *                                             不传则直接打印到终端
 * @param {boolean} [opt.acceptDialogs]        confirm()/alert() 一律确认
 * @param {boolean} [opt.goto]                 false → 不自动 goto（脚本要自定义 timeout / 先等条件）
 * @param {number} [opt.waitAfter]             goto 之后先等多久（默认 1500ms）
 * @param {(page: import('puppeteer-core').Page) => any} [opt.setup]  goto 之前的页面配置
 *                                             （evaluateOnNewDocument / 事件监听等）
 * @returns {Promise<{browser: any, page: any, profile: string|null}>}
 */
export async function launchPage(opt = {}) {
  const {
    args = [],
    ignoreDefaultArgs = undefined,
    cleanProfile = false,
    profileName = 'engreader-verify-',
    viewport = { width: 390, height: 844 },
    collectErrors = null,
    acceptDialogs = false,
    goto = true,
    waitAfter = 1500,
    setup = null,
  } = opt;

  const profile = cleanProfile ? fs.mkdtempSync(path.join(os.tmpdir(), profileName)) : null;
  const launchOpt = {
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', ...args],
  };
  if (profile) launchOpt.userDataDir = profile;
  if (ignoreDefaultArgs) launchOpt.ignoreDefaultArgs = ignoreDefaultArgs;

  const browser = await puppeteer.launch(launchOpt);
  const page = await browser.newPage();

  if (collectErrors) {
    page.on('console', (m) => {
      if (m.type() === 'error') collectErrors.push('[console] ' + m.text().slice(0, 160));
    });
    page.on('pageerror', (e) => collectErrors.push(String(e).slice(0, 200)));
  } else {
    page.on('console', (m) => {
      if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 160));
    });
    page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 220)));
  }
  if (acceptDialogs) page.on('dialog', (d) => d.accept());
  if (setup) await setup(page);

  await page.setViewport(viewport);
  if (goto) {
    await page.goto(PAGE_URL, { waitUntil: 'networkidle2' });
    await sleep(waitAfter);
  }
  return { browser, page, profile };
}

/**
 * 等应用真正可用：词典就绪（+ 内置书已上架）。
 *
 * 各脚本以前都靠一个固定 sleep（1500~2600ms）赌这件事。首屏要拉 3.8MB 的 dict.json，
 * 机器/磁盘慢一点就赌输，而赌输的表现不是报错而是「后面所有 UI 断言集体找不到元素」——
 * 排查时会以为是功能坏了。等真实信号，别等时间。
 */
export async function waitAppReady(page, { timeout = 60000, needBooks = true, poll = 250 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await page
      .evaluate((wantBooks) => ({
        dict: document.querySelector('#dict-status')?.textContent || '(无 #dict-status)',
        books: document.querySelectorAll('.book-card').length,
        wantBooks,
      }), needBooks)
      .catch((e) => ({ error: String(e).slice(0, 120) }));
    if (!last.error && /就绪/.test(last.dict) && (!needBooks || last.books > 0)) return true;
    await sleep(poll);
  }
  // 超时不抛异常，但必须留下「卡在哪一步」的现场，否则后面一串「找不到元素」会让人以为是功能坏了
  console.log(`  [就绪等待超时 ${timeout}ms] ` + JSON.stringify(last));
  return false;
}

/**
 * 移除新手指引遮罩。它是 position:fixed; inset:0，不移除会吃掉后面所有 page.click。
 * 只清遮罩本身（#guide-overlay），不要用 [class*=guide] 广撒网——那会把顶栏的
 * 「?」按钮（class="btn-guide"）一起删掉。
 */
export async function removeGuide(page) {
  await page.evaluate(() => {
    document.querySelectorAll('#guide-overlay').forEach((n) => n.remove());
  });
}

/** 页面当前用的 Chrome 版本（各脚本开头打一行，便于对照「这条结论是在哪个浏览器上得的」） */
export async function browserTag(page) {
  return page.evaluate(() => navigator.userAgent.replace(/^.*(Chrome\/[\d.]+).*$/, '$1'));
}

/**
 * 收尾：关浏览器 → 清临时档案 → 打印结果与失败项 → 按失败数决定退出码。
 * @param {{browser?: any, state: {passed:number,failed:number,fails:string[]}, profile?: string|null, preClose?: () => any}} opt
 */
export async function finish({ browser, state, profile = null, preClose = null }) {
  // preClose 的返回值不一定是 Promise（http.Server.close() 返回的是 server 自己），
  // 所以不能直接 .catch()，否则收尾阶段会崩在断言之后、把结果刷不出来。
  if (preClose) { try { await preClose(); } catch (e) { /* 收尾失败不掩盖断言结果 */ } }
  if (browser) await browser.close().catch(() => {});
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
  console.log(`\n结果: ${state.passed} 通过, ${state.failed} 失败`);
  if (state.fails.length) console.log('失败项：\n  - ' + state.fails.join('\n  - '));
  process.exit(state.failed ? 1 : 0);
}
