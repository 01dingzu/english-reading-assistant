// app.js — 路由与页面主控
import { $, $$, el, toast, fmtDate } from './util.js';
import { loadDict, setVocabCache } from './dict.js';
import { books, words, kv } from './db.js';
import { importFile, importRawText } from './importer.js';
import { openBook, bindReaderUI, openSheet, speak } from './reader.js';
import * as review from './review.js';
import { SAMPLES, SAMPLE } from './sample.js';

// 复习答题状态（提交后禁止重复提交，下一题时重置）
let answered = false;

// ---------- vocab cache ----------
export async function refreshVocabCache() {
  const all = await words.all();
  setVocabCache(new Set(all.map(r => r.word)));
}

// ---------- 全局错误兜底：任何脚本错误可见，不再无声无息 ----------
window.addEventListener('error', (e) => {
  toast('出错了：' + (e.message || '未知错误'), 3000);
  console.error(e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('未处理的 Promise 异常', e.reason);
});

// ---------- 启动 ----------
async function boot() {
  // 1. 先绑 UI、启动路由——界面立刻可用，不等词典
  try {
    bindReaderUI();
    bindShelfUI();
    bindWordsUI();
    bindReviewUI();
    bindGuideUI();
    window.addEventListener('hashchange', route);
    route();
  } catch (e) {
    console.error(e);
    toast('初始化失败：' + e.message, 4000);
  }

  // 2. 词典异步加载（3.7MB，手机上可能要几秒）
  const status = $('#dict-status');
  try {
    await loadDict(t => { status.textContent = t; status.classList.add('ok'); });
    status.textContent = '词典就绪';
    status.classList.add('ok');
  } catch (e) {
    console.error(e);
    status.textContent = '词典加载失败';
  }

  // 3. 生词缓存 + 预载内置书（难度估算依赖词典，故在词典之后）
  try {
    await refreshVocabCache();
  } catch (e) { console.error(e); }

  try {
    const seeded = await kv.get('seeded');
    if (!seeded) {
      for (const s of SAMPLES) {
        try { await importRawText(s); } catch (e) { console.error(e); }
      }
      await kv.set('seeded', 1);
      renderShelf();  // 预载完成，刷新书架
    }
  } catch (e) { console.error(e); }

  // 4. 首次访问显示指引
  maybeShowGuide();
}

// ---------- 新手指引 ----------
function bindGuideUI() {
  $('#btn-guide').onclick = () => showGuide(false);
  $('#guide-close').onclick = () => hideGuide();
  $('#guide-backdrop').onclick = () => hideGuide();
}

function maybeShowGuide() {
  kv.get('guideShown').then(shown => {
    if (!shown) showGuide(true);
  }).catch(() => {});
}

function showGuide(first) {
  $('#guide-overlay').hidden = false;
  if (first) kv.set('guideShown', 1).catch(() => {});
}

function hideGuide() {
  $('#guide-overlay').hidden = true;
}

// ---------- 路由 ----------
function route() {
  const hash = location.hash || '#/shelf';
  const [_, page, arg] = hash.split('/');

  const tab = page === 'read' ? 'reader' : page || 'shelf';
  $$('#tabbar a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));

  $$('.view').forEach(v => v.classList.remove('active'));

  if (page === 'read' && arg) {
    $('#view-reader').classList.add('active');
    $('#page-title').textContent = '阅读';
    openBook(arg).catch(e => { console.error(e); toast('打开书籍失败'); });
  } else if (page === 'words') {
    $('#view-words').classList.add('active');
    $('#page-title').textContent = '生词本';
    renderWords();
  } else if (page === 'review') {
    $('#view-review').classList.add('active');
    $('#page-title').textContent = '复习';
    renderReviewHome();
  } else {
    $('#view-shelf').classList.add('active');
    $('#page-title').textContent = '书架';
    renderShelf();
  }
  openSheet(false);
}

// ---------- 书架 ----------
const COVER_COLORS = ['#0F6E56', '#534AB7', '#185FA5', '#993556', '#854F0B', '#3C3489'];
const LEVEL_LABEL = { easy: '舒适', mid: '适中', hard: '挑战' };

async function renderShelf() {
  const list = await books.all();
  const grid = $('#shelf-grid');
  grid.innerHTML = '';
  $('#shelf-empty').style.display = list.length ? 'none' : 'block';

  for (const b of list) {
    const color = COVER_COLORS[b.id % COVER_COLORS.length];
    const card = el('div', { class: 'book-card', onclick: () => { location.hash = `#/read/${b.id}`; } },
      el('div', { class: 'book-cover', style: `background:${color}` }, b.title.slice(0, 1).toUpperCase()),
      el('div', { class: 'book-title' }, b.title),
      el('div', { class: 'book-author' }, b.author || `${b.chCount} 章 · ${b.meta.uniqueWords} 词`),
      el('span', { class: `book-level lv-${b.meta.level}` },
        `${LEVEL_LABEL[b.meta.level]} · 生词率 ${Math.round(b.meta.newRate * 100)}%`),
      el('button', {
        class: 'book-del',
        onclick: async (e) => {
          e.stopPropagation();
          if (confirm(`删除《${b.title}》？生词记录会保留。`)) {
            await books.del(b.id);
            renderShelf();
          }
        },
      }, '删除'),
    );
    grid.append(card);
  }

  // 内置书被删光后提供恢复入口
  const hasSample = list.some(b => b.format === 'builtin');
  if (!hasSample) {
    grid.append(el('div', {
      class: 'book-card',
      style: 'border-style:dashed;align-items:center;justify-content:center;min-height:190px',
      onclick: async () => {
        const book = await importRawText(SAMPLE);
        if (book) { toast('示例书已导入'); location.hash = `#/read/${book.id}`; }
      },
    }, el('span', { style: 'font-size:13px;color:var(--ink-2)' }, '＋ 恢复示例书'), el('span', { style: 'font-size:11px;color:var(--ink-3)' }, '伊索寓言 · 6 篇')));
  }
}

function bindShelfUI() {
  $('#btn-import').onclick = () => $('#file-input').click();
  $('#file-input').onchange = async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    toast('正在导入…');
    for (const f of files) {
      const book = await importFile(f);
      if (book) toast(`《${book.title}》导入完成`);
    }
    e.target.value = '';
    renderShelf();
  };
}

// ---------- 生词本 ----------
function bindWordsUI() {
  // 生词本页当前无全局控件（删除按钮为行内绑定）；
  // 保留函数确保 boot 绑定链完整，也方便未来在这里挂筛选/导出等控件
}

async function renderWords() {
  const all = await words.all();
  const stats = {
    new: all.filter(r => review.statusOf(r) === 'new').length,
    learning: all.filter(r => review.statusOf(r) === 'learning').length,
    mastered: all.filter(r => review.statusOf(r) === 'mastered').length,
  };
  $('#words-summary').innerHTML = '';
  $('#words-summary').append(
    statChip(all.length, '全部'),
    statChip(stats.new, '新生'),
    statChip(stats.learning, '复习中'),
    statChip(stats.mastered, '已掌握'),
  );

  const list = $('#words-list');
  list.innerHTML = '';
  $('#words-empty').style.display = all.length ? 'none' : 'block';

  const sorted = [...all].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  for (const r of sorted) {
    const st = review.statusOf(r);
    const stLabel = { new: '新生', learning: '复习中', mastered: '已掌握' }[st];
    list.append(el('div', { class: 'word-row' },
      el('div', { class: 'w-main' },
        el('div', { class: 'w-t' }, r.word + (r.ph ? ` /${r.ph}/` : '')),
        el('div', { class: 'w-d' }, (r.tr || '').split('\n')[0]),
      ),
      el('span', { class: `w-s st-${st}` }, stLabel),
      el('button', {
        class: 'btn btn-ghost w-listen', title: '朗读',
        'aria-label': `朗读 ${r.word}`,
        onclick: (e) => { e.stopPropagation(); speak(r.word); },
      }, '🔊'),
      el('button', {
        class: 'btn btn-ghost', style: 'font-size:12px',
        onclick: async () => {
          if (confirm(`从生词本删除「${r.word}」？`)) {
            await words.del(r.word);
            renderWords();
            refreshVocabCache();
          }
        },
      }, '×'),
    ));
  }
}

function statChip(n, label) {
  return el('div', { class: 'stat-chip' }, el('b', null, String(n)), el('span', null, label));
}

// ---------- 复习 ----------
function bindReviewUI() {
  $('#btn-start-review').onclick = async () => {
    const ok = await review.startSession();
    if (ok) {
      $('#review-home').hidden = true;
      $('#review-session').hidden = false;
      nextQuestion();
    }
  };
  $('#rv-submit').onclick = submitAnswer;
  $('#rv-next').onclick = () => nextQuestion();
  $('#rv-skip').onclick = () => nextQuestion();
  $('#rv-quit').onclick = () => {
    $('#review-session').hidden = true;
    $('#review-home').hidden = false;
    renderReviewHome();
  };
  document.querySelector('#review-card')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!answered) submitAnswer();
    else nextQuestion();
  });
}

