// wordcard.js — 查词卡片的唯一渲染实现
//
// 每日共读页（#d-sheet）与书架阅读页（#sheet）原本各写了一套 DOM：字段顺序、
// 字号、高亮色、类名（sh-* / w-*）全不一样，改一处漏一处。这里收成一份。
//
// 边界：只负责「结构与内容」。朗读、加入生词本、整句翻译由调用方注入——
// 两边发音引擎本就不同（daily 用原生 speechSynthesis，书架走 TTS 模块），
// 硬合会把 reader.js 的整套 TTS 初始化拖进每日页（见 daily.js 顶部约束 3）。

import { el, highlightInSentence } from './util.js';

/**
 * @returns {{frag: DocumentFragment, ctx: HTMLElement|null}}
 *   ctx 是语境句节点，调用方可以往里追加「译句」按钮与译文。
 */
export function buildWordCard({ word, ph, tag, variant, tr, frq, sentence, source }) {
  const frag = document.createDocumentFragment();

  const head = el('div', { class: 'wc-head' });
  head.append(el('span', { class: 'wc-word' }, word || ''));
  if (ph) head.append(el('span', { class: 'wc-ph' }, `/${ph}/`));
  if (tag) head.append(el('span', { class: 'wc-tag' }, String(tag).toUpperCase()));
  frag.append(head);

  if (variant) {
    frag.append(el('div', { class: 'wc-variant' }, `${variant} → 原形 ${word}`));
  }
  if (tr) {
    frag.append(el('div', { class: 'wc-tr' }, tr));
  }
  if (frq && frq < 90000) {
    frag.append(el('div', { class: 'wc-frq' }, `词频排名约 #${frq}`));
  }

  let ctx = null;
  if (sentence) {
    const [a, hit, b] = highlightInSentence(sentence, word);
    ctx = el('div', { class: 'wc-ctx' });
    if (a) ctx.append(a);
    if (hit) ctx.append(el('span', { class: 'wc-hl' }, hit));
    if (b) ctx.append(b);
    if (source) ctx.append(el('div', { class: 'wc-src' }, `出自《${source}》`));
    frag.append(ctx);
  }

  return { frag, ctx };
}
