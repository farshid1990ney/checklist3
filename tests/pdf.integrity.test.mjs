// =====================================================================
// شبیه‌سازی سرتاسری «PDF درایو = PDF برنامه»
//
// این پرونده دقیقاً همان مسیری را اجرا می‌کند که مرورگر واقعی طی می‌کند:
//   ۱. کد کلاینت (از بلوک اپ در index.html) با Babel کامپایل و در محیط
//      شبه‌مرورگری اجرا می‌شود.
//   ۲. `sendRecordToAppsScript` واقعی — با پاکت امضاشده‌ی HMAC — از طریق
//      `fetch` شبیه‌سازی‌شده به سرور واقعیِ `Code.gs` (در mock-appsscript)
//      می‌رسد و فایل واقعاً در «درایو»ی شبیه‌ساز ذخیره می‌شود.
//   ۳. کتابخانه‌ی html2pdf با یک نسخه‌ی «قطعی» جایگزین شده: بایت‌های PDFِ
//      خروجی، اثر انگشتِ (SHA-256) همان HTMLای هستند که به کتابخانه داده
//      شده. پس اگر بایت‌های فایلِ درایو همان اثر انگشت را داشته باشند،
//      ثابت شده که فایل درایو دقیقاً از همان برگه‌ای ساخته شده که برنامه
//      نمایش می‌دهد — نه یک رندر دیگر.
//
// چهار بررسی (زیر ۴ تست مستقل، هر کدام چند ادعا):
//   چک ۱ — یکسان بودن منبع: آنچه در پنجره‌ی چاپ دیده می‌شود، آنچه به
//          html2pdf داده می‌شود و آنچه `recordReportHtml` می‌سازد یکی است.
//   چک ۲ — یکسان بودن بایت: فایل ذخیره‌شده در درایو همان بایت‌هایی است که
//          از همان HTML نمایشی ساخته شده (اثر انگشت داخل فایل = اثر انگشت
//          برگه‌ی نمایشی) + پوشه/نام‌گذاری/لینک درست است.
//   چک ۳ — مسیر پشتیبان: وقتی کتابخانه‌ی PDF در دسترس نیست، همان سندِ کامل
//          به سرور می‌رسد و کاربر از «غیریکسان بودن رندر سرور» مطلع می‌شود.
//   چک ۴ — تمام چرخه‌ی حیات: ارسال دوباره همان برگه فایل را به‌روز می‌کند
//          (نه کپی تکراری) و بعد از هر امضا، فایل درایو با برگه‌ی امضاشده‌ی
//          تازه همگام می‌شود.
// =====================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as immer from 'immer';
import * as ReactNS from 'react';
import { loadServer } from './mock-appsscript.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, '..', 'index.html');
const CODE = path.join(__dirname, '..', 'Code.gs');
const KEY = 'dk_test_key_1234567890';

/* --------------------------------------------------- استخراج و کامپایل اپ */

function extractAppSource() {
  const html = fs.readFileSync(HTML, 'utf8');
  const startTag = '<script type="text/plain" id="app-source">';
  const i = html.indexOf(startTag);
  assert.ok(i >= 0, 'بلوک app-source پیدا نشد');
  return html.slice(i + startTag.length, html.indexOf('</script>', i));
}

const EXPORTS = [
  'recordReportHtml', 'REPORT_STYLE', 'sendRecordToAppsScript', 'htmlToPdfBase64',
  'printSingleRecord', 'recordPdfFileName', 'cloudFolderName', 'renderSignatureBoxes',
  'applySignatureToRecord', 'makeSignRequest', 'makeSignChain', 'normalizeSignRequest',
  'gregorianToJalaliStr', 'buildEnvelope', 'callAppsScript',
];

/* --------------------------------------------- DOM شبه‌مرورگری ضبط‌کننده */

function makeFakeDom() {
  const log = [];
  const makeEl = (tag) => {
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      attrs: {}, style: { cssText: '' }, innerHTML: '', textContent: '',
      children: [], parent: null, removed: false,
      setAttribute(k, v) { el.attrs[k] = String(v); },
      appendChild(c) { el.children.push(c); if (c) c.parent = el; return c; },
      removeChild(c) { const i = el.children.indexOf(c); if (i > -1) el.children.splice(i, 1); return c; },
      remove() { el.removed = true; if (el.parent) el.parent.removeChild(el); },
      click() { log.push('click:' + (el.attrs.download || el.tagName)); },
    };
    return el;
  };
  const body = makeEl('body');
  const doc = {
    body, __log: log, __created: [],
    // عمداً head تعریف نشده: اگر کتابخانه‌ای بخواهد از شبکه لود شود، خطا
    // می‌گیرد و مسیر «در دسترس نبودن» به‌صورت واقعی تست می‌شود.
    getElementById: () => makeEl('div'),
    createElement: (tag) => { const e = makeEl(tag); doc.__created.push(e); return e; },
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
  };
  const win = {
    immer,
    devicePixelRatio: 1, innerWidth: 1280, innerHeight: 900,
    location: { search: '', href: 'http://localhost/', pathname: '/' },
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    print() {}, open: () => null,
    navigator: { onLine: true, sendBeacon: () => true },
    history: { replaceState() {} },
  };
  return { win, doc, makeEl };
}

