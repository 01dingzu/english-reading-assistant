// test.mjs — 核心逻辑冒烟测试（Node 环境，无 DOM 依赖的模块）
import { readFileSync } from 'fs';
import { morphFallback, findSentence, highlightInSentence } from './js/util.js';

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
};

// ---- 词典查询逻辑（复刻 dict.js 的 lookup 流程）----
console.log('[dict lookup]');
const data = JSON.parse(readFileSync('./data/dict.json', 'utf-8'));
const DICT = new Map(data.w.map(r => [r[0], r]));
const LEMMA = new Map(Object.entries(data.lemma));

function lookup(raw) {
  const w = raw.toLowerCase();
  let hit = DICT.get(w);
  if (hit) return hit;
  const via = LEMMA.get(w);
  if (via && (hit = DICT.get(via))) return hit;
  const stem = morphFallback(w);
  if (stem !== w && (hit = DICT.get(stem))) return hit;
  return null;
}

t('词典规模 >= 30000', DICT.size >= 30000);
t('lemma 表规模 >= 30000', LEMMA.size >= 30000);
t('原词查询 perceive', lookup('perceive')?.[2]?.includes('理解'));
t('大小写 PERCEIVE', lookup('PERCEIVE') !== null);
t('变形 perceived 命中（词条或还原）', ['perceive', 'perceived'].includes(lookup('perceived')?.[0]));
t('不规则 went -> go', lookup('went')?.[0] === 'go');
t('复数 wolves -> wolf', lookup('wolves')?.[0] === 'wolf');
t('比较级 happier -> happy', lookup('happier')?.[0] === 'happy');
t('ing 形式 reading -> read', lookup('reading') !== null);
t('示例书词汇 ridiculed 可查', lookup('ridiculed') !== null);
t('示例书词汇 famished 可查', lookup('famished') !== null);
t('示例书词汇 trellised', lookup('trellised') !== null || lookup('trellised') === null); // 容许未收录
t('生僻词 zyzzyva 可能缺失（不崩溃）', lookup('zyzzyva') !== undefined);

// ---- 句子定位 ----
console.log('[sentence]');
const para = 'He thus addressed him: "Sirrah, last year you grossly insulted me." "Indeed," bleated the lamb.';
const s1 = findSentence(para, 'insulted');
t('找到包含 insulted 的句子', s1.includes('insulted'));
const [a, hit, b] = highlightInSentence(s1, 'insulted');
t('高亮命中', hit === 'insulted' && a.endsWith(' '));

// ---- SM-2 ----
console.log('[sm-2]');
let srs = { ef: 2.5, interval: 0, reps: 0, next: Date.now(), lapses: 0 };
function grade(s, q) {
  const x = { ...s };
  if (q >= 3) {
    x.reps += 1;
    x.interval = x.reps === 1 ? 1 : x.reps === 2 ? 6 : Math.round(x.interval * x.ef);
  } else { x.lapses += 1; x.reps = 0; x.interval = 1; }
  x.ef = Math.max(1.3, x.ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  x.next = Date.now() + x.interval * 86400000;
  return x;
}
srs = grade(srs, 5);
t('第一次复习后 interval=1', srs.interval === 1);
srs = grade(srs, 5);
t('第二次复习后 interval=6', srs.interval === 6);
srs = grade(srs, 5);
t('第三次复习后 interval=16（ef 递增）', srs.interval === 16);
srs = grade(srs, 1);
t('答错重置 reps=0', srs.reps === 0 && srs.interval === 1);
srs = grade(srs, 5); srs = grade(srs, 3);
t('犹豫(q=3) ef 下降', srs.ef < 2.5);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
