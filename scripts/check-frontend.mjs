#!/usr/bin/env node
/* =========================================================
 * 前端静态预检（部署前运行，不启动浏览器）
 *
 * 解决部署脚本过去只检查 server.js 语法、却看不见前端模块的问题：
 *   1. index.html 引用的本地 JS/CSS 是否真的存在
 *   2. 三个核心模块是否仍被页面加载
 *   3. public/*.js 与 index.html 内联脚本能否通过语法解析
 *
 * 运行：node scripts/check-frontend.mjs
 * ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const INDEX = path.join(PUBLIC_DIR, 'index.html');

/* 页面必须加载的核心模块。新增前端模块时，在这里补一行。
   漏写会导致「index.html 引用了但文件没上传」的情况逃过预检，
   上线后页面报 404 才发现。 */
const REQUIRED_MODULES = [
  '/clinical-core.js',
  '/record-core.js',
  '/cohort-core.js',
  '/export-core.js',
  '/ai-intake-ui.js',
];

let failures = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { console.error(`  ✗ ${msg}`); failures += 1; };

function attr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tag.match(re);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

function localAsset(url) {
  if (!url) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) return null; // http(s)、data:、锚点
  let clean;
  try { clean = decodeURIComponent(url.split(/[?#]/)[0]); } catch { clean = url.split(/[?#]/)[0]; }
  if (!clean || clean === '/') return null;
  const abs = path.resolve(PUBLIC_DIR, clean.replace(/^\/+/, ''));
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) return null;
  return { rel: path.relative(PUBLIC_DIR, abs), abs };
}

if (!fs.existsSync(INDEX)) {
  bad('缺少 public/index.html');
  process.exit(1);
}
const html = fs.readFileSync(INDEX, 'utf8');

/* ---------- 1. 页面引用的本地资源 ---------- */
const refs = [];
for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
  const src = attr(m[0], 'src');
  if (src) refs.push({ kind: 'script', url: src });
}
for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
  const rel = attr(m[0], 'rel');
  const href = attr(m[0], 'href');
  if (rel && /stylesheet/i.test(rel) && href) refs.push({ kind: 'stylesheet', url: href });
}

let missing = 0;
for (const ref of refs) {
  const asset = localAsset(ref.url);
  if (!asset) continue;
  if (!fs.existsSync(asset.abs) || !fs.statSync(asset.abs).isFile()) {
    bad(`${ref.kind === 'script' ? '脚本' : '样式'}不存在：public/${asset.rel}`);
    missing += 1;
  }
}
if (missing === 0) ok(`index.html 引用的 ${refs.length} 个本地资源均存在`);

for (const required of REQUIRED_MODULES) {
  const loaded = refs.some((r) => r.kind === 'script' && (r.url.split(/[?#]/)[0] === required));
  if (!loaded) bad(`页面未加载核心模块：${required}`);
}

/* ---------- 2. public/*.js 语法 ---------- */
const jsFiles = fs.readdirSync(PUBLIC_DIR)
  .filter((f) => f.endsWith('.js') && !f.includes('.bak'))
  .sort();
for (const file of jsFiles) {
  const abs = path.join(PUBLIC_DIR, file);
  const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
  if (r.status === 0) {
    ok(`语法通过：public/${file}`);
  } else {
    const detail = `${r.stderr || r.stdout || ''}`.trim().split('\n').slice(0, 4).join('\n    ');
    bad(`语法错误：public/${file}${detail ? `\n    ${detail}` : ''}`);
  }
}

/* ---------- 3. index.html 内联脚本语法 ---------- */
const inline = [];
for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  const attrs = m[1] || '';
  if (/\bsrc\s*=/i.test(attrs)) continue; // 外链脚本已单独检查
  const type = (attr(`<script ${attrs}>`, 'type') || 'text/javascript').toLowerCase();
  if (!/^(?:text|application)\/(?:java|ecma)script$|^module$/.test(type)) continue;
  inline.push({ attrs, code: m[2], type });
}
if (inline.length === 0) {
  bad('index.html 中没有找到内联脚本（页面逻辑不应为空）');
} else {
  let inlineBad = 0;
  inline.forEach((block, i) => {
    try {
      new vm.Script(block.code, { filename: `index.html#inline-${i + 1}` });
    } catch (e) {
      bad(`内联脚本语法错误（第 ${i + 1} 段）：${e.message}`);
      inlineBad += 1;
    }
  });
  if (inlineBad === 0) ok(`index.html 内联脚本语法通过（${inline.length} 段）`);
}

/* ---------- 汇总 ---------- */
console.log('');
if (failures === 0) {
  console.log(`✅ 前端静态检查通过（${jsFiles.length} 个外部脚本，${inline.length} 段内联脚本）`);
  process.exit(0);
}
console.error(`❌ 前端静态检查失败：${failures} 项，已中止部署`);
process.exit(1);