/* ------------------- FileReader جعلی (مثل مرورگر، از روی blob می‌خواند) */

class FakeFileReader {
  constructor() { this.result = null; this.onload = null; this.onerror = null; }
  readAsDataURL(blob) {
    this.result = 'data:application/pdf;base64,' + String((blob && blob.__b64) || '');
    if (this.onload) this.onload();
  }
}

/* ----------------- html2pdf قطعی: بایت‌ها = اثر انگشتِ HTMLِ ورودی -------
   در جهان واقعی هم خروجی html2pdf تابعی یک‌دستا از همان ورودی است؛ اینجا
   آن تابع را شفاف می‌کنیم تا بتوان اثبات کرد فایل درایو از همان ورودی است. */

function installDeterministicHtml2pdf(win, capture) {
  win.html2pdf = function html2pdf() {
    const chain = {
      set(o) { capture.opt = o; return chain; },
      from(holder) { capture.holder = holder; return chain; },
      outputPdf() {
        const rendered = String(capture.holder.innerHTML);
        const hash = crypto.createHash('sha256').update(rendered, 'utf8').digest('hex');
        // بدنه‌ی محتوایی شبیه‌سازی‌شده (مثل content stream واقعی) تا اندازه‌ی
        // فایل از حداقلِ اعتبارسنجیِ کلاینت/سرور (>۲۰۰ نویسه‌ی base64) بگذرد.
        const stream = 'T* BT /F1 12 Tf (Darkav Simulation Page) Tj ET\n'.repeat(30);
        const pdfText = `%PDF-1.4\n1 0 obj\n<< /Producer (darkav-sim) /RenderedSha256 (${hash}) >>\nendobj\n` +
          `2 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\ntrailer\n%%EOF`;
        capture.pdfText = pdfText;
        capture.hash = hash;
        return Promise.resolve({ __b64: Buffer.from(pdfText, 'utf8').toString('base64'), __hash: hash });
      },
    };
    return chain;
  };
}

/* ---------------------------------------------- بارگذاری اپ + اتصال سرور */

async function bootSim() {
  const { api, env } = await loadServer(CODE, { properties: { API_KEY: KEY } });
  const { win, doc } = makeFakeDom();
  globalThis.FileReader = FakeFileReader;

  const requests = [];
  const fakeFetch = async (url, init) => {
    const out = api.doPost({ postData: { contents: init.body } });
    const text = out.getContent();
    requests.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  };

  const printed = [];
  win.open = () => {
    const w = { __html: '', document: { write(h) { w.__html = h; }, close() {} }, close() {} };
    printed.push(w);
    return w;
  };

  // هر سناریو سرورِ تازه دارد، پس فکتوری اپ هم با `fetch` همان سناریو بسته
  // می‌شود (کد کامپایل‌شده کش می‌شود تا دوباره‌کاری نشود).
  const Babel = require('@babel/standalone');
  if (!compiledCache) {
    compiledCache = Babel.transform(extractAppSource(), {
      presets: [['react', { runtime: 'classic' }]], filename: 'app.jsx',
    }).code;
  }
  const storage = (() => {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear() };
  })();
  const factory = new Function(
    'React', 'ReactDOM', 'window', 'document', 'navigator', 'sessionStorage', 'localStorage',
    'indexedDB', 'qrcode', 'XLSX', 'Html5Qrcode', 'html2pdf', 'location', 'fetch',
    `"use strict";\n${compiledCache}\n; return { ${EXPORTS.join(', ')} };`
  );
  const React = Object.assign({}, ReactNS, { default: ReactNS });
  const app = factory(
    React, { createRoot: () => ({ render() {}, unmount() {} }) }, win, doc, win.navigator, storage, storage,
    undefined, () => ({}), {}, function Html5QrcodeStub() {}, null, win.location, fakeFetch,
  );

  const capture = {};
  installDeterministicHtml2pdf(win, capture);

  return { app, api, env, win, doc, capture, requests, printed };
}

let compiledCache = null;

