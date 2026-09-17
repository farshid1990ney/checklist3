#!/usr/bin/env node
/**
 * دو کار انجام می‌دهد و هر دو idempotent است:
 *
 *   ۱. کد سرور (Code.gs) را داخل index.html جاسازی می‌کند تا دکمه‌ی «کپی کد
 *      سرور» در صفحه تنظیمات کار کند.
 *   ۲. کتابخانه‌های `vendor/` را داخل markerهای `<!--@vendor:NAME-->` جاسازی
 *      می‌کند تا وابستگی حیاتی اپ به CDNهای خارجی حذف شود (رفع ایراد #18).
 *
 *   ۳. نسخه‌ی «آماده‌ی استقرار» را در `deploy/index.html` می‌سازد: JSX با Babel
 *      از پیش کامپایل می‌شود تا مرورگر دیگر نیازی به دانلود babel.min.js
 *      (~۲٫۳ مگابایت) و کامپایل در زمان اجرا (~۱٫۵ تا ۷ ثانیه) نداشته باشد.
 *
 *     node tools/build.mjs
 *
 * اگر فایل vendor را به‌روز کردید، کافی است همین دستور را دوباره بزنید.
 *
 * ⚠️ برای استقرار از `deploy/index.html` استفاده کنید، نه `index.html`.
 *    فایل `index.html` منبع توسعه است (JSX خام + تگ Babel) و تست‌ها از همان
 *    بلوک‌های `@core` می‌خوانند.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const gsPath = path.join(root, 'Code.gs');
const htmlPath = path.join(root, 'index.html');

const gs = fs.readFileSync(gsPath, 'utf8');
let html = fs.readFileSync(htmlPath, 'utf8');

/* ---------------------------------------------------------------------------
   ۱) جاسازی کتابخانه‌های vendor
   --------------------------------------------------------------------------- */
// این دو کتابخانه حیاتی‌اند: بدون qrcode کل صفحه‌ی تجهیزات/بارکد می‌میرد و
// بدون immer اپ به مسیر کندِ کپی کامل JSON بازمی‌گردد. هر دو کوچک‌اند، پس
// جاسازی‌شان به‌جای تکیه بر CDN منطقی است.
const VENDOR = [
  { name: 'immer', file: 'vendor/immer.umd.production.min.js', global: 'immer',
    note: 'immer 9.0.21 (UMD production) — آخرین نسخه‌ای که build UMD دارد' },
  { name: 'qrcode-generator', file: 'vendor/qrcode-generator.js', global: 'qrcode',
    note: 'qrcode-generator 1.4.4 — تولید وکتور SVG بارکد' },
  // React + ReactDOM حیاتیِ مطلق‌اند: بدون‌شان کل اپ صفحه‌ی سفید نشان می‌دهد.
  // برخلاف تصور اولیه، حجم این دو (production UMD، نه development) کوچک است
  // (~۱۴۰ کیلوبایت جمعاً، نه ۳٫۵ مگابایت — آن رقم برای Babel standalone بود)
  // پس جاسازی‌شان به‌صرفه است و دیگر بوت اپ به unpkg/jsdelivr گره نمی‌خورد.
  // Babel standalone عمداً همچنان CDN می‌ماند: فقط در index.html خامِ توسعه
  // استفاده می‌شود (برای تدوین/دیباگ محلی)، در deploy/index.html به‌طور کامل
  // حذف می‌شود چون JSX از پیش در زمان build کامپایل شده است.
  { name: 'react', file: 'vendor/react.production.min.js', global: 'React',
    note: 'react 18.3.1 (UMD production)' },
  { name: 'react-dom', file: 'vendor/react-dom.production.min.js', global: 'ReactDOM',
    note: 'react-dom 18.3.1 (UMD production)' },
];

for (const lib of VENDOR) {
  const start = `<!--@vendor:${lib.name}-->`;
  const end = `<!--@/vendor:${lib.name}-->`;
  const i = html.indexOf(start);
  const j = html.indexOf(end);
  if (i < 0 || j < 0) throw new Error(`markerهای vendor برای «${lib.name}» در index.html پیدا نشدند.`);

  const file = path.join(root, lib.file);
  if (!fs.existsSync(file)) throw new Error(`فایل vendor موجود نیست: ${lib.file}`);
  let code = fs.readFileSync(file, 'utf8');

  // اگر کد شامل رشته‌ی بسته‌کننده‌ی تگ یا کامنت HTML باشد، جاسازی‌اش HTML را
  // می‌شکند. به‌جای حدس زدن، صریح بررسی و رد می‌کنیم.
  if (/<\/script/i.test(code) || code.includes('<!--')) {
    throw new Error(`محتوای ${lib.file} شامل توالی ممنوعه برای جاسازی در HTML است.`);
  }

  const block = `${start}
<script>/* ${lib.note} — جاسازی‌شده از ${lib.file} توسط tools/build.mjs */
${code.trim()}
</script>
`;
  html = html.slice(0, i) + block + html.slice(j);
  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  console.log(`✔ ${lib.name} (${kb(code.length)}) جاسازی شد`);
}

const START = '/*__CODE_GS_START__*/';
const END = '/*__CODE_GS_END__*/';
const i = html.indexOf(START);
const j = html.indexOf(END);
if (i < 0 || j < 0) throw new Error('نشانگرهای جاسازی (/*__CODE_GS_START__*/ … /*__CODE_GS_END*/) در index.html پیدا نشدند.');

