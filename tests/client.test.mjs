import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadServer } from './mock-appsscript.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, '..', 'index.html');

/* ------------------------------------------------------------------ harness */

const CORE_BLOCKS = ['crypto', 'digits', 'jalali', 'cloudconfig', 'migrate', 'sync', 'scoring', 'coverage', 'roles', 'permissions', 'signrequest', 'opsanitize', 'loginaid'];

function extractCore() {
  const html = fs.readFileSync(HTML, 'utf8');
  const startTag = '<script type="text/plain" id="app-source">';
  const i = html.indexOf(startTag);
  const src = html.slice(i + startTag.length, html.indexOf('</script>', i));

  const parts = [];
  for (const name of CORE_BLOCKS) {
    const a = src.indexOf(`/* @core-start: ${name} */`);
    const b = src.indexOf(`/* @core-end: ${name} */`);
    assert.ok(a >= 0 && b > a, `بلوک هسته «${name}» پیدا نشد`);
    parts.push(`// ---- ${name} ----\n` + src.slice(a, b));
  }
  return parts.join('\n\n');
}

const PRELUDE = `
const APP_VERSION = 4;
const CLIENT_ID = 'test-client';
const DEFAULT_APPS_SCRIPT_URL = '';
const SESSION_API_KEY = 'test_session_api_key';
const sessionStorage = globalThis.__sessionStorage;
`;

function loadCore() {
  const code = extractCore();
  const names = [
    'sha256Hex', 'hmacSha256Hex', 'randomHex', 'uid', 'derivePasswordHash', 'makeCredential',
    'verifyCredential', 'verifyManagerPinHash', 'timingSafeEqualStr', 'HASH_ALGO', 'PBKDF2_ITERATIONS',
    'toEnglishDigits', 'toPersianDigits', 'sanitizeNumericInput', 'escapeHtml',
    'toJalali', 'toGregorian', 'safeToJalali', 'safeToGregorian', 'gregorianToJalaliStr',
    'jalaliMonthLength', 'jalaliMonthName', 'isValidJalaliDateStr', 'jalaliStrToDate', 'nowJalaliDateTime', 'pad2', 'isLeapJalaliYear', 'isCompleteJalaliDraft',
  'sanitizeOpForConflict_', 'MAX_CONFLICT_OP_BYTES', 'resolveSignerName',
    'DEFAULT_ADMIN_CRED', 'DEFAULT_PIN_CRED',
  'sha256BytesPure', 'hmacSha256BytesPure', 'pbkdf2Sha256Pure', 'HAS_SUBTLE', 'diagnoseLoginInput',
    'resolveCloudConfig', 'pickSyncableSettings',
    'migrateData',
    'diffState', 'mergeRemote', 'normalizeEntity', 'sameEntity', 'stableStringify', 'snapshotToLocal',
    'collectTouchedCollections', 'SYNC_COLLECTIONS', 'MAX_OP_TRIES',
    'scoreRecord', 'qualityLabel',
    'INSPECTION_PERIODS', 'PERIOD_LABELS', 'resolveTemplatePeriod', 'periodKey', 'periodWindowLabel', 'templateCoverage',
  'prevPeriodKey', 'periodElapsedRatio', 'coverageAlerts', 'AT_RISK_RATIO',
    'ROLE_LABELS', 'DEFAULT_PAGES_BY_ROLE', 'ASSIGNABLE_PAGES',
    'effectivePages', 'buildPermissions', 'MANAGER_ROLES', 'ALWAYS_ON_PAGES',
    'SIGN_REQUEST_STATUS', 'SIGN_SLOTS', 'SIGN_REQUEST_STATUS_LABELS',
    'normalizeSignRequest', 'makeSignRequest', 'isPendingSignRequest', 'canSignRequest',
    'canSeeSignRequest', 'buildSignQueue', 'applySignatureToRecord', 'cancelSignRequest',
    'signRequestCandidates',
    'SIGN_SLOT_SEQUENCE', 'SIGN_CHAIN_LABELS', 'SIGN_FLOW_MODES', 'resolveSignFlowMode',
    'isSignChainMode', 'requiredSignSlots', 'normalizeSignStep', 'activeSignStep',
    'makeSignChain', 'signChainProgress', 'signChainLabel', 'signSlotLabel', 'validateSignChain',
    'SIGN_QUEUE_PAGE_SIZE',
    'templateSignerCount', 'signSlotsForCount', 'signerCountLabel',
    'referSignRequest', 'canReferSignRequest',
  ];
  const factory = new Function(PRELUDE + '\n' + code + `\n; return { ${names.join(', ')} };`);
  return factory();
}

const store = new Map();
globalThis.__sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const C = loadCore();

/* ================================================================== jalali */

test('تبدیل میلادی به شمسی: نوروز ۱۴۰۳ و تاریخ امروز', () => {
  assert.deepEqual(C.toJalali(2024, 3, 20), [1403, 1, 1]);
  assert.deepEqual(C.toJalali(2025, 3, 21), [1404, 1, 1]);
  assert.deepEqual(C.toJalali(2026, 9, 13), [1405, 6, 22]);
  assert.equal(C.gregorianToJalaliStr(new Date(2026, 8, 13)), '1405/06/22');
});

test('تبدیل شمسی به میلادی', () => {
  assert.deepEqual(C.toGregorian(1403, 1, 1), [2024, 3, 20]);
  assert.deepEqual(C.toGregorian(1405, 6, 22), [2026, 9, 13]);
});

test('رفت و برگشت شمسی↔میلادی برای ۶۰ سال بدون خطا', () => {
  const start = new Date(1990, 0, 1).getTime();
  const end = new Date(2060, 11, 31).getTime();
  let n = 0;
  for (let t = start; t < end; t += 86400000 * 7) {
    const d = new Date(t);
    const j = C.safeToJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
    assert.ok(j, 'تبدیل به شمسی ناموفق بود برای ' + d.toISOString());
    const g = C.safeToGregorian(j[0], j[1], j[2]);
    assert.deepEqual(g, [d.getFullYear(), d.getMonth() + 1, d.getDate()], 'round-trip برای ' + d.toISOString());
    n++;
  }
  assert.ok(n > 300, 'تعداد نمونه‌های تست کافی نیست');
});

test('طول ماه‌های شمسی و سال کبیسه', () => {
  for (let m = 1; m <= 6; m++) assert.equal(C.jalaliMonthLength(1403, m), 31);
  for (let m = 7; m <= 11; m++) assert.equal(C.jalaliMonthLength(1403, m), 30);
  assert.equal(C.jalaliMonthLength(1403, 12), 30, '۱۴۰۳ کبیسه است');
  assert.equal(C.jalaliMonthLength(1404, 12), 29, '۱۴۰۴ کبیسه نیست');
  assert.equal(C.jalaliMonthLength(1399, 12), 30, '۱۳۹۹ کبیسه است');
  assert.equal(C.isLeapJalaliYear(1403), true);
  assert.equal(C.isLeapJalaliYear(1404), false);
});

test('طول اسفند با طول واقعی سال شمسی (از روی تقویم میلادی) یکی است', () => {
  const days = (g) => Date.UTC(g[0], g[1] - 1, g[2]) / 86400000;
  let leaps = 0;
  for (let jy = 1300; jy <= 1500; jy++) {
    const yearLen = days(C.toGregorian(jy + 1, 1, 1)) - days(C.toGregorian(jy, 1, 1));
    assert.ok(yearLen === 365 || yearLen === 366, `طول سال ${jy} نامعتبر: ${yearLen}`);
    const esfand = yearLen - 336; // ۶ ماه ۳۱ روزه + ۵ ماه ۳۰ روزه
    assert.equal(C.jalaliMonthLength(jy, 12), esfand, `اسفند ${jy} باید ${esfand} روزه باشد`);
    if (esfand === 30) leaps++;
  }
  // در هر ۳۳ سال حدود ۸ سال کبیسه وجود دارد
  assert.ok(leaps > 40 && leaps < 60, `تعداد سال‌های کبیسه غیرمنتظره: ${leaps}`);
});

test('تقویم سمت سرور (Code.gs) با تقویم سمت کلاینت یکی است', async () => {
  const { api, env } = await loadServer(path.join(__dirname, '..', 'Code.gs'), { properties: { API_KEY: 'k' } });
  const days = (g) => Date.UTC(g[0], g[1] - 1, g[2]) / 86400000;
  for (let t = Date.UTC(2020, 0, 1); t < Date.UTC(2035, 0, 1); t += 86400000 * 3) {
    const d = new Date(t);
    const server = api.gregorianToJalali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    const client = C.toJalali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    assert.deepEqual([server.jy, server.jm, server.jd], client,
      `اختلاف تقویم در ${d.toISOString().slice(0, 10)}`);
  }
});

test('تاریخ نامعتبر کرش نمی‌کند (رفع ایراد ۲-۳)', () => {
  assert.equal(C.safeToJalali(NaN, 1, 1), null);
  assert.equal(C.safeToJalali(99999, 1, 1), null);
  assert.equal(C.safeToGregorian(99999, 1, 1), null);
  assert.equal(C.gregorianToJalaliStr(new Date('not-a-date')), '');
  assert.equal(C.jalaliMonthName(13), '');
  assert.equal(C.jalaliMonthLength(1403, 99), 30);
});

test('اعتبارسنجی رشته تاریخ شمسی با ارقام فارسی', () => {
  assert.equal(C.isValidJalaliDateStr('1403/12/30'), true);
  assert.equal(C.isValidJalaliDateStr('1404/12/30'), false, '۱۴۰۴ اسفند ۳۰ روز ندارد');
  assert.equal(C.isValidJalaliDateStr('1403/13/01'), false);
  assert.equal(C.isValidJalaliDateStr('۱۴۰۳/۰۱/۰۱'), true);
  assert.equal(C.isValidJalaliDateStr(''), false);
  assert.equal(C.isValidJalaliDateStr('1403/1/1'), true);
  const d = C.jalaliStrToDate('1403/01/01');
  assert.equal(d.getFullYear(), 2024);
  assert.equal(d.getMonth(), 2);
  assert.equal(d.getDate(), 20);
  const eod = C.jalaliStrToDate('1403/01/01', true);
  assert.equal(eod.getHours(), 23);
  assert.equal(C.jalaliStrToDate('bad'), null);
});

/* ================================================================== digits */

test('تبدیل و پاک‌سازی ارقام (رفع ایراد ۴-۵)', () => {
  assert.equal(C.toEnglishDigits('۱۲۳٤٥٦'), '123456');
  assert.equal(C.toPersianDigits('1234'), '۱۲۳۴');
  assert.equal(C.sanitizeNumericInput('۱۲abc۳'), '123');
  assert.equal(C.sanitizeNumericInput('12345', { maxLen: 2 }), '12');
  assert.equal(C.sanitizeNumericInput('12.3.4', { allowDecimal: true }), '12.34');
  assert.equal(C.sanitizeNumericInput('150', { max: 100 }), '100');
  assert.equal(C.sanitizeNumericInput(null), '');
});

/* ================================================================== crypto */

test('PBKDF2 قطعی است و salt متفاوت هش متفاوت می‌دهد (رفع ایراد ۱-۴)', async () => {
  const a = await C.derivePasswordHash('1234', 'salt-a', 1000);
  const b = await C.derivePasswordHash('1234', 'salt-a', 1000);
  const c = await C.derivePasswordHash('1234', 'salt-b', 1000);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 64);
  // رمز یکسان با salt یکسان دیگر هش یکسانِ جهانی نمی‌دهد
  const legacy = await C.sha256Hex('1234');
  assert.notEqual(a, legacy);
});

test('makeCredential + verifyCredential با الگوریتم جدید', async () => {
  const cred = await C.makeCredential('secret1', 1000);
  assert.equal(cred.hashAlgo, C.HASH_ALGO);
  assert.equal(cred.salt.length, 32);
  assert.equal(cred.iterations, 1000);
  const user = { passwordHash: cred.passwordHash, salt: cred.salt, hashAlgo: cred.hashAlgo, iterations: cred.iterations };
  assert.equal((await C.verifyCredential(user, 'secret1')).ok, true);
  assert.equal((await C.verifyCredential(user, 'wrong')).ok, false);
});

test('کاربر قدیمی با SHA-256 بدون salt: ورود موفق + ارتقای خودکار', async () => {
  const legacyHash = await C.sha256Hex('1234');
  const user = { passwordHash: legacyHash };
  const v = await C.verifyCredential(user, '1234');
  assert.equal(v.ok, true);
  assert.ok(v.upgrade, 'باید اعتبارنامه ارتقایافته برگرداند');
  assert.equal(v.upgrade.hashAlgo, C.HASH_ALGO);
  assert.ok(v.upgrade.salt.length > 0);
  const bad = await C.verifyCredential(user, '4321');
  assert.equal(bad.ok, false);
  assert.equal(bad.upgrade, null);
});

test('پین مدیریت قدیمی ارتقا می‌یابد', async () => {
  const settings = { managerPinHash: await C.sha256Hex('123456') };
  const v = await C.verifyManagerPinHash(settings, '123456');
  assert.equal(v.ok, true);
  assert.equal(v.upgrade.managerPinHashAlgo, C.HASH_ALGO);
  assert.ok(v.upgrade.managerPinSalt);
  assert.equal((await C.verifyManagerPinHash(settings, '000000')).ok, false);
  assert.equal((await C.verifyManagerPinHash({}, '123456')).ok, false);
});

test('HMAC با Node crypto یکی است (امضای درخواست)', async () => {
  const expected = crypto.createHmac('sha256', 'mykey').update('db.push|123|abc').digest('hex');
  assert.equal(await C.hmacSha256Hex('mykey', 'db.push|123|abc'), expected);
});

test('uid یکتا و با پیشوند درست', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const id = C.uid('rec');
    assert.ok(id.startsWith('rec-'));
    assert.ok(!seen.has(id), 'شناسه تکراری تولید شد');
    seen.add(id);
  }
});

