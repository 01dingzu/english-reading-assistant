// reader.js — 阅读器渲染 + 点词查义 + 段落翻译 + 书签
import { $, $$, el, TOKEN_RE, toast, fmtDate, findSentence, highlightInSentence, splitSentences } from './util.js';
import { books, chapters, words, bookmarks, kv } from './db.js';
import { lookup, inVocab } from './dict.js';
import { translateSentence } from './translate.js';
import {
  Speaker, speakOnce, loadSettings, saveSettings, getSettings,
  listVoices, resolveVoice, hasAiVoice, hasCloudVoice, isDegraded, ready as ttsReady,
  preferKokoro, preferCloud, hasKokoroVoice, kokoroUsable, engineLabel, isKokoroBroken,
  kokoroInfo, kokoroVoicesByGroup, ensureKokoro, warmKokoro, onKokoroProgress,
  KOKORO_DTYPES, KOKORO_DEFAULT_VOICE,
} from './tts.js';

let currentBook = null;
let currentCh = null;   // {title, paras}
let chIdx = 0;
let fontSize = 19;

// ---------- 跟读（AI 音色逐句朗读） ----------
const readAlong = new Speaker();
let readAlongItems = [];
let readAlongBound = false;

export function speak(text) {
  // 本地模型 / 自备接口是异步合成的，失败要说出来（不然用户只看到「点了没反应」）
  if (!speakOnce(text, { onError: (m) => toast(m, 3400) })) toast('当前浏览器不支持朗读');
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
  maybeShowFeatureTip();
}

// 首次进入阅读页时，展示「句子翻译 + 书签」功能提示条
const FEATURE_TIP_KEY = 'guide.features.v1';
async function maybeShowFeatureTip() {
  const tip = $('#feature-tip');
  if (!tip) return;
  try {
    const shown = await kv.get(FEATURE_TIP_KEY);
    if (shown) return;
  } catch (e) { /* 忽略 kv 异常，照常展示 */ }
  tip.hidden = false;
}

function dismissFeatureTip() {
  $('#feature-tip').hidden = true;
  kv.set(FEATURE_TIP_KEY, 1).catch(() => {});
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
  refreshReadAlongQueue();
}