/* ------------------------------------------------------------ داده نمونه */

const ORG = { orgName: 'سازمان درکاو', logoDataUrl: '', passThreshold: 80 };
const ALI = { id: 'u-ali', username: 'ali', name: 'علی محمدی', role: 'inspector', active: true };
const REZA = { id: 'u-reza', username: 'reza', name: 'رضا کریمی', role: 'approver', active: true };
const MGR = { id: 'u-mgr', username: 'mgr', name: 'مدیر داخلی', role: 'manager', active: true };
const COMPLETED_AT = '2026-09-16T10:30:00.000Z'; // ۱۴۰۵/۰۶/۲۵

function sampleRecord(app, over = {}) {
  return Object.assign({
    id: 'rec-sim12', assetId: 'a1', assetCode: 'DB-01', assetName: 'تابلو برق ۱', location: 'سالن ۱',
    templateId: 't1', templateName: 'بازرسی دوره‌ای تابلو برق', category: 'برق',
    inspectorId: ALI.id, inspectorName: ALI.name,
    date: app.gregorianToJalaliStr(new Date(COMPLETED_AT)), dateJalali: app.gregorianToJalaliStr(new Date(COMPLETED_AT)),
    completedAt: COMPLETED_AT,
    percent: 100, score: 100, maxScore: 100, status: 'موفق', criticalFail: false,
    details: [
      { itemId: 'i1', label: 'اتصال زمین (ارت) برقرار است؟', value: true, earned: 60, max: 60, critical: true },
      { itemId: 'i2', label: 'دمای سطح تابلو (درجه سانتی‌گراد)', value: '۳۱', earned: 0, max: 0, critical: false },
    ],
    notes: 'همه‌چیز عادی بود.',
    signatures: { inspector: { image: 'data:image/png;base64,SIG-INSPECTOR', name: ALI.name } },
    signRequest: app.makeSignChain({
      steps: [{ toUser: REZA, slot: 'approver' }, { toUser: MGR, slot: 'manager' }],
      byUser: ALI, at: Date.parse(COMPLETED_AT),
    }),
  }, over);
}

/* --------------------------------------------------- ابزار بررسی درایو */

function allFiles(folder, out = []) {
  folder.files.forEach(f => { if (!f.isTrashed()) out.push(f); });
  folder.folders.forEach(d => allFiles(d, out));
  return out;
}

function findFolder(root, name) {
  if (root.getName() === name) return root;
  for (const d of root.folders) { const r = findFolder(d, name); if (r) return r; }
  return null;
}