test('timingSafeEqualStr', () => {
  assert.equal(C.timingSafeEqualStr('abc', 'abc'), true);
  assert.equal(C.timingSafeEqualStr('abc', 'abd'), false);
  assert.equal(C.timingSafeEqualStr('abc', 'ab'), false);
  assert.equal(C.timingSafeEqualStr('', ''), true);
});

/* ================================================================== scoring */

const TPL = {
  id: 't1', name: 'قالب', passThreshold: 80,
  items: [
    { id: 'i1', type: 'yesno', label: 'ارت برقرار است', weight: 40, critical: true },
    { id: 'i2', type: 'checkbox', label: 'درب سالم', weight: 20, critical: false },
    { id: 'i3', type: 'rating', label: 'نظافت', weight: 40, critical: false, scaleMax: 5 },
    { id: 'i4', type: 'numeric', label: 'دما', weight: 0, critical: false },
    { id: 'i5', type: 'text', label: 'توضیح', weight: 0, critical: false },
  ],
};

test('امتیازدهی: همه درست = ۱۰۰٪ و موفق', () => {
  const r = C.scoreRecord(TPL, { i1: 'بله', i2: true, i3: 5, i4: '35', i5: 'ok' });
  assert.equal(r.percent, 100);
  assert.equal(r.status, 'موفق');
  assert.equal(r.criticalFail, false);
  assert.equal(r.totalWeight, 100);
  assert.equal(r.details.length, 5);
});

test('امتیازدهی: آیتم حیاتی «خیر» = ناموفق حیاتی حتی با درصد بالا', () => {
  const r = C.scoreRecord(TPL, { i1: 'خیر', i2: true, i3: 5 });
  assert.equal(r.criticalFail, true);
  assert.equal(r.status, 'ناموفق (حیاتی)');
  assert.equal(r.percent, 60);
});

test('امتیازدهی: آیتم‌های اطلاعاتی در مخرج نمی‌آیند', () => {
  const r = C.scoreRecord(TPL, { i1: 'بله', i2: true });
  assert.equal(r.totalWeight, 100);
  assert.equal(r.percent, 60);
  assert.equal(r.status, 'ناموفق');
});

test('امتیازدهی: rating متناسب و ارقام فارسی', () => {
  const r = C.scoreRecord(TPL, { i1: 'بله', i2: true, i3: '۳' });
  assert.equal(Math.round(r.earned), 40 + 20 + 24);
});

test('امتیازدهی: قالب بدون آیتم وزنی = ۱۰۰٪', () => {
  const r = C.scoreRecord({ items: [{ id: 'x', type: 'text', label: 'a', weight: 0 }] }, {});
  assert.equal(r.percent, 100);
  assert.equal(r.status, 'موفق');
});

test('qualityLabel', () => {
  assert.equal(C.qualityLabel(96), 'عالی');
  assert.equal(C.qualityLabel(85), 'خوب');
  assert.equal(C.qualityLabel(65), 'متوسط');
  assert.equal(C.qualityLabel(45), 'ضعیف');
  assert.equal(C.qualityLabel(10), 'بحرانی');
});

/* ================================================================== sync/diff */

function mkData(over = {}) {
  return Object.assign({
    version: 4, revision: 0, lastSyncAt: 0,
    users: [{ id: 'u1', username: 'admin', role: 'admin', active: true, pages: [], updatedAt: 1 }],
    categories: ['برق'],
    templates: [], assets: [], assignments: [], records: [],
    settings: { orgName: 'درکاو', passThreshold: 80, googleAppsScriptUrl: 'u', cloudApiKey: 'k', syncConnectionSettings: false },
  }, over);
}

test('diffState: افزودن، تغییر و حذف موجودیت', () => {
  const prev = mkData({ assets: [{ id: 'a1', code: 'X', updatedAt: 1 }] });
  const next = mkData({
    assets: [
      { id: 'a1', code: 'X-ویرایش', updatedAt: 1 },
      { id: 'a2', code: 'Y', updatedAt: 1 },
    ],
    records: [{ id: 'r1', percent: 50, updatedAt: 2 }],
  });
  const ops = C.diffState(prev, next, null, false);
  const kinds = ops.map(o => `${o.entity}:${o.kind}:${o.id || ''}`);
  assert.ok(kinds.includes('assets:upsert:a1'));
  assert.ok(kinds.includes('assets:upsert:a2'));
  assert.ok(kinds.includes('records:upsert:r1'));
  const up = ops.find(o => o.entity === 'assets' && o.id === 'a1');
  assert.equal(up.data.code, 'X-ویرایش');
  assert.ok(up.data.updatedAt >= Date.now() - 5000, 'updatedAt باید زمان همین تغییر باشد');
  assert.equal(up.clientId, 'test-client');
  assert.ok(up.opId);
});

test('diffState: حذف موجودیت → عملیات delete', () => {
  const prev = mkData({ assets: [{ id: 'a1', code: 'X', updatedAt: 1 }] });
  const next = mkData({ assets: [] });
  const ops = C.diffState(prev, next, null, false);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, 'delete');
  assert.equal(ops[0].id, 'a1');
});

test('diffState: بدون تغییر → بدون عملیات (از جمله تغییر فقط updatedAt)', () => {
  const prev = mkData({ assets: [{ id: 'a1', code: 'X', updatedAt: 1 }] });
  assert.equal(C.diffState(prev, mkData({ assets: [{ id: 'a1', code: 'X', updatedAt: 1 }] }), null, false).length, 0);
  assert.equal(C.diffState(prev, mkData({ assets: [{ id: 'a1', code: 'X', updatedAt: 999999 }] }), null, false).length, 0);
  assert.equal(C.diffState(prev, mkData({ assets: [{ id: 'a1', code: 'X', deleted: false, updatedAt: 1 }] }), null, false).length, 0);
});

test('diffState: تغییر دسته‌بندی و تنظیمات؛ کلید API به‌طور پیش‌فرض همگام نمی‌شود', () => {
  const prev = mkData();
  const next = mkData({
    categories: ['برق', 'مکانیک'],
    settings: Object.assign({}, prev.settings, { orgName: 'سازمان جدید', cloudApiKey: 'NEWKEY' }),
  });
  const ops = C.diffState(prev, next, null, false);
  const cat = ops.find(o => o.entity === 'categories');
  assert.deepEqual(cat.data, ['برق', 'مکانیک']);
  const set = ops.find(o => o.entity === 'settings');
  assert.equal(set.data.orgName, 'سازمان جدید');
  assert.equal(set.data.cloudApiKey, undefined, 'کلید API نباید بدون اجازه همگام شود');

  const ops2 = C.diffState(mkData({ settings: Object.assign({}, prev.settings, { syncConnectionSettings: true }) }),
    mkData({ settings: Object.assign({}, prev.settings, { syncConnectionSettings: true, cloudApiKey: 'NEWKEY' }) }), null, true);
  const set2 = ops2.find(o => o.entity === 'settings');
  assert.equal(set2.data.cloudApiKey, 'NEWKEY');
});

test('diffState: فقط مجموعه‌های دست‌خورده بررسی می‌شوند', () => {
  const prev = mkData();
  const next = mkData({ records: [{ id: 'r1', updatedAt: 5 }] });
  const ops = C.diffState(prev, next, new Set(['records']), false);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].entity, 'records');
});

test('mergeRemote: LWW در سطح هر موجودیت', () => {
  const local = mkData({ assets: [{ id: 'a1', code: 'LOCAL', updatedAt: 100 }] });
  const newer = { entities: { assets: [{ id: 'a1', code: 'SERVER', updatedAt: 200 }] }, revision: 5, serverTime: 200 };
  const m1 = C.mergeRemote(local, newer);
  assert.equal(m1.data.assets[0].code, 'SERVER');
  assert.equal(m1.stats.updated, 1);
  assert.equal(m1.data.revision, 5);

  const older = { entities: { assets: [{ id: 'a1', code: 'OLD', updatedAt: 50 }] }, revision: 6, serverTime: 200 };
  const m2 = C.mergeRemote(local, older);
  assert.equal(m2.data.assets[0].code, 'LOCAL', 'نسخه قدیمی‌تر سرور نباید جایگزین شود');
  assert.equal(m2.stats.skipped, 1);
});

test('mergeRemote: افزودن، tombstone و مرتب‌سازی سوابق', () => {
  const local = mkData({
    assets: [{ id: 'a1', code: 'A', updatedAt: 1 }, { id: 'a2', code: 'B', updatedAt: 1 }],
    records: [{ id: 'r1', completedAt: '2026-01-01T00:00:00.000Z', updatedAt: 1 }],
  });
  const remote = {
    entities: {
      assets: [{ id: 'a2', deleted: true, updatedAt: 9 }, { id: 'a3', code: 'C', updatedAt: 9 }],
      records: [{ id: 'r2', completedAt: '2026-06-01T00:00:00.000Z', updatedAt: 9, details: [{ itemId: 'x' }] }],
    },
    revision: 9, serverTime: 1000,
  };
  const m = C.mergeRemote(local, remote);
  assert.deepEqual(m.data.assets.map(a => a.id), ['a1', 'a3']);
  assert.equal(m.stats.removed, 1);
  assert.equal(m.stats.added, 2);
  assert.deepEqual(m.data.records.map(r => r.id), ['r2', 'r1'], 'جدیدترین اول');
  assert.equal(m.data.lastSyncAt, 1000);
});

test('mergeRemote: pages به آرایه تبدیل و active نرمال می‌شود', () => {
  const local = mkData({ users: [] });
  const remote = { entities: { users: [{ id: 'u9', username: 'x', role: 'inspector', pages: 'dashboard,records', active: 'true', updatedAt: 5 }] }, serverTime: 5 };
  const u = C.mergeRemote(local, remote).data.users[0];
  assert.deepEqual(u.pages, ['dashboard', 'records']);
  assert.equal(u.active, true);
});

test('mergeRemote: حذف‌شده‌ها از طریق deleted=false در normalize پاک می‌شوند', () => {
  const n = C.normalizeEntity('assets', { id: 'a', deleted: false, code: 'x' });
  assert.equal('deleted' in n, false);
});

test('mergeRemote: تنظیمات ابری، آدرس/کلید محلی را بازنویسی نمی‌کند', () => {
  const local = mkData();
  const remote = { entities: {}, settings: { orgName: 'سرور', passThreshold: 90 }, serverTime: 1 };
  const s = C.mergeRemote(local, remote).data.settings;
  assert.equal(s.orgName, 'سرور');
  assert.equal(s.passThreshold, 90);
  assert.equal(s.cloudApiKey, 'k', 'کلید محلی حفظ می‌شود');
});

test('snapshotToLocal + migrateData روی پاسخ سرور', () => {
  const remote = {
    entities: {
      users: [{ id: 'u1', username: 'admin', role: 'admin', pages: [], active: true, updatedAt: 3 }],
      assets: [{ id: 'a1', code: 'A', updatedAt: 3 }],
      categories: [{ id: 'cat-برق', name: 'برق', order: 0, updatedAt: 3 }],
    },
    settings: { orgName: 'سازمان', passThreshold: 70 },
    revision: 3, serverTime: 3,
  };
  const local = C.snapshotToLocal(remote, null);
  assert.equal(local.version, 4);
  assert.equal(local.settings.orgName, 'سازمان');
  assert.deepEqual(local.categories, ['برق']);
  assert.equal(local.records.length, 0);
});

test('stableStringify مستقل از ترتیب کلیدهاست', () => {
  assert.equal(C.stableStringify({ b: 1, a: 2 }), C.stableStringify({ a: 2, b: 1 }));
  assert.equal(C.sameEntity({ id: 'x', a: 1, updatedAt: 5 }, { id: 'x', a: 1, updatedAt: 9 }), true);
  assert.equal(C.sameEntity({ id: 'x', a: 1 }, { id: 'x', a: 2 }), false);
  assert.equal(C.sameEntity({ id: 'x', a: { b: [1, 2] } }, { id: 'x', a: { b: [1, 2] } }), true);
});

/* ================================================================== permissions */

test('ادمین به همه صفحات و همه مجوزها دسترسی دارد', () => {
  const p = C.buildPermissions({ id: 'u', role: 'admin', pages: [] });
  assert.ok(p.pages.includes('users') && p.pages.includes('settings'));
  assert.equal(p.canManage, true);
  assert.equal(p.canExecute, true);
  assert.equal(p.isAdmin, true);
});

test('مشاهده‌گر حتی با واگذاری دستی، «اجرای بازرسی» نمی‌گیرد (رفع ایراد ۴-۸)', () => {
  const p = C.buildPermissions({ id: 'u', role: 'viewer', pages: ['dashboard', 'runner', 'assets', 'records', 'templates', 'users', 'settings'] });
  assert.equal(p.pages.includes('runner'), false);
  assert.equal(p.pages.includes('users'), false, 'صفحه کاربران قابل واگذاری نیست');
  assert.equal(p.pages.includes('settings'), false);
  assert.equal(p.canManage, false);
  assert.equal(p.canExecute, false);
});

test('بازرس اجرا می‌کند ولی مدیریت نمی‌کند (رفع ایراد ۲-۷)', () => {
  const p = C.buildPermissions({ id: 'u', role: 'inspector', pages: ['dashboard', 'runner', 'assets', 'records', 'templates', 'tasks'] });
  assert.equal(p.canExecute, true);
  assert.equal(p.canManage, false);
  assert.ok(p.pages.includes('templates'), 'دیدن قالب مجاز است');
});

test('مدیر هم مدیریت می‌کند و هم وظیفه می‌بیند', () => {
  const p = C.buildPermissions({ id: 'u', role: 'manager' });
  assert.equal(p.canManage, true);
  assert.equal(p.canViewAllTasks, true);
  assert.equal(p.isAdmin, false);
});

test('تأییدکننده canApprove دارد', () => {
  assert.equal(C.buildPermissions({ id: 'u', role: 'approver' }).canApprove, true);
  assert.equal(C.buildPermissions({ id: 'u', role: 'inspector' }).canApprove, false);
});

test('effectivePages بدون کاربر و بدون تکرار', () => {
  assert.deepEqual(C.effectivePages(null), []);
  const pages = C.effectivePages({ role: 'inspector', pages: ['dashboard', 'dashboard', 'records'] });
  assert.deepEqual(pages, ['dashboard', 'records', 'signQueue']);
});

