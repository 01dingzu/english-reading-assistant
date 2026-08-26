// reader.js — 阅读器渲染 + 点词查义
import { $, el, TOKEN_RE, toast, findSentence, highlightInSentence } from './util.js';
import { books, chapters, words } from './db.js';
import { lookup, inVocab } from './dict.js';

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
  fontSize = (await import('./db.js')).kv.get('fontSize').then(v => v || 19).catch(() => 19);
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
    box.append(buildPara(para));
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
  $('#reader-content').addEventListener('click', onTokenClick);
  $('#sheet-backdrop').onclick = () => openSheet(false);
  window.addEventListener('scroll', () => {
    if (currentBook) updateProgress();
  }, { passive: true });
}

async function setFont(delta) {
  fontSize = Math.max(15, Math.min(26, fontSize + delta));
  $('#reader-content').style.fontSize = fontSize + 'px';
  const { kv } = await import('./db.js');
  kv.set('fontSize', fontSize);
}
