#!/usr/bin/env node
/**
 * بررسی صحت index.html:
 *  ۱. کد برنامه (app-source) دقیقاً مثل مرورگر با Babel کامپایل می‌شود.
 *  ۲. کد سرور (Code.gs) از نظر syntax بررسی می‌شود.
 *  ۳. هیچ ارجاع dangling به توابع حذف‌شده باقی نمانده باشد.
 *
 *     node tools/verify.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function extractAppSource(text) {
  const startTag = '<script type="text/plain" id="app-source">';
  const i = text.indexOf(startTag);
  if (i < 0) throw new Error('بلوک app-source پیدا نشد');
  const from = i + startTag.length;
  const to = text.indexOf('</script>', from);
  return text.slice(from, to);
}

const src = extractAppSource(html);
let failed = false;

// ---- ۱. کامپایل JSX ----
let Babel;
try {
  Babel = (await import('@babel/standalone')).default;
} catch (e) {
  console.log('⚠ @babel/standalone نصب نیست؛ بررسی JSX رد شد. (npm i @babel/standalone)');
  Babel = null;
}

if (Babel) {
  try {
    Babel.transform(src, {
      presets: [['react', { runtime: 'classic' }], ['env', { modules: false }]],
      filename: 'app.jsx',
    });
    console.log('✔ کد برنامه (JSX) بدون خطا کامپایل شد');
  } catch (e) {
    failed = true;
    console.error('✘ خطای کامپایل JSX:\n' + (e && e.message ? e.message : e));
  }
}

// ---- ۲. syntax کد سرور ----
try {
  const gs = fs.readFileSync(path.join(root, 'Code.gs'), 'utf8');
  fs.writeFileSync('/tmp/_code_gs_check.js', gs);
  const { execSync } = await import('node:child_process');
  execSync('node --check /tmp/_code_gs_check.js', { stdio: 'pipe' });
  console.log('✔ Code.gs از نظر syntax معتبر است');
} catch (e) {
  failed = true;
  console.error('✘ خطای syntax در Code.gs:\n' + (e.stderr ? e.stderr.toString() : e.message));
}

// ---- ۳. ارجاع‌های dangling ----
const declared = new Set();
for (const m of src.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
for (const m of src.matchAll(/(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
for (const m of src.matchAll(/const\s*\{([^}]+)\}\s*=\s*React/g)) {
  m[1].split(',').forEach(x => declared.add(x.trim()));
}
const globals = new Set(['window', 'document', 'navigator', 'console', 'localStorage', 'sessionStorage',
  'indexedDB', 'crypto', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'React', 'ReactDOM', 'XLSX', 'qrcode', 'Html5Qrcode', 'alert', 'confirm', 'prompt', 'Image',
  'Blob', 'FileReader', 'TextEncoder', 'URL', 'Date', 'Math', 'JSON', 'Object', 'Array', 'String',
  'Number', 'Boolean', 'Map', 'Set', 'Promise', 'Error', 'RegExp', 'parseInt', 'parseFloat',
  'isNaN', 'isFinite', 'structuredClone', 'Uint8Array', 'require', 'process', 'globalThis']);

const suspicious = ['cloudPush', 'cloudPull', 'DEFAULT_CLOUD_API_KEY'];
suspicious.forEach(name => {
  const re = new RegExp('\\b' + name + '\\b', 'g');
  const uses = (src.match(re) || []).length;
  const isDeclared = declared.has(name);
  if (uses && !isDeclared) {
    failed = true;
    console.error(`✘ ارجاع به «${name}» وجود دارد ولی تعریف نشده است (${uses} مورد)`);
  } else if (uses === 0) {
    console.log(`✔ دیگر ارجاعی به «${name}» وجود ندارد`);
  }
});

// ---- ۴. کلید API نباید در فایل باشد ----
const keyMatch = src.match(/const DEFAULT_CLOUD_API_KEY\s*=\s*'([^']+)'/);
if (keyMatch && keyMatch[1].trim()) {
  failed = true;
  console.error('✘ کلید API داخل فایل جاسازی شده است!');
} else {
  console.log('✔ هیچ کلید API ای داخل فایل جاسازی نشده است');
}

// ---- ۵. بلوک‌های @core برای تست ----
const cores = [...src.matchAll(/\/\* @core-start: ([\w-]+) \*\//g)].map(m => m[1]);
const ends = [...src.matchAll(/\/\* @core-end: ([\w-]+) \*\//g)].map(m => m[1]);
if (cores.join(',') !== ends.join(',')) {
  failed = true;
  console.error(`✘ بلوک‌های @core ناقص‌اند: start=[${cores}] end=[${ends}]`);
} else {
  console.log(`✔ بلوک‌های هسته برای تست: ${cores.join(', ')}`);
}

// ---- ۶. کلاس‌های رنگ Tailwind که در پالت تعریف نشده‌اند ----
// Tailwind برای رنگ ناشناخته هیچ کلاسی تولید نمی‌کند، پس این اشتباه بی‌صداست:
// عنصر رندر می‌شود ولی بدون رنگ. قبلاً warn-200 و danger-600 همین‌طور خراب بودند.
{
  // استخراج بلوک colors با شمارش آکولاد (رگ‌اکس به تورفتگی حساس است و
  // اولین «}» داخلی را به‌اشتباه پایان بلوک می‌گیرد).
  function extractColorsBlock(text) {
    const start = text.indexOf('colors: {');
    if (start < 0) return null;
    let i = text.indexOf('{', start);
    let depth = 0;
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
    return null;
  }
  const cfgMatch = extractColorsBlock(html);
  const defined = new Set();
  if (cfgMatch) {
    // نام پالت + سایه‌هایی که داخل بلوکش تعریف شده.
    // [^{}]* عمدی است: باعث می‌شود فقط بلوک «برگ» مچ شود و کلید بیرونی
    // «colors: {» (که محتوایش آکولاد دارد) پالت‌های داخلی را نبلعد.
    for (const pm of cfgMatch.matchAll(/(\w+):\s*\{([^{}]*)\}/g)) {
      const palette = pm[1];
      for (const sm of pm[2].matchAll(/(\d+)\s*:/g)) defined.add(`${palette}-${sm[1]}`);
    }
  }

  const used = new Set();
  for (const m of src.matchAll(/\b(brand|ok|warn|danger|slate)-(\d{2,3})\b/g)) {
    if (m[1] === 'slate') continue; // پالت پیش‌فرض Tailwind
    used.add(`${m[1]}-${m[2]}`);
  }

  const missing = [...used].filter(c => !defined.has(c)).sort();
  if (!cfgMatch) {
    console.log('⚠ بلوک colors در tailwind.config پیدا نشد؛ بررسی رنگ رد شد.');
  } else if (missing.length) {
    failed = true;
    console.error(`✘ کلاس رنگ استفاده‌شده ولی تعریف‌نشده (بدون رنگ رندر می‌شود): ${missing.join(', ')}`);
  } else {
    console.log(`✔ همه‌ی ${used.size} کلاس رنگ استفاده‌شده در پالت تعریف شده‌اند`);
  }
}

// ---- ۷. همه‌ی منابع CDN باید واقعاً در دسترس باشند ----
// پیش‌تر immer@10.1.1/dist/immer.umd.production.min.js خطای ۴۰۴ می‌داد و چون
// بارگذاری <script> شکست‌نشدنیِ بی‌صداست، window.immer هرگز تعریف نمی‌شد.
// با `--no-net` می‌توان این بررسی را رد کرد.
if (!process.argv.includes('--no-net')) {
  const urls = [...new Set([...html.matchAll(/https:\/\/[^"'\s)]+\.(?:js|css)/g)].map(m => m[0]))];
  const bad = [];
  for (const u of urls) {
    try {
      const res = await fetch(u, { method: 'HEAD', redirect: 'follow' });
      // بعضی CDNها HEAD را پشتیبانی نمی‌کنند؛ در آن صورت با GET باز بررسی می‌کنیم
      const ok = res.ok || (res.status === 405 && (await fetch(u, { method: 'GET' })).ok);
      if (!ok) bad.push(`${u} → HTTP ${res.status}`);
    } catch (e) {
      bad.push(`${u} → ${e.message}`);
    }
  }
  if (bad.length) {
    failed = true;
    console.error('✘ منبع CDN در دسترس نیست:\n   ' + bad.join('\n   '));
  } else {
    console.log(`✔ همه‌ی ${urls.length} منبع CDN پاسخ ۲۰۰ دادند`);
  }
}

// ---- ۸. خروجی deploy نباید از منبع عقب مانده باشد ----
// این بررسی به Babel نیاز ندارد و همیشه اجرا می‌شود: فقط مهرِ هشِ منبعی را که
// build داخل خروجی گذاشته با منبع فعلی مقایسه می‌کند. بدون این، تنها نشانه‌ی
// «build نزدم» این بود که کاربر نهایی رفتار قدیمی ببیند.
{
  const deployPath = path.join(root, 'deploy', 'index.html');
  const srcTag = '<script type="text/plain" id="app-source">';
  const si = html.indexOf(srcTag);
  const jsx = si < 0 ? null : html.slice(si + srcTag.length, html.indexOf('</script>', si));
  if (jsx === null) {
    failed = true;
    console.error('✘ بلوک app-source در index.html پیدا نشد.');
  } else if (!fs.existsSync(deployPath)) {
    failed = true;
    console.error('✘ deploy/index.html وجود ندارد — `npm run build` را اجرا کنید.');
  } else {
    const want = crypto.createHash('sha256').update(jsx, 'utf8').digest('hex').slice(0, 16);
    const got = (fs.readFileSync(deployPath, 'utf8').match(/<!--@build-src-hash:([0-9a-f]+)-->/) || [])[1];
    if (got !== want) {
      failed = true;
      console.error(`✘ deploy/index.html از index.html عقب است (مهر ${got || 'ندارد'} ≠ ${want}).\n` +
        '   `npm run build` را بزنید، وگرنه فایلی که میزبانی می‌کنید نسخه‌ی قدیمی است.');
    } else {
      console.log('✔ deploy/index.html با منبع همگام است (مهر ' + want + ')');
    }
  }
}

process.exit(failed ? 1 : 0);