test('صفحه «در انتظار امضا» همیشه فعال است و با واگذاری دسترسی حذف نمی‌شود', () => {
  // حتی اگر ادمین فهرست صفحات را بدون signQueue ذخیره کرده باشد، کاربر نباید
  // از دیدن و امضای درخواست‌های خودش قفل شود.
  const inspector = { id: 'u1', role: 'inspector', pages: ['dashboard', 'records'] };
  assert.ok(C.effectivePages(inspector).includes('signQueue'));

  const viewer = { id: 'u2', role: 'viewer', pages: ['dashboard'] };
  const vp = C.effectivePages(viewer);
  assert.ok(vp.includes('signQueue'), 'صف امضا برای همه نقش‌ها فعال است');
  assert.ok(!vp.includes('runner'), 'ولی صفحه اجرا برای مشاهده‌گر بسته می‌ماند');

  // ادمین هم تکراری نمی‌گیرد
  const adminPages = C.effectivePages({ id: 'u3', role: 'admin' });
  assert.equal(adminPages.filter(p => p === 'signQueue').length, 1);
  assert.ok(!adminPages.includes('signQueue') === false);

  // در فهرست قابل‌واگذاری نیست (وگرنه ادمین می‌تواند کاربر را از صف خودش قفل کند)
  assert.ok(!C.ASSIGNABLE_PAGES.some(p => p.key === 'signQueue'));
});

/* ================================================================== migrate */

test('migrateData(null) کرش نمی‌کند (رفع ایراد ۴-۱۰)', () => {
  assert.equal(C.migrateData(null), null);
  assert.equal(C.migrateData(undefined), null);
  assert.equal(C.migrateData('string'), null);
  assert.equal(C.migrateData([]), null);
});

test('migrateData داده‌ی نسخه ۳ را به نسخه ۴ ارتقا می‌دهد', () => {
  const legacy = {
    version: 3,
    users: [{ username: 'admin', passwordHash: 'abc', role: 'manager', name: 'مدیر' }],
    categories: [{ name: 'برق' }, 'مکانیک', ''],
    templates: [{ id: 't1', name: 'ق' }],
    assets: [{ id: 'a1', code: 'A' }],
    records: [{ percent: 10 }, null],
    settings: { orgName: 'سازمان' },
  };
  const d = C.migrateData(legacy);
  assert.equal(d.version, 4);
  assert.equal(d.users[0].role, 'admin', 'حداقل یک ادمین تضمین می‌شود');
  assert.ok(d.users[0].id);
  assert.equal(d.users[0].hashAlgo, 'sha256');
  assert.equal(d.users[0].sessionVersion, 1);
  assert.equal(d.users[0].phone, '');
  assert.deepEqual(d.categories, ['برق', 'مکانیک']);
  assert.deepEqual(d.templates[0].items, []);
  assert.equal(d.records.length, 1, 'رکورد null حذف می‌شود');
  assert.ok(d.records[0].id);
  assert.ok(d.records[0].details);
  assert.equal(d.settings.passThreshold, 80);
  assert.equal(d.settings.syncConnectionSettings, false);
});

test('migrateData آرایه‌های گم‌شده را بازسازی می‌کند', () => {
  const d = C.migrateData({ settings: null });
  ['users', 'categories', 'templates', 'assets', 'assignments', 'records'].forEach(k => assert.ok(Array.isArray(d[k])));
  assert.equal(typeof d.settings, 'object');
});

/* ================================================================== cloudconfig */

test('resolveCloudConfig کلید نشست را وقتی کلید ذخیره‌شده خالی است برمی‌دارد', () => {
  store.clear();
  assert.equal(C.resolveCloudConfig({ googleAppsScriptUrl: 'U', cloudApiKey: '' }).apiKey, '');
  store.set('test_session_api_key', 'SESSIONKEY');
  assert.equal(C.resolveCloudConfig({ googleAppsScriptUrl: 'U', cloudApiKey: '' }).apiKey, 'SESSIONKEY');
  assert.equal(C.resolveCloudConfig({ googleAppsScriptUrl: 'U', cloudApiKey: 'STORED' }).apiKey, 'STORED');
  store.clear();
});

test('pickSyncableSettings فقط فیلدهای مجاز را برمی‌دارد', () => {
  const s = { orgName: 'o', passThreshold: 70, cloudApiKey: 'K', googleAppsScriptUrl: 'U', managerPinHash: 'H', logoDataUrl: 'BIG' };
  const a = C.pickSyncableSettings(s, false);
  assert.equal(a.cloudApiKey, undefined);
  assert.equal(a.googleAppsScriptUrl, undefined);
  assert.equal(a.logoDataUrl, undefined);
  assert.equal(a.orgName, 'o');
  const b = C.pickSyncableSettings(s, true);
  assert.equal(b.cloudApiKey, 'K');
});

/* ============================================== درخواست امضا («جهت امضا») */

const INSPECTOR = { id: 'u-ins', username: 'ali', name: 'علی محمدی', role: 'inspector', active: true };
const APPROVER = { id: 'u-app', username: 'reza', name: 'رضا کریمی', role: 'approver', active: true };
const MANAGER = { id: 'u-mgr', username: 'mgr', name: 'مدیر داخلی', role: 'manager', active: true };
const ADMIN = { id: 'u-adm', username: 'admin', name: 'ادمین', role: 'admin', active: true };
const VIEWER = { id: 'u-vw', username: 'vw', name: 'مشاهده‌گر', role: 'viewer', active: true };

function recWithRequest(over = {}) {
  return Object.assign({
    id: 'r1', assetCode: 'DB-01', assetName: 'تابلو', templateName: 'بازرسی', percent: 88,
    status: 'موفق', inspectorName: 'علی محمدی', date: '1405/06/22', details: [],
    signatures: { inspector: { image: 'data:inspector', name: 'علی محمدی' } },
    signRequest: C.makeSignRequest({ toUser: APPROVER, byUser: INSPECTOR, slot: 'approver', note: 'فردا صبح', at: 1000 }),
    updatedAt: 1000,
  }, over);
}

test('makeSignRequest: گیرنده، ارجاع‌دهنده و وضعیت اولیه درست ثبت می‌شود', () => {
  const sr = C.makeSignRequest({ toUser: APPROVER, byUser: INSPECTOR, slot: 'approver', note: 'ناظر شیفت عصر', at: 5000 });
  assert.equal(sr.toUserId, 'u-app');
  assert.equal(sr.toUserName, 'رضا کریمی');
  assert.equal(sr.byUserId, 'u-ins');
  assert.equal(sr.byUserName, 'علی محمدی');
  assert.equal(sr.slot, 'approver');
  assert.equal(sr.note, 'ناظر شیفت عصر');
  assert.equal(sr.requestedAt, 5000);
  assert.equal(sr.status, C.SIGN_REQUEST_STATUS.PENDING);
  assert.equal(sr.signedAt, 0);
});

test('makeSignRequest: ورودی نامعتبر → null، و slot ناشناخته به approver برمی‌گردد', () => {
  assert.equal(C.makeSignRequest({ toUser: null, byUser: INSPECTOR }), null);
  assert.equal(C.makeSignRequest({ toUser: {}, byUser: INSPECTOR }), null);
  assert.equal(C.makeSignRequest({ toUser: APPROVER, slot: 'inspector' }).slot, 'approver');
  // یادداشت خیلی طولانی کوتاه می‌شود تا ستون شیت منفجر نشود
  assert.equal(C.makeSignRequest({ toUser: APPROVER, note: 'x'.repeat(2000) }).note.length, 500);
});

test('normalizeSignRequest: مقدار ناقص/خراب بی‌خطر نرمال می‌شود', () => {
  assert.equal(C.normalizeSignRequest(null), null);
  assert.equal(C.normalizeSignRequest(undefined), null);
  assert.equal(C.normalizeSignRequest('string'), null);
  assert.equal(C.normalizeSignRequest({}), null, 'بدون گیرنده معنا ندارد');
  // وضعیت ناشناخته به pending برمی‌گردد (نه اینکه رکورد از صف بیفتد)
  const n = C.normalizeSignRequest({ toUserId: 'u-app', status: 'weird' });
  assert.equal(n.status, 'pending');
  assert.equal(n.toUserName, '');
  assert.equal(n.signedAt, 0);
  // رشته‌های عددی به عدد تبدیل می‌شوند (سلول شیت ممکن است رشته برگرداند)
  assert.equal(C.normalizeSignRequest({ toUserId: 'u-app', requestedAt: '123' }).requestedAt, 123);
});

test('isPendingSignRequest فقط برای درخواست باز true است', () => {
  assert.equal(C.isPendingSignRequest(recWithRequest()), true);
  assert.equal(C.isPendingSignRequest(recWithRequest({ signRequest: undefined })), false);
  assert.equal(C.isPendingSignRequest(recWithRequest({ signRequest: null })), false);
  const signed = C.applySignatureToRecord(recWithRequest(), { image: 'data:x', name: 'رضا' }, APPROVER, 9000);
  assert.equal(C.isPendingSignRequest(signed), false);
  assert.equal(C.isPendingSignRequest(null), false);
});

test('canSignRequest: فقط گیرنده یا ادمین (طبق تصمیم محصول)', () => {
  const rec = recWithRequest();
  assert.equal(C.canSignRequest(rec, APPROVER, C.buildPermissions(APPROVER)), true, 'گیرنده می‌تواند');
  assert.equal(C.canSignRequest(rec, ADMIN, C.buildPermissions(ADMIN)), true, 'ادمین می‌تواند جانشین شود');
  assert.equal(C.canSignRequest(rec, INSPECTOR, C.buildPermissions(INSPECTOR)), false, 'ارجاع‌دهنده نمی‌تواند خودش امضا کند');
  assert.equal(C.canSignRequest(rec, MANAGER, C.buildPermissions(MANAGER)), false, 'مدیر بدون ادمین بودن نمی‌تواند');
  assert.equal(C.canSignRequest(rec, VIEWER, C.buildPermissions(VIEWER)), false);
  // درخواست بسته دیگر قابل امضا نیست
  const signed = C.applySignatureToRecord(rec, { image: 'data:x', name: 'رضا' }, APPROVER, 9000);
  assert.equal(C.canSignRequest(signed, APPROVER, C.buildPermissions(APPROVER)), false);
  assert.equal(C.canSignRequest(signed, ADMIN, C.buildPermissions(ADMIN)), false);
  assert.equal(C.canSignRequest(null, ADMIN, C.buildPermissions(ADMIN)), false);
});

test('canSeeSignRequest: گیرنده و ارجاع‌دهنده و ادمین می‌بینند، غریبه نه', () => {
  const rec = recWithRequest();
  assert.equal(C.canSeeSignRequest(rec, APPROVER, C.buildPermissions(APPROVER)), true);
  assert.equal(C.canSeeSignRequest(rec, INSPECTOR, C.buildPermissions(INSPECTOR)), true, 'ارجاع‌دهنده برای پیگیری');
  assert.equal(C.canSeeSignRequest(rec, ADMIN, C.buildPermissions(ADMIN)), true);
  assert.equal(C.canSeeSignRequest(rec, VIEWER, C.buildPermissions(VIEWER)), false);
  assert.equal(C.canSeeSignRequest(recWithRequest({ signRequest: undefined }), APPROVER, C.buildPermissions(APPROVER)), false);
});

test('applySignatureToRecord: امضا در شیار approver می‌نشیند و نام از حساب کاربری می‌آید', () => {
  const rec = recWithRequest();
  const out = C.applySignatureToRecord(rec, { image: 'data:sig', name: 'اسم تایپ‌شده', title: 'ناظر' }, APPROVER, 9000);

  assert.ok(out.signatures.approver, 'امضای ناظر باید پر شود');
  assert.equal(out.signatures.approver.image, 'data:sig');
  // نام تایپ‌شده روی پد نادیده گرفته می‌شود؛ هویت از حساب کاربری می‌آید
  assert.equal(out.signatures.approver.name, 'رضا کریمی');
  assert.equal(out.signatures.approver.title, 'ناظر');
  assert.equal(out.signatures.approver.signedViaRequest, true);
  // امضای بازرس دست‌نخورده می‌ماند
  assert.equal(out.signatures.inspector.image, 'data:inspector');

  assert.equal(out.signRequest.status, 'signed');
  assert.equal(out.signRequest.signedAt, 9000);
  assert.equal(out.signRequest.signedByUserId, 'u-app');
  assert.equal(out.signRequest.signedByUserName, 'رضا کریمی');
  assert.equal(out.updatedAt, 9000, 'updatedAt باید جلو برود تا sync تغییر را ببیند');

  // ورودی جهش نمی‌یابد (برای immer و تست‌ها مهم است)
  assert.equal(rec.signRequest.status, 'pending');
  assert.equal(rec.signatures.approver, undefined);
});

test('applySignatureToRecord: ادمین که جانشین می‌شود، ردپایش ثبت می‌گردد', () => {
  const out = C.applySignatureToRecord(recWithRequest(), { image: 'data:a', name: 'x' }, ADMIN, 9000);
  assert.equal(out.signRequest.signedByUserId, 'u-adm');
  assert.notEqual(out.signRequest.signedByUserId, out.signRequest.toUserId,
    'باید قابل تشخیص باشد که گیرنده خودش امضا نکرده');
  assert.equal(out.signatures.approver.name, 'ادمین');
});

test('applySignatureToRecord: ورودی نامعتبر → null و رکورد دست‌نخورده', () => {
  const rec = recWithRequest();
  assert.equal(C.applySignatureToRecord(rec, null, APPROVER), null);
  assert.equal(C.applySignatureToRecord(rec, { name: 'بدون تصویر' }, APPROVER), null);
  assert.equal(C.applySignatureToRecord(recWithRequest({ signRequest: undefined }), { image: 'd' }, APPROVER), null);
  assert.equal(C.applySignatureToRecord(null, { image: 'd' }, APPROVER), null);
  assert.equal(rec.signRequest.status, 'pending');
});