function folderChain(root, leafName) {
  const walk = (folder, trail) => {
    const here = trail.concat([folder.getName()]);
    if (folder.getName() === leafName) return here;
    for (const d of folder.folders) {
      const r = walk(d, here);
      if (r) return r;
    }
    return null;
  };
  return walk(root, []);
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

/** اثر انگشتِ ذخیره‌شده در بایت‌های فایل درایو را بیرون می‌کشد. */
function hashFromPdfBytes(buf) {
  const m = String(buf.toString('utf8')).match(/\/RenderedSha256 \(([0-9a-f]{64})\)/);
  return m ? m[1] : null;
}

/* ============================================================ چک ۱ تا ۴ */

test('چک ۱ — یکسان بودن منبع: پنجره‌ی چاپ، ورودی html2pdf و recordReportHtml یکی هستند', async () => {
  const { app, capture, printed } = await bootSim();
  const rec = sampleRecord(app);

  // آنچه کاربر در برنامه می‌بیند (پنجره‌ی چاپ)
  app.printSingleRecord(rec, ORG, () => {});
  assert.equal(printed.length, 1, 'پنجره‌ی چاپ باید باز شود');
  const shown = printed[0].__html;

  // آنچه برای ساخت فایل می‌رود (مسیر ذخیره‌ی درایو)
  const json = await app.sendRecordToAppsScript('https://mock/exec', KEY, rec, ORG, () => {});
  assert.equal(json.ok, true, 'ذخیره باید موفق باشد');

  const expectedBody = app.recordReportHtml(rec, ORG);

  const shownBody = /<body>([\s\S]*?)<script>/.exec(shown)[1];
  assert.equal(shownBody, expectedBody, 'بدنه‌ی پنجره‌ی چاپ باید دقیقاً خروجی recordReportHtml باشد');

  const holder = capture.holder;
  assert.ok(holder, 'html2pdf باید holder را گرفته باشد');
  const holderStyle = /^<style>([\s\S]*?)<\/style>/.exec(holder.innerHTML)[1];
  const holderBody = holder.innerHTML.replace(/^<style>[\s\S]*?<\/style>/, '');
  assert.equal(holderBody, expectedBody, 'بدنه‌ی داده‌شده به html2pdf باید همان برگه‌ی نمایشی باشد');

  const shownStyle = /<style>([\s\S]*?)<\/style>/.exec(shown)[1];
  assert.equal(holderStyle, shownStyle, 'CSS هر دو مسیر باید یکی باشد');
  assert.equal(holderStyle, app.REPORT_STYLE, 'هر دو باید REPORT_STYLE باشند');
  assert.equal(holder.attrs.dir, 'rtl', 'جهت سند باید فارسی باشد');

  // حاشیه‌ی صفحه: پنجره‌ی چاپ @page 14mm دارد؛ فایل ساخته‌شده هم باید ۱۴ میلی‌متر باشد
  assert.ok(app.REPORT_STYLE.includes('@page { size: A4; margin: 14mm; }'), 'حاشیه‌ی چاپ ۱۴ میلی‌متر است');
  assert.deepEqual(capture.opt.margin, [14, 14, 14, 14], 'حاشیه‌ی فایل ساخته‌شده باید دقیقاً مثل پنجره‌ی چاپ باشد');
  assert.deepEqual(capture.opt.jsPDF.format, 'a4', 'اندازه‌ی صفحه باید A4 باشد');
});

test('چک ۲ — یکسان بودن بایت: فایل ذخیره‌شده در درایو دقیقاً همان بایت‌های ساخته‌شده از برگه‌ی نمایشی است', async () => {
  const { app, env, capture, requests } = await bootSim();
  const rec = sampleRecord(app);

  const json = await app.sendRecordToAppsScript('https://mock/exec', KEY, rec, ORG, () => {});
  assert.equal(json.ok, true);

  // ۲-۱. فایل در درایو پیدا شود و مسیر پوشه‌ها درست باشد
  const root = env.__drive.root;
  const rootFolder = findFolder(root, app.cloudFolderName(ORG));
  assert.ok(rootFolder, 'پوشه‌ی ریشه باید با نام سازمان ساخته شده باشد');
  const chain = folderChain(rootFolder, 'برق') || folderChain(rootFolder, rec.category);
  assert.ok(chain, 'پوشه‌ی دسته‌بندی باید وجود داشته باشد');
  assert.equal(chain[1], '1405', 'پوشه‌ی سال شمسی درست');
  assert.equal(chain[2], '06-شهریور', 'پوشه‌ی ماه شمسی درست');

  const pdfs = allFiles(root).filter(f => f.getMimeType() === 'application/pdf');
  assert.equal(pdfs.length, 1, 'دقیقاً یک فایل PDF باید ذخیره شده باشد');
  const file = pdfs[0];

  // ۲-۲. بایت‌های درایو === بایت‌های ساخته‌شده از برگه‌ی نمایشی
  const driveBytes = Buffer.from(file.getBlob().getBytes());
  const driveHash = hashFromPdfBytes(driveBytes);
  assert.ok(driveHash, 'فایل درایو باید اثر انگشت رندر را داشته باشد');
  assert.equal(driveHash, capture.hash, 'بایت‌های درایو باید از همان برگه‌ای باشند که برنامه نشان داد');
  const expectedPdfText = capture.pdfText;
  assert.equal(driveBytes.toString('utf8'), expectedPdfText, 'بایت‌به‌بایت یکی باشند');

  // ۲-۳. آنچه سرور گرفت همان چیزی است که کلاینت ساخت (نه چیز دیگر)
  const env_ = requests.find(r => r.body.action === 'save_record');
  assert.ok(env_, 'درخواست save_record باید رسیده باشد');
  assert.equal(env_.body.payload.pdfBase64, Buffer.from(expectedPdfText, 'utf8').toString('base64'),
    'base64 ارسال‌شده به سرور === بایت‌های همان رندر');
  assert.equal(env_.body.payload.html, '', 'وقتی بایت هست، نیازی به html نیست');

  // ۲-۴. نام فایل درایو === نام دانلود محلی (هر دو یک فایل‌اند)
  assert.equal(file.getName(), app.recordPdfFileName(rec), 'نام فایل درایو و دانلود محلی باید یکی باشد');
  assert.ok(file.getName().includes('DB-01'), 'کد تجهیز در نام فایل');
  assert.ok(file.getName().includes('بازرسی دوره‌ای تابلو برق'), 'نام قالب در نام فایل');

  // ۲-۵. لینک برگشتی سرور به همان فایل اشاره کند
  assert.equal(json.pdfUrl, file.getUrl(), 'pdfUrl پاسخ باید لینک همان فایل باشد');
});

test('چک ۳ — مسیر پشتیبان: بدون کتابخانه‌ی PDF، همان سندِ کامل به سرور می‌رسد و کاربر مطلع می‌شود', async () => {
  const { app, env, win, requests } = await bootSim();
  delete win.html2pdf; // شبیه‌سازی «کتابخانه در دسترس نیست» (مثلاً آفلاین)
  const rec = sampleRecord(app);

  // برگه‌ی نمایشی برای مقایسه
  const shownBody = app.recordReportHtml(rec, ORG);

  const notes = [];
  const json = await app.sendRecordToAppsScript('https://mock/exec', KEY, rec, ORG, (m) => notes.push(m));
  assert.equal(json.ok, true);

  const req = requests.find(r => r.body.action === 'save_record');
  assert.equal(req.body.payload.pdfBase64, '', 'بایتی در کار نیست');
  const expectedHtml = `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><style>${app.REPORT_STYLE}</style></head><body>${shownBody}</body></html>`;
  assert.equal(req.body.payload.html, expectedHtml,
    'در مسیر پشتیبان هم باید دقیقاً همان سندِ نمایشی به سرور برود');

  // فایل در درایو از مسیر تبدیلِ سرور ساخته شده
  const pdfs = allFiles(env.__drive.root).filter(f => f.getName().endsWith('.pdf'));
  assert.equal(pdfs.length, 1, 'فایل باید در درایو ذخیره شود');
  assert.ok(pdfs[0].getMimeType() === 'application/pdf', 'خروجی باید PDF باشد');

  // کاربر باید بفهمد این نسخه با موتور سرور رندر شده (نه نسخه‌ی دقیق کلاینتی)
  assert.ok(notes.some(n => n.includes('موتور سمت سرور')),
    'پیام باید شفاف بگوید رندر سمت سرور انجام شده');
});

test('چک ۴ — چرخه‌ی کامل: ارسال دوباره فایل را به‌روز می‌کند و بعد از هر امضا فایل با برگه همگام می‌شود', async () => {
  const { app, env, capture } = await bootSim();
  const rec = sampleRecord(app);

  // ۴-۱. بار اول
  const first = await app.sendRecordToAppsScript('https://mock/exec', KEY, rec, ORG, () => {});
  assert.equal(first.ok, true);
  const files1 = allFiles(env.__drive.root).filter(f => f.getMimeType() === 'application/pdf');
  assert.equal(files1.length, 1);
  const hash1 = capture.hash;

  // ۴-۲. ارسال دوباره‌ی همان برگه → همان یک فایل به‌روز می‌شود، نه کپی جدید
  const second = await app.sendRecordToAppsScript('https://mock/exec', KEY, rec, ORG, () => {});
  assert.equal(second.ok, true);
  const files2 = allFiles(env.__drive.root).filter(f => f.getMimeType() === 'application/pdf');
  assert.equal(files2.length, 1, 'نباید فایل تکراری ساخته شود');
  assert.equal(files2[0].getId(), files1[0].getId(), 'همان فایل باید به‌روز شود');
  assert.equal(files2[0].getUrl(), first.pdfUrl, 'لینک فایل تغییر نمی‌کند');

  // ۴-۳. حالا ناظر امضا می‌کند — همان‌طور که صفحه‌ی «در انتظار امضا» انجام می‌دهد
  const signed = app.applySignatureToRecord(rec, { image: 'data:image/png;base64,SIG-APPROVER', signedAt: Date.now() }, REZA);
  assert.ok(signed.signatures.approver, 'امضای ناظر باید نشسته باشد');
  const signedHtml = app.recordReportHtml(signed, ORG);
  assert.notEqual(signedHtml, app.recordReportHtml(rec, ORG), 'برگه‌ی امضاشده با قبلی فرق دارد');
  assert.ok(signedHtml.includes('رضا کریمی'), 'امضای تازه باید در برگه باشد');

  const third = await app.sendRecordToAppsScript('https://mock/exec', KEY, signed, ORG, () => {});
  assert.equal(third.ok, true);
  const files3 = allFiles(env.__drive.root).filter(f => f.getMimeType() === 'application/pdf');
  assert.equal(files3.length, 1, 'همچنان یک فایل');
  const driveHash = hashFromPdfBytes(Buffer.from(files3[0].getBlob().getBytes()));
  assert.equal(driveHash, sha256('<style>' + app.REPORT_STYLE + '</style>' + signedHtml),
    'بایت‌های درایو باید اثر انگشت برگه‌ی امضاشده‌ی تازه باشند');
  assert.notEqual(driveHash, hash1, 'محتوا باید واقعاً عوض شده باشد');
});
