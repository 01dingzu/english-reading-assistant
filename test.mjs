// test.mjs — 核心逻辑冒烟测试（Node 环境，纯逻辑模块）
//
// 原则：lookup / grade 一律 import 生产实现，**不要在这里复刻**。
// 复刻版会和主代码各自演化——主代码改了，测试照样全绿，那是假绿灯。
import { readFileSync } from 'fs';
import { morphFallback, findSentence, highlightInSentence, splitSentences } from './js/util.js';
import { offlineTranslate } from './js/translate.js';
import { initDict, lookup } from './js/dict.js';
import { grade, initSrs } from './js/review.js';

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
};

// ---- 词典查询（真实现 + 真数据）----
console.log('[dict lookup]');
const data = JSON.parse(readFileSync('./data/dict.json', 'utf-8'));
const dictSize = initDict(data);

t('词典规模 >= 30000', dictSize >= 30000);
t('lemma 表规模 >= 30000', Object.keys(data.lemma).length >= 30000);
t('原词查询 perceive', !!lookup('perceive')?.tr?.includes('理解'));
t('大小写 PERCEIVE', lookup('PERCEIVE') !== null);
t('变形 perceived 命中（词条或还原）', ['perceive', 'perceived'].includes(lookup('perceived')?.word));
t('不规则 went -> go', lookup('went')?.word === 'go');
t('复数 wolves -> wolf', lookup('wolves')?.word === 'wolf');
t('比较级 happier -> happy', lookup('happier')?.word === 'happy');
t('ing 形式 reading -> read', lookup('reading') !== null);
t('示例书词汇 ridiculed 可查', lookup('ridiculed') !== null);
t('示例书词汇 famished 可查', lookup('famished') !== null);
t('生僻词查不崩（trellised / zyzzyva）',
  [lookup('trellised'), lookup('zyzzyva')].every(r => r === null || typeof r.word === 'string'));
t('还原词会带回原形信息', (() => {
  const r = lookup('perceived');
  return r && (r.word === 'perceive' ? r.variant === 'perceived' : true);
})());

// ---- 句子定位 ----
console.log('[sentence]');
const para = 'He thus addressed him: "Sirrah, last year you grossly insulted me." "Indeed," bleated the lamb.';
const s1 = findSentence(para, 'insulted');
t('找到包含 insulted 的句子', s1.includes('insulted'));
const [a, hit, b] = highlightInSentence(s1, 'insulted');
t('高亮命中', hit === 'insulted' && a.endsWith(' '));
t('splitSentences 拆出 2 句（引号后切分）', splitSentences(para).length === 2);
t('splitSentences 第二句为引语', splitSentences(para)[1].includes('"Indeed,"'));
t('morphFallback 兜底规则', morphFallback('happier') === 'happi' || morphFallback('happier').length >= 3);

// ---- 离线直译 ----
console.log('[translate offline]');
const ot = offlineTranslate('The quick brown fox jumps over the lazy dog.');
t('离线直译产出中文', ot.includes('这') && ot.includes('越过'));
t('离线直译保留英文标点', ot.endsWith('.'));
// 注意：这两条以前是「未收录词原样保留」——它长期是绿的，因为旧版测试没初始化
// dict.js 的词典，glossOf 查不到任何词，于是"所有词都原样保留"。词典真加载后
// 才暴露出来：已收录词必须被译掉，未收录词才该原样留下。
t('已收录词被译成中文', ot.includes('狐狸'));
t('未收录词原样保留', offlineTranslate('A zyzzyva appeared.').includes('zyzzyva'));
t('空串安全', offlineTranslate('') === '');

// ---- SM-2（真实现）----
console.log('[sm-2]');
let srs = initSrs();
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