test('cancelSignRequest: فقط ادمین یا ارجاع‌دهنده، و فقط روی درخواست باز', () => {
  const rec = recWithRequest();
  assert.equal(C.cancelSignRequest(rec, APPROVER, C.buildPermissions(APPROVER)), null, 'گیرنده نمی‌تواند لغو کند');
  assert.equal(C.cancelSignRequest(rec, VIEWER, C.buildPermissions(VIEWER)), null);

  const byOwner = C.cancelSignRequest(rec, INSPECTOR, C.buildPermissions(INSPECTOR), 8000);
  assert.equal(byOwner.signRequest.status, 'cancelled');
  assert.equal(byOwner.updatedAt, 8000);

  const byAdmin = C.cancelSignRequest(rec, ADMIN, C.buildPermissions(ADMIN), 8000);
  assert.equal(byAdmin.signRequest.status, 'cancelled');

  // دوباره لغو کردن درخواستِ already-cancelled جایز نیست
  assert.equal(C.cancelSignRequest(byOwner, ADMIN, C.buildPermissions(ADMIN)), null);
  assert.equal(rec.signRequest.status, 'pending', 'ورودی جهش نیافته');
});

test('buildSignQueue: تفکیک «باید امضا کنم» از «پیگیری» و مرتب‌سازی از قدیمی‌ترین', () => {
  const mk = (id, toUser, byUser, at, extra = {}) => Object.assign(
    { id, assetCode: id, percent: 80, status: 'موفق', inspectorName: 'بازرس', details: [], updatedAt: at },
    { signRequest: C.makeSignRequest({ toUser, byUser, at }) }, extra);

  // mk(id, toUser, byUser, at) — گیرنده اول، ارجاع‌دهنده دوم
  const records = [
    mk('old', APPROVER, MANAGER, 1000),             // به ناظر، از طرف مدیر
    mk('tracked', INSPECTOR, APPROVER, 1500),       // به بازرس → در صفِ خودِ بازرس
    mk('other', MANAGER, INSPECTOR, 2000),          // به مدیر، از طرف بازرس → پیگیری بازرس
    mk('new', APPROVER, INSPECTOR, 3000),           // به ناظر، از طرف بازرس
    mk('deleted', APPROVER, INSPECTOR, 500, { deleted: true }),
    { id: 'nosig', assetCode: 'N', percent: 50, status: 'موفق', details: [], updatedAt: 1 },
  ];

  const qApp = C.buildSignQueue(records, APPROVER, C.buildPermissions(APPROVER));
  assert.deepEqual(qApp.toSign.map(x => x.record.id), ['old', 'new'], 'قدیمی‌ترین اول');
  assert.equal(qApp.toSign[0].mine, true);
  assert.deepEqual(qApp.tracking.map(x => x.record.id), ['tracked'], 'فقط چیزی که خودش ارجاع داده');

  const qIns = C.buildSignQueue(records, INSPECTOR, C.buildPermissions(INSPECTOR));
  assert.deepEqual(qIns.toSign.map(x => x.record.id), ['tracked'], 'بازرس گیرنده‌ی این یکی است');
  assert.deepEqual(qIns.tracking.map(x => x.record.id), ['other', 'new'], 'پیگیری ارجاع‌های خودش');

  // ادمین (رفع ایراد P2-۷): صف شخصی‌اش فقط موارد خطاب به خودش است و بقیه‌ی
  // درخواست‌های باز در سطل جداگانه‌ی adminAll می‌روند تا حق «امضا به جانشینی»
  // حفظ شود ولی تب اول و شمارنده‌ی منو غول‌آسا نشوند.
  const qAdm = C.buildSignQueue(records, ADMIN, C.buildPermissions(ADMIN));
  assert.deepEqual(qAdm.toSign.map(x => x.record.id), [], 'هیچ درخواستی خطاب به خود ادمین نیست');
  assert.deepEqual(qAdm.adminAll.map(x => x.record.id), ['old', 'tracked', 'other', 'new'],
    'همه‌ی بازها در سطل ادمین؛ رکورد حذف‌شده نمی‌آید');
  assert.equal(qAdm.adminAll.every(x => x.mine === false), true, 'هیچ‌کدام مال خودش نیست');
  // ادمین همچنان بر همه‌ی آن‌ها حق امضا دارد
  assert.equal(qAdm.adminAll.every(x => C.canSignRequest(x.record, ADMIN, C.buildPermissions(ADMIN))), true,
    'ادمین باید بتواند همه را به جانشینی امضا کند');
  assert.equal(qAdm.tracking.length, 0);

  // غیرادمین هرگز adminAll ندارد
  assert.deepEqual(qApp.adminAll, [], 'ناظر سطل ادمین نمی‌گیرد');
  assert.deepEqual(qIns.adminAll, [], 'بازرس سطل ادمین نمی‌گیرد');

  const signed = C.applySignatureToRecord(records[0], { image: 'd', name: 'x' }, APPROVER, 9000);
  const qAdm2 = C.buildSignQueue([signed, records[1]], ADMIN, C.buildPermissions(ADMIN));
  assert.deepEqual(qAdm2.adminAll.map(x => x.record.id), ['tracked'], 'امضاشده از صف ادمین بیرون می‌رود');
  assert.deepEqual(qAdm2.tracking.map(x => x.record.id), ['old'], 'و به پیگیری منتقل می‌شود');

  // ورودی نامعتبر
  assert.deepEqual(C.buildSignQueue(null, APPROVER, {}).toSign, []);
  assert.deepEqual(C.buildSignQueue(records, null, {}).toSign, []);
  assert.deepEqual(C.buildSignQueue(null, APPROVER, {}).adminAll, [], 'سطل ادمین هم خالی است');
});

test('buildSignQueue: درخواست‌های بسته فقط در بخش پیگیری می‌آیند', () => {
  const signed = C.applySignatureToRecord(recWithRequest(), { image: 'd', name: 'x' }, APPROVER, 9000);
  const q = C.buildSignQueue([signed], APPROVER, C.buildPermissions(APPROVER));
  assert.equal(q.toSign.length, 0, 'چیز امضاشده دیگر در صف نیست');
  assert.equal(q.tracking.length, 0, 'گیرنده که ارجاع‌دهنده نیست، سوابق بسته را نمی‌بیند');

  const qOwner = C.buildSignQueue([signed], INSPECTOR, C.buildPermissions(INSPECTOR));
  assert.equal(qOwner.tracking.length, 1, 'ارجاع‌دهنده نتیجه را می‌بیند');
  assert.equal(qOwner.tracking[0].signRequest.status, 'signed');

  const qAdmin = C.buildSignQueue([signed], ADMIN, C.buildPermissions(ADMIN));
  assert.equal(qAdmin.tracking.length, 1, 'ادمین همه را می‌بیند');
});

/* ============ P3-۱۴: emit زودهنگام در DatePicker ============ */

test('isCompleteJalaliDraft: فقط قالب کامل را می‌پذیرد (ایراد P3-۱۴)', () => {
  // کامل: سال ۴ رقمی + ماه و روز هر دو ۲ رقمی
  assert.equal(C.isCompleteJalaliDraft('1403/01/05'), true);
  assert.equal(C.isCompleteJalaliDraft('1403/12/29'), true);

  // ناقص — این‌ها دقیقاً همان حالت‌هایی هستند که پیش‌تر emit زودهنگام می‌کردند
  assert.equal(C.isCompleteJalaliDraft('1403/01/1'), false, 'روز تک‌رقمی نباید emit شود');
  assert.equal(C.isCompleteJalaliDraft('1403/1/05'), false, 'ماه تک‌رقمی نباید emit شود');
  assert.equal(C.isCompleteJalaliDraft('1403/01'), false);
  assert.equal(C.isCompleteJalaliDraft('1403'), false);
  assert.equal(C.isCompleteJalaliDraft(''), false);
  assert.equal(C.isCompleteJalaliDraft(null), false);

  // ارقام فارسی هم باید پذیرفته شوند (کاربر ممکن است کیبورد فارسی داشته باشد)
  assert.equal(C.isCompleteJalaliDraft('۱۴۰۳/۰۱/۰۵'), true, 'ارقام فارسی باید نرمال شوند');
  assert.equal(C.isCompleteJalaliDraft('۱۴۰۳/۰۱/۵'), false);

  // نویز اضافی نادیده گرفته می‌شود ولی قالب باید کامل بماند
  assert.equal(C.isCompleteJalaliDraft('1403/01/05 '), true);
  assert.equal(C.isCompleteJalaliDraft('1403-01-05'), false, 'جداکننده‌ی غیر از / پذیرفته نیست');
});

test('سناریوی واقعی تایپ: «1403/01/1» هنگام رسیدن به «1403/01/15» emit نمی‌کند', () => {
  // شبیه‌سازی آنچه کاربر واقعاً تایپ می‌کند، نویسه به نویسه
  const target = '1403/01/15';
  const emittedAt = [];
  for (let i = 1; i <= target.length; i++) {
    const typed = target.slice(0, i);
    if (C.isCompleteJalaliDraft(typed)) emittedAt.push(typed);
  }
  assert.deepEqual(emittedAt, ['1403/01/15'],
    'فقط یک بار و در انتهای تایپ باید emit شود، نه روی 1403/01/1');
});

test('signRequestCandidates: فقط کاربران فعالِ دارای canApprove، بدون خودِ کاربر', () => {
  const users = [INSPECTOR, APPROVER, MANAGER, ADMIN, VIEWER,
    { id: 'u-off', name: 'غیرفعال', role: 'approver', active: false },
    null, { name: 'بدون id' }];

  const fromInspector = C.signRequestCandidates(users, INSPECTOR);
  const ids = fromInspector.map(u => u.id).sort();
  assert.deepEqual(ids, ['u-adm', 'u-app', 'u-mgr'], 'بازرس/مشاهده‌گر/غیرفعال حذف می‌شوند');
  assert.ok(!ids.includes('u-ins'), 'خود کاربر در فهرست نیست');

  // از دید ادمین، خودش حذف می‌شود ولی بقیه همان‌اند
  assert.deepEqual(C.signRequestCandidates(users, ADMIN).map(u => u.id).sort(), ['u-app', 'u-mgr']);
  assert.deepEqual(C.signRequestCandidates(null, INSPECTOR), []);
  // بدون کاربر جاری، هیچ‌کس به‌عنوان «خود» حذف نمی‌شود → فقط سه نقش تأییدکننده
  assert.deepEqual(C.signRequestCandidates(users, null).map(u => u.id).sort(), ['u-adm', 'u-app', 'u-mgr']);
});

test('migrateData: signRequest خراب پاک و signRequest سالم نرمال می‌شود', () => {
  const d = C.migrateData({
    version: 1,
    records: [
      { id: 'r1', details: 'not-array', signRequest: { toUserId: 'u-app', status: 'bogus' } },
      { id: 'r2', signRequest: { note: 'بدون گیرنده' } },
      { id: 'r3', signRequest: null },
      { id: 'r4' },
    ],
  });
  assert.ok(Array.isArray(d.records[0].details));
  assert.equal(d.records[0].signRequest.status, 'pending', 'وضعیت ناشناخته → pending');
  assert.equal(d.records[0].signRequest.toUserName, '');
  assert.equal(d.records[1].signRequest, undefined, 'درخواست بدون گیرنده حذف می‌شود');
  assert.equal('signRequest' in d.records[2], false, 'null حذف می‌شود');
  assert.equal('signRequest' in d.records[3], false);
});

test('normalizeEntity: signRequest خالی از سرور حذف می‌شود تا op اکو تولید نکند', () => {
  // ستون JSON در شیت وقتی خالی باشد null برمی‌گرداند؛ اگر null را نگه داریم،
  // sameEntity تفاوت می‌بیند و هر بار یک op بی‌مصرف به صف اضافه می‌شود.
  const withNull = C.normalizeEntity('records', { id: 'r1', signRequest: null });
  assert.equal('signRequest' in withNull, false);
  const withUndef = C.normalizeEntity('records', { id: 'r1', signRequest: undefined });
  assert.equal('signRequest' in withUndef, false);

  const sr = C.makeSignRequest({ toUser: APPROVER, byUser: INSPECTOR, at: 1000 });
  const kept = C.normalizeEntity('records', { id: 'r1', signRequest: sr });
  assert.deepEqual(kept.signRequest, sr, 'درخواست واقعی باید دست‌نخورده بماند');

  // و مهم: رکوردِ بدونِ این فیلد با رکوردِ null-دار یکسان حساب شود
  assert.equal(C.sameEntity(C.normalizeEntity('records', { id: 'r1', signRequest: null }),
    C.normalizeEntity('records', { id: 'r1' })), true);
});

/* ================ #۸: یکدستی نام امضاکننده (resolveSignerName) ================
   پیش از رفع، دکمه‌ی امضا با نام خالی هم فعال بود و امضایی با signerName تهی
   ثبت می‌شد؛ بعداً در فهرست «در انتظار امضا» بی‌نام نمایش داده می‌شد. */

test('resolveSignerName: نام را trim می‌کند و به username برمی‌گردد', () => {
  const C = loadCore();
  assert.equal(C.resolveSignerName({ name: '  علی رضایی  ' }), 'علی رضایی', 'فاصله‌های اضافی باید حذف شود');
  assert.equal(C.resolveSignerName({ name: '', username: 'ali.r' }), 'ali.r', 'نام خالی → username');
  assert.equal(C.resolveSignerName({ name: '   ', username: 'ali.r' }), 'ali.r', 'نام فقط-فاصله هم خالی است');
  assert.equal(C.resolveSignerName({ username: 'ali.r' }), 'ali.r');
  assert.equal(C.resolveSignerName({}), '', 'هیچ نامی → رشته‌ی خالی (نه undefined)');
  assert.equal(C.resolveSignerName(null), '', 'ورودی null نباید crash کند');
  assert.equal(C.resolveSignerName(undefined), '');
  assert.equal(typeof C.resolveSignerName({ name: 123 }), 'string', 'خروجی همیشه رشته است');
});

