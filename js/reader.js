// reader.js — 阅读器渲染 + 点词查义 + 段落翻译 + 书签
import { $, $$, el, TOKEN_RE, toast, fmtDate, findSentence, highlightInSentence, splitSentences } from './util.js';
import { books, chapters, words, bookmarks, kv } from './db.js';
import { lookup, inVocab } from './dict.js';
import { translateSentence } from './translate.js';

let currentBook = null;
let currentCh = null;   // {title, paras}
let chIdx = 0;
let fontSize = 19;

export function speak(text) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.92;
    speechSynthesis.speak(u);
  } catch (e) { toast('当前浏览器不支持朗读'); }
}

// ---------- 渲染 ----------
export async function openBook(bookId) {
  currentBook = await books.get(Number(bookId));
  if (!currentBook) { toast('书不存在'); return; }
  chIdx = currentBook.progress?.ch || 0;
  const stored = await kv.get('fontSize');
  fontSize = stored || 19;
  await renderChapter(chIdx);
  window.scrollTo(0, 0);
}

async function renderChapter(idx) {
  if (!currentBook) return;
  chIdx = Math.max(0, Math.min(idx, currentBook.chCount - 1));
  currentCh = await chapters.get(currentBook.id, chIdx);
  if (!currentCh) currentCh = { title: '(空)', paras: [] };

  $('#rd-title').textContent = currentBook.title;
  $('#rd-chapter').textContent = currentCh.title || '';
  $('#ch-pos').textContent = `${chIdx + 1} / ${currentBook.chCount}`;

  const box = $('#reader-content');
  box.innerHTML = '';
  box.style.fontSize = fontSize + 'px';

  if (currentCh.title && currentCh.title !== '正文') {
    box.append(el('h2', { class: 'ch-title' }, currentCh.title));
  }
  for (const para of currentCh.paras) {
    box.append(buildParaBlock(para));
  }
  // 进度条按章节数 + 章内滚动近似
  updateProgress();
  currentBook.progress = { ...currentBook.progress, ch: chIdx };
  books.put(currentBook);
}

function buildPara(text) {
  const p = el('p');
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m.index > last) p.append(text.slice(last, m.index));
    const w = m[0];
    const span = el('span', { class: 'tok' + (inVocab(w) ? ' in-vocab' : ''), 'data-w': w }, w);
    p.append(span);
    last = m.index + w.length;
  }
  if (last < text.length) p.append(text.slice(last));
  return p;
}

// 段落块 = <p> + 「译」按钮 + 内联译文区
function buildParaBlock(text) {
  const wrap = el('div', { class: 'para-block' });
  wrap.append(buildPara(text));
  wrap.append(el('button', {
    class: 'btn-tr', title: '翻译本段',
    onclick: (e) => { e.stopPropagation(); toggleParaTr(wrap); },
  }, '译'));
  wrap.append(el('div', { class: 'para-tr', hidden: true }));
  return wrap;
}

async function toggleParaTr(wrap) {
  const box = wrap.querySelector('.para-tr');
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  if (box.dataset.done) return;

  const sents = splitSentences(wrap.querySelector('p').textContent);
  const frag = document.createDocumentFragment();
  for (const s of sents) {
    frag.append(el('div', { class: 'tr-row' },
      el('div', { class: 'tr-src' }, s),
      el('div', { class: 'tr-dst' }, '…'),
    ));
  }
  box.innerHTML = '';
  box.append(frag);
  box.dataset.done = '1';

  // 逐句翻译（在线优先，失败自动回退离线直译，结果缓存）
  for (let i = 0; i < sents.length; i++) {
    const dst = box.children[i]?.querySelector('.tr-dst');
    if (!dst) continue;
    try {
      const res = await translateSentence(sents[i]);
      dst.textContent = res.text;
      if (res.offline) {
        const tag = el('span', { class: 'tr-tag' }, '离线直译');
        dst.append(' ', tag);
      }
    } catch (e) {
      dst.textContent = '（翻译失败）';
    }
  }
}

function updateProgress() {
  if (!currentBook) return;
  const chPart = chIdx / Math.max(1, currentBook.chCount);
  const scrollPart = Math.min(1, (window.scrollY) / Math.max(1, document.body.scrollHeight - innerHeight)) / Math.max(1, currentBook.chCount);
  $('#progress-bar').style.width = Math.min(100, (chPart + scrollPart) * 100) + '%';
}

