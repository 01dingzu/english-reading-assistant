// catchup.js — 把「补词包」写进 IndexedDB 的一次性页面
//
// 为什么单独做一个页面，而不是让用户下载 JSON 再去「导入备份」选文件：
// 1. 这个页面和 App 同源（都在 01dingzu.github.io/english-reading-assistant/），
//    所以能直接操作同一个 IndexedDB 库；换成本地 file:// 就读不到她的词。
// 2. 少两步操作：不用下载、不用找文件选择器。
// 3. 只 import db.js，不 import app.js —— 后者会连带拉起 TTS、词典、路由一整套。
//
// 导入语义与 app.js 的 importBackup 一致：已存在的词直接跳过，绝不覆盖 srs。

import { words, kv } from '../js/db.js';

const $ = (s) => document.querySelector(s);
const PACK_DIR = '../data/catchup/';

let allWords = [];       // 合并去重后的补词包内容
let haveSet = new Set(); // 本地已有的词

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function fail(msg) {
  $('#c-loading').hidden = true;
  const box = $('#c-error');
  box.hidden = false;
  box.textContent = msg;
}

async function loadPacks() {
  const res = await fetch(PACK_DIR + 'index.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`找不到补词包清单（HTTP ${res.status}）`);
  const idx = await res.json();

  const merged = new Map();
  for (const item of idx.packs || []) {
    const r = await fetch(PACK_DIR + item.file, { cache: 'no-store' });
    if (!r.ok) continue;
    const data = await r.json();
    for (const rec of data.words || []) {
      if (!rec || typeof rec.word !== 'string') continue;
      const key = rec.word.toLowerCase();
      if (merged.has(key)) continue;
      merged.set(key, { ...rec, word: key });
    }
  }
  return [...merged.values()].sort(
    (a, b) => (a.day || 0) - (b.day || 0) || a.word.localeCompare(b.word)
  );
}

function render() {
  const fresh = allWords.filter((w) => !haveSet.has(w.word));
  const have = allWords.length - fresh.length;

  $('#c-total').textContent = allWords.length;
  $('#c-new').textContent = fresh.length;
  $('#c-have').textContent = have;

  // 按篇分组
  const groups = new Map();
  for (const w of allWords) {
    const key = w.day || 0;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  }

  const list = $('#c-list');
  list.innerHTML = '';
  for (const [day, ws] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const bookTitle = (ws[0].contexts?.[0]?.bookTitle || '').split(' · ')[0];
    const g = document.createElement('div');
    g.className = 'c-group';
    const h = document.createElement('h3');
    h.textContent = day ? `第 ${day} 篇${bookTitle ? ' · ' + bookTitle : ''}` : '其他';
    g.append(h);
    for (const w of ws) {
      const row = document.createElement('div');
      row.className = 'c-word' + (haveSet.has(w.word) ? ' is-have' : '');
      const first = (w.tr || '').split('\n')[0];
      row.innerHTML =
        `<span class="w">${esc(w.word)}</span>` +
        `<span class="p">${esc(w.ph ? '/' + w.ph + '/' : '')}</span>` +
        `<span class="t">${esc(first)}</span>`;
      g.append(row);
    }
    list.append(g);
  }

  const btn = $('#c-go');
  if (fresh.length === 0) {
    btn.disabled = true;
    btn.textContent = '这些词都已经在词库里了';
    $('#c-note').textContent = '没有可新增的词。下次出新文章后可以再来一次。';
  } else {
    btn.disabled = false;
    btn.textContent = `导入 ${fresh.length} 个词`;
    $('#c-note').textContent =
      `已在库的 ${have} 个会跳过，复习进度不受影响。导入后它们会作为「新词」进闪卡。`;
  }

  $('#c-body').hidden = false;
}

async function doImport() {
  const btn = $('#c-go');
  const fresh = allWords.filter((w) => !haveSet.has(w.word));
  if (!fresh.length) return;

  btn.disabled = true;
  let done = 0;
  try {
    for (const rec of fresh) {
      // 逐条写：一次事务写全部会在配额/中断时整体回滚，看不到已经存到哪。
      await words.put({
        ...rec,
        ph: rec.ph || '',
        tr: rec.tr || '',
        contexts: Array.isArray(rec.contexts) ? rec.contexts : [],
        createdAt: rec.createdAt || Date.now(),
      });
      done++;
      btn.textContent = `导入中 ${done} / ${fresh.length}`;
    }
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = `出错，已导入 ${done} 个`;
    $('#c-error').hidden = false;
    $('#c-error').textContent = '导入中断：' + (err?.message || err);
    return;
  }

  try {
    await kv.set('catchup.lastImport', { at: Date.now(), added: done });
  } catch { /* 记录失败不影响导入结果 */ }

  $('#c-body').hidden = true;
  $('#c-added').textContent = done;
  $('#c-done').hidden = false;
  $('#c-flash').onclick = () => { location.href = '../#/words/flash'; };
}

async function main() {
  try {
    const [pack, local] = await Promise.all([loadPacks(), words.all()]);
    allWords = pack;
    haveSet = new Set(local.map((w) => w.word));
    if (!allWords.length) { fail('补词包是空的。'); return; }
    $('#c-loading').hidden = true;
    render();
    $('#c-go').onclick = doImport;
  } catch (err) {
    console.error(err);
    fail('读取失败：' + (err?.message || err));
  }
}

main();