test('applySignatureToRecord: نام خالی یعنی امضا ثبت نمی‌شود (ایراد #۸)', () => {
  const C = loadCore();
  const mkRec = () => ({
    id: 'r1', title: 'کار', signatures: {},
    signRequest: C.makeSignRequest({
      toUser: { id: 'u2', name: 'مریم' }, byUser: { id: 'u1', name: 'علی' }, slot: 'approver', at: 900,
    }),
  });
  const sig = { image: 'data:image/png;base64,AAAA' };
  const good = { id: 'u2', name: 'مریم' };

  assert.equal(C.applySignatureToRecord(mkRec(), sig, { id: 'u2', name: '   ' }, 1000), null,
    'نام فقط-فاصله باید رد شود، وگرنه امضای بی‌نام در گزارش می‌ماند');
  assert.equal(C.applySignatureToRecord(mkRec(), sig, { id: 'u2' }, 1000), null,
    'کاربر بدون هیچ نامی باید رد شود');
  assert.equal(C.applySignatureToRecord(mkRec(), sig, null, 1000), null, 'user تهی باید رد شود');
  assert.equal(C.applySignatureToRecord(mkRec(), { image: '' }, good, 1000), null, 'بدون تصویر امضا رد می‌شود');
  assert.equal(C.applySignatureToRecord(mkRec(), sig, { id: 'u2', username: 'maryam' }, 1000) !== null, true,
    'نبود name ولی وجود username باید پذیرفته شود');

  const out = C.applySignatureToRecord(mkRec(), sig, { id: 'u2', name: '  مریم  ' }, 1000);
  assert.ok(out, 'ورودی معتبر باید بپذیرد');
  assert.equal(out.signatures.approver.name, 'مریم', 'نام trim‌شده ذخیره می‌شود، نه خام');
  assert.equal(out.signRequest.status, C.SIGN_REQUEST_STATUS.SIGNED, 'وضعیت باید به امضاشده برود');
  assert.equal(out.signRequest.signedByUserName, 'مریم');
  assert.equal(out.signRequest.signedAt, 1000);
  assert.equal(out.updatedAt, 1000, 'updatedAt باید جلو برود تا LWW درست کار کند');
});

/* ============ #۵: payload تلاش مجدد نباید از سقف IndexedDB بگذرد ============ */

test('sanitizeOpForConflict_: کپی عمیق می‌دهد و ورودی تهی را null می‌کند', () => {
  const C = loadCore();
  assert.equal(C.sanitizeOpForConflict_(null), null);
  assert.equal(C.sanitizeOpForConflict_(undefined), null);
  assert.equal(C.sanitizeOpForConflict_(0), null, 'مقادیر falsy غیر از شیء رد می‌شوند');
  const op = { id: 'op1', kind: 'update', entity: { records: [{ id: 'r1', title: 'x' }] }, atMs: 5 };
  const copy = C.sanitizeOpForConflict_(op);
  assert.deepEqual(copy, op, 'محتوا باید دست‌نخورده بماند');
  assert.notEqual(copy, op, 'باید کپی باشد تا جهش بعدی روی صف اثر نگذارد');
  assert.notEqual(copy.entity, op.entity, 'کپی باید عمیق باشد');
});

test('sanitizeOpForConflict_: op بزرگ‌تر از سقف را رد می‌کند (نه ذخیره‌ی بی‌صدا)', () => {
  const C = loadCore();
  assert.ok(C.MAX_CONFLICT_OP_BYTES > 0, 'سقف باید تعریف شده باشد');
  const huge = { id: 'op2', kind: 'update', entity: { records: [{ id: 'r1', blob: 'A'.repeat(C.MAX_CONFLICT_OP_BYTES + 1) }] } };
  assert.equal(C.sanitizeOpForConflict_(huge), null, 'بزرگ‌تر از سقف → null تا دکمه غیرفعال شود');
  const justUnder = { id: 'op3', entity: { blob: 'A'.repeat(Math.max(10, C.MAX_CONFLICT_OP_BYTES - 200)) } };
  assert.ok(C.sanitizeOpForConflict_(justUnder), 'زیر سقف باید پذیرفته شود');
});

test('sanitizeOpForConflict_: شیء غیرقابل‌سریال‌شدن استثنا نمی‌دهد', () => {
  const C = loadCore();
  const cyclic = { id: 'op4' }; cyclic.self = cyclic;
  assert.equal(C.sanitizeOpForConflict_(cyclic), null, 'چرخه باید null شود، نه throw');
});

/* ========= #۶: ترتیب دسته‌ها باید از ستون order سرور پیروی کند =========
   پیش از رفع، دسته‌ی جدید همیشه به انتها چسبانده می‌شد و تغییر ترتیب روی
   دستگاه دیگر هرگز به این دستگاه نمی‌رسید. */

test('mergeRemote: در pull کامل، دسته‌ها بر اساس order سرور بازچینی می‌شوند (ایراد #۶)', () => {
  const C = loadCore();
  const local = { categories: ['الف', 'ب', 'پ'] };
  const remote = {
    full: true,
    entities: { categories: [
      { name: 'الف', order: 3 }, { name: 'ب', order: 1 }, { name: 'پ', order: 2 },
    ] },
  };
  const { data } = C.mergeRemote(local, remote);
  assert.deepEqual(data.categories, ['ب', 'پ', 'الف'], 'ترتیب سرور باید حاکم باشد');
});

test('mergeRemote: دسته‌ی جدید سرور در جای درست درج می‌شود، نه همیشه انتها', () => {
  const C = loadCore();
  const local = { categories: ['الف', 'پ'] };
  const remote = { full: true, entities: { categories: [
    { name: 'الف', order: 1 }, { name: 'ب', order: 2 }, { name: 'پ', order: 3 },
  ] } };
  const { data } = C.mergeRemote(local, remote);
  assert.deepEqual(data.categories, ['الف', 'ب', 'پ'], '«ب» باید وسط بیفتد');
});

test('mergeRemote: tombstone دسته را حذف می‌کند', () => {
  const C = loadCore();
  const local = { categories: ['الف', 'ب', 'پ'] };
  const remote = { full: true, entities: { categories: [
    { name: 'الف', order: 1, deleted: true }, { name: 'ب', order: 2 }, { name: 'پ', order: 3 },
  ] } };
  const { data } = C.mergeRemote(local, remote);
  assert.deepEqual(data.categories, ['ب', 'پ'], 'دسته‌ی حذف‌شده نباید برگردد');
});

test('mergeRemote: در pull افزایشیِ ناقص، ترتیب محلی را به‌هم نمی‌ریزد', () => {
  const C = loadCore();
  // فقط یک ردیف برگشته؛ order بقیه نامعلوم است → بازچینی باید انجام نشود.
  const local = { categories: ['الف', 'ب', 'پ'] };
  const remote = { full: false, entities: { categories: [{ name: 'پ', order: 0 }] } };
  const { data } = C.mergeRemote(local, remote);
  assert.deepEqual(data.categories, ['الف', 'ب', 'پ'], 'بازچینی ناقص خطرناک است؛ ترتیب فعلی حفظ شود');
});

test('mergeRemote: order غیرعددی نادیده گرفته می‌شود', () => {
  const C = loadCore();
  const local = { categories: ['الف', 'ب'] };
  const remote = { full: true, entities: { categories: [
    { name: 'الف', order: 'abc' }, { name: 'ب', order: null },
  ] } };
  const { data } = C.mergeRemote(local, remote);
  assert.deepEqual(data.categories, ['الف', 'ب'], 'بدون order معتبر، ترتیب دست‌نخورده می‌ماند');
});

/* ============ fallback خالص JS برای context ناامن (crypto.subtle نباشد) ============
   علت اصلی گیر کردن اپ روی «در حال آماده‌سازی سامانه…»: `crypto.subtle` فقط در
   HTTPS/localhost وجود دارد. با file:// یا http:// معمولی، `derivePasswordHash`
   استثنا می‌داد و چون بوت try/catch نداشت، `setReady(true)` هرگز اجرا نمی‌شد. */

import nodeCrypto from 'node:crypto';
const hexOf = b => Buffer.from(b).toString('hex');
const bytesOf = s => new TextEncoder().encode(s);

test('sha256BytesPure: در همه‌ی مرزهای بلوک با crypto نود یکی است', () => {
  const C = loadCore();
  // طول‌های ۰ تا ۳۰۰ همه‌ی مرزهای padding (۵۵، ۵۶، ۶۳، ۶۴، ۶۵، ۱۱۹، ۱۲۰…) را پوشش می‌دهد
  for (let L = 0; L <= 300; L++) {
    const s = 'x'.repeat(L);
    assert.equal(hexOf(C.sha256BytesPure(bytesOf(s))),
      nodeCrypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex'),
      `SHA-256 برای طول ${L} فرق دارد`);
  }
  for (const s of ['', 'سلام دنیا', '🎉', 'y'.repeat(4096)]) {
    assert.equal(hexOf(C.sha256BytesPure(bytesOf(s))),
      nodeCrypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex'),
      'UTF-8 چندبایتی/بلند باید درست هش شود');
  }
});

test('hmacSha256BytesPure: کلید کوتاه، دقیقاً ۶۴ و بلندتر از ۶۴ بایت', () => {
  const C = loadCore();
  // کلید بلندتر از ۶۴ بایت باید اول هش شود (RFC 2104) — این مسیر جداست
  for (const klen of [0, 1, 32, 63, 64, 65, 128]) {
    for (const mlen of [0, 1, 55, 64, 200]) {
      const k = 'k'.repeat(klen), m = 'm'.repeat(mlen);
      assert.equal(hexOf(C.hmacSha256BytesPure(bytesOf(k), bytesOf(m))),
        nodeCrypto.createHmac('sha256', Buffer.from(k, 'utf8')).update(Buffer.from(m, 'utf8')).digest('hex'),
        `HMAC برای klen=${klen} mlen=${mlen} فرق دارد`);
    }
  }
});

test('pbkdf2Sha256Pure: با pbkdf2 نود یکی است (شامل تکرار ۱ و ۲)', () => {
  const C = loadCore();
  for (const [pw, salt, it] of [['1234', 'abcd', 1], ['1234', 'abcd', 2], ['123456', 'salt', 1000], ['پسورد', 'نمک', 500]]) {
    assert.equal(hexOf(C.pbkdf2Sha256Pure(bytesOf(pw), bytesOf(salt), it, 32)),
      nodeCrypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), Buffer.from(salt, 'utf8'), it, 32, 'sha256').toString('hex'),
      `PBKDF2 برای «${pw}» با ${it} تکرار فرق دارد`);
  }
});

test('سازگاری دو مسیر: خروجی WebCrypto و مسیر خالص JS یکی است', async () => {
  const C = loadCore();
  assert.equal(C.HAS_SUBTLE, true, 'در Node باید crypto.subtle در دسترس باشد');
  for (const [pw, salt, it] of [['1234', 'a1b2c3', 1000], ['رمز-کاربر', 'salt-1234567890', 1000]]) {
    const viaSubtle = await C.derivePasswordHash(pw, salt, it);
    const viaPure = hexOf(C.pbkdf2Sha256Pure(bytesOf(pw), bytesOf(salt), it, 32));
    assert.equal(viaSubtle, viaPure, 'هش کاربران موجود نباید با فعال‌شدن fallback باطل شود');
  }
});

test('context ناامن: بدون crypto.subtle هم رمز مشتق می‌شود (علت اصلی هنگ بوت)', async () => {
  const realCrypto = globalThis.crypto;
  // شبیه‌سازی file:// یا http:// معمولی: crypto هست ولی subtle ندارد
  Object.defineProperty(globalThis, 'crypto', {
    value: { getRandomValues: a => realCrypto.getRandomValues(a) },
    configurable: true, writable: true,
  });
  try {
    const C = loadCore();
    assert.equal(C.HAS_SUBTLE, false, 'باید تشخیص دهد subtle در دسترس نیست');
    const hash = await C.derivePasswordHash('1234', 'abcd', 1000);
    assert.equal(hash, nodeCrypto.pbkdf2Sync(Buffer.from('1234'), Buffer.from('abcd'), 1000, 32, 'sha256').toString('hex'),
      'مسیر fallback باید همان هش درست را بدهد');
    // makeCredential همان چیزی است که در بوت صدا زده می‌شد و هنگ می‌کرد
    const cred = await C.makeCredential('1234', 1000);
    assert.ok(cred.passwordHash && cred.salt, 'makeCredential باید بدون استثنا کامل شود');
    // verifyCredential شیء {ok, upgrade} برمی‌گرداند، نه boolean
    // امضای تابع verifyCredential(user, password) است
    assert.equal((await C.verifyCredential(cred, '1234')).ok, true, 'رمز درست باید تأیید شود');
    assert.equal((await C.verifyCredential(cred, '9999')).ok, false, 'رمز غلط باید رد شود');
    assert.ok((await C.sha256Hex('abc')) === nodeCrypto.createHash('sha256').update('abc').digest('hex'));
    assert.ok((await C.hmacSha256Hex('k', 'm')) === nodeCrypto.createHmac('sha256', 'k').update('m').digest('hex'));
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true, writable: true });
  }
  assert.equal(loadCore().HAS_SUBTLE, true, 'crypto باید بعد از تست برگردد');
});

/* ===== diagnoseLoginInput: دام‌های رایج ورود برای کاربر فارسی‌زبان ===== */

test('diagnoseLoginInput: ارقام فارسی در رمز را تشخیص می‌دهد', () => {
  const C = loadCore();
  assert.ok(C.diagnoseLoginInput('admin', '۱۲۳۴').some(h => h.includes('فارسی')),
    '۱۲۳۴ باید هشدار ارقام فارسی بدهد');
  assert.ok(C.diagnoseLoginInput('admin', '١٢٣٤').length > 0, 'ارقام عربی-هندی هم باید گرفته شوند');
  assert.deepEqual(C.diagnoseLoginInput('admin', '1234'), [], 'ورودی درست نباید هیچ هینتی بدهد');
  assert.deepEqual(C.diagnoseLoginInput('', ''), [], 'ورودی خالی هینت نمی‌گیرد (خطای جداگانه دارد)');
});

