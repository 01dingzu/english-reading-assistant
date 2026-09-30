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
  // Web API / 类型化数组（本地语音模型、音频编码会用到）
  'Audio', 'AudioContext', 'OffscreenCanvas', 'caches', 'WebAssembly', 'crypto',
  'atob', 'btoa', 'TextDecoder', 'TextEncoder', 'AbortController', 'Event',
  'CustomEvent', 'Worker', 'MediaRecorder', 'Notification', 'Image',
  'ArrayBuffer', 'DataView', 'Int16Array', 'Uint8Array', 'Float32Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'URLSearchParams', 'FormData', 'Headers', 'Request', 'Response',
]);

function collectDefs(src) {
  const defined = new Set();
  const add = (name) => name && defined.add(name.trim());

  // function 声明（含 export / async 前缀）
  for (const m of src.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) add(m[1]);
  // const/let/var 声明（含 export、解构）
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{/g)) {
    // 解构声明有四种写法，名字都不在开头：{ a, b: c, d as e, f = 默认值 }。
    // 两个坑：①默认值要剪掉，否则登记进去的名字是整段 "f = 默认值"，真正的 f 反被判成未定义引用；
    //        ②默认值里可能嵌对象（viewport = { width: 390 }），结尾的 } 必须配对找——
    //          老写法 [^}]+ 会在内层 } 处提前收尾，后面的名字整片漏登记（setup 就这么漏过）。
    const start = m.index + m[0].length - 1;
    let depth = 0, end = -1;
    for (let j = start; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) continue;
    src.slice(start + 1, end).replace(/[{}]/g, ' ').split(',').forEach((s) =>
      add(s.trim().split(/\s+as\s+/).pop().split('=')[0].split(':').pop().trim()));
  }
  // class 声明
  for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // class 体内的成员方法（async / static / get / set / *）——它们长得像函数调用，
  // 不登记就会被当成「未定义引用」（Speaker._loop / setItems 曾整片误报）。
  // 名字可省：`window.Audio = class { constructor(){} play(){} }` 是匿名类表达式，
  // 老的 `class\s+名字` 只认带名字的，匿名类的方法会整片误报。
  for (const cm of src.matchAll(/\bclass\b[^{]*\{/g)) {
    let depth = 0, start = cm.index + cm[0].length - 1, end = -1;
    for (let j = start; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) continue;
    const body = src.slice(start, end);
    for (const m of body.matchAll(/(?:^|\n)\s*(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) add(m[1]);
  }
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
  // 参数里的解构：function f(a, { rate, onError } = {}) —— 这些也是定义
  for (const m of src.matchAll(/\(([^()]{0,300})\)/g)) {
    for (const d of m[1].matchAll(/\{([^{}]{1,200})\}/g)) {
      d[1].split(',').forEach(p => add(p.trim().split(/[:=]/)[0].trim()));
    }
  }
  return defined;
}

let fail = 0;
for (const path of process.argv.slice(2)) {
  const src = readFileSync(path, 'utf-8');
  const defined = collectDefs(src);

  // 去掉注释与字符串字面量，再抹掉 obj.method( 形式的成员调用。
  //
  // 字符串匹配必须带上转义分支 `\\.`：老写法 `'[^'\n]*'` 遇到正文里的撇号
  // （don't / it's）会把「一个字符串的结束引号」和「下一个字符串的开始引号」配成一对，
  // 从中间吞掉一大段代码、又漏出一段数据出来，于是 js/finance-samples.js 这种
  // 塞满了英文原文的文件会整片误报——报得太多等于没报。
  const cleaned = src
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g,
      (match) => (/^["'`]/.test(match) ? '""' : ' '))
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
