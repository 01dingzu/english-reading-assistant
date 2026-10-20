// review.js — SM-2 间隔复习 + 语境填空
import { $, el, toast, shuffle, highlightInSentence } from './util.js';
import { words } from './db.js';

const DAY = 86400000;

// ---------- SM-2 ----------
export function initSrs() {
  return { ef: 2.5, interval: 0, reps: 0, next: Date.now(), lapses: 0 };
}

// q: 5 记得 / 3 犹豫 / 1 忘了
export function grade(srs, q) {
  const s = { ...srs };
  if (q >= 3) {
    s.reps += 1;
    s.interval = s.reps === 1 ? 1 : s.reps === 2 ? 6 : Math.round(s.interval * s.ef);
  } else {
    s.lapses += 1;
    s.reps = 0;
    s.interval = 1;
  }
  s.ef = Math.max(1.3, s.ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  s.next = Date.now() + s.interval * DAY;
  return s;
}

export function statusOf(rec) {
  if (!rec.srs) return 'new';
  if (rec.srs.reps >= 4 && rec.srs.interval >= 21) return 'mastered';
  return 'learning';
}

export function isDue(rec) {
  return !rec.srs || rec.srs.next <= Date.now();
}

export function nextLabel(rec) {
  if (!rec.srs) return '未开始';
  const days = Math.ceil((rec.srs.next - Date.now()) / DAY);
  if (days <= 0) return '待复习';
  return days + ' 天后';
}

// ---------- 复习会话 ----------
// 注意：「本批是否已作答」的状态在 app.js（它同时要管提交按钮与 Enter 键），
// 这里不要再存一份——只写不读的影子状态最容易被误当成真正的判据。
let queue = [];
let queueTotal = 0;
let current = null;

export async function startSession() {
  const all = await words.all();
  const due = all.filter(isDue);
  const fresh = all.filter(r => !r.srs);
  const rest = due.filter(r => r.srs);
  // 新词最多 8 个混入，复习到期优先
  queue = [...shuffle(rest), ...shuffle(fresh).slice(0, 8)].slice(0, 20);
  if (!queue.length) { toast('没有需要复习的词，先去阅读吧'); return false; }
  queueTotal = queue.length;
  queueDone = 0;
  current = null;
  return true;
}

export function sessionInfo() {
  return { total: queueTotal, done: queueDone };
}

let queueDone = 0;

export async function renderNextQuestion(cardBox) {
  if (!queue.length) return false;
  current = queue.shift();
  queueDone++;

  cardBox.innerHTML = '';
  // 只保留一种题型：语境填空。
  // 「听音拼写」考的是能不能把音还原成字母，属于输出训练，和读速不是一条线；
  // 混在同一轮里会让人在「看一眼就懂」和「从零拼」之间反复颠簸。
  const hasCtx = !!current.contexts?.length;
  cardBox.append(el('span', { class: 'rv-mode' }, hasCtx ? '语境填空' : '释义提示'));

  if (hasCtx) {
    const ctx = current.contexts[current.contexts.length - 1];
    const [a, , b] = highlightInSentence(ctx.sentence, current.word);
    const line = el('div', { class: 'rv-sentence' });
    if (a) line.append(a);
    line.append(el('span', { class: 'rv-blank' }, '＿＿＿'));
    if (b) line.append(b);
    cardBox.append(line);
    cardBox.append(el('p', {
      style: 'font-size:12px;color:var(--ink-3);margin-top:10px',
    }, ctx.bookTitle ? '出自《' + ctx.bookTitle + '》' : ''));
  } else {
    // 少数词取不到原句（专名、或书架里点的词段落太碎）：
    // 给中文释义 + 首字母，仍然要求写出英文。不朗读——出声就等于把答案念出来了。
    cardBox.append(el('div', { class: 'rv-sentence' }, (current.tr || '（无释义）').split('\n')[0]));
    cardBox.append(el('p', { class: 'rv-hint' }, firstLetterHint(current.word)));
  }

  const input = el('input', {
    class: 'rv-input', type: 'text', autocomplete: 'off',
    autocapitalize: 'off', spellcheck: 'false', placeholder: '输入英文单词',
  });
  cardBox.append(input);
  input.focus();
  return true;
}

function firstLetterHint(word) {
  const w = String(word || '');
  if (w.length <= 2) return `以 ${w.slice(0, 1)} 开头`;
  return `提示：${w[0]}${' _'.repeat(w.length - 1)}  （${w.length} 个字母）`;
}

export function normalize(s) {
  return (s || '').toLowerCase().trim().replace(/[^a-z'-]/g, '');
}

export function checkAnswer(inputVal) {
  if (!current) return null;
  const ans = normalize(inputVal);
  const ok = ans === current.word || (!!current.variant && ans === current.variant);
  return { ok, word: current.word };
}

export async function applyGrade(q) {
  if (!current) return;
  current.srs = current.srs ? grade(current.srs, q) : grade(initSrs(), q);
  current.status = statusOf(current);
  current.lastReview = Date.now();
  await words.put(current);
}

export function currentRec() { return current; }
