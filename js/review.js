// review.js — SM-2 间隔复习 + 填空/听写两种题型
import { $, el, toast, shuffle, highlightInSentence } from './util.js';
import { words } from './db.js';
import { speak } from './reader.js';

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
let queue = [];
let queueTotal = 0;
let current = null;
let answered = false;

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
  answered = false;
  return true;
}

export function sessionInfo() {
  return { total: queueTotal, done: queueDone };
}

let queueDone = 0;

export async function renderNextQuestion(cardBox) {
  if (!queue.length) return false;
  current = queue.shift();
  answered = false;
  queueDone++;

  cardBox.innerHTML = '';
  const useCloze = current.contexts?.length && Math.random() < 0.6;
  const mode = useCloze ? '语境填空' : '听音拼写';

  cardBox.append(el('span', { class: 'rv-mode' }, mode));

  if (useCloze) {
    const ctx = current.contexts[current.contexts.length - 1];
    const [a, hit, b] = highlightInSentence(ctx.sentence, current.word);
    const line = el('div', { class: 'rv-sentence' });
    if (a) line.append(a);
    line.append(el('span', { class: 'rv-blank' }, '＿＿＿'));
    if (b) line.append(b);
    cardBox.append(line);
    cardBox.append(el('p', {
      style: 'font-size:12px;color:var(--ink-3);margin-top:10px',
    }, ctx.bookTitle ? '出自《' + ctx.bookTitle + '》' : ''));
  } else {
    cardBox.append(el('p', { class: 'rv-sentence' }, '听发音，拼写单词'));
    cardBox.append(el('button', {
      class: 'btn rv-play', onclick: () => speak(current.word),
    }, '▶ 播放'));
    if (current.contexts?.length) {
      cardBox.append(el('p', {
        style: 'font-size:12px;color:var(--ink-3);margin-top:10px',
      }, '提示：' + current.contexts[current.contexts.length - 1].sentence.slice(0, 40) + '…'));
    }
  }

  const input = el('input', {
    class: 'rv-input', type: 'text', autocomplete: 'off',
    autocapitalize: 'off', spellcheck: 'false', placeholder: '输入英文单词',
  });
  cardBox.append(input);
  input.focus();

  if (!useCloze) setTimeout(() => speak(current.word), 300);
  return true;
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
