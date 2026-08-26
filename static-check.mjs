// static-check.mjs — 检查模块内调用的函数是否都有定义（防止 bindWordsUI 那种运行时 ReferenceError）
// 用法: node static-check.mjs <file.js> ...
import { readFileSync } from 'node:fs';

const BUILTIN = new Set([
  // JS 关键词与保留字
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'new',
  'await', 'async', 'var', 'let', 'const', 'of', 'in', 'else', 'do', 'try', 'finally',
  'throw', 'delete', 'instanceof', 'void', 'yield', 'class', 'extends', 'super',
  'import', 'export', 'default', 'from', 'as', 'get', 'set', 'static',
  // 浏览器/Node 全局
  'fetch', 'console', 'confirm', 'alert', 'prompt', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'Number', 'String', 'Boolean', 'Array', 'Object',
  'Map', 'Set', 'Promise', 'JSON', 'Math', 'Date', 'RegExp', 'Error', 'parseInt',
  'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'require',
  'document', 'window', 'location', 'navigator', 'speechSynthesis', 'SpeechSynthesisUtterance',
  'DOMParser', 'indexedDB', 'IDBKeyRange', 'JSZip', 'URL', 'Blob', 'File', 'FileReader',
  'process', 'module', 'exports', 'arguments', 'structuredClone', 'queueMicrotask',
  'requestAnimationFrame', 'getComputedStyle', 'localStorage', 'performance',
]);

function collectDefs(src) {
  const defined = new Set();
  const add = (name) => name && defined.add(name.trim());

  // function 声明（含 export / async 前缀）
  for (const m of src.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) add(m[1]);
  // const/let/var 声明（含 export、解构）
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}/g))
    m[1].split(',').forEach(s => add(s.trim().split(/\s+as\s+/).pop()));
  // class 声明
  for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // import 绑定
  for (const m of src.matchAll(/import\s+(?:\*\s+as\s+([A-Za-z_$][\w$]*)|\{([^}]+)\})?\s*(?:from|;)/g)) {
    if (m[1]) add(m[1]);
    if (m[2]) m[2].split(',').forEach(s => add(s.trim().split(/\s+as\s+/).pop()));
  }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) add(m[1]);
  // 箭头函数赋值
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:=\s*(?:async\s+)?)?\([^)]*\)\s*=>/g)) add(m[1]);
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/g)) add(m[1]);
  // 函数参数名（宽松：全部标识符在 ( ... ) 内的第一层）——抓 resolve/reject/fn/onStatus 这类
  for (const m of src.matchAll(/\(([^()]{0,200})\)\s*(?:=>|\{)/g)) {
    if (!/[=;]/.test(m[1])) m[1].split(',').forEach(p => add(p.trim().split(/[:=]/)[0].trim()));
  }
  // 标签/属性简写对象 { name }
  for (const m of src.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*[,}]/g)) add(m[1]);
  return defined;
}

let fail = 0;
for (const path of process.argv.slice(2)) {
  const src = readFileSync(path, 'utf-8');
  const defined = collectDefs(src);

  // 去掉 obj.method( 形式的成员调用、字符串、注释
  const cleaned = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, '""')
    .replace(/\b[A-Za-z_$][\w$]*\s*\.\s*[\w$]+\s*\(/g, '(');

  const called = new Map();
  const lines = cleaned.split('\n');
  lines.forEach((ln, i) => {
    for (const m of ln.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!called.has(m[1])) called.set(m[1], i + 1);
    }
  });

  const missing = [...called.entries()].filter(([n]) => !defined.has(n) && !BUILTIN.has(n));
  if (missing.length) {
    fail++;
    console.log(`✗ ${path}`);
    for (const [n, line] of missing) console.log(`   未定义引用: ${n}  (line ${line})`);
  } else {
    console.log(`✓ ${path}`);
  }
}
process.exit(fail ? 1 : 0);
