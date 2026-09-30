// dict.js — 词典加载、查询、词形还原
import { morphFallback } from './util.js';
import { words } from './db.js';

let DICT = null;        // Map: word -> {word, ph, tr, tag, frq}
let LEMMA = null;       // Map: variant -> base
let RANK = null;        // Map: word -> frequency rank (index)
let _vocabCache = null; // Set: 生词本里的词

/** 用已解析的词典数据初始化。浏览器走 loadDict（fetch），Node 测试直接喂对象 */
export function initDict(data) {
  DICT = new Map();
  RANK = new Map();
  data.w.forEach((row, i) => {
    DICT.set(row[0], { word: row[0], ph: row[1], tr: row[2], tag: row[3], frq: row[4] });
    RANK.set(row[0], i);
  });
  LEMMA = new Map(Object.entries(data.lemma));
  return DICT.size;
}

export async function loadDict(onStatus) {
  if (DICT) return;
  const res = await fetch('data/dict.json');
  if (!res.ok) throw new Error('dict.json 加载失败: ' + res.status);
  initDict(await res.json());
  if (onStatus) onStatus(`${DICT.size} 词已就绪`);
}

// 完整查词：原词 → 词形还原表 → 后备规则
export function lookup(rawWord) {
  if (!DICT) return null;
  const w = rawWord.toLowerCase().replace(/[’]/g, "'");
  let hit = DICT.get(w);
  if (hit) return hit;
  const viaLemma = LEMMA.get(w);
  if (viaLemma && (hit = DICT.get(viaLemma))) {
    return { ...hit, variant: w };
  }
  const stem = morphFallback(w);
  if (stem !== w && (hit = DICT.get(stem))) {
    return { ...hit, variant: w };
  }
  return null;
}

// 估算难度：词频排名 <= topN 视为可能已掌握
export function isCommonWord(word, topN = 6000) {
  if (!RANK) return true;
  const w = word.toLowerCase();
  const r = RANK.get(w) ?? RANK.get(LEMMA.get(w) ?? '') ?? RANK.get(morphFallback(w));
  return r !== undefined && r < topN;
}

// 生词本缓存（阅读器高亮用）
export function setVocabCache(set) { _vocabCache = set; }
export function inVocab(word) { return _vocabCache && _vocabCache.has(word.toLowerCase()); }

/**
 * 重算生词缓存。
 * 放在词典层是刻意的：它管的就是「哪些词在生词本里」。原先它住在 app.js，
 * reader.js 加完生词得 `await import('./app.js')` 反向取用——造成 app ↔ reader 循环依赖。
 */
export async function refreshVocabCache() {
  const all = await words.all();
  setVocabCache(new Set(all.map(r => r.word)));
}