// 段落文本 → 词元节点序列（点词查义的最小单元）
function buildInline(text) {
  const nodes = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const w = m[0];
    nodes.push(el('span', { class: 'tok' + (inVocab(w) ? ' in-vocab' : ''), 'data-w': w }, w));
    last = m.index + w.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// 段落按句切分渲染：每句一个 .sent，供跟读高亮（点词仍在句内生效）
function buildPara(text) {
  const p = el('p');
  const sents = splitSentences(text);
  if (sents.length <= 1) {
    p.append(...buildInline(text));
    return p;
  }
  sents.forEach((s, i) => {
    if (i) p.append(' ');
    p.append(el('span', { class: 'sent', 'data-i': String(i) }, ...buildInline(s)));
  });
  return p;
}

// 段落块 = <p> + 「读 / 译」按钮 + 内联译文区
function buildParaBlock(text) {
  const wrap = el('div', { class: 'para-block' });
  const p = buildPara(text);
  wrap.append(p);
  const tools = el('div', { class: 'para-tools' });
  tools.append(el('button', {
    class: 'btn-spk', title: '从本段开始朗读',
    onclick: (e) => { e.stopPropagation(); readFromPara(wrap); },
  }, '读'));
  tools.append(el('button', {
    class: 'btn-tr', title: '翻译本段',
    onclick: (e) => { e.stopPropagation(); toggleParaTr(wrap); },
  }, '译'));
  wrap.append(tools);
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

// ---------- 跟读播放器 ----------
// 队列 = 本章「章标题 + 每段每句」，每项带 DOM 节点，读到哪高亮到哪
function collectReadAlong() {
  const out = [];
  const title = $('#reader-content .ch-title');
  if (title && title.textContent.trim()) out.push({ text: title.textContent.trim(), node: title });
  for (const p of $$('#reader-content > .para-block > p')) {
    const sents = $$('.sent', p);
    if (sents.length) {
      for (const s of sents) {
        const t = s.textContent.trim();
        if (t) out.push({ text: t, node: s });
      }
    } else {
      const t = p.textContent.trim();
      if (t) out.push({ text: t, node: p });
    }
  }
  return out;
}

function refreshReadAlongQueue() {
  readAlong.stop();
  readAlongItems = collectReadAlong();
  readAlong.setItems(readAlongItems);
  updateTtsBar();
}

function clearSentHighlight() {
  $$('#reader-content .senting').forEach(n => n.classList.remove('senting'));
}

function highlightSent(node) {
  clearSentHighlight();
  if (!node) return;
  node.classList.add('senting');
  if (!getSettings().autoScroll) return;
  const r = node.getBoundingClientRect();
  if (r.top < 96 || r.bottom > innerHeight - 140) {
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function readFromPara(wrap) {
  const target = wrap.querySelector('p .sent') || wrap.querySelector('p');
  if (!target) return;
  const i = readAlongItems.findIndex(it => it.node === target);
  if (i < 0) { toast('本段暂无可朗读内容'); return; }
  readAlong.play(i).catch(() => {});
}

function toggleReadAlong() {
  if (!readAlongItems.length) { toast('本章没有可朗读内容'); return; }
  if (readAlong.state === 'playing') readAlong.pause();
  else readAlong.play().catch(() => {});
}

function stopReadAlong() {
  readAlong.stop();
  clearSentHighlight();
}

function bindReadAlong() {
  if (readAlongBound) return;
  readAlongBound = true;
  readAlong.onchange = () => updateTtsBar();
  readAlong.onindex = (i, item) => { highlightSent(item && item.node); updateTtsBar(); };
  readAlong.onerror = (msg) => toast(msg, 3400);
  readAlong.onend = () => toast('本章读完');
}

function updateTtsBar() {
  const bar = $('#tts-bar');
  if (!bar) return;
  const inReader = $('#view-reader')?.classList.contains('active');
  const show = !!inReader && readAlong.total > 0;
  bar.hidden = !show;
  document.body.classList.toggle('tts-open', show);
  if (!show) return;

  const pos = $('#tts-pos');
  if (pos) {
    pos.textContent = readAlong.index >= 0
      ? `${readAlong.index + 1} / ${readAlong.total}`
      : `${readAlong.total} 句`;
  }
  const play = $('#tts-play');
  if (play) play.textContent = readAlong.state === 'playing' ? '⏸' : '▶';
  const info = $('#tts-voice');
  if (info) {
    const label = engineLabel();
    info.textContent = label;
    info.title = label;
  }
}

// ---------- 语音设置面板 ----------
const ENGINE_OPTIONS = [
  ['auto', '自动（优先本地/神经音色）'],
  ['kokoro', '仅本地 AI 音色'],
  ['system', '仅本机音色'],
  ['cloud', '自备 AI 语音'],
];

function openTtsSettings() {
  const body = $('#sheet-body');
  body.innerHTML = '';
  const s = getSettings();
  body.append(el('div', { class: 'bm-title' }, '语音设置'));

  // 当前实际生效的音色（AI 音色合成失败时会自动降级，这里要说清楚）
  const active = resolveVoice();
  const degraded = isDegraded();
  body.append(el('div', { class: 'tts-active' + (degraded ? ' warn' : '') },
    el('span', { class: 'tts-active-k' }, '当前音色'),
    el('span', { class: 'tts-active-v', id: 'tts-active-voice' },
      preferKokoro() || preferCloud() ? engineLabel() : (active ? active.name : '无可用音色')),
    degraded ? el('span', { class: 'tts-active-tag' }, '已降级') : null,
  ));

  if (preferKokoro()) {
    body.append(el('div', { class: 'tts-tip ok' },
      '本地 AI 音色已就绪：句子在浏览器里合成，离线也能读，不耗流量、不占额度。'));
  } else if (hasKokoroVoice() && !kokoroUsable()) {
    body.append(el('div', { class: 'tts-tip' },
      '已启用本地 AI 音色，但模型本次没加载上（可能没下完 / 被清缓存 / 内存不足），现在先用后面的音色。'));
  } else if (hasAiVoice()) {
    body.append(el('div', { class: 'tts-tip ok' },
      '已检测到 AI 神经音色，朗读使用云端合成，需要联网。'));
  } else if (!hasCloudVoice()) {
    body.append(el('div', { class: 'tts-tip' },
      '当前浏览器只提供机械音色。用 Edge 打开本站可获得 AI 神经音色（免费、无需配置）；',
      '启用下面的「本地 AI 音色」可拿到 28 个接近真人的音色，离线也能用。'));
  }

  // 引擎
  const chipRow = el('div', { class: 'tts-chips', id: 'tts-engine-chips' });
  for (const [k, label] of ENGINE_OPTIONS) {
    chipRow.append(el('button', {
      class: 'tts-chip' + (s.engine === k ? ' on' : ''),
      'data-engine': k,
      onclick: async () => { await saveSettings({ engine: k }); updateTtsBar(); openTtsSettings(); },
    }, label));
  }
  body.append(el('div', { class: 'tts-row' }, el('div', { class: 'tts-label' }, '朗读引擎'), chipRow));

  // 本地神经语音（Kokoro-82M）：需要用户点一下才下载，属于可选能力
  body.append(kokoroBlock());

  // 音色
  const voices = listVoices();
  const voiceBox = el('div', { class: 'tts-voices', id: 'tts-voices' });
  if (!voices.length) {
    voiceBox.append(el('div', { class: 'tts-empty' }, '没有可用音色'));
  } else {
    let lastTier = 0;
    for (const v of voices) {
      if (v.tier !== lastTier) {
        lastTier = v.tier;
        voiceBox.append(el('div', { class: 'tts-group' }, v.tierLabel));
      }
      const on = s.voiceName ? s.voiceName === v.name : resolveVoice()?.name === v.name;
      voiceBox.append(el('div', {
        class: 'tts-voice' + (on ? ' on' : ''),
        'data-voice': v.name,
        onclick: async () => {
          await saveSettings({ voiceName: v.name });
          updateTtsBar();
          openTtsSettings();
        },
      },
        el('span', { class: 'tts-voice-name' }, v.name),
        el('span', { class: 'tts-voice-lang' }, v.lang),
      ));
    }
  }
  body.append(el('div', { class: 'tts-row' }, el('div', { class: 'tts-label' }, '浏览器内置音色'), voiceBox));

  // 语速
  const rateVal = el('span', { class: 'tts-rate-val', id: 'tts-rate-val' }, String(s.rate));
  const rate = el('input', {
    type: 'range', min: '0.6', max: '1.5', step: '0.05',
    value: String(s.rate), class: 'tts-rate', id: 'tts-rate',
    oninput: (e) => { rateVal.textContent = e.target.value; },
    onchange: async (e) => { await saveSettings({ rate: Number(e.target.value) }); },
  });
  body.append(el('div', { class: 'tts-row' },
    el('div', { class: 'tts-label' }, '语速'),
    el('div', { class: 'tts-rate-wrap' }, rate, rateVal)));

  // 自动滚动
  body.append(el('div', { class: 'tts-row' },
    el('div', { class: 'tts-label' }, '跟读'),
    el('button', {
      class: 'tts-chip' + (s.autoScroll ? ' on' : ''),
      id: 'tts-autoscroll',
      onclick: async () => { await saveSettings({ autoScroll: !s.autoScroll }); openTtsSettings(); },
    }, s.autoScroll ? '朗读时自动滚动到当前句' : '朗读时不滚动')));

  // 试听
  body.append(el('div', { class: 'tts-row' },
    el('div', { class: 'tts-label' }, '试听'),
    el('button', {
      class: 'btn', id: 'tts-preview',
      onclick: () => speak('The quick brown fox jumps over the lazy dog.'),
    }, '听一句')));

  // 自备 AI 语音
  if (s.engine === 'cloud') {
    const c = s.cloud;
    const cloud = el('div', { class: 'tts-cloud', id: 'tts-cloud' },
      el('div', { class: 'tts-label' }, '自备 AI 语音（OpenAI 兼容接口）'),
      field('接口地址', 'tts-cloud-endpoint', c.endpoint, 'https://api.openai.com/v1'),
      field('API Key', 'tts-cloud-key', c.key, 'sk-…', 'password'),
      field('模型', 'tts-cloud-model', c.model, 'tts-1'),
      field('音色名', 'tts-cloud-voice', c.voice, 'alloy'),
      el('p', { class: 'tts-note' },
        'Key 只保存在本机浏览器（IndexedDB），不会上传到本站——本站没有后端。'),
      el('p', { class: 'tts-note' },
        '接口需是 HTTPS 公网地址：浏览器会拦截网页对本地 / 明文接口的请求。'),
      el('p', { class: 'tts-note' },
        '配置后朗读音频由你选的服务合成，费用由该服务结算。'),
      el('button', {
        class: 'btn btn-primary', id: 'tts-cloud-save',
        onclick: async () => {
          const val = (id) => ($('#' + id)?.value || '').trim();
          await saveSettings({
            cloud: {
              enabled: true,
              endpoint: val('tts-cloud-endpoint'),
              key: val('tts-cloud-key'),
              model: val('tts-cloud-model'),
              voice: val('tts-cloud-voice'),
            },
          });
          toast(hasCloudVoice() ? 'AI 语音已保存' : '请把接口地址和 Key 填全');
          openTtsSettings();
        },
      }, '保存并启用'),
    );
    body.append(cloud);
  }

  openSheet(true);
}

// ---------- 本地 AI 音色（Kokoro-82M）----------
// 这是「可选能力」：不预下载，用户点一下才拉模型；下载后进浏览器缓存，之后离线可用。
let kkSubscribed = false;

function subscribeKokoroProgress() {
  if (kkSubscribed) return;
  kkSubscribed = true;
  onKokoroProgress((p) => {
    updateKokoroProgress(p);
    // 下载完成 → 面板若还开着，就地重渲染成「音色列表」
    if (p.phase === 'ready' && $('#sheet') && $('#sheet').hidden === false && $('#tts-kokoro')) {
      openTtsSettings();
    }
  });
}

/** 进度条按 id 找节点：面板随时可能被重渲染，闭包里的引用会失效 */
function updateKokoroProgress(snap) {
  const wrap = $('#kk-progress');
  const bar = $('#kk-bar');
  const txt = $('#kk-progress-text');
  if (!wrap || !bar) return;
  const p = snap || (kokoroInfo().progress || {});
  const active = p.phase === 'loading-lib' || p.phase === 'loading-model';
  wrap.hidden = !active;
  if (!active) { if (txt) txt.textContent = ''; return; }
  const st = $('#kk-status');
  if (st) st.textContent = p.phase === 'loading-lib' ? '正在获取语音引擎…' : '正在下载模型…';
  if (p.phase === 'loading-lib') {
    bar.style.width = '8%';
    if (txt) txt.textContent = '正在获取语音引擎…';
    return;
  }
  const pct = typeof p.pct === 'number' ? p.pct : -1;
  // pct = -1 表示服务端没给总大小，只能显示已获取体积（假装有百分比是骗人）
  bar.style.width = pct >= 0 ? Math.max(4, pct) + '%' : '100%';
  bar.classList.toggle('indeterminate', pct < 0);
  if (txt) {
    txt.textContent = pct >= 0
      ? `下载模型 ${pct}%（已获取 ${p.mb || 0} MB）`
      : `下载模型…（已获取 ${p.mb || 0} MB）`;
  }
}

async function enableKokoro() {
  const btn = $('#kk-download');
  if (btn) { btn.disabled = true; btn.textContent = '下载中…'; }
  const s = getSettings();
  const model = s.kokoro.model || 'q8';
  try {
    subscribeKokoroProgress();
    await ensureKokoro({ model });                    // 进度走订阅更新
    await warmKokoro(s.kokoro.voice || KOKORO_DEFAULT_VOICE);  // 预热：把首次 shader 编译的等待吃掉
    const patch = { kokoro: { enabled: true, warm: true, model } };
    // 点「下载并启用」的意图就是用它，顺手把引擎切过去（本机/自备引擎才需要改）
    if (s.engine === 'system' || s.engine === 'cloud') patch.engine = 'kokoro';
    await saveSettings(patch);
    updateTtsBar();
    toast('本地 AI 音色已就绪，共 28 个音色可选');
  } catch (e) {
    toast(`本地语音下载失败：${(e && e.message) || e}（可稍后再试）`, 4200);
  }
  if ($('#sheet') && $('#sheet').hidden === false) openTtsSettings();
}

function kokoroBlock() {
  const s = getSettings();
  const info = kokoroInfo();
  const box = el('div', { class: 'tts-kokoro', id: 'tts-kokoro' });
  box.append(el('div', { class: 'tts-label' }, '本地 AI 音色（Kokoro-82M）'));

  if (!info.supported) {
    box.append(el('p', { class: 'tts-note' }, '当前浏览器不支持本地语音模型（需要 WebAssembly + 音频播放）。'));
    return box;
  }

  const stat = el('div', { class: 'kk-status', id: 'kk-status' });
  if (info.loading) stat.textContent = '正在下载模型…';
  else if (info.ready) stat.textContent = `已就绪 · ${info.device === 'webgpu' ? 'WebGPU 加速' : 'WebAssembly'}${isKokoroBroken() ? ' · 本次会话已停用' : ''}`;
  else if (info.error) stat.textContent = `上次加载失败：${info.error}`;
  else stat.textContent = '未启用';
  box.append(stat);

  box.append(el('div', { class: 'kk-progress', id: 'kk-progress', hidden: true },
    el('div', { class: 'kk-bar', id: 'kk-bar' })));
  box.append(el('div', { class: 'kk-progress-text', id: 'kk-progress-text' }, ''));

  if (!info.ready) {
    // 两句写成两个 p：el() 的多个子串是相邻文本节点，同一行会被连在一起读
    box.append(el('p', { class: 'tts-note' },
      '在浏览器里直接跑，28 个音色（美音 / 英音、男声 / 女声），免费、无需 Key；下载一次之后朗读不再联网。'));
    box.append(el('p', { class: 'tts-note' },
      `首次启用需联网下载${KOKORO_DTYPES[s.kokoro.model] || KOKORO_DTYPES.q8}模型（看网速，通常 1 分钟内）；模型进浏览器缓存，不会重复下载。`));
    box.append(el('button', {
      class: 'btn btn-primary', id: 'kk-download',
      onclick: () => enableKokoro(),
    }, info.loading ? '下载中…' : '下载并启用'));
    updateKokoroProgress();
    return box;
  }

  // 已就绪 → 28 个音色（分组展示，避免和浏览器音色混在一起）
  const cur = s.kokoro.voice || KOKORO_DEFAULT_VOICE;
  const grid = el('div', { class: 'tts-voices kk-voices', id: 'kk-voices' });
  for (const g of kokoroVoicesByGroup()) {
    grid.append(el('div', { class: 'tts-group' }, `${g.label} · ${g.voices.length}`));
    for (const v of g.voices) {
      grid.append(el('div', {
        class: 'tts-voice' + (v.id === cur ? ' on' : ''),
        'data-kvoice': v.id,
        onclick: async () => {
          const now = getSettings();
          await saveSettings({
            kokoro: { voice: v.id },
            engine: now.engine === 'system' ? 'kokoro' : now.engine,
          });
          updateTtsBar();
          openTtsSettings();
        },
      },
        el('span', { class: 'tts-voice-name' }, v.name + (v.rec ? ' ★' : '')),
        el('span', { class: 'tts-voice-lang' }, v.id),
      ));
    }
  }
  box.append(grid);
  const on = preferKokoro();
  const enabled = !!s.kokoro.enabled;
  box.append(el('div', { class: 'kk-actions' },
    el('button', {
      class: 'btn', id: 'kk-preview',
      onclick: () => speak('Reading opens a door that no one can close.'),
    }, '试听当前音色'),
    el('button', {
      class: 'tts-chip' + (on ? ' on' : ''), id: 'kk-use',
      onclick: async () => {
        await saveSettings({ engine: 'kokoro' });
        updateTtsBar();
        openTtsSettings();
      },
    }, on ? '正在使用' : '设为当前引擎'),
    // 模型留在浏览器缓存里，随时可以再开；停用只是不再用它朗读
    el('button', {
      class: 'tts-chip' + (enabled ? ' on' : ''), id: 'kk-toggle',
      onclick: async () => {
        await saveSettings({ kokoro: { enabled: !enabled } });
        updateTtsBar();
        openTtsSettings();
      },
    }, enabled ? '已启用' : '已停用')));
  return box;
}

function field(label, id, value, placeholder, type = 'text') {
  return el('label', { class: 'tts-field' },
    el('span', null, label),
    el('input', { id, type, value: value || '', placeholder }),
  );
}

// ---------- 导航 ----------
export function bindReaderUI() {
  $('#btn-back').onclick = () => { stopReadAlong(); location.hash = '#/shelf'; };
  $('#btn-prev-ch').onclick = () => { renderChapter(chIdx - 1); window.scrollTo(0, 0); };
  $('#btn-next-ch').onclick = () => { renderChapter(chIdx + 1); window.scrollTo(0, 0); };
  $('#btn-font-plus').onclick = () => setFont(+1);
  $('#btn-font-minus').onclick = () => setFont(-1);
  $('#btn-bookmark').onclick = () => addBookmark();
  $('#btn-bookmark-list').onclick = () => showBookmarkList();
  $('#btn-tts').onclick = () => toggleReadAlong();
  $('#feature-tip-close').onclick = () => dismissFeatureTip();
  $('#reader-content').addEventListener('click', onTokenClick);
  $('#sheet-backdrop').onclick = () => openSheet(false);
  window.addEventListener('scroll', () => {
    if (currentBook) updateProgress();
  }, { passive: true });

  // 跟读控制条
  $('#tts-play').onclick = () => toggleReadAlong();
  $('#tts-next').onclick = () => readAlong.next().catch(() => {});
  $('#tts-prev').onclick = () => readAlong.prev().catch(() => {});
  $('#tts-stop').onclick = () => stopReadAlong();
  $('#tts-set').onclick = () => openTtsSettings();

  // 切视图 / 切章时收好状态
  window.addEventListener('hashchange', () => requestAnimationFrame(updateTtsBar));
}

/** 语音层初始化：读设置 → 绑事件 → 等音色列表 → 恢复本地模型（命中缓存，不产生下载） */
export async function initTts() {
  await loadSettings();
  bindReadAlong();
  subscribeKokoroProgress();
  const s = getSettings();
  // 只有「上次成功加载过」才在后台恢复：没下载完就进站的用户不该被悄悄吃掉 90MB 流量
  if (s.kokoro.enabled && s.kokoro.warm) {
    ensureKokoro({ model: s.kokoro.model })
      .then(() => warmKokoro(s.kokoro.voice))
      .then(() => updateTtsBar())
      .catch(() => { /* 加载不上就本次会话退浏览器音色，设置面板会如实说明 */ });
  }
  await ttsReady();
  updateTtsBar();
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
