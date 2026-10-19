// daily.js — 每日共读页：点词即入生词本，与 App 共用同一个 IndexedDB
//
// 设计约束（重要）：
//   1. 必须与 App 同源才能共享 IndexedDB。所以本页放在 App 仓库的 daily/ 下，
//      必须在同一个 origin 打开（GH Pages 或本地 http server 都行，但不能混用）。
//   2. dict.js 的 loadDict() 里 fetch('data/dict.json') 是相对页面 URL 的，
//      在 /daily/ 下会 404。这里自己 fetch 再喂 initDict()，不改动 App 的代码。
//   3. 不动 reader.js：它一被 import 就会拉起整套 TTS 初始化，这页不需要。

import { el, TOKEN_RE, findSentence, highlightInSentence } from './util.js';
import { words, kv } from './db.js';
import { initDict, lookup } from './dict.js';

const $id = (id) => document.getElementById(id);
const FS_KEY = 'dailyFontSize';
const FS_DEFAULT = 22;
const FS_MIN = 20;
const FS_MAX = 34;
const TIP_KEY = 'daily.tip.v1';

let DATA = null;
let DAY = 1;
let VOCAB = new Map();     // word(原形) -> 生词记录
let tapped = new Set();    // 本页点过（今天新增）的词
let dictReady = false;
let fs = FS_DEFAULT;

