// util.js — 分词、句子切分、通用工具
export const TOKEN_RE = /[A-Za-z][A-Za-z'’-]*/g;

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

export function toast(msg, ms = 1800) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

// 词形还原的后备规则（词典 lemma 表查不到时）
const SUF_RULES = [
  [/ies$/, 'y'], [/ves$/, 'f'], [/([sxz]|ch|sh)es$/, '$1'],
  [/([^aeiou])ies$/, '$1y'],
  [/ying$/, 'ie'], [/ing$/, ''], [/ied$/, 'y'], [/ed$/, ''],
  [/er$/, ''], [/est$/, ''], [/s$/, ''],
];

export function morphFallback(word) {
  const w = word.toLowerCase();
  for (const [re, rep] of SUF_RULES) {
    if (re.test(w)) {
      const stem = w.replace(re, rep);
      if (stem.length >= 3) return stem;
    }
  }
  return w;
}

// 从段落文本里提取包含目标词的句子
export function findSentence(paragraphText, word) {
  if (!paragraphText) return '';
  const parts = paragraphText.split(/(?<=[.!?;])\s+/);
  const lower = word.toLowerCase();
  const hit = parts.find(s =>
    s.toLowerCase().includes(lower) ||
    s.toLowerCase().includes(morphFallback(lower))
  );
  return (hit || parts[0] || '').trim().slice(0, 220);
}

// 高亮句子里目标词（首次出现，含简单词形匹配）
export function highlightInSentence(sentence, word) {
  const re = new RegExp(
    `\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\w{0,3}\\b`, 'i'
  );
  const m = sentence.match(re);
  if (!m) return [sentence];
  const i = m.index;
  return [sentence.slice(0, i), m[0], sentence.slice(i + m[0].length)];
}

export function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