// برای قرار گرفتن داخل template literal: backtick و ${ باید escape شوند
const escaped = gs.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const block = `${START}
// کد کامل Google Apps Script (نسخه ۸ — پایگاه Google Sheets) که در صفحه تنظیمات
// قابل کپی است. این بلوک به‌طور خودکار از فایل Code.gs تولید می‌شود:
//     node tools/build.mjs
const APPS_SCRIPT_CODE = \`${escaped}\`;
`;

html = html.slice(0, i) + block + html.slice(j);
fs.writeFileSync(htmlPath, html, 'utf8');

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log(`✔ Code.gs (${kb(gs.length)}) داخل index.html جاسازی شد → ${kb(html.length)}`);

/* ---------------------------------------------------------------------------
   ۳) ساخت نسخه‌ی آماده‌ی استقرار با JSX از پیش کامپایل‌شده
   --------------------------------------------------------------------------- */
const Babel = require('@babel/standalone');

const SRC_TAG = '<script type="text/plain" id="app-source">';
const si = html.indexOf(SRC_TAG);
if (si < 0) throw new Error('بلوک app-source در index.html پیدا نشد.');
const sj = html.indexOf('</script>', si);
const jsx = html.slice(si + SRC_TAG.length, sj);

const t0 = Date.now();
// دقیقاً همان presetهایی که پیش‌تر در مرورگر اجرا می‌شد، تا رفتار عوض نشود.
let compiled = Babel.transform(jsx, {
  presets: [['react', { runtime: 'classic' }], ['env', { modules: false }]],
  filename: 'app.jsx',
  // بدون این، Babel هر نویسه‌ی غیر-ASCII را به \uXXXX فرار می‌کند. چون کل
  // رابط کاربری فارسی است، این کار ۱۷٬۸۴۶ escape می‌ساخت و ~۸۸ کیلوبایت به
  // حجم فایل اضافه می‌کرد (هر نویسه‌ی ۲ بایتی می‌شد ۶ نویسه). فایل UTF-8
  // اعلام شده، پس نویسه‌های خام کاملاً مجاز و معادل‌اند.
  generatorOpts: { jsescOption: { minimal: true } },
}).code;
const compileMs = Date.now() - t0;

// چون خروجی مستقیم داخل HTML می‌نشیند، هر توالی `</script` باید شکسته شود
// وگرنه مرورگر زودتر از موعد تگ را می‌بندد. در حالت اجرا-در-مرورگر این مشکل
// وجود نداشت چون کد از راه textContent تزریق می‌شد.
compiled = compiled.replace(/<\/script/gi, '<\\/script');
if (compiled.includes('</script')) throw new Error('خروجی کامپایل همچنان </script دارد — جاسازی امن نیست.');

let out = html.slice(0, si)
  + '<script type="text/plain" id="app-source-compiled">\n'
  + compiled
  + '\n</script>'
  + html.slice(sj + '</script>'.length);

// حذف Babel از بار اولیه (unpkg + fallback jsdelivr)
const babelTags = [
  '<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>\n',
  "<script>window.Babel || document.write('<script src=\"https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js\"><\\/script>');</script>\n",
];
for (const tag of babelTags) {
  if (!out.includes(tag)) throw new Error('تگ Babel پیدا نشد — ساختار index.html عوض شده است.');
  out = out.replace(tag, '<!-- Babel از بار اولیه حذف شد: JSX در زمان build کامپایل می‌شود (~۲٫۳MB کمتر) -->\n');
}

// boot guard دیگر Babel را لازم ندارد، و به‌جای transform، کد کامپایل‌شده را برمی‌دارد
out = out.replace("    if (!window.Babel) missing.push('Babel');\n", '');

const oldTransform = [
  "    const source = document.getElementById('app-source').textContent;",
  '    const output = Babel.transform(source, {',
  '      presets: [',
  "        ['react', { runtime: 'classic' }],",
  "        ['env', { modules: false }],",
  '      ],',
  "      filename: 'app.jsx',",
  '    }).code;',
].join('\n');
if (!out.includes(oldTransform)) throw new Error('بلوک Babel.transform پیدا نشد.');
const newTransform = [
  '    // JSX از پیش در زمان build کامپایل شده است؛ اینجا فقط اجرا می‌شود.',
  "    const output = document.getElementById('app-source-compiled').textContent;",
].join('\n');
out = out.replace(oldTransform, newTransform);

/* مهر منبع: هش کد JSXی که این خروجی از آن ساخته شده.
   چرا لازم است: `deploy/index.html` یک artifact است و اگر کسی `index.html` را
   عوض کند و build نزند، یک فایل کهنه را میزبانی می‌کند و هیچ نشانه‌ای هم
   نمی‌بیند — بدترین نوع باگ. `npm run verify` این مهر را با منبع فعلی مقایسه
   می‌کند و اگر جا مانده باشد، صریح شکست می‌خورد. */
const srcHash = crypto.createHash('sha256').update(jsx, 'utf8').digest('hex').slice(0, 16);
out = out.replace('<script type="text/plain" id="app-source-compiled">',
  `<!--@build-src-hash:${srcHash}-->\n<script type="text/plain" id="app-source-compiled">`);

const deployDir = path.join(root, 'deploy');
fs.mkdirSync(deployDir, { recursive: true });
fs.writeFileSync(path.join(deployDir, 'index.html'), out, 'utf8');
console.log(`✔ مهر منبع: ${srcHash}`);

console.log(`✔ JSX کامپایل شد (${compileMs}ms در build) — ${kb(jsx.length)} → ${kb(compiled.length)}`);
console.log(`✔ deploy/index.html ساخته شد → ${kb(out.length)} (بدون Babel در مرورگر)`);