// ---------- 小工具 ----------
function toast(msg, ms = 1900) {
  const t = $id('d-toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** 词典里的原形（scavengers → scavenger）；查不到就退回小写原词 */
function baseKey(raw) {
  if (!dictReady) return raw.toLowerCase();
  const e = lookup(raw);
  return (e && e.word) || raw.toLowerCase();
}

function fail(html) {
  const box = $id('d-error');
  box.hidden = false;
  box.innerHTML = html;
  $id('d-article').innerHTML = '';
  $id('d-end').hidden = true;
  $id('d-dock').style.display = 'none';
  $id('d-timer').hidden = true;
}

// ---------- 启动 ----------
async function boot() {
  bindUI();
  await readFont();

  if (location.protocol === 'file:') {
    fail(
      '<b>这个页面不能双击打开</b><br>'
      + '它要和阅读器共用浏览器的本地数据库，必须是 http 地址。'
      + '<code>在 App 目录里跑：python -m http.server 8891 --bind 127.0.0.1<br>'
      + '然后访问 http://127.0.0.1:8891/daily/</code>'
    );
    return;
  }

  try {
    const idx = await getJSON('../data/daily/index.json');
    const days = (idx.days || []).slice().sort((a, b) => a.day - b.day);
    const q = Number(new URLSearchParams(location.search).get('day'));
    DAY = q || (days.length ? days[days.length - 1].day : 1);
    DATA = await getJSON(`../data/daily/day-${String(DAY).padStart(3, '0')}.json`);
  } catch (e) {
    fail('<b>今天的文章没找到</b><br>' + String(e.message || e).replace(/</g, '&lt;'));
    return;
  }

  // 词典和生词本并行加载；词典挂了也能标记（只是没有音标释义）
  await Promise.all([loadDictSafe(), loadVocab()]);

  renderHead();
  renderArticle();
  await maybeShowTip();
  updateDock();
  startClock();
  await initTimer();
}

async function loadDictSafe() {
  try {
    const data = await getJSON('../data/dict.json');
    initDict(data);
    dictReady = true;
  } catch (e) {
    console.warn('词典加载失败，降级为只记词形', e);
    dictReady = false;
  }
}

async function loadVocab() {
  try {
    const all = await words.all();
    VOCAB = new Map(all.map((r) => [r.word, r]));
  } catch (e) {
    VOCAB = new Map();
    toast('生词本读取失败，这次的标记可能存不上');
  }
}

// ---------- 渲染 ----------
function renderHead() {
  // 这里只写「篇」，不写 Day —— Day 是「第几个阅读日」，一篇一天时两者同号，
  // 一天读两篇时就会打架（Day 1 里有第 1、2 篇）。用篇号，语义唯一，不会被误读成日期。
  $id('d-day').textContent = `第 ${DATA.day} 篇`;
  $id('d-theme').textContent = [DATA.week, DATA.theme].filter(Boolean).join(' · ');
  $id('d-title').textContent = DATA.title || '';

  const bits = [];
  if (DATA.date) bits.push(DATA.date);
  if (DATA.words) bits.push(`${DATA.words} 词`);
  if (DATA.density) bits.push(`生词密度 ${DATA.density}/100`);
  if (DATA.minutes) bits.push(`建议 ${DATA.minutes} 分钟`);
  $id('d-sub').textContent = bits.join(' · ');

  if (Array.isArray(DATA.before) && DATA.before.length) {
    const box = $id('d-before');
    box.hidden = false;
    box.append(el('b', null, '读前先猜，别查资料'));
    box.append(el('ol', null, ...DATA.before.map((s) => el('li', null, s))));
  }
}

function tokClass(key) {
  if (tapped.has(key)) return ' tok tapped';
  if (VOCAB.has(key)) return ' tok saved';
  return ' tok';
}

function renderArticle() {
  const box = $id('d-article');
  box.innerHTML = '';
  for (const para of DATA.paras || []) {
    const p = document.createElement('p');
    let last = 0;
    for (const m of para.matchAll(TOKEN_RE)) {
      if (m.index > last) p.append(para.slice(last, m.index));
      const raw = m[0];
      const key = baseKey(raw);
      p.append(el('span', { class: tokClass(key).trim(), 'data-w': raw, 'data-k': key }, raw));
      last = m.index + raw.length;
    }
    if (last < para.length) p.append(para.slice(last));
    box.append(p);
  }

  if (DATA.note) {
    const n = $id('d-note');
    n.hidden = false;
    n.textContent = DATA.note;
  }
  if (Array.isArray(DATA.after) && DATA.after.length) {
    const a = $id('d-after');
    a.hidden = false;
    a.append(el('b', null, '读完，回我四样东西'));
    a.append(el('ol', null, ...DATA.after.map((s) => el('li', null, s))));
  }
}

function refreshTokens() {
  document.querySelectorAll('#d-article .tok').forEach((t) => {
    const k = t.dataset.k;
    t.classList.toggle('saved', VOCAB.has(k) && !tapped.has(k));
    t.classList.toggle('tapped', tapped.has(k));
  });
}

// ---------- 标记 ----------
function sentenceOf(raw) {
  const span = [...document.querySelectorAll('#d-article .tok')].find((t) => t.dataset.w === raw);
  const p = span && span.closest('p');
  return p ? findSentence(p.textContent, raw) : '';
}

async function toggleMark(raw) {
  const key = baseKey(raw);
  const rec = VOCAB.get(key);

  if (rec) {
    // 只在「今天这页、自己加的、还没进复习」时才允许点掉，避免误删复习进度
    const removable = rec.source === 'daily' && rec.day === DAY && !(rec.srs && rec.srs.reps > 0);
    if (!removable) {
      toast('这个词已经在生词本里，点两下看释义');
      return;
    }
    await words.del(key);
    VOCAB.delete(key);
    tapped.delete(key);
    refreshTokens();
    updateDock();
    toast('已移出生词本');
    return;
  }

  const entry = dictReady ? lookup(raw) : null;
  const sent = sentenceOf(raw);
  const now = Date.now();
  const record = {
    word: key,
    createdAt: now,
    // 复习时靠 contexts 出「语境填空」，所以原句一定要跟过去
    contexts: sent ? [{ sentence: sent, bookTitle: `${DATA.title} · ${DATA.week} ${DATA.theme}` }] : [],
    status: 'new',
    srs: null,
    ph: entry?.ph || '',
    tr: entry?.tr || '（词典未收录，稍后我补）',
    tag: entry?.tag || '',
    variant: entry?.variant || '',
    day: DAY,
    source: 'daily',
  };

  try {
    await words.put(record);
  } catch (e) {
    toast('保存失败：' + (e.message || e));
    return;
  }
  VOCAB.set(key, record);
  tapped.add(key);
  refreshTokens();
  updateDock();
  toast(`「${key}」已进生词本`);
}

// ---------- 释义弹层 ----------
function openSheet(node) {
  const sheet = $id('d-sheet');
  const body = $id('d-sheet-body');
  body.innerHTML = '';
  if (node) body.append(node);
  sheet.hidden = false;
}

function closeSheet() { $id('d-sheet').hidden = true; }

function showWord(raw) {
  const key = baseKey(raw);
  const rec = VOCAB.get(key);
  const entry = dictReady ? lookup(raw) : null;
  const frag = document.createDocumentFragment();

  const head = el('div', null, el('span', { class: 'sh-word' }, entry?.word || raw));
  if (entry?.ph) head.append(el('span', { class: 'sh-ph' }, `/${entry.ph}/`));
  if (entry?.tag) head.append(el('span', { class: 'sh-tag' }, entry.tag.toUpperCase()));
  frag.append(head);

  if (entry?.variant) {
    frag.append(el('div', { class: 'sh-tag', style: 'margin:10px 0 0' }, `${entry.variant} 的原形`));
  }
  frag.append(el('div', { class: 'sh-tr' }, entry?.tr || '词典未收录（可能是专名或生造词）'));

  const sent = rec?.contexts?.[0]?.sentence || sentenceOf(raw);
  if (sent) {
    const [a, hit, b] = highlightInSentence(sent, baseKey(raw));
    const ctx = el('div', { class: 'sh-ctx' });
    if (a) ctx.append(a);
    if (hit) ctx.append(el('em', null, hit));
    if (b) ctx.append(b);
    frag.append(ctx);
  }

  const acts = el('div', { class: 'sh-actions' });
  acts.append(el('button', { onclick: () => speak(entry?.word || raw) }, '朗读'));
  if (rec) {
    const removable = rec.source === 'daily' && rec.day === DAY && !(rec.srs && rec.srs.reps > 0);
    acts.append(el('button', {
      class: removable ? 'danger' : '',
      onclick: async () => {
        if (!removable) { toast('已在复习队列里，去生词本页管理'); return; }
        await words.del(key);
        VOCAB.delete(key);
        tapped.delete(key);
        refreshTokens(); updateDock(); closeSheet();
        toast('已移出生词本');
      },
    }, removable ? '移出生词本' : '已在生词本'));
  } else {
    acts.append(el('button', {
      class: 'primary',
      onclick: async () => { await toggleMark(raw); closeSheet(); },
    }, '加入生词本'));
  }
  frag.append(acts);

  openSheet(frag);
}

function speak(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.92;
    const vs = (speechSynthesis.getVoices() || []).filter((v) => /en[-_]/i.test(v.lang));
    const best = vs.find((v) => /Natural|Online/i.test(v.name)) || vs[0];
    if (best) u.voice = best;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (e) { /* 没有语音就不出声，不影响读 */ }
}

// ---------- 今日清单 ----------
function todayRecords() {
  return [...VOCAB.values()]
    .filter((r) => r.source === 'daily' && r.day === DAY)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function buildPlain() {
  const list = todayRecords();
  const head = [
    `第 ${DATA.day} 篇 · ${DATA.title}`,
    `${DATA.date || ''} · ${[DATA.week, DATA.theme].filter(Boolean).join(' ')} · ${DATA.words || '?'} 词 · 生词密度 ${DATA.density || '?'}`,
    '',
  ];
  if (timerSaved) {
    head.push(`通读 ${fmtClock(timerSaved.ms)} · ${timerSaved.wpm} wpm（${timerSaved.words} 词）`, '');
  }
  head.push(`今日标记 ${list.length} 词：`);
  const rows = list.map((r, i) => {
    const ph = r.ph ? ` /${r.ph}/` : '';
    const tr = (r.tr || '').split('\n')[0];
    const sent = r.contexts?.[0]?.sentence || '';
    return `${i + 1}. ${r.word}${ph} ${tr}` + (sent ? `\n   语境：${sent}` : '');
  });
  return head.concat(rows).join('\n');
}

function showList() {
  const list = todayRecords();
  const frag = document.createDocumentFragment();
  frag.append(el('div', { class: 'lg-title' }, `Day ${DATA.day} · 今天标记的词`));
  frag.append(el('div', { class: 'lg-sub' }, list.length
    ? '这些都是你自己点出来的。复制给我，我按它们补卡片、排复习。'
    : '这一篇你还没点任何一个词。'));

  if (!list.length) {
    frag.append(el('div', { class: 'sh-empty' },
      '一个词都没卡住，说明这篇对你偏简单。',
      el('br'),
      '下次我会把难度往上抬一档。'));
  }

  for (const r of list) {
    frag.append(el('div', { class: 'lg-row' },
      el('span', { class: 'lg-w' }, r.word),
      r.ph ? el('span', { class: 'lg-ph' }, `/${r.ph}/`) : null,
      el('span', { class: 'lg-tr' }, (r.tr || '').split('\n')[0]),
    ));
  }

  const tools = el('div', { class: 'lg-tools' });
  if (list.length) {
    tools.append(el('button', { class: 'primary', onclick: () => copyPlain() }, '复制清单'));
    tools.append(el('button', { onclick: () => downloadPlain() }, '存成文件'));
  }
  tools.append(el('button', {
    onclick: () => { closeSheet(); location.href = '../index.html#/review'; },
  }, '去复习'));
  frag.append(tools);

  openSheet(frag);
}

async function copyPlain() {
  const text = buildPlain();
  try {
    await navigator.clipboard.writeText(text);
    toast('清单已复制，粘给我就行');
  } catch (e) {
    // 剪贴板被拒（http 非安全上下文常见）→ 退到 textarea
    try {
      const ta = el('textarea', { style: 'position:fixed;left:-9999px;top:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      toast(ok ? '清单已复制' : '复制失败，用「存成文件」');
    } catch (err) {
      toast('复制失败，用「存成文件」');
    }
  }
}

function downloadPlain() {
  const blob = new Blob([buildPlain()], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `day-${String(DAY).padStart(3, '0')}-tapped.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- 计数与计时 ----------
function updateDock() {
  const n = todayRecords().length;
  $id('d-n').textContent = String(n);
}

let t0 = Date.now();
let awayMs = 0;
let awayAt = 0;

function startClock() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) awayAt = Date.now();
    else if (awayAt) { awayMs += Date.now() - awayAt; awayAt = 0; }
  });
  const tick = () => {
    const paused = awayAt ? Date.now() - awayAt : 0;
    const ms = Math.max(0, Date.now() - t0 - awayMs - paused);
    const s = Math.floor(ms / 1000);
    $id('d-clock').textContent = `· 已读 ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  setInterval(tick, 1000);
}

// ---------- 通读计时器 ----------
// 与上面的 d-clock 分工不同：d-clock 是「页面停留多久」，从打开就算，含查词和发呆；
// 这个计时器只掐「第一遍通读」，由用户自己按开始/结束，结果按篇号存进 kv，
// 我这边能直接读出来更新基线，不需要她手抄。
const TIMER_KEY = 'read.timer.';   // + 篇号
let timerState = 'idle';           // idle | run | done
let timerStart = 0;
let timerMs = 0;
let timerAwayMs = 0;
let timerAwayAt = 0;
let timerTick = null;
let timerSaved = null;             // 这一篇上一次的记录

const fmtClock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function timerElapsed() {
  if (timerState !== 'run') return timerMs;
  const paused = timerAwayAt ? Date.now() - timerAwayAt : 0;
  return Math.max(0, Date.now() - timerStart - timerAwayMs - paused);
}

function renderTimer() {
  const btn = $id('d-timer-btn');
  const clock = $id('d-timer-clock');
  const hint = $id('d-timer-hint');
  const done = $id('d-timer-done');

  if (timerState === 'run') {
    btn.textContent = '读完了';
    btn.classList.add('on');
    clock.classList.add('on');
    clock.textContent = fmtClock(timerElapsed());
    hint.textContent = '计时中 · 切走会自动暂停';
    done.hidden = true;
    return;
  }

  btn.classList.remove('on');
  clock.classList.remove('on');

  if (timerState === 'done') {
    btn.textContent = '重测';
    clock.textContent = fmtClock(timerMs);
    hint.textContent = '已存';
    done.hidden = false;
    return;
  }

  done.hidden = true;
  btn.textContent = timerSaved ? '重测' : '开始通读计时';
  clock.textContent = timerSaved ? fmtClock(timerSaved.ms) : '0:00';
  hint.textContent = timerSaved
    ? `上次 ${fmtClock(timerSaved.ms)} · ${timerSaved.wpm} wpm`
    : '第一遍不停、不点词，读完按停';
}

function startTimer() {
  timerState = 'run';
  timerStart = Date.now();
  timerMs = 0;
  timerAwayMs = 0;
  timerAwayAt = document.hidden ? Date.now() : 0;
  $id('d-timer-done').hidden = true;
  renderTimer();
  clearInterval(timerTick);
  timerTick = setInterval(() => { if (timerState === 'run') renderTimer(); }, 250);
}

async function stopTimer() {
  timerMs = timerElapsed();
  clearInterval(timerTick);

  const words = Number(DATA.words) || 0;
  if (timerMs < 5000 || !words) {
    timerState = 'idle';
    renderTimer();
    toast('不到 5 秒，这次不算');
    return;
  }

  timerState = 'done';
  const mins = timerMs / 60000;
  const wpm = Math.round(words / mins);
  const rec = { day: DAY, words, ms: timerMs, wpm, at: Date.now() };
  timerSaved = rec;

  $id('d-timer-done').innerHTML =
    `${words} 词 · ${fmtClock(timerMs)} · <b>${wpm} wpm</b><br>`
    + '<span style="color:var(--ink-3);font-size:12.5px">已存进这一篇的记录，我明天读它来调难度</span>';
  renderTimer();
  toast(`通读 ${wpm} wpm`);

  try {
    await kv.set(TIMER_KEY + DAY, rec);
  } catch (e) {
    toast('计时结果没存上（数据库拒绝）');
  }
}

function onTimerBtn() {
  if (timerState === 'run') stopTimer();
  else startTimer();
}

async function initTimer() {
  try { timerSaved = (await kv.get(TIMER_KEY + DAY)) || null; } catch (e) { timerSaved = null; }
  renderTimer();

  // 切走标签页时暂停，不然去回个消息回来，wpm 就废了
  document.addEventListener('visibilitychange', () => {
    if (timerState !== 'run') return;
    if (document.hidden) timerAwayAt = Date.now();
    else if (timerAwayAt) { timerAwayMs += Date.now() - timerAwayAt; timerAwayAt = 0; }
  });
}

// ---------- 字号 / 提示 ----------
async function readFont() {
  try {
    const v = await kv.get(FS_KEY);
    if (typeof v === 'number') fs = v;
  } catch (e) { /* 读不到就用默认 */ }
  applyFont();
}

function applyFont() {
  document.documentElement.style.setProperty('--fs', fs + 'px');
}

async function setFont(delta) {
  fs = Math.min(FS_MAX, Math.max(FS_MIN, fs + delta));
  applyFont();
  try { await kv.set(FS_KEY, fs); } catch (e) { /* 记不住也不影响 */ }
}

async function maybeShowTip() {
  let seen = false;
  try { seen = await kv.get(TIP_KEY); } catch (e) { /* 忽略 */ }
  if (seen) $id('d-tip').hidden = true;
  else $id('d-tip').hidden = false;
}

// ---------- 事件 ----------
function bindUI() {
  $id('d-tip-close').onclick = () => {
    $id('d-tip').hidden = true;
    kv.set(TIP_KEY, 1).catch(() => {});
  };
  $id('d-fp').onclick = () => setFont(2);
  $id('d-fm').onclick = () => setFont(-2);
  $id('d-open-list').onclick = () => showList();
  $id('d-timer-btn').onclick = onTimerBtn;
  $id('d-sheet-x').onclick = () => closeSheet();
  $id('d-sheet').addEventListener('click', (e) => {
    if (e.target.id === 'd-sheet') closeSheet();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheet();
  });

  // 单击 = 标记 / 取消；两下 = 看释义。
  // 单击延后 250ms 执行，是为了让双击能被识别出来 —— 不然双击会先入库再弹窗。
  let timer = null;
  let pending = null;
  $id('d-article').addEventListener('click', (e) => {
    const tok = e.target.closest('.tok');
    if (!tok) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
      const isDouble = pending === tok;
      pending = null;
      if (isDouble) { showWord(tok.dataset.w); return; }
    }
    pending = tok;
    timer = setTimeout(() => {
      timer = null;
      pending = null;
      toggleMark(tok.dataset.w);
    }, 250);
  });

  window.addEventListener('scroll', () => {
    const h = document.documentElement.scrollHeight - innerHeight;
    const pct = h > 0 ? Math.min(100, (scrollY / h) * 100) : 0;
    $id('d-bar').style.width = pct + '%';
  }, { passive: true });
}

boot();