async function renderReviewHome() {
  const all = await words.all();
  const due = all.filter(review.isDue).length;
  const learning = all.filter(r => review.statusOf(r) === 'learning').length;
  const mastered = all.filter(r => review.statusOf(r) === 'mastered').length;
  $('#review-stats').innerHTML = '';
  $('#review-stats').append(
    statChip(due, '今日待复习'),
    statChip(learning, '复习中'),
    statChip(mastered, '已掌握'),
  );
  $('#btn-start-review').disabled = all.length === 0;
}

async function nextQuestion() {
  const card = $('#review-card');
  const has = await review.renderNextQuestion(card);
  if (!has) {
    toast('本批复习完成 🎉');
    $('#rv-quit').click();
    return;
  }
  answered = false;
  const info = review.sessionInfo();
  $('#rv-counter').textContent = `${info.done} / ${info.total}`;
  $('#rv-submit').hidden = false;
  $('#rv-next').hidden = true;
  card.querySelector('.rv-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (!answered) submitAnswer(); }
  });
}

async function submitAnswer() {
  const input = document.querySelector('#review-card .rv-input');
  if (!input || answered) return;
  const res = review.checkAnswer(input.value);
  if (!res) return;
  answered = true;
  input.disabled = true;

  const card = $('#review-card');
  const rec = review.currentRec();
  const result = el('div', { class: 'rv-result ' + (res.ok ? 'ok' : 'bad') },
    res.ok ? '✓ 正确' : `✗ 正确答案：${rec.word}`,
    el('span', { class: 'ans-tr' }, rec.tr || ''),
  );

  // 自评三键
  const rate = el('div', { class: 'review-actions', style: 'margin-top:12px' });
  const mk = (q, label, primary) => el('button', {
    class: 'btn' + (primary ? ' btn-primary' : ''),
    onclick: async () => {
      await review.applyGrade(q);
      nextQuestion();
    },
  }, label);
  rate.append(mk(1, '忘了'), mk(3, '犹豫'), mk(res.ok ? 5 : 3, res.ok ? '记得' : '对了', true));

  card.append(result, rate);
  $('#rv-submit').hidden = true;
  $('#rv-next').hidden = true;
}

// ---------- go ----------
boot();