test('diagnoseLoginInput: فاصله و نویسه‌ی نامرئی را تشخیص می‌دهد', () => {
  const C = loadCore();
  assert.ok(C.diagnoseLoginInput('admin', ' 1234').some(h => h.includes('فاصله')), 'فاصله‌ی ابتدا');
  assert.ok(C.diagnoseLoginInput('admin', '1234 ').some(h => h.includes('فاصله')), 'فاصله‌ی انتها');
  assert.ok(C.diagnoseLoginInput(' admin ', '1234').some(h => h.includes('نام کاربری')), 'فاصله در نام کاربری');
  assert.ok(C.diagnoseLoginInput('admin', '1234\u200c').some(h => h.includes('نامرئی')), 'نیم‌فاصله');
  assert.ok(C.diagnoseLoginInput('admin', '12\u00a034').some(h => h.includes('نامرئی')), 'فاصله‌ی نشکن');
  // چند مشکل همزمان → همه گزارش شوند
  const multi = C.diagnoseLoginInput(' admin', '۱۲۳۴ ');
  assert.ok(multi.length >= 3, `باید چند هینت بدهد، داد: ${multi.length}`);
});

test('diagnoseLoginInput: ورودی تهی/غیررشته‌ای استثنا نمی‌دهد', () => {
  const C = loadCore();
  for (const bad of [null, undefined, 0, {}, []]) {
    assert.ok(Array.isArray(C.diagnoseLoginInput(bad, bad)), 'باید همیشه آرایه برگرداند');
  }
});

/* ============ مدل ب — زنجیره‌ی امضای اجباری و ترتیبی ============ */

const CHAIN_A = { id: 'u-app', username: 'reza', name: 'رضا کریمی', role: 'approver', active: true };
const CHAIN_B = { id: 'u-mgr', username: 'mgr', name: 'مدیر ارشد', role: 'manager', active: true };

function chainRec(over = {}) {
  return Object.assign({
    id: 'rc1', assetCode: 'DB-01', percent: 90, status: 'موفق', details: [],
    inspectorName: 'علی محمدی',
    signatures: { inspector: { image: 'data:ins', name: 'علی محمدی' } },
    signRequest: C.makeSignChain({
      steps: [{ toUser: CHAIN_A, slot: 'approver' }, { toUser: CHAIN_B, slot: 'manager' }],
      byUser: INSPECTOR, at: 1000,
    }),
    updatedAt: 1000,
  }, over);
}

test('makeSignChain: دو مرحله به ترتیب استاندارد ساخته می‌شود', () => {
  const sr = chainRec().signRequest;
  assert.equal(sr.steps.length, 2);
  assert.deepEqual(sr.steps.map(s => s.slot), ['approver', 'manager']);
  assert.equal(sr.current, 0);
  assert.equal(sr.status, 'pending');
  // آینه‌ی مرحله‌ی فعال = مرحله‌ی اول
  assert.equal(sr.toUserId, 'u-app');
  assert.equal(sr.slot, 'approver');
});

test('makeSignChain: ترتیب ورودی مهم نیست؛ خروجی همیشه approver سپس manager', () => {
  const sr = C.makeSignChain({
    steps: [{ toUser: CHAIN_B, slot: 'manager' }, { toUser: CHAIN_A, slot: 'approver' }],
    byUser: INSPECTOR, at: 1,
  });
  assert.deepEqual(sr.steps.map(s => s.slot), ['approver', 'manager']);
  assert.equal(sr.toUserId, 'u-app', 'نوبت اول با ناظر است، نه تأییدکننده‌ی نهایی');
});

test('makeSignChain: یک شیار تکراری دور ریخته می‌شود و ورودی خالی → null', () => {
  const sr = C.makeSignChain({
    steps: [{ toUser: CHAIN_A, slot: 'approver' }, { toUser: CHAIN_B, slot: 'approver' }],
    byUser: INSPECTOR, at: 1,
  });
  assert.equal(sr.steps.length, 1);
  assert.equal(C.makeSignChain({ steps: [], byUser: INSPECTOR }), null);
  assert.equal(C.makeSignChain({ steps: [{ toUser: null }] }), null);
  assert.equal(C.makeSignChain({ steps: 'nope' }), null);
});

test('ترتیبی بودن: نفر سوم تا امضای نفر دوم اجازه‌ی امضا ندارد', () => {
  const rec = chainRec();
  assert.equal(C.canSignRequest(rec, CHAIN_A, C.buildPermissions(CHAIN_A)), true, 'نوبت ناظر است');
  assert.equal(C.canSignRequest(rec, CHAIN_B, C.buildPermissions(CHAIN_B)), false,
    'تأییدکننده‌ی نهایی نباید بتواند از نوبت جلو بزند');

  const after = C.applySignatureToRecord(rec, { image: 'data:a' }, CHAIN_A, 2000);
  assert.equal(after.signatures.approver.name, 'رضا کریمی');
  assert.equal(after.signRequest.status, 'pending', 'هنوز یک مرحله مانده');
  assert.equal(after.signRequest.current, 1);
  assert.equal(C.canSignRequest(after, CHAIN_A, C.buildPermissions(CHAIN_A)), false, 'نوبتش گذشته');
  assert.equal(C.canSignRequest(after, CHAIN_B, C.buildPermissions(CHAIN_B)), true, 'حالا نوبت اوست');

  const done = C.applySignatureToRecord(after, { image: 'data:b' }, CHAIN_B, 3000);
  assert.equal(done.signRequest.status, 'signed');
  assert.equal(done.signatures.manager.name, 'مدیر ارشد');
  assert.equal(done.signatures.approver.image, 'data:a', 'امضای مرحله‌ی قبل دست‌نخورده');
  assert.equal(done.signatures.inspector.image, 'data:ins');
  assert.equal(C.isPendingSignRequest(done), false);

  // ورودی هیچ‌کدام جهش نیافته
  assert.equal(rec.signRequest.current, 0);
  assert.equal(after.signRequest.steps[1].status, 'pending');
});

test('صف امضا: نفر سوم پیش از نوبتش، مورد را در «پیگیری» با نشان upcoming می‌بیند', () => {
  const rec = chainRec();
  const qB = C.buildSignQueue([rec], CHAIN_B, C.buildPermissions(CHAIN_B));
  assert.equal(qB.toSign.length, 0);
  assert.equal(qB.tracking.length, 1);
  assert.equal(qB.tracking[0].upcoming, true);

  const qA = C.buildSignQueue([rec], CHAIN_A, C.buildPermissions(CHAIN_A));
  assert.equal(qA.toSign.length, 1);
  assert.equal(qA.toSign[0].step.slot, 'approver');
  assert.equal(qA.toSign[0].stepIndex, 0);

  // پس از امضای ناظر، جای این دو عوض می‌شود
  const after = C.applySignatureToRecord(rec, { image: 'd' }, CHAIN_A, 2000);
  assert.equal(C.buildSignQueue([after], CHAIN_B, C.buildPermissions(CHAIN_B)).toSign.length, 1);
  assert.equal(C.buildSignQueue([after], CHAIN_A, C.buildPermissions(CHAIN_A)).toSign.length, 0);
});

test('لغو زنجیره: مراحل باز لغو می‌شوند ولی امضاهای ثبت‌شده می‌مانند', () => {
  const after = C.applySignatureToRecord(chainRec(), { image: 'd' }, CHAIN_A, 2000);
  const cancelled = C.cancelSignRequest(after, INSPECTOR, C.buildPermissions(INSPECTOR), 4000);
  assert.equal(cancelled.signRequest.status, 'cancelled');
  assert.equal(cancelled.signRequest.steps[0].status, 'signed', 'مرحله‌ی امضاشده دست‌نخورده');
  assert.equal(cancelled.signRequest.steps[1].status, 'cancelled');
  assert.equal(cancelled.signatures.approver.image, 'd');
  assert.equal(C.canSignRequest(cancelled, CHAIN_B, C.buildPermissions(CHAIN_B)), false);
});

test('signChainProgress و signChainLabel: شمارش درست «x از ۳»', () => {
  const rec = chainRec();
  const p0 = C.signChainProgress(rec);
  assert.equal(p0.total, 3);
  assert.equal(p0.done, 1, 'فقط امضای بازرس');
  assert.ok(C.signChainLabel(rec).indexOf('رضا کریمی') > -1);

  const p1 = C.signChainProgress(C.applySignatureToRecord(rec, { image: 'd' }, CHAIN_A, 2000));
  assert.equal(p1.done, 2);
  assert.equal(p1.total, 3);

  const done = C.applySignatureToRecord(
    C.applySignatureToRecord(rec, { image: 'd' }, CHAIN_A, 2000), { image: 'e' }, CHAIN_B, 3000);
  assert.equal(C.signChainProgress(done).done, 3);
  assert.equal(C.signChainLabel(done), 'همه‌ی امضاها کامل شد');

  // رکورد بدون زنجیره (نسخه‌ی قدیمی) نباید کرش کند
  assert.equal(C.signChainLabel({ signatures: {} }), '');
  assert.equal(C.signChainProgress(null).total, 1);
});

test('سازگاری رو به عقب: درخواست تکِ نسخه ۸.۲ به زنجیره‌ی یک‌مرحله‌ای تبدیل می‌شود', () => {
  const legacy = {
    toUserId: 'u-app', toUserName: 'رضا کریمی', byUserId: 'u-ins', byUserName: 'علی',
    slot: 'approver', note: 'یادداشت', requestedAt: 700, status: 'pending',
    signedAt: 0, signedByUserId: '', signedByUserName: '',
  };
  const n = C.normalizeSignRequest(legacy);
  assert.equal(n.steps.length, 1);
  assert.equal(n.steps[0].toUserId, 'u-app');
  assert.equal(n.toUserId, 'u-app', 'فیلد تخت هم باید باشد');
  assert.equal(n.note, 'یادداشت');
  assert.equal(C.signChainProgress({ signatures: { inspector: {} }, signRequest: legacy }).total, 2,
    'برگه‌ی قدیمی دو امضا دارد نه سه');

  // نسخه‌ی قدیمیِ امضاشده
  const legacySigned = Object.assign({}, legacy, { status: 'signed', signedAt: 900, signedByUserId: 'u-app' });
  assert.equal(C.normalizeSignRequest(legacySigned).status, 'signed');
  assert.equal(C.normalizeSignRequest(legacySigned).current, 1);
});

test('validateSignChain: هر مرحله فرد متفاوت، فعال و دارای اجازه‌ی تأیید', () => {
  const users = [INSPECTOR, CHAIN_A, CHAIN_B, VIEWER,
    { id: 'u-off', username: 'off', name: 'غیرفعال', role: 'approver', active: false }];
  const settings = { signFlowMode: 'chain' };

  assert.equal(C.validateSignChain({ approver: 'u-app', manager: 'u-mgr' }, users, INSPECTOR, settings), null);

  assert.ok(C.validateSignChain({ approver: '', manager: 'u-mgr' }, users, INSPECTOR, settings));
  assert.ok(C.validateSignChain({ approver: 'u-app', manager: '' }, users, INSPECTOR, settings));
  assert.ok(/دو مرحله/.test(C.validateSignChain({ approver: 'u-app', manager: 'u-app' }, users, INSPECTOR, settings)));
  assert.ok(C.validateSignChain({ approver: 'u-vw', manager: 'u-mgr' }, users, INSPECTOR, settings),
    'مشاهده‌گر اجازه‌ی تأیید ندارد');
  assert.ok(C.validateSignChain({ approver: 'u-off', manager: 'u-mgr' }, users, INSPECTOR, settings),
    'کاربر غیرفعال رد می‌شود');
  assert.ok(C.validateSignChain({ approver: 'u-app', manager: 'u-ins' }, users, INSPECTOR, settings),
    'خودِ بازرس نمی‌تواند گیرنده باشد');
  assert.ok(C.validateSignChain({ approver: 'u-app', manager: 'ghost' }, users, INSPECTOR, settings));

  // در حالت ساده هیچ الزامی نیست
  assert.equal(C.validateSignChain({}, users, INSPECTOR, { signFlowMode: 'single' }), null);
});

test('resolveSignFlowMode: پیش‌فرض زنجیره است و فقط single آن را عوض می‌کند', () => {
  assert.equal(C.resolveSignFlowMode(undefined), 'chain');
  assert.equal(C.resolveSignFlowMode({}), 'chain');
  assert.equal(C.resolveSignFlowMode({ signFlowMode: 'nonsense' }), 'chain');
  assert.equal(C.resolveSignFlowMode({ signFlowMode: 'single' }), 'single');
  assert.equal(C.isSignChainMode({ signFlowMode: 'single' }), false);
  assert.deepEqual(C.requiredSignSlots({}), ['approver', 'manager']);
  assert.deepEqual(C.requiredSignSlots({ signFlowMode: 'single' }), []);
});

test('signRequestCandidates: excludeIds نفر انتخاب‌شده‌ی مرحله‌ی دیگر را حذف می‌کند', () => {
  const users = [INSPECTOR, CHAIN_A, CHAIN_B, ADMIN];
  const all = C.signRequestCandidates(users, INSPECTOR).map(u => u.id).sort();
  assert.deepEqual(all, ['u-adm', 'u-app', 'u-mgr']);
  const minusA = C.signRequestCandidates(users, INSPECTOR, ['u-app']).map(u => u.id).sort();
  assert.deepEqual(minusA, ['u-adm', 'u-mgr']);
  // ورودی نامعتبر در excludeIds بی‌اثر است
  assert.deepEqual(C.signRequestCandidates(users, INSPECTOR, ['', null]).map(u => u.id).sort(), all);
});

/* ============ اعتبارنامه‌های پیش‌فرضِ از پیش محاسبه‌شده ============ */

test('DEFAULT_ADMIN_CRED / DEFAULT_PIN_CRED دقیقاً با PBKDF2 زنده می‌خوانند', async () => {
  // اگر این تست بشکند یعنی هیچ‌کس نمی‌تواند با admin/1234 وارد شود — بی‌صدا و فاجعه‌بار
  const a = C.DEFAULT_ADMIN_CRED;
  assert.equal(a.hashAlgo, C.HASH_ALGO);
  assert.equal(a.iterations, C.PBKDF2_ITERATIONS);
  assert.equal(await C.derivePasswordHash('1234', a.salt, a.iterations), a.passwordHash);
  assert.equal((await C.verifyCredential(Object.assign({}, a), '1234')).ok, true);
  assert.equal((await C.verifyCredential(Object.assign({}, a), '12345')).ok, false);

  const p = C.DEFAULT_PIN_CRED;
  assert.equal(await C.derivePasswordHash('123456', p.salt, p.iterations), p.passwordHash);
  assert.notEqual(a.salt, p.salt);
});

