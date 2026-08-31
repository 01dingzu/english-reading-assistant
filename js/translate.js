// translate.js — 句子翻译（在线 API + 离线直译回退 + kv 缓存）
import { TOKEN_RE } from './util.js';
import { lookup } from './dict.js';
import { kv } from './db.js';

// 高频功能词表：让离线直译更接近"可读的中文"（优先于词典释义）
const GLOSS = {
  the: '这', a: '一个', an: '一个', of: '的', to: '去/向', in: '在…里',
  on: '在…上', at: '在', for: '为了', with: '和/带着', and: '和', or: '或',
  is: '是', are: '是', was: '曾是', were: '曾是', be: '是', been: '曾是',
  being: '正在', am: '是', do: '做', does: '做', did: '做了', have: '有',
  has: '有', had: '有过', will: '将', would: '会', can: '能', could: '能',
  may: '可能', might: '也许', must: '必须', shall: '将要', should: '应该',
  not: '不', no: '不', yes: '是', i: '我', you: '你', he: '他', she: '她',
  it: '它', we: '我们', they: '他们', me: '我', him: '他', her: '她',
  us: '我们', them: '他们', my: '我的', your: '你的', his: '他的', her: '她的',
  our: '我们的', their: '他们的', this: '这个', that: '那个', these: '这些',
  those: '那些', who: '谁', what: '什么', which: '哪个', when: '何时',
  where: '哪里', why: '为什么', how: '如何', if: '如果', because: '因为',
  but: '但是', so: '所以', then: '然后', than: '比', very: '很', more: '更多',
  most: '最多', as: '作为', by: '由/通过', from: '从', about: '关于',
  into: '进入', over: '越过', under: '在…下', after: '在…之后',
  before: '在…之前', up: '向上', down: '向下', out: '出去', all: '所有',
  some: '一些', any: '任何', many: '许多', much: '很多', little: '少量',
  just: '只是', also: '也', only: '只有', one: '一', two: '二', three: '三',
  first: '第一', last: '最后', now: '现在', here: '这里', there: '那里',
  again: '再次', well: '好', good: '好', bad: '坏', great: '很棒', big: '大',
  small: '小', new: '新', old: '旧', long: '长', short: '短', high: '高',
  low: '低', same: '相同', other: '其他', another: '另一个', every: '每个',
  own: '自己的', said: '说', say: '说', make: '做/使', made: '做了',
  get: '得到', got: '得到', see: '看到', saw: '看到', come: '来', came: '来了',
  go: '去', went: '去了', know: '知道', knew: '知道', think: '认为',
  thought: '认为', take: '拿/花', took: '拿了', give: '给', gave: '给了',
  find: '找到', found: '找到', tell: '告诉', told: '告诉了', ask: '问',
  asked: '问了', want: '想要', wanted: '想要', need: '需要', needed: '需要',
  like: '喜欢', love: '爱', work: '工作', worked: '工作了', live: '生活/居住',
  lived: '生活过', money: '钱', time: '时间', year: '年', day: '天',
  man: '男人', woman: '女人', people: '人们', world: '世界', life: '生活',
  way: '方式', thing: '东西', things: '东西', business: '生意/商业',
  market: '市场', price: '价格', prices: '价格', stock: '股票', stocks: '股票',
  share: '股份/份额', shares: '股份', company: '公司', companies: '公司',
  trade: '交易', trading: '交易', profit: '利润', loss: '亏损', gain: '收益',
  value: '价值', worth: '值得', buy: '买', bought: '买了', sell: '卖',
  sold: '卖了', hold: '持有', held: '持有', invest: '投资', invested: '投资了',
  investment: '投资', investor: '投资者', investors: '投资者', capital: '资本',
  interest: '利息/兴趣', rate: '比率/利率', rates: '比率',   risk: '风险',
  rich: '富有', poor: '贫穷',
};

// 取词的一个简洁中文释义（优先取第一行第一段）
function glossOf(word) {
  const w = word.toLowerCase().replace(/[’]/g, "'");
  if (GLOSS[w]) return GLOSS[w];
  const entry = lookup(w);
  if (!entry) return '';
  const line = (entry.tr || '').split('\n')[0];
  if (!line) return '';
  // 释义行形如 "n. 金钱；财富" 或 "vt. 花费；度过" → 去掉词性前缀
  const m = line.match(/^(?:[a-z]+\.\s*)?(.*)$/);
  const zh = (m ? m[1] : line).split(/[；;]/)[0].trim();
  return zh || line;
}

// 离线词对词直译：保留标点与未收录词，词序不变
export function offlineTranslate(text) {
  if (!text) return '';
  let out = '';
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m.index > last) out += text.slice(last, m.index);
    const w = m[0];
    const zh = glossOf(w);
    out += zh || w;
    last = m.index + w.length;
  }
  if (last < text.length) out += text.slice(last);
  return out;
}

// 在线翻译（MyMemory 免费接口：CORS 开放、无需 key、单次 ≤500 字符较稳妥）
async function onlineTranslate(text) {
  const q = encodeURIComponent(text.slice(0, 500));
  const res = await fetch(
    `https://api.mymemory.translated.net/get?q=${q}&langpair=en|zh-CN`,
    { headers: { 'Accept': 'application/json' } }
  );
  if (!res.ok) throw new Error('translate http ' + res.status);
  const data = await res.json();
  const t = data && data.responseData && data.responseData.translatedText;
  if (!t || (data.responseStatus && Number(data.responseStatus) !== 200)) {
    throw new Error('translate rejected');
  }
  return t;
}

const cachePrefix = 'tr:';

// 对外主入口：先缓存 → 在线 → 离线回退（结果一律缓存）
export async function translateSentence(text) {
  const src = (text || '').trim();
  if (!src) return { text: '', offline: false, fromCache: false };

  const cached = await kv.get(cachePrefix + src).catch(() => null);
  if (cached) return { text: cached, offline: false, fromCache: true };

  let t = null, offline = false;
  try {
    t = await onlineTranslate(src);
    if (!t || t.toLowerCase() === src.toLowerCase()) throw new Error('noop');
  } catch (e) {
    offline = true;
    t = offlineTranslate(src);
  }
  await kv.set(cachePrefix + src, t).catch(() => {});
  return { text: t, offline, fromCache: false };
}

// 清空翻译缓存（词典重装等场景用）
export async function clearTranslateCache() {
  // kv 无遍历 API，直接重建不可行——保留，按 key 覆盖即可
}