// ---------- 点词 ----------
export function onTokenClick(e) {
  const tok = e.target.closest('.tok');
  if (!tok) return;
  const w = tok.dataset.w;
  const paraText = tok.closest('p')?.textContent || '';
  showWordSheet(w, paraText);
}

async function showWordSheet(word, paraText) {
  const entry = lookup(word);
  const body = $('#sheet-body');
  body.innerHTML = '';

  if (!entry) {
    body.append(el('div', { class: 'w-notfound' },
      el('div', { class: 'w-word' }, word),
      el('p', null, '词典未收录（人名/地名或拼写变体）'),
      el('button', { class: 'btn', onclick: () => speak(word) }, '朗读'),
    ));
  } else {
    const head = el('div', { class: 'w-head' },
      el('span', { class: 'w-word' }, entry.word),
      entry.ph ? el('span', { class: 'w-ph' }, '/' + entry.ph + '/') : null,
      entry.tag ? el('span', { class: 'w-tag' }, entry.tag.toUpperCase()) : null,
    );
    body.append(head);

    const trBox = el('div', { class: 'w-tr' });
    for (const line of entry.tr.split('\n')) {
      trBox.append(el('span', { class: 'tr-line' }, line));
    }
    body.append(trBox);

    if (entry.variant) {
      body.append(el('div', { class: 'w-senses' }, `${entry.variant} → 原形 ${entry.word}`));
    }
    if (entry.frq && entry.frq < 90000) {
      body.append(el('div', { class: 'w-frq' }, `词频排名约 #${entry.frq}`));
    }
  }

  // 语境句
  const sent = findSentence(paraText, word);
  if (sent) {
    const [a, hit, b] = highlightInSentence(sent, word);
    const ctx = el('div', { class: 'w-ctx' }, a,
      hit ? el('span', { class: 'hl' }, hit) : null, b);
    const trBtn = el('button', {
      class: 'btn-ghost w-ctx-tr-btn',
      onclick: async (e) => {
        const btn = e.target;
        btn.disabled = true;
        btn.textContent = '翻译中…';
        try {
          const res = await translateSentence(sent);
          let dst = ctx.querySelector('.w-ctx-tr');
          if (!dst) {
            dst = el('div', { class: 'w-ctx-tr' });
            ctx.append(dst);
          }
          dst.textContent = res.text;
          if (res.offline) {
            const tag = el('span', { class: 'tr-tag' }, '离线直译');
            dst.append(' ', tag);
          }
          btn.textContent = '再译一次';
        } catch (err) {
          btn.textContent = '翻译失败，重试';
        }
        btn.disabled = false;
      },
    }, '译句');
    ctx.append(trBtn);
    body.append(ctx);
  }

  // 动作按钮
  const saved = await words.get(word.toLowerCase());
  const actions = el('div', { class: 'w-actions' });
  actions.append(el('button', { class: 'btn btn-primary', onclick: async () => {
    await addWord(word, sent);
    openSheet(false);
  } }, saved ? '已收录 · 再存一次语境' : '加入生词本'));
  actions.append(el('button', { class: 'btn', onclick: () => speak(word) }, '朗读'));
  if (entry) {
    actions.append(el('button', { class: 'btn', onclick: () => speak(sent || word) }, '读句子'));
  }
  body.append(actions);

  openSheet(true);
}

async function addWord(word, sentence) {
  const w = word.toLowerCase();
  const entry = lookup(w);
  const rec = (await words.get(w)) || {
    word: w,
    createdAt: Date.now(),
    contexts: [],
    status: 'new',
    srs: null,
  };
  if (entry) {
    rec.ph = entry.ph || rec.ph || '';
    rec.tr = entry.tr || rec.tr || '';
    rec.tag = entry.tag || rec.tag || '';
    rec.frq = entry.frq ?? rec.frq;
  } else {
    rec.tr = rec.tr || '（词典未收录）';
  }
  if (sentence && !rec.contexts.some(c => c.sentence === sentence)) {
    rec.contexts.push({ bookId: currentBook?.id, bookTitle: currentBook?.title, sentence });
    if (rec.contexts.length > 5) rec.contexts.shift();
  }
  await words.put(rec);
  toast(`「${w}」已加入生词本`);
  // 更新高亮
  document.querySelectorAll(`.tok[data-w="${word}"]`).forEach(t => t.classList.add('in-vocab'));
  const { setVocabCache } = await import('./dict.js');
  const { refreshVocabCache } = await import('./app.js');
  await refreshVocabCache();
}

