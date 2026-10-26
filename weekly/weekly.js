// weekly.js — 周回顾 / 周开始
//
// 两种模式走同一个页面：
//   带 &mode=review → 强制回顾（周五提醒用；这周一篇没读也照常显示）
//   带 &mode=start  → 强制预告（周一提醒用；这周还没开工也照常显示）
//   不带 mode       → 周数据 status=reading 且有文章就走回顾，否则走预告
//
// 周一提醒发本周、周五提醒发本周，两处用同一个周号；周号 = floor((今天-2026-10-19)/7)+1。
//
// 她的选择存在 kv `week.choice.W02`，我下次生成文章时读得到，据此决定出哪个主题。
// 某一周还没写详细预告时，退化成 52 周地图上的原定主题（data/weeks/plan.json），链接不会 404。

import { words, kv } from '../js/db.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}
async function getJSON(p) {
  const r = await fetch(p, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${p} 读取失败（HTTP ${r.status}）`);
  return r.json();
}
// '1' / '01' / 'w1' / 'W01' → 'W01'
function normWeek(v) {
  if (!v) return null;
  const m = String(v).match(/^w?0*(\d+)$/i);
  return m ? 'W' + String(Number(m[1])).padStart(2, '0') : null;
}
function fmtDate(d) {
  return String(d || '').slice(5).replace('-', '-');
}

function fail(msg) {
  $('#w-loading').hidden = true;
  $('#w-error').hidden = false;
  $('#w-error').textContent = msg;
}

// ---------- 周回顾 ----------
async function renderReview(week, articles, nextWeek) {
  $('#w-crumb').textContent = '周回顾';
  $('#r-kicker').textContent = `${week.week} · ${week.quarter || ''}`.replace(/ · $/, '');
  $('#r-theme').textContent = week.theme + (week.angle ? ` · ${week.angle}` : '');

  const dates = articles.map((a) => a.date).sort();
  const totalWords = articles.reduce((n, a) => n + (a.words || 0), 0);
  $('#r-sub').textContent = articles.length
    ? `${articles.length} 篇 · ${totalWords.toLocaleString()} 词 · ${fmtDate(dates[0])} — ${fmtDate(dates[dates.length - 1])}`
    : '这周还没有阅读记录';

  // 她的数据：点词按 day 归组，wpm 从 kv read.timer.N 取
  let tapped = new Map();
  let timers = new Map();
  let haveSet = new Set();
  try {
    const [all, kvs] = await Promise.all([words.all(), kv.all()]);
    haveSet = new Set(all.map((w) => w.word));
    for (const w of all) {
      if (w.day != null) tapped.set(w.day, (tapped.get(w.day) || 0) + 1);
    }
    for (const kvp of kvs) {
      const m = String(kvp.key).match(/^read\.timer\.(\d+)$/);
      if (m) timers.set(Number(m[1]), kvp.value || {});
    }
  } catch (e) { console.error(e); }

  const wpms = articles.map((a) => timers.get(a.day)?.wpm).filter(Boolean);
  const avgWpm = wpms.length ? Math.round(wpms.reduce((a, b) => a + b, 0) / wpms.length) : null;
  const tappedTotal = articles.reduce((n, a) => n + (tapped.get(a.day) || 0), 0);

  const stats = [
    { n: articles.length, l: '篇' },
    { n: totalWords.toLocaleString(), l: '词' },
    { n: avgWpm ?? '—', l: avgWpm ? '平均 wpm' : '平均 wpm（没计时）' },
    { n: tappedTotal, l: '圈了词' },
  ];
  $('#r-stats').innerHTML = stats
    .map((s) => `<div class="w-stat"><b>${esc(s.n)}</b><span>${esc(s.l)}</span></div>`)
    .join('');

  // 文章列表
  const angleOf = new Map((week.angles || []).map((a) => [a.day, a]));
  $('#r-list').innerHTML = articles.length ? articles.map((a) => {
    const t = timers.get(a.day);
    const ang = angleOf.get(a.day);
    const cnt = tapped.get(a.day) || 0;
    return `<a class="r-item" href="../daily/?day=${a.day}">
      <span class="n">${String(a.day).padStart(2, '0')}</span>
      <span class="body">
        <span class="ttl">${esc(a.title)}</span>
        <span class="k">${esc(ang?.kicker || '')}${ang?.kicker ? ' · ' : ''}${a.words} 词</span>
      </span>
      <span class="meta">
        <b>${t?.wpm ? t.wpm + ' wpm' : '—'}</b>
        ${cnt ? cnt + ' 词' : ''}
      </span>
    </a>`;
  }).join('') : '<p class="w-note">这周还没有记录。跳过也没关系，下周继续。</p>';

  // 词汇场：已收的高亮
  const field = week.wordfield || {};
  const groups = [
    ['动词', field.verbs || []],
    ['名词', field.nouns || []],
    ['形容词', field.adjs || []],
  ].filter(([, list]) => list.length);
  const hasWord = (w) => haveSet.has(w) || [...haveSet].some(
    (x) => x !== w && x.startsWith(w) && x.length - w.length <= 3
  );
  $('#r-words').innerHTML = groups.map(([label, list]) => `
    <div class="r-field">
      <div class="lbl">${label}</div>
      <div class="r-chips">${list.map((w) =>
        `<span class="r-chip${hasWord(w) ? ' have' : ''}">${esc(w)}</span>`).join('')}</div>
    </div>`).join('');

  // 收尾
  const closing = week.closing || [];
  if (closing.length) {
    $('#r-closing').innerHTML = closing.map((c) => `<li>${esc(c)}</li>`).join('');
  } else {
    $('#r-close-block').hidden = true;
  }

  // 下周入口（强制走预告，避免那周刚开个头就变成半截回顾）
  if (nextWeek) {
    $('#r-next').href = `?week=${Number(nextWeek.week.slice(1))}&mode=start`;
    const opt = (nextWeek.options || []).find((o) => o.id === nextWeek.defaultOption);
    $('#r-next-title').textContent = opt ? opt.title : '下周主题';
  } else {
    $('#r-next').hidden = true;
  }

  $('#w-loading').hidden = true;
  $('#w-review').hidden = false;
  document.title = `${week.week} 周回顾 · ${week.theme}`;
}

// ---------- 周开始 ----------
async function renderPreview(week) {
  $('#w-crumb').textContent = '周开始';
  $('#p-kicker').textContent = `${week.week} ${week.quarter ? '· ' + week.quarter : ''}`;
  $('#p-intro').textContent = week.intro || '';

  const options = week.options || [];
  if (!options.length) { fail('这一周还没有候选主题。'); return; }

  // 回显她上次的选择
  let chosen = week.defaultOption || options[0].id;
  try {
    const saved = await kv.get(`week.choice.${week.week}`);
    if (saved?.id && options.some((o) => o.id === saved.id)) chosen = saved.id;
  } catch { /* 读不到用默认 */ }

  const renderOptions = () => {
    $('#p-options').innerHTML = options.map((o) => `
      <div class="p-opt${o.id === chosen ? ' on' : ''}" data-id="${esc(o.id)}">
        <div class="hd">
          <span class="ttl">${esc(o.title)}</span>
          <span class="pick">${o.id === chosen ? '选这个' : esc(o.kind || '')}</span>
        </div>
        <p class="line">${esc(o.oneLine || '')}</p>
        <div class="tags">
          <span>${esc(o.kind || '')}</span>
          <em>${esc(o.planned || '')}</em>
        </div>
      </div>`).join('');

    const cur = options.find((o) => o.id === chosen);
    $('#p-detail').innerHTML = (cur.angles || []).map((a) => `
      <div class="p-angle">
        <span class="d">D${a.day}</span>
        <span class="c">
          <span class="k">${esc(a.kicker)}</span>
          <span class="l">${esc(a.line)}</span>
        </span>
      </div>`).join('');

    const w = cur.words || {};
    const chip = (label, list) => list?.length
      ? `<div class="r-field"><div class="lbl">${label}</div><div class="r-chips">${
          list.map((x) => `<span class="r-chip">${esc(x)}</span>`).join('')}</div></div>`
      : '';
    $('#p-words').innerHTML =
      chip('动词', w.verbs) + chip('名词', w.nouns) + chip('形容词', w.adjs);
    $('#p-detail-title').textContent = `五天切口 · ${cur.title}`;

    // 为什么读这个
    if (cur.why) {
      $('#p-words').innerHTML += `<p class="w-note" style="margin-top:14px">${esc(cur.why)}</p>`;
    }
  };

  renderOptions();

  $('#p-options').onclick = (e) => {
    const card = e.target.closest('.p-opt');
    if (!card) return;
    chosen = card.dataset.id;
    renderOptions();
    $('#p-confirm').disabled = false;
    $('#p-confirm').textContent = '就按这个出文章';
    $('#p-hint').textContent = '';
  };

  // 已有选择：按钮文案换成「已经记下了」
  const saved0 = await kv.get(`week.choice.${week.week}`).catch(() => null);
  if (saved0?.id) {
    $('#p-confirm').textContent = '已经记下了，改主意就再点一次';
    $('#p-hint').textContent = `上次选的是「${
      options.find((o) => o.id === saved0.id)?.title || saved0.id}」。`;
  }

  $('#p-confirm').onclick = async () => {
    const btn = $('#p-confirm');
    btn.disabled = true;
    try {
      await kv.set(`week.choice.${week.week}`, { id: chosen, at: Date.now() });
      const cur = options.find((o) => o.id === chosen);
      btn.textContent = '记下了';
      $('#p-hint').textContent = `下周按「${cur.title}」出文章。选别的再点一次就行。`;
    } catch (err) {
      btn.disabled = false;
      $('#p-hint').textContent = '记不下来：' + (err?.message || err);
    }
  };

  $('#w-loading').hidden = true;
  $('#w-preview').hidden = false;
  document.title = `${week.week} 周开始 · 主题选择`;
}

// ---------- 入口 ----------

// 读某一周的数据。详细文件缺失时退化成 52 周地图上的原定主题，
// 保证 weekly/?week=N 永远打得开（周一提醒不能发一个 404 出去）。
async function loadWeek(want, idx) {
  const entry = (idx.weeks || []).find((w) => w.week === want);
  // index 只是指针，不是白名单：直接按 Wxx.json 命名找文件，找不到才退到地图
  const file = entry?.file || `${want}.json`;
  try { return await getJSON('../data/weeks/' + file); } catch { /* 落到下面的兜底 */ }
  const plan = await getJSON('../data/weeks/plan.json').catch(() => null);
  const p = (plan?.weeks || []).find((x) => x.week === want);
  if (!p) throw new Error(`没有 ${want} 这一周的数据`);
  const title = p.angle ? `${p.theme} · ${p.angle}` : p.theme;
  return {
    week: want,
    status: 'planned',
    theme: p.theme,
    angle: p.angle,
    quarter: p.quarter,
    defaultOption: 'planned',
    intro: '这一周的详细预告还没写，先按周地图上的原定主题。想读别的方向，跟我说一句就行。',
    options: [{
      id: 'planned',
      title,
      kind: p.kind === 'rev' ? '复盘周' : '周地图',
      planned: '原定',
      oneLine: p.kind === 'rev' ? '这一周是复盘与测试，不按主题出新文章。' : '按原定计划出文章。想换方向就说一声。',
      angles: [],
    }],
  };
}

async function boot() {
  try {
    const idx = await getJSON('../data/weeks/index.json');
    const want = normWeek(params.get('week')) || idx.current;
    const week = await loadWeek(want, idx);
    const mode = (params.get('mode') || '').toLowerCase();

    const dailyIdx = await getJSON('../data/daily/index.json');
    const articles = (dailyIdx.days || [])
      .filter((d) => normWeek(d.week) === want)
      .sort((a, b) => a.day - b.day);

    const nextEntry = (idx.weeks || []).find((w) => w.week === idx.next);
    const nextWeek = nextEntry ? await getJSON('../data/weeks/' + nextEntry.file).catch(() => null) : null;

    const toReview = mode === 'review' || (!mode && week.status === 'reading' && articles.length);
    if (toReview) {
      await renderReview(week, articles, nextWeek);
    } else {
      await renderPreview(week);
    }
  } catch (e) {
    console.error(e);
    fail('读取失败：' + (e?.message || e));
  }
}

boot();
