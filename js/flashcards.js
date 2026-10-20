// flashcards.js — 生词本闪卡模式：正面单词 → 翻面看释义/语境 → 自评喂 SM-2
import { $, el, shuffle, highlightInSentence } from './util.js';
import { words } from './db.js';
import { grade, initSrs, statusOf } from './review.js';
import { speak } from './reader.js';

const FILTERS = {
  all: r => true,
  new: r => !r.srs,
  learning: r => r.srs && statusOf(r) === 'learning',
  mastered: r => statusOf(r) === 'mastered',
};

const FLASH_MAX = 8;   // 单轮上限：与复习页「新词最多 8 个」对齐，避免一次连翻二十几张

let queue = [];
let total = 0;
let done = 0;
let current = null;
let flipped = false;
let box = null;        // 卡片容器（.flash-card）
let activeFilter = 'new';
let emptyReason = 'none';   // 'none' | 'empty'（生词本空）| 'no-new'（新词刷完了）

export async function startFlashSession(filter) {
  // 闪卡只负责「新词首刷」。到期复习交给复习页，两条线不重叠。
  activeFilter = filter || 'new';
  const all = await words.all();
  const list = all.filter(FILTERS[activeFilter] || FILTERS.all);
  if (!list.length) {
    emptyReason = all.length ? 'no-new' : 'empty';
    return false;
  }
  emptyReason = 'none';
  queue = shuffle(list).slice(0, FLASH_MAX);
  total = queue.length;
  done = 0;
  current = null;
  flipped = false;
  return true;
}

/** 上一轮为什么没起来，让 UI 决定空态文案 */
export function flashEmptyReason() { return emptyReason; }

export function flashInfo() {
  return { total, done };
}

export function currentRec() { return current; }

// 渲染下一张：正面（单词+音标+朗读）
export async function renderFlashCard(cardBox) {
  if (!queue.length) return false;
  current = queue.shift();
  done++;
  flipped = false;
  box = cardBox;

  cardBox.innerHTML = '';
  cardBox.classList.remove('flipped');

  const front = el('div', { class: 'flash-face flash-front' },
    el('button', {
      class: 'btn btn-ghost fc-speak', title: '朗读',
      'aria-label': `朗读 ${current.word}`,
      onclick: (e) => { e.stopPropagation(); speak(current.word); },
    }, '🔊'),
    el('div', { class: 'fc-word' }, current.word),
    el('div', { class: 'fc-ph' }, current.ph ? `/${current.ph}/` : ''),
    el('div', { class: 'fc-hint' }, '点卡片翻面'),
  );

  const back = el('div', { class: 'flash-face flash-back' },
    el('div', { class: 'fc-tr' }, (current.tr || '暂无释义').split('\n')[0]),
    ...(current.contexts?.length ? [ctxBlock(current)] : []),
    el('div', { class: 'fc-rate' },
      el('button', { class: 'btn fc-rate-btn', onclick: () => rate(1) }, '忘了'),
      el('button', { class: 'btn fc-rate-btn', onclick: () => rate(3) }, '模糊'),
      el('button', { class: 'btn btn-primary fc-rate-btn', onclick: () => rate(5) }, '认识'),
    ),
  );

  cardBox.append(front, back);
  return true;
}

function ctxBlock(rec) {
  const ctx = rec.contexts[rec.contexts.length - 1];
  const [a, hit, b] = highlightInSentence(ctx.sentence, rec.word);
  const line = el('div', { class: 'fc-ctx' });
  if (a) line.append(a);
  line.append(el('span', { class: 'fc-ctx-hl' }, hit));
  if (b) line.append(b);
  if (ctx.bookTitle) {
    line.append(el('div', { class: 'fc-ctx-src' }, `出自《${ctx.bookTitle}》`));
  }
  return el('div', { class: 'fc-ctx-wrap' },
    el('div', { class: 'fc-ctx-label' }, '语境'),
    line,
  );
}

// 翻面 / 翻回
export function flip() {
  if (!box || !current) return;
  flipped = !flipped;
  box.classList.toggle('flipped', flipped);
}

export function isFlipped() { return flipped; }

// 自评：q=5 认识 / 3 模糊 / 1 忘了，与复习共用 SM-2
let rating = false;
async function rate(q) {
  if (!current || rating) return;
  rating = true;
  try {
    current.srs = current.srs ? grade(current.srs, q) : grade(initSrs(), q);
    current.status = statusOf(current);
    current.lastReview = Date.now();
    await words.put(current);
    const hasNext = await renderFlashCard(box);
    if (!hasNext) {
      const card = $('#flash-card');
      if (card) {
        card.hidden = true;
        $('#fc-quit')?.click();
      }
      return;
    }
    const counter = $('#fc-counter');
    if (counter) counter.textContent = `${done} / ${total}`;
  } finally {
    rating = false;
  }
}
