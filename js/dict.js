// dict.js — 词典加载、查询、词形还原
import { morphFallback } from './util.js';

let DICT = null;        // Map: word -> {word, ph, tr, tag, frq}
let LEMMA = null;       // Map: variant -> base
let RANK = null;        // Map: word -> frequency rank (index)
let _vocabCache = null; // Set: 生词本里的词

export async function loadDict(onStatus) {
  if (DICT) return;
  const res = await fetch('data/dict.json');
  if (!res.ok) throw new Error('dict.json 加载失败: ' + res.status);
  const data = await res.json();
  DICT = new Map();
  RANK = new Map();
  data.w.forEach((row, i) => {
    DICT.set(row[0], { word: row[0], ph: row[1], tr: row[2], tag: row[3], frq: row[4] });
    RANK.set(row[0], i);
  });
  LEMMA = new Map(Object.entries(data.lemma));
  if (onStatus) onStatus(`${DICT.size} 词已就绪`);
}

export function dictReady() { return DICT !== null; }

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