/* =====================================================================
   تعداد امضاکنندگان در سطح چک‌لیست + ارجاع مرحله‌ی فعال
   ===================================================================== */

test('templateSignerCount: مقدار صریح قالب مقدم بر تنظیم سازمان است', () => {
  const single = { signFlowMode: 'single' };
  const chain = { signFlowMode: 'chain' };
  assert.equal(C.templateSignerCount({ signers: 1 }, chain), 1, 'صریح ۱ حتی در سازمان زنجیره‌ای');
  assert.equal(C.templateSignerCount({ signers: 2 }, chain), 2);
  assert.equal(C.templateSignerCount({ signers: 3 }, single), 3, 'صریح ۳ حتی در سازمان ساده');
  // نامعتبر/غایب → ارث از سازمان
  assert.equal(C.templateSignerCount({}, chain), 3);
  assert.equal(C.templateSignerCount({}, single), 1);
  assert.equal(C.templateSignerCount({ signers: 7 }, single), 1);
  assert.equal(C.templateSignerCount({ signers: '2' }, chain), 2, 'رشته‌ی عددی هم پذیرفته می‌شود');
  assert.equal(C.templateSignerCount(null, chain), 3);
});

test('signSlotsForCount و signerCountLabel: شیارها و برچسب‌های ۱/۲/۳', () => {
  assert.deepEqual(C.signSlotsForCount(1), []);
  assert.deepEqual(C.signSlotsForCount(2), ['approver']);
  assert.deepEqual(C.signSlotsForCount(3), ['approver', 'manager']);
  assert.deepEqual(C.signSlotsForCount(99), ['approver', 'manager']);
  assert.ok(C.signerCountLabel(1).includes('بازرس'));
  assert.ok(C.signerCountLabel(2).includes('ناظر'));
  assert.ok(C.signerCountLabel(3).includes('تأییدکننده'));
});

test('validateSignChain با شیارهای صریح: چک‌لیست دو‌امضا فقط ناظر را الزامی می‌داند', () => {
  const users = [INSPECTOR, CHAIN_A, CHAIN_B, VIEWER];
  // حتی در سازمان «ساده»، اگر قالب شیار بدهد اعتبارسنجی اجرا می‌شود
  assert.equal(C.validateSignChain({ approver: 'u-app' }, users, INSPECTOR, { signFlowMode: 'single' }, ['approver']), null);
  assert.ok(C.validateSignChain({}, users, INSPECTOR, { signFlowMode: 'single' }, ['approver']), 'ناظر نباید جا بیندازد');
  // شیار مدیر اصلاً لازم نیست — خالی بودنش خطا نیست
  assert.equal(C.validateSignChain({ approver: 'u-app', manager: '' }, users, INSPECTOR, chainSettings(), ['approver']), null);
  // فهرست خالی → هیچ الزامی نیست
  assert.equal(C.validateSignChain({}, users, INSPECTOR, { signFlowMode: 'chain' }, []), null);
  function chainSettings() { return { signFlowMode: 'chain' }; }
});

test('migrateData: فیلد signers قالب فقط ۱/۲/۳ می‌ماند', () => {
  const mk = (signers) => C.migrateData({
    version: 4, users: [], categories: [], assets: [], assignments: [], records: [],
    templates: [{ id: 't1', name: 'ت', items: [], signers }],
    settings: {}, revision: 0, lastSyncAt: 0,
  });
  assert.equal(mk(2).templates[0].signers, 2);
  assert.equal(mk('3').templates[0].signers, 3);
  assert.equal('signers' in mk(0).templates[0], false);
  assert.equal('signers' in mk(4).templates[0], false);
  assert.equal('signers' in mk('abc').templates[0], false);
});

function referRec() {
  return {
    id: 'rr1', assetCode: 'DB-01', percent: 90, status: 'موفق', details: [],
    inspectorId: INSPECTOR.id, inspectorName: INSPECTOR.name,
    signatures: { inspector: { image: 'data:ins', name: INSPECTOR.name } },
    signRequest: C.makeSignChain({
      steps: [{ toUser: CHAIN_A, slot: 'approver', note: 'یادداشت اصلی' }, { toUser: CHAIN_B, slot: 'manager' }],
      byUser: INSPECTOR, at: 1000,
    }),
    updatedAt: 1000,
  };
}

test('referSignRequest: گیرنده‌ی فعال می‌تواند به کاربر واجد شرایط ارجاع دهد', () => {
  const rec = referRec();
  const next = C.referSignRequest(rec, { toUser: ADMIN, byUser: CHAIN_A, note: 'حاضر نیستم' }, C.buildPermissions(CHAIN_A), 2000);
  assert.ok(next);
  assert.equal(next.signRequest.current, 0, 'همان مرحله فعال می‌ماند');
  const step = next.signRequest.steps[0];
  assert.equal(step.toUserId, 'u-adm');
  assert.equal(step.toUserName, 'ادمین');
  assert.equal(step.note, 'حاضر نیستم');
  assert.equal(step.referredFrom.userId, 'u-app', 'ردپای ارجاع‌دهنده');
  assert.equal(step.referredFrom.at, 2000);
  assert.equal(next.signRequest.steps[1].toUserId, 'u-mgr', 'مرحله‌ی بعدی دست‌نخورده');
  assert.equal(next.updatedAt, 2000);
  // ورودی جهش نیافته است
  assert.equal(rec.signRequest.steps[0].toUserId, 'u-app');
});

test('referSignRequest: ادمین به جانشینی ارجاع می‌دهد ولی بقیه نه', () => {
  const rec = referRec();
  const byAdmin = C.referSignRequest(rec, { toUser: CHAIN_A, byUser: ADMIN, note: '' }, C.buildPermissions(ADMIN), 3000);
  assert.ok(byAdmin, 'ادمین اجازه دارد');
  // ارجاع دوباره به همان گیرنده‌ی فعلی توسط ادمین هم مجاز است (رفع بن‌بست)
  const byOther = C.referSignRequest(rec, { toUser: ADMIN, byUser: CHAIN_B, note: '' }, C.buildPermissions(CHAIN_B), 3000);
  assert.equal(byOther, null, 'نفر مرحله‌ی بعدی حق ارجاع ندارد');
  const byInspector = C.referSignRequest(rec, { toUser: ADMIN, byUser: INSPECTOR, note: '' }, C.buildPermissions(INSPECTOR), 3000);
  assert.equal(byInspector, null, 'بازرس/ارجاع‌دهنده حق ارجاع مرحله را ندارد');
});

test('referSignRequest: مقصدهای نامعتبر رد می‌شوند', () => {
  const rec = referRec();
  const perm = C.buildPermissions(CHAIN_A);
  assert.equal(C.referSignRequest(rec, { toUser: CHAIN_A, byUser: CHAIN_A }, perm), null, 'به خودش نه');
  assert.equal(C.referSignRequest(rec, { toUser: INSPECTOR, byUser: CHAIN_A }, perm), null, 'به بازرس نه');
  assert.equal(C.referSignRequest(rec, { toUser: VIEWER, byUser: CHAIN_A }, perm), null, 'به بدون اجازه نه');
  assert.equal(C.referSignRequest(rec, { toUser: CHAIN_B, byUser: CHAIN_A }, perm), null, 'به گیرنده‌ی مرحله‌ی بازِ دیگر نه');
  assert.equal(C.referSignRequest(rec, { toUser: { id: 'u-off', name: 'خاموش', role: 'approver', active: false }, byUser: CHAIN_A }, perm), null, 'به غیرفعال نه');
  assert.equal(C.referSignRequest(rec, { toUser: null, byUser: CHAIN_A }, perm), null, 'بدون مقصد نه');
  // زنجیره‌ی بسته/لغوشده اصلاً ارجاع‌پذیر نیست
  const signed = C.applySignatureToRecord(
    C.applySignatureToRecord(rec, { image: 'd' }, CHAIN_A, 2000), { image: 'e' }, CHAIN_B, 3000);
  assert.equal(C.referSignRequest(signed, { toUser: ADMIN, byUser: ADMIN }, C.buildPermissions(ADMIN)), null);
});

test('referSignRequest: بعد از ارجاع، نفر تازه امضا می‌کند و زنجیره جلو می‌رود', () => {
  const rec = referRec();
  const referred = C.referSignRequest(rec, { toUser: ADMIN, byUser: CHAIN_A }, C.buildPermissions(CHAIN_A), 2000);
  assert.equal(C.canSignRequest(referred, ADMIN, C.buildPermissions(ADMIN)), true);
  const after = C.applySignatureToRecord(referred, { image: 'data:adm' }, ADMIN, 4000);
  assert.ok(after, 'امضای گیرنده‌ی تازه می‌نشیند');
  assert.equal(after.signRequest.current, 1, 'نوبت مرحله‌ی بعد می‌شود');
  assert.equal(after.signatures.approver.name, 'ادمین');
  // ارجاعِ مرحله‌ی تازه (مدیر → دیگری) همچنان کار می‌کند
  const referred2 = C.referSignRequest(after, { toUser: { id: 'u-x', name: 'ناظر جدید', role: 'approver', active: true }, byUser: CHAIN_B }, C.buildPermissions(CHAIN_B), 5000);
  assert.ok(referred2);
  assert.equal(referred2.signRequest.steps[1].toUserId, 'u-x');
});

test('referSignRequest: از round-trip JSON (همگام‌سازی) سالم برمی‌گردد', () => {
  const rec = referRec();
  const referred = C.referSignRequest(rec, { toUser: ADMIN, byUser: CHAIN_A, note: 'n' }, C.buildPermissions(CHAIN_A), 2000);
  const round = C.normalizeSignRequest(JSON.parse(JSON.stringify(referred.signRequest)));
  assert.equal(round.steps[0].toUserId, 'u-adm');
  assert.equal(round.steps[0].referredFrom.userId, 'u-app');
  assert.equal(round.steps[0].referredFrom.userName, 'رضا کریمی');
});

test('normalizeSignStep: بدون referredFrom مقدار null می‌گیرد (سازگاری داده‌ی قدیمی)', () => {
  const s = C.normalizeSignStep({ toUserId: 'u-app', slot: 'approver' });
  assert.equal(s.referredFrom, null);
  const s2 = C.normalizeSignStep({ toUserId: 'u-app', slot: 'approver', referredFrom: { userId: 'u-x', userName: 'x', at: 10 } });
  assert.deepEqual(s2.referredFrom, { userId: 'u-x', userName: 'x', at: 10 });
});

/* =====================================================================
   بازرسی دوره‌ای — کلید دوره و پوشش زیرسیستم‌ها
   ===================================================================== */

const D = (s) => new Date(s + 'T12:00:00+03:30'); // ساعت تهران، دور از مرز نیمه‌شب

test('periodKey: مرزهای ماهانه — تا ماه بعد لیست عوض می‌شود', () => {
  // ۲۵ شهریور ۱۴۰۵
  const now = D('2026-09-16');
  const key = C.periodKey('monthly', now);
  assert.equal(key, '1405/06');
  // همان ماه → یک کلید؛ ماه بعد → کلید تازه
  assert.equal(C.periodKey('monthly', D('2026-09-01')), key, 'روزهای یک ماه شمسی باید هم‌کلید باشند');
  assert.equal(C.periodKey('monthly', D('2026-09-22')), key, '۳۱ شهریور هم همان ماه است');
  assert.notEqual(C.periodKey('monthly', D('2026-09-23')), key, 'اول مهر باید کلید تازه بگیرد');
  assert.notEqual(C.periodKey('monthly', D('2026-08-16')), key, 'مرداد ماه قبل است');
});

test('periodKey: هفتگی از شنبه شروع می‌شود', () => {
  // ۲۰۲۶/۰۹/۱۲ شنبه است؛ تا جمعه ۱۸ام همان هفته، شنبه ۱۹ام هفته‌ی بعد
  const sat = D('2026-09-12'), fri = D('2026-09-18'), nextSat = D('2026-09-19');
  assert.equal(sat.getDay(), 6, 'فرض تست: ۱۲ سپتامبر ۲۰۲۶ شنبه است');
  const k1 = C.periodKey('weekly', sat);
  assert.equal(C.periodKey('weekly', D('2026-09-16')), k1, 'چهارشنبه همان هفته');
  assert.equal(C.periodKey('weekly', fri), k1, 'جمعه پایان همان هفته است');
  assert.notEqual(C.periodKey('weekly', nextSat), k1, 'شنبه‌ی بعدی هفته‌ی تازه است');
  assert.ok(k1.endsWith('-W'), 'کلید هفته نشان مشخص دارد');
});

test('periodKey: روزانه/فصلی/سالیانه', () => {
  assert.equal(C.periodKey('daily', D('2026-09-16')), '1405/06/25');
  assert.notEqual(C.periodKey('daily', D('2026-09-17')), C.periodKey('daily', D('2026-09-16')));
  // شهریور = فصل ۲؛ فروردین = فصل ۱
  assert.equal(C.periodKey('quarterly', D('2026-09-16')), '1405/S2');
  assert.equal(C.periodKey('quarterly', D('2026-04-25')), '1405/S1');
  assert.notEqual(C.periodKey('quarterly', D('2026-06-20')), C.periodKey('quarterly', D('2026-06-25')),
    'مرز فصل باید درست باشد: ۳۰ خرداد فصل ۱ و ۴ تیر فصل ۲ است');
  assert.equal(C.periodKey('annual', D('2026-09-16')), '1405');
  assert.equal(C.periodKey('annual', D('2027-03-25')), '1406');
});