// ---------- sheet 开关 ----------
export function openSheet(show) {
  $('#sheet').hidden = !show;
  $('#sheet-backdrop').hidden = !show;
}

// ---------- 导航 ----------
export function bindReaderUI() {
  $('#btn-back').onclick = () => { location.hash = '#/shelf'; };
  $('#btn-prev-ch').onclick = () => { renderChapter(chIdx - 1); window.scrollTo(0, 0); };
  $('#btn-next-ch').onclick = () => { renderChapter(chIdx + 1); window.scrollTo(0, 0); };
  $('#btn-font-plus').onclick = () => setFont(+1);
  $('#btn-font-minus').onclick = () => setFont(-1);
  $('#btn-bookmark').onclick = () => addBookmark();
  $('#btn-bookmark-list').onclick = () => showBookmarkList();
  $('#reader-content').addEventListener('click', onTokenClick);
  $('#sheet-backdrop').onclick = () => openSheet(false);
  window.addEventListener('scroll', () => {
    if (currentBook) updateProgress();
  }, { passive: true });
}

// ---------- 书签 ----------
// 当前视口靠上 1/3 处附近的段落作为锚点
function currentParaIdx() {
  const blocks = $$('#reader-content > .para-block');
  if (!blocks.length) return 0;
  const anchor = innerHeight / 3;
  let best = 0, bestD = Infinity;
  blocks.forEach((b, i) => {
    const d = Math.abs(b.getBoundingClientRect().top - anchor);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

export async function addBookmark() {
  if (!currentBook) { toast('请先打开一本书'); return; }
  const paraIdx = currentParaIdx();
  const text = (currentCh.paras[paraIdx] || '').slice(0, 80);
  const list = await bookmarks.byBook(currentBook.id);
  if (list.some(b => b.chIdx === chIdx && b.paraIdx === paraIdx)) {
    toast('此位置已有书签');
    return;
  }
  await bookmarks.put({
    bookId: currentBook.id,
    bookTitle: currentBook.title,
    chIdx, paraIdx,
    text,
    createdAt: Date.now(),
  });
  toast('已加书签 🔖');
}

export async function showBookmarkList() {
  if (!currentBook) { toast('请先打开一本书'); return; }
  const list = await bookmarks.byBook(currentBook.id);
  const body = $('#sheet-body');
  body.innerHTML = '';
  body.append(el('div', { class: 'bm-title' }, `书签 · ${currentBook.title}`));

  if (!list.length) {
    body.append(el('div', { class: 'bm-empty' },
      '这本书还没有书签',
      el('div', { class: 'bm-empty-sub' }, '阅读时点右上角 🔖 收藏当前位置，之后可一键跳回')));
    openSheet(true);
    return;
  }

  const sorted = [...list].sort((a, b) => (a.chIdx - b.chIdx) || (a.paraIdx - b.paraIdx));
  for (const bm of sorted) {
    const row = el('div', {
      class: 'bm-row',
      onclick: () => { openSheet(false); jumpToBookmark(bm); },
    },
      el('div', { class: 'bm-main' },
        el('div', { class: 'bm-ch' }, `${bm.chIdx + 1} 章 · ${fmtDate(bm.createdAt)}`),
        el('div', { class: 'bm-text' }, bm.text),
      ),
      el('button', {
        class: 'bm-del', title: '删除书签',
        onclick: async (e) => {
          e.stopPropagation();
          await bookmarks.del(bm.id);
          showBookmarkList();
        },
      }, '×'),
    );
    body.append(row);
  }
  openSheet(true);
}

async function jumpToBookmark(bm) {
  if (!currentBook || currentBook.id !== bm.bookId) {
    await openBook(bm.bookId);
  }
  if (chIdx !== bm.chIdx) {
    await renderChapter(bm.chIdx);
  }
  requestAnimationFrame(() => {
    const blocks = $$('#reader-content > .para-block');
    const target = blocks[bm.paraIdx]?.querySelector('p') || blocks[bm.paraIdx];
    if (target) target.scrollIntoView({ block: 'start' });
    updateProgress();
  });
}

async function setFont(delta) {
  fontSize = Math.max(15, Math.min(26, fontSize + delta));
  $('#reader-content').style.fontSize = fontSize + 'px';
  kv.set('fontSize', fontSize);
}
