// importer.js — TXT/EPUB 导入 + 难度估算
import { TOKEN_RE } from './util.js';
import { books, chapters } from './db.js';
import { lookup, isCommonWord } from './dict.js';
import { toast } from './util.js';

const CH_RE = /^\s*(chapter|part|book|prologue|epilogue|scene|act)\b/i;

// ---------- TXT ----------
function parseTxt(text, filename) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chapters = [];
  let cur = { title: '正文', lines: [] };
  for (const ln of lines) {
    const t = ln.trim();
    if (t && t.length < 70 && CH_RE.test(t) && /^[^a-z]*[A-Za-z]/.test(t)) {
      if (cur.lines.some(l => l.trim())) chapters.push(cur);
      cur = { title: t, lines: [] };
    } else {
      cur.lines.push(ln);
    }
  }
  if (cur.lines.some(l => l.trim())) chapters.push(cur);
  return chapters.map(c => ({
    title: c.title,
    // 段落：连续非空行合并？英文书一段一行，空行分段
    text: c.lines.join('\n').split(/\n\s*\n/).map(p => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean),
  }));
}

// ---------- EPUB ----------
async function parseEpub(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  // container.xml -> opf path
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('不是有效的 EPUB 文件');
  const containerXml = await containerFile.async('string');
  const opfPath = containerXml.match(/full-path="([^"]+)"/)?.[1];
  if (!opfPath) throw new Error('EPUB 结构异常');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const opfXml = await zip.file(opfPath).async('string');

  // 元数据（dc: 前缀标签用正则提取更可靠）
  const title = opfXml.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/)?.[1]?.trim();
  const author = opfXml.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/)?.[1]?.trim();

  // manifest id -> href（item 标签无命名空间前缀，可安全用正则）
  const manifest = new Map();
  for (const m of opfXml.matchAll(/<item\s[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*\/?>(?:<\/item>)?/g)) {
    manifest.set(m[1], m[2]);
  }
  for (const m of opfXml.matchAll(/<item\s[^>]*href="([^"]+)"[^>]*id="([^"]+)"[^>]*\/?>(?:<\/item>)?/g)) {
    if (!manifest.has(m[2])) manifest.set(m[2], m[1]);
  }
  const spineRefs = [...opfXml.matchAll(/<itemref\s[^>]*idref="([^"]+)"[^>]*\/?>/g)]
    .map(m => manifest.get(m[1]))
    .filter(Boolean);

  const out = [];
  for (const href of spineRefs) {
    const path = opfDir + decodeURIComponent(href);
    const file = zip.file(path) || zip.file(path.replace(/^\//, ''));
    if (!file) continue;
    const html = await file.async('string');
    const parser = new DOMParser();
    const dom = parser.parseFromString(html, 'text/html');
    // 去掉脚本样式
    dom.querySelectorAll('script,style').forEach(n => n.remove());
    const blocks = [...dom.body.querySelectorAll('h1,h2,h3,h4,p,blockquote,li')]
      .map(n => n.textContent.replace(/\s+/g, ' ').trim())
      .filter(t => t.length > 1);
    if (!blocks.length) continue;
    const chTitle = dom.body.querySelector('h1,h2,h3')?.textContent?.trim() || `第 ${out.length + 1} 节`;
    out.push({ title: chTitle.slice(0, 60), text: blocks });
  }
  return { title, author, chapters: out };
}

// ---------- 难度估算 ----------
function analyze(chapterList) {
  const uniq = new Map();  // lemma-ish -> count
  let total = 0;
  for (const ch of chapterList) {
    const text = ch.text.join(' ');
    for (const m of text.matchAll(TOKEN_RE)) {
      total++;
      const w = m[0].toLowerCase();
      uniq.set(w, (uniq.get(w) || 0) + 1);
    }
  }
  let newish = 0;
  for (const w of uniq.keys()) {
    if (!isCommonWord(w, 6000)) newish++;
  }
  const rate = uniq.size ? newish / uniq.size : 0;   // 按 unique 词算生词率
  const level = rate < 0.06 ? 'easy' : rate < 0.14 ? 'mid' : 'hard';
  return { words: total, uniqueWords: uniq.size, newRate: +rate.toFixed(3), level };
}

export async function importFile(file) {
  const name = file.name;
  try {
    let title = name.replace(/\.(txt|epub)$/i, '');
    let author = '';
    let chList;

    if (/\.epub$/i.test(name)) {
      const buf = await file.arrayBuffer();
      const parsed = await parseEpub(buf);
      title = parsed.title || title;
      author = parsed.author || '';
      chList = parsed.chapters;
    } else {
      const text = await file.text();
      chList = parseTxt(text, name);
    }

    if (!chList.length) { toast('没解析出内容'); return null; }

    const meta = analyze(chList);
    const book = {
      title: title.slice(0, 80),
      author: author.slice(0, 40),
      format: /\.epub$/i.test(name) ? 'epub' : 'txt',
      chCount: chList.length,
      meta,
      progress: { ch: 0, ratio: 0 },
      addedAt: Date.now(),
    };
    const id = await books.put(book);
    book.id = id;
    for (let i = 0; i < chList.length; i++) {
      await chapters.put({ bookId: id, idx: i, title: chList[i].title, paras: chList[i].text });
    }
    return book;
  } catch (e) {
    console.error(e);
    toast('导入失败：' + (e.message || '文件无法解析'));
    return null;
  }
}

export async function importRawText({ title, author, chaptersRaw }) {
  const chList = chaptersRaw;
  if (!chList.length) return null;
  const meta = analyze(chList);
  const book = {
    title, author: author || '示例',
    format: 'builtin',
    chCount: chList.length,
    meta,
    progress: { ch: 0, ratio: 0 },
    addedAt: Date.now(),
  };
  const id = await books.put(book);
  book.id = id;
  for (let i = 0; i < chList.length; i++) {
    await chapters.put({ bookId: id, idx: i, title: chList[i].title, paras: chList[i].text });
  }
  return book;
}

export { lookup };