test('periodKey: ورودی نامعتبر/نامشخص بی‌خطر است', () => {
  assert.equal(C.periodKey('monthly', new Date('not-a-date')), null);
  assert.equal(C.periodKey('weird', D('2026-09-16')), null);
  assert.ok(C.periodKey('monthly'), 'بدون تاریخ، الان را حساب می‌کند');
});

test('periodWindowLabel: برچسب انسانی دوره‌ها', () => {
  const now = D('2026-09-16');
  assert.equal(C.periodWindowLabel('monthly', now), 'شهریور ۱۴۰۵');
  assert.ok(C.periodWindowLabel('daily', now).includes('۲۵ شهریور'));
  assert.ok(C.periodWindowLabel('quarterly', now).includes('تابستان'));
  assert.ok(C.periodWindowLabel('weekly', now).startsWith('هفته‌ی'));
  assert.ok(C.periodWindowLabel('annual', now).includes('۱۴۰۵'));
});

test('resolveTemplatePeriod: فقط دوره‌های معتبر، وگرنه ماهانه', () => {
  assert.equal(C.resolveTemplatePeriod({ period: 'weekly' }), 'weekly');
  assert.equal(C.resolveTemplatePeriod({ period: 'hourly' }), 'monthly');
  assert.equal(C.resolveTemplatePeriod({}), 'monthly');
  assert.equal(C.resolveTemplatePeriod(null), 'monthly');
});

const COV_TPL = { id: 'tpl-m', name: 'سرویس ماشین‌آلات', period: 'monthly' };
const COV_ASSETS = [
  { id: 'm1', code: 'MC-01', name: 'ماشین ۱', templateId: 'tpl-m' },
  { id: 'm2', code: 'MC-02', name: 'ماشین ۲', templateId: 'tpl-m' },
  { id: 'm3', code: 'MC-03', name: 'ماشین ۳', templateId: 'tpl-m' },
  { id: 'x1', code: 'DB-01', name: 'تابلو ۱', templateId: 'tpl-other' },
];
const NOW = new Date('2026-09-16T12:00:00+03:30');

test('templateCoverage: بازرسیِ دوره‌ی جاری تجهیز را از لیست خارج می‌کند', () => {
  const records = [
    { id: 'r1', templateId: 'tpl-m', assetId: 'm1', status: 'موفق', percent: 90, completedAt: '2026-09-10T08:00:00Z', inspectorName: 'علی' },
  ];
  const cov = C.templateCoverage(COV_TPL, COV_ASSETS, records, NOW);
  assert.equal(cov.total, 3, 'فقط زیرسیستم‌های همین قالب');
  assert.equal(cov.done.length, 1);
  assert.deepEqual(cov.pending.map(a => a.id).sort(), ['m2', 'm3']);
  assert.equal(cov.percent, 33);
  assert.equal(cov.done[0].record.id, 'r1');
});

test('templateCoverage: بازرسی ماه قبل حساب نمی‌شود — لیست دوباره پر شده', () => {
  const records = [
    { id: 'r-old', templateId: 'tpl-m', assetId: 'm1', status: 'موفق', percent: 90, completedAt: '2026-08-10T08:00:00Z' },
    { id: 'r-now', templateId: 'tpl-m', assetId: 'm2', status: 'موفق', percent: 90, completedAt: '2026-09-10T08:00:00Z' },
  ];
  const cov = C.templateCoverage(COV_TPL, COV_ASSETS, records, NOW);
  assert.deepEqual(cov.done.map(d => d.asset.id), ['m2'], 'بازرسی مرداد نباید در شهریور حساب شود');
  assert.deepEqual(cov.pending.map(a => a.id).sort(), ['m1', 'm3']);
});

test('templateCoverage: تکرار بازرسی در یک دوره دوبار حساب نمی‌شود و دوره‌های دیگر جداست', () => {
  const records = [
    { id: 'r1', templateId: 'tpl-m', assetId: 'm1', percent: 80, completedAt: '2026-09-10T08:00:00Z' },
    { id: 'r2', templateId: 'tpl-m', assetId: 'm1', percent: 95, completedAt: '2026-09-12T08:00:00Z' },
    { id: 'r3', templateId: 'tpl-other', assetId: 'm2', percent: 70, completedAt: '2026-09-12T08:00:00Z' },
  ];
  const cov = C.templateCoverage(COV_TPL, COV_ASSETS, records, NOW);
  assert.equal(cov.done.length, 1, 'دو بار بازرسی یک تجهیز = یک مورد انجام‌شده');
  assert.equal(cov.done[0].record.id, 'r2', 'آخرین بازرسی نشان داده می‌شود');
  assert.equal(cov.pending.length, 2);
});

test('templateCoverage: دوره‌ی هفتگی — مرز شنبه', () => {
  const tpl = { id: 'tpl-w', name: 'هفتگی', period: 'weekly' };
  const assets = [{ id: 'm1', code: 'MC-01', name: 'م', templateId: 'tpl-w' }];
  // چهارشنبه همین هفته → انجام‌شده؛ چهارشنبه‌ی هفته قبل → نه
  const inWeek = { id: 'r1', templateId: 'tpl-w', assetId: 'm1', percent: 90, completedAt: '2026-09-15T08:00:00Z' };
  const lastWeek = { id: 'r2', templateId: 'tpl-w', assetId: 'm1', percent: 90, completedAt: '2026-09-08T08:00:00Z' };
  assert.equal(C.templateCoverage(tpl, assets, [inWeek], NOW).done.length, 1);
  assert.equal(C.templateCoverage(tpl, assets, [lastWeek], NOW).pending.length, 1);
});

test('templateCoverage: قالب بدون تجهیز و رکورد خالی نمی‌شکند', () => {
  const cov = C.templateCoverage({ id: 't', period: 'annual' }, [], [], NOW);
  assert.equal(cov.total, 0);
  assert.equal(cov.percent, 0);
  assert.deepEqual(cov.pending, []);
});

test('migrateData: دوره‌ی نامعتبر قالب به ماهانه تبدیل می‌شود', () => {
  const mk = (period) => C.migrateData({
    version: 4, users: [], categories: [], assets: [], assignments: [], records: [],
    templates: [{ id: 't1', name: 'ت', items: [], period }],
    settings: {}, revision: 0, lastSyncAt: 0,
  });
  assert.equal(mk('weekly').templates[0].period, 'weekly');
  assert.equal(mk('daily').templates[0].period, 'daily');
  assert.equal(mk('hourly').templates[0].period, 'monthly');
  assert.equal(mk(undefined).templates[0].period, 'monthly');
});

/* ---------- دوره‌ی قبل، نسبت سپری‌شدن و هشدارهای پوشش ---------- */

test('prevPeriodKey: دوره‌ی قبل برای هر پنج دوره درست است', () => {
  const at = new Date('2026-09-16T10:00:00Z'); // ۲۵ شهریور ۱۴۰۵ (سه‌شنبه)
  assert.equal(C.prevPeriodKey('daily', at), '1405/06/24');
  // ۲۵ شهریور چهارشنبه است؛ هفته از شنبه ۲۱ شهریور شروع شده؛ هفته‌ی قبل از شنبه ۱۴ شهریور
  assert.equal(C.prevPeriodKey('weekly', at), '1405/06/14-W');
  assert.equal(C.prevPeriodKey('monthly', at), '1405/05');
  // شهریور ماه ششم است → فصل دوم (تیر/مرداد/شهریور)؛ فصل قبل = فصل یکم
  assert.equal(C.prevPeriodKey('quarterly', at), '1405/S1');
  assert.equal(C.prevPeriodKey('annual', at), '1404');
});

test('prevPeriodKey: چرخش سال/فصل در مرزها درست است', () => {
  // اول فروردین: ماه قبل اسفند سال قبل، فصل قبل فصل ۴ سال قبل، سال قبل
  const norooz = new Date('2026-03-21T10:00:00Z'); // ۱ فروردین ۱۴۰۵
  assert.equal(C.prevPeriodKey('monthly', norooz), '1404/12');
  assert.equal(C.prevPeriodKey('quarterly', norooz), '1404/S4');
  assert.equal(C.prevPeriodKey('annual', norooz), '1404');
  // اول تیر (شروع فصل ۲): فصل قبل فصل ۱ همان سال
  const tir = new Date('2026-06-22T10:00:00Z'); // ۱ تیر ۱۴۰۵
  assert.equal(C.prevPeriodKey('quarterly', tir), '1405/S1');
});

test('periodElapsedRatio: بین ۰ و ۱ است و با گذشت دوره زیاد می‌شود', () => {
  // ماهانه: اول ماه ≈ ۰، آخر ماه ≈ ۱
  const early = new Date('2026-08-23T08:00:00Z'); // ~۱ شهریور
  const late = new Date('2026-09-21T16:00:00Z');  // ~۳۰ شهریور
  const rEarly = C.periodElapsedRatio('monthly', early);
  const rLate = C.periodElapsedRatio('monthly', late);
  assert.ok(rEarly >= 0 && rEarly < 0.15, 'اوایل ماه: ' + rEarly);
  assert.ok(rLate > 0.9 && rLate <= 1, 'اواخر ماه: ' + rLate);
  assert.ok(rLate > rEarly);
  // روزانه/هفتگی هم کران‌دارند
  assert.ok(C.periodElapsedRatio('daily', late) >= 0 && C.periodElapsedRatio('daily', late) < 1);
  assert.ok(C.periodElapsedRatio('weekly', late) >= 0 && C.periodElapsedRatio('weekly', late) < 1);
  assert.ok(C.periodElapsedRatio('quarterly', late) >= 0 && C.periodElapsedRatio('quarterly', late) < 1);
  assert.ok(C.periodElapsedRatio('annual', late) >= 0 && C.periodElapsedRatio('annual', late) < 1);
});

test('coverageAlerts: زیرسیستم بی‌بازرسیِ دو دوره «عقب‌افتاده» است', () => {
  const tpl = { id: 'tpl-a', name: 'الف', period: 'monthly', items: [] };
  const assets = [{ id: 'x1', code: 'X-1', name: 'یک', templateId: 'tpl-a' }, { id: 'x2', code: 'X-2', name: 'دو', templateId: 'tpl-a' }];
  const now = new Date('2026-09-16T10:00:00Z'); // ۲۵ شهریور ۱۴۰۵ → ماه ۰۶
  const lastMonth = '2026-08-30T10:00:00Z';      // ~۸ شهریور → ماه ۰۶ هم نیست؛ ماه ۰۵ است
  const thisMonth = '2026-09-10T10:00:00Z';       // ~۱۹ شهریور → ماه ۰۶
  // x1 این ماه بازرسی شده؛ x2 نه این ماه نه ماه قبل → عقب‌افتاده
  const recs = [
    { id: 'r1', templateId: 'tpl-a', assetId: 'x1', completedAt: thisMonth },
    { id: 'r2', templateId: 'tpl-a', assetId: 'x2', completedAt: new Date('2026-07-10T10:00:00Z').toISOString() }, // ۱۹ تیر → ماه ۰۴، نه این ماه نه ماه قبل
  ];
  const al = C.coverageAlerts(tpl, assets, recs, now);
  assert.equal(al.overdue.length, 1, 'x2 نه این ماه نه ماه قبل بازرسی شده → عقب‌افتاده');
  assert.equal(al.overdue[0].id, 'x2');
});

test('coverageAlerts: با بازرسی در دوره‌ی قبل، دیگر عقب‌افتاده نیست', () => {
  const tpl = { id: 'tpl-b', name: 'ب', period: 'monthly', items: [] };
  const assets = [{ id: 'y1', code: 'Y-1', name: 'یک', templateId: 'tpl-b' }];
  const now = new Date('2026-09-16T10:00:00Z');
  // ماه قبل (۱۴۰۵/۰۵ ≈ اوت) بازرسی شده ولی این ماه نه → عقب‌افتاده نیست ولی باقی‌مانده است
  const prevMonth = new Date('2026-08-10T10:00:00Z').toISOString();
  const al = C.coverageAlerts(tpl, assets, [{ id: 'r1', templateId: 'tpl-b', assetId: 'y1', completedAt: prevMonth }], now);
  assert.equal(al.pending.length, 1, 'این ماه هنوز بازرسی نشده');
  assert.equal(al.overdue.length, 0, 'ولی چون دوره‌ی قبل بازرسی شده، عقب‌افتاده نیست');
});

test('coverageAlerts: در اواخر دوره، بی‌بازرسی‌ها «در خطر تأخیر» می‌شوند', () => {
  const tpl = { id: 'tpl-c', name: 'پ', period: 'monthly', items: [] };
  const assets = [{ id: 'z1', code: 'Z-1', name: 'یک', templateId: 'tpl-c' }];
  const early = new Date('2026-08-24T10:00:00Z'); // اوایل شهریور → نسبت کم
  const late = new Date('2026-09-21T10:00:00Z');  // اواخر شهریور → نسبت زیاد
  const recEarly = C.coverageAlerts(tpl, assets, [], early);
  const recLate = C.coverageAlerts(tpl, assets, [], late);
  assert.equal(recEarly.atRisk.length, 0, 'اوایل دوره در خطر نیست');
  assert.equal(recLate.atRisk.length, 1, 'اواخر دوره در خطر است');
  assert.equal(recLate.pending.length, 1);
});

test('migrateData: correctives و photos نرمال می‌شوند', () => {
  const d = C.migrateData({
    version: 4, users: [], categories: [], templates: [], assets: [], assignments: [],
    records: [
      { id: 'r1', photos: 'bad' },
      { id: 'r2', photos: [{ image: 'data:x' }, null, 'junk'] },
    ],
    correctives: [
      { id: 'c1', status: 'weird', note: '' },
      { id: 'c2', status: 'closed' },
    ],
    settings: {}, revision: 0, lastSyncAt: 0,
  });
  assert.deepEqual(d.records[0].photos, [], 'مقدار نامعتبر → آرایه خالی');
  assert.equal(d.records[1].photos.length, 1, 'فقط آبجکت‌های معتبر می‌مانند');
  assert.equal(d.correctives[0].status, 'open', 'وضعیت نامعتبر → باز');
  assert.equal(d.correctives[1].status, 'closed', 'وضعیت معتبر حفظ می‌شود');
});
