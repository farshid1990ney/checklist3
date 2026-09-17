import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServer } from './mock-appsscript.mjs';
import { loadCore } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODE = path.join(__dirname, '..', 'Code.gs');

// واترمارک delta sync با ستون syncedAt (ساعت سرور) بسته می‌شود، پس بین دو
// نوشتن باید واقعاً میلی‌ثانیه بگذرد تا آزمون قطعی (deterministic) بماند.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = 'dk_test_key_1234567890';

async function boot(props = {}) {
  const { api, env } = await loadServer(CODE, { properties: { API_KEY: KEY, ...props } });
  return { api, env };
}

function envelope(action, payload, extra = {}) {
  return { action, apiKey: KEY, ...extra, payload };
}

function post(api, env_) {
  return (obj) => {
    const out = api.doPost({ postData: { contents: JSON.stringify(obj) } });
    return JSON.parse(out.getContent());
  };
}

/**
 * یک کاربر ادمین می‌سازد (از راه پنجره‌ی bootstrap — چون هنوز هیچ ادمینی
 * نیست، این نوشتن بدون نشست هم پذیرفته می‌شود) و با auth.login وارد می‌شود
 * تا sessionToken واقعی و امضاشده‌ی سرور را برای تست‌های RBAC برگرداند.
 */
async function seedAdminSession(call, overrides = {}) {
  const at = Date.now();
  const user = Object.assign({
    id: 'admin-1', username: 'admin', name: 'مدیر', role: 'admin',
    passwordHash: 'ADMIN_HASH', active: true, pages: ['dashboard'], updatedAt: at,
  }, overrides);
  call(envelope('db.push', { ops: [{ opId: 'seed-' + user.id, entity: 'users', kind: 'upsert', at, data: user }] }));
  const login = call(envelope('auth.login', { username: user.username, passwordHash: user.passwordHash }));
  assert.equal(login.ok, true, 'seedAdminSession: ورود ادمین آزمایشی باید موفق باشد');
  return { user, sessionToken: login.sessionToken };
}

function sign(action, ts, nonce, key = KEY) {
  return crypto.createHmac('sha256', key).update([action, ts, nonce].join('|')).digest('hex');
}

/* ============================ امنیت ============================ */

test('بدون API_KEY در Script Properties، درخواست رد می‌شود (auto-register حذف شده)', async () => {
  const { api, env } = await loadServer(CODE, { properties: {} });
  const call = post(api, env);
  const res = call({ action: 'db.pull', apiKey: 'کلید-مهاجم' });
  assert.equal(res.ok, false);
  assert.match(res.error, /API_KEY/);
  assert.equal(env.__props.getProperty('API_KEY'), null, 'کلید مهاجم نباید ثبت شود');
});

// کلید نمونه‌ی قوی: ۴۳ نویسه، آنتروپی بالا
const STRONG_KEY = 'a7Kd92mXq4Lp8vRn3sTw6Yb1Hc5Jf0ZgEu2Oi4Pl8Qx';

test('ALLOW_KEY_BOOTSTRAP فقط وقتی صریحاً فعال باشد کلید اول را ثبت می‌کند', async () => {
  const { api, env } = await loadServer(CODE, { properties: { ALLOW_KEY_BOOTSTRAP: 'true' } });
  const res = post(api, env)({ action: 'db.pull', apiKey: STRONG_KEY });
  assert.equal(res.ok, true);
  assert.equal(env.__props.getProperty('API_KEY'), STRONG_KEY);
});

test('bootstrap کلید کوتاه را رد می‌کند و چیزی ثبت نمی‌کند (ایراد P1-۴)', async () => {
  const { api, env } = await loadServer(CODE, { properties: { ALLOW_KEY_BOOTSTRAP: 'true' } });
  const res = post(api, env)({ action: 'db.pull', apiKey: 'a' });
  assert.equal(res.ok, false, 'کلید تک‌نویسه‌ای نباید پذیرفته شود');
  assert.match(res.error, /کوتاه/);
  assert.equal(env.__props.getProperty('API_KEY'), null, 'کلید ضعیف نباید ثبت شود');
});

test('bootstrap کلید بلندِ بی‌آنتروپی را رد می‌کند (ایراد P1-۴)', async () => {
  const { api, env } = await loadServer(CODE, { properties: { ALLOW_KEY_BOOTSTRAP: 'true' } });
  const res = post(api, env)({ action: 'db.pull', apiKey: 'a'.repeat(64) });
  assert.equal(res.ok, false, 'کلید تکراری با وجود طول زیاد نباید پذیرفته شود');
  assert.match(res.error, /آنتروپی/);
  assert.equal(env.__props.getProperty('API_KEY'), null);
});

test('bootstrap کلید ضعیف، قفل دسترسی بعدی را باز نمی‌کند', async () => {
  const { api, env } = await loadServer(CODE, { properties: { ALLOW_KEY_BOOTSTRAP: 'true' } });
  post(api, env)({ action: 'db.pull', apiKey: 'weak' });
  // چون کلید ضعیف رد شده، API_KEY هنوز خالی است و هیچ کلیدی کار نمی‌کند
  const after = post(api, env)({ action: 'db.pull', apiKey: STRONG_KEY });
  assert.equal(after.ok, true, 'کلید قوی باید بتواند bootstrap را کامل کند');
  assert.equal(env.__props.getProperty('API_KEY'), STRONG_KEY);
});

/* ============ P0-۳: نشت حذف با ساعت عقبِ کلاینت ============ */

test('حذف با ساعت عقبِ کلاینت، توسط push بعدی زنده نمی‌شود (ایراد P0-۳)', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const now = Date.now();

  // ۱) رکورد ساخته می‌شود
  call(envelope('db.push', { ops: [{ opId: 'c1', entity: 'assets', kind: 'upsert', at: now,
    data: { id: 'a1', code: 'DB-01', name: 'تابلو', updatedAt: now } }] }));

  // ۲) کلاینتی با ساعت ۶۰ ثانیه عقب، رکورد را حذف می‌کند
  const behind = now - 60000;
  const del = call(envelope('db.push', { ops: [{ opId: 'd1', entity: 'assets', kind: 'delete', at: behind, id: 'a1' }] }));
  assert.equal(del.applied.length, 1, 'حذف باید اعمال شود');

  // ۳) کلاینت دیگری (ساعت درست) همان رکورد را با مهرِ جدیدتر از «حذفِ ادعاشده»
  //    ولی قدیمی‌تر از لحظه‌ی واقعی حذف، push می‌کند.
  const raced = now - 30000;
  const up = call(envelope('db.push', { ops: [{ opId: 'u1', entity: 'assets', kind: 'upsert', at: raced,
    data: { id: 'a1', code: 'DB-01', name: 'تابلو', updatedAt: raced } }] }));

  // بدون رفع: tombstone مهرِ behind می‌گرفت و این push برنده می‌شد → رکورد زنده می‌شد.
  assert.equal(up.conflicts.length, 1, 'push هم‌زمان باید به tombstone بخورد، نه اینکه آن را برگرداند');
  assert.equal(up.applied.length, 0);

  const pull = call(envelope('db.pull', {}));
  const row = (pull.entities.assets || []).find(a => String(a.id) === 'a1');
  assert.ok(!row || row.deleted === true, 'رکورد حذف‌شده نباید دوباره زنده شود');
});

test('tombstone برای موجودیتی که هرگز روی سرور نبوده هم مهر سرور می‌گیرد', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const far = Date.now() - 3600000; // یک ساعت عقب

  const del = call(envelope('db.push', { ops: [{ opId: 'd2', entity: 'assets', kind: 'delete', at: far, id: 'ghost' }] }));
  assert.equal(del.applied.length, 1);

  // push بعدی با مهرِ جدیدتر از far نباید ghost را زنده کند
  const up = call(envelope('db.push', { ops: [{ opId: 'u2', entity: 'assets', kind: 'upsert', at: far + 1000,
    data: { id: 'ghost', code: 'G', name: 'روح', updatedAt: far + 1000 } }] }));
  assert.equal(up.conflicts.length, 1, 'tombstone باید برنده بماند');

  const pull = call(envelope('db.pull', {}));
  const row = (pull.entities.assets || []).find(a => String(a.id) === 'ghost');
  assert.ok(!row || row.deleted === true);
});

/* ============ P1-۲: کش نگاشت id→row در یک دسته عملیات ============ */

test('دسته‌ی ترکیبی (ساخت/patch/حذف/ساخت دوباره) با کش نگاشت درست اعمال می‌شود', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const t = Date.now();

  const res = call(envelope('db.push', { ops: [
    { opId: 'm1', entity: 'assets', kind: 'upsert', at: t, data: { id: 'x1', code: 'C1', name: 'n1', updatedAt: t } },
    { opId: 'm2', entity: 'assets', kind: 'upsert', at: t + 1, patch: { name: 'n2' }, id: 'x1' },
    { opId: 'm3', entity: 'assets', kind: 'upsert', at: t + 2, data: { id: 'x2', code: 'C2', name: 'b', updatedAt: t + 2 } },
    { opId: 'm4', entity: 'assets', kind: 'delete', at: t + 3, id: 'x2' },
    { opId: 'm5', entity: 'assets', kind: 'upsert', at: t + 4, data: { id: 'x3', code: 'C3', name: 'c', updatedAt: t + 4 } },
    { opId: 'm6', entity: 'assets', kind: 'upsert', at: t + 5, patch: { name: 'c2' }, id: 'x3' },
  ] }));
  assert.equal(res.applied.length, 6, 'همه‌ی ۶ عملیات باید اعمال شوند: ' + JSON.stringify(res.errors));

  const pull = call(envelope('db.pull', {}));
  const all = pull.entities.assets || [];
  const x1 = all.find(a => a.id === 'x1');
  const x3 = all.find(a => a.id === 'x3');
  const x2 = all.find(a => a.id === 'x2');
  assert.equal(x1.name, 'n2', 'patch باید روی ردیف درست نشسته باشد');
  assert.equal(x1.code, 'C1', 'فیلدهای دست‌نخورده نباید پاک شوند');
  assert.equal(x3.name, 'c2', 'patch روی ردیفِ تازه‌ساخته‌شده باید کار کند');
  assert.ok(x2 && x2.deleted === true, 'x2 باید tombstone باشد');
  assert.equal(all.filter(a => !a.deleted).length, 2, 'دقیقاً دو رکورد زنده');
});

test('دو دسته‌ی پشت‌سرهم، کش کهنه را به دسته‌ی بعد نشت نمی‌دهند', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const t = Date.now();

  call(envelope('db.push', { ops: [{ opId: 'p1', entity: 'assets', kind: 'upsert', at: t,
    data: { id: 'k1', code: 'K1', name: 'a', updatedAt: t } }] }));

  // دسته‌ی دوم باید k1 را ببیند (کش از نو ساخته می‌شود) و رکورد تازه اضافه کند
  const res2 = call(envelope('db.push', { ops: [
    { opId: 'p2', entity: 'assets', kind: 'upsert', at: t + 1, patch: { name: 'b' }, id: 'k1' },
    { opId: 'p3', entity: 'assets', kind: 'upsert', at: t + 2, data: { id: 'k2', code: 'K2', name: 'c', updatedAt: t + 2 } },
    { opId: 'p4', entity: 'assets', kind: 'upsert', at: t + 3, patch: { name: 'd' }, id: 'k2' },
  ] }));
  assert.equal(res2.applied.length, 3, JSON.stringify(res2.errors));

  const pull = call(envelope('db.pull', {}));
  const all = pull.entities.assets || [];
  assert.equal(all.find(a => a.id === 'k1').name, 'b');
  assert.equal(all.find(a => a.id === 'k2').name, 'd');
});

/* ============ P3-۱۵: فیلتر تاریخ شمسی در records.list ============ */

// برای ساختن داده‌ی آزمون از تبدیلِ شمسی→میلادیِ خودِ هسته‌ی کلاینت استفاده
// می‌کنیم (که جداگانه تست شده)، نه از یک الگوریتم دستیِ دوم که خودش می‌تواند
// خطا داشته باشد و نتیجه‌ی آزمون را بی‌معنی کند.
const JALALI_CORE = loadCore('server-test-jalali');

/** شمسی → epoch ms در نیمه‌ی روز، تا اختلاف منطقه‌ی زمانی نتیجه را عوض نکند */
function jalaliToMs(jy, jm, jd) {
  const g = JALALI_CORE.safeToGregorian(jy, jm, jd);
  assert.ok(g, `تبدیل ${jy}/${jm}/${jd} ناموفق بود`);
  return new Date(g[0], g[1] - 1, g[2], 12, 0, 0).getTime();
}

test('records.list فیلتر تاریخ شمسی را درست تفسیر می‌کند (ایراد P3-۱۵)', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const t = Date.now();

  const inMs = jalaliToMs(1403, 6, 15);
  const outMs = jalaliToMs(1402, 1, 1);

  const mkRec = (id, ms) => ({ opId: 'r-' + id, entity: 'records', kind: 'upsert', at: t,
    data: { id, assetCode: id, percent: 90, status: 'موفق', details: [],
      completedAt: ms, updatedAt: t } });

  const push = call(envelope('db.push', { ops: [mkRec('in', inMs), mkRec('out', outMs)] }));
  assert.equal(push.applied.length, 2, JSON.stringify(push.errors));

  const res = call(envelope('records.list', { filter: { from: '1403/01/01', to: '1403/12/29' }, light: true }));
  assert.equal(res.ok, true, JSON.stringify(res));
  const ids = (res.records || []).map(r => String(r.id));
  assert.ok(ids.includes('in'), 'رکورد داخل بازه‌ی شمسی باید برگردد؛ ' + JSON.stringify(ids));
  assert.ok(!ids.includes('out'),
    'رکورد بیرون بازه نباید برگردد (پیش‌تر Date.parse سال ۱۴۰۲ را میلادی تفسیر می‌کرد)');
});

test('فیلتر تاریخ شمسی: کران بالا کل آن روز را شامل می‌شود', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const t = Date.now();
  // رکورد در ساعت ۲۲:۳۰ همان روز — اگر `to` نیمه‌شب تفسیر شود، از قلم می‌افتد
  const g = JALALI_CORE.safeToGregorian(1403, 6, 15);
  const late = new Date(g[0], g[1] - 1, g[2], 22, 30, 0).getTime();

  call(envelope('db.push', { ops: [{ opId: 'l1', entity: 'records', kind: 'upsert', at: t,
    data: { id: 'late', assetCode: 'L', percent: 70, status: 'موفق', details: [], completedAt: late, updatedAt: t } }] }));

  const res = call(envelope('records.list', { filter: { to: '1403/06/15' } }));
  const ids = (res.records || []).map(r => String(r.id));
  assert.ok(ids.includes('late'), 'رکورد ساعت ۲۲:۳۰ باید داخل «تا ۱۴۰۳/۰۶/۱۵» باشد؛ ' + JSON.stringify(ids));
});

test('records.list همچنان epoch ms را می‌پذیرد (سازگاری عقب‌رو)', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const t = Date.now();
  call(envelope('db.push', { ops: [{ opId: 'e1', entity: 'records', kind: 'upsert', at: t,
    data: { id: 'rec1', assetCode: 'A', percent: 80, status: 'موفق', details: [], completedAt: t, updatedAt: t } }] }));

  const all = call(envelope('records.list', { filter: { from: t - 60000, to: t + 60000 } }));
  assert.equal(all.ok, true);
  assert.equal((all.records || []).length, 1, 'فیلتر epoch باید مثل قبل کار کند');

  const none = call(envelope('records.list', { filter: { from: t + 3600000 } }));
  assert.equal((none.records || []).length, 0);
});

test('کلید API اشتباه رد می‌شود', async () => {
  const { api, env } = await boot();
  const res = post(api, env)({ action: 'db.pull', apiKey: 'wrong', payload: {} });
  assert.equal(res.ok, false);
  assert.match(res.error, /نامعتبر/);
});

test('ping بدون کلید کار می‌کند ولی داده‌ی حساس نمی‌دهد', async () => {
  const { api, env } = await boot();
  const res = post(api, env)({ action: 'ping' });
  assert.equal(res.ok, true);
  assert.equal(res.version, '8.0');
});

test('امضای HMAC معتبر پذیرفته و دستکاری‌شده رد می‌شود', async () => {
  const { api, env } = await boot({ REQUIRE_SIGNATURE: 'true' });
  const call = post(api, env);
  const ts = Date.now(), nonce = crypto.randomUUID();

  const good = call({ action: 'db.pull', apiKey: KEY, ts, nonce, sig: sign('db.pull', ts, nonce), payload: {} });
  assert.equal(good.ok, true);

  const bad = call({ action: 'db.pull', apiKey: KEY, ts, nonce: crypto.randomUUID(), sig: 'deadbeef', payload: {} });
  assert.equal(bad.ok, false);

  // replay: همان nonce دوباره
  const replay = call({ action: 'db.pull', apiKey: KEY, ts, nonce, sig: sign('db.pull', ts, nonce), payload: {} });
  assert.equal(replay.ok, false);
  assert.match(replay.error, /replay/);
});

test('امضای غایب وقتی REQUIRE_SIGNATURE فعال است رد می‌شود', async () => {
  const { api, env } = await boot({ REQUIRE_SIGNATURE: 'true' });
  const res = post(api, env)({ action: 'db.pull', apiKey: KEY, payload: {} });
  assert.equal(res.ok, false);
  assert.match(res.error, /sig/);
});

test('اختلاف ساعت بیش از حد مجاز رد می‌شود', async () => {
  const { api, env } = await boot();
  const ts = Date.now() - 3600 * 1000, nonce = crypto.randomUUID();
  const res = post(api, env)({ action: 'db.pull', apiKey: KEY, ts, nonce, sig: sign('db.pull', ts, nonce), payload: {} });
  assert.equal(res.ok, false);
  assert.match(res.error, /ساعت/);
});

test('محدودسازی نرخ درخواست', async () => {
  const { api, env } = await boot({ RATE_LIMIT_PER_MINUTE: '3' });
  const call = post(api, env);
  assert.equal(call(envelope('db.revision', {})).ok, true);
  assert.equal(call(envelope('db.revision', {})).ok, true);
  assert.equal(call(envelope('db.revision', {})).ok, true);
  const fourth = call(envelope('db.revision', {}));
  assert.equal(fourth.ok, false);
  assert.match(fourth.error, /بیش از حد مجاز/);
});

/* ==================== همگام‌سازی: push / pull ==================== */

test('db.push یک رکورد را ذخیره و db.pull آن را برمی‌گرداند', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const at = Date.now();
  const push = call(envelope('db.push', {
    baseRevision: 0,
    ops: [{
      opId: 'op-1', clientId: 'c1', entity: 'assets', kind: 'upsert', at,
      data: { id: 'a1', code: 'DB-01', name: 'تابلو برق ۱', location: 'سالن ۱', templateId: 't1', updatedAt: at },
    }],
  }));
  assert.equal(push.ok, true);
  assert.equal(push.applied.length, 1);
  assert.equal(push.revision, 1);

  const pull = call(envelope('db.pull', {}));
  assert.equal(pull.ok, true);
  assert.equal(pull.entities.assets.length, 1);
  assert.equal(pull.entities.assets[0].code, 'DB-01');
  assert.equal(pull.full, true);
});

test('Last-Write-Wins در سطح ردیف: نوشتن کهنه‌تر رد و تعارض گزارش می‌شود', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const newer = Date.now();
  const older = newer - 60000;

  call(envelope('db.push', { ops: [{ opId: 'n1', entity: 'assets', kind: 'upsert', at: newer,
    data: { id: 'a1', code: 'NEW', name: 'نسخه جدید', updatedAt: newer } }] }));

  const stale = call(envelope('db.push', { ops: [{ opId: 'o1', entity: 'assets', kind: 'upsert', at: older,
    data: { id: 'a1', code: 'OLD', name: 'نسخه قدیمی', updatedAt: older } }] }));
  assert.equal(stale.conflicts.length, 1, 'نوشتن کهنه باید تعارض بخورد');
  assert.equal(stale.conflicts[0].entity, 'assets');
  assert.equal(stale.applied.length, 0);

  const pull = call(envelope('db.pull', {}));
  assert.equal(pull.entities.assets[0].code, 'NEW', 'داده جدیدتر نباید بازنویسی شود');
});

test('نوشتن تازه‌تر اعمال می‌شود و بقیه‌ی فیلدها حفظ می‌شوند (merge ردیفی)', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const t1 = Date.now() - 1000, t2 = Date.now();
  call(envelope('db.push', { ops: [{ opId: 'x1', entity: 'assets', kind: 'upsert', at: t1,
    data: { id: 'a1', code: 'DB-01', name: 'نام اولیه', location: 'سالن ۱', serial: 'S-1', updatedAt: t1 } }] }));
  call(envelope('db.push', { ops: [{ opId: 'x2', entity: 'assets', kind: 'upsert', at: t2,
    data: { id: 'a1', name: 'نام ویرایش‌شده', updatedAt: t2 } }] }));
  const a = call(envelope('db.pull', {})).entities.assets[0];
  assert.equal(a.name, 'نام ویرایش‌شده');
  assert.equal(a.code, 'DB-01', 'فیلدهای ارسال‌نشده باید حفظ شوند');
  assert.equal(a.location, 'سالن ۱');
});

test('opId تکراری idempotent است (دوبار اعمال نمی‌شود)', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const at = Date.now();
  const op = { opId: 'dup-1', clientId: 'c', entity: 'records', kind: 'upsert', at,
    data: { id: 'r1', assetCode: 'DB-01', percent: 90, updatedAt: at } };
  const first = call(envelope('db.push', { ops: [op] }));
  const second = call(envelope('db.push', { ops: [op] }));
  assert.equal(first.applied.length, 1);
  assert.equal(second.applied.length, 0);
  assert.equal(second.skipped.length, 1);
  assert.equal(second.skipped[0].reason, 'DUPLICATE');
  assert.equal(call(envelope('db.pull', {})).entities.records.length, 1);
});

test('حذف → tombstone و در delta pull دیده می‌شود', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const at = Date.now();
  call(envelope('db.push', { ops: [{ opId: 'c1', entity: 'assets', kind: 'upsert', at, data: { id: 'a1', code: 'X', updatedAt: at } }] }));
  await sleep(3);
  // واترمارک از خود سرور گرفته می‌شود؛ ردیف بالا پیش از آن نوشته شده است
  const before = call(envelope('db.pull', {})).serverTime;
  await sleep(3);
  const del = call(envelope('db.push', { ops: [{ opId: 'c2', entity: 'assets', kind: 'delete', id: 'a1', at: Date.now() }] }));
  assert.equal(del.applied[0].reason, 'TOMBSTONED');

  const delta = call(envelope('db.pull', { since: before }));
  assert.equal(delta.entities.assets.length, 1);
  assert.equal(delta.entities.assets[0].deleted, true);
  assert.equal(delta.full, false);
});

test('delta pull فقط تغییرات بعد از since را برمی‌گرداند', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const t1 = 1700000000000, t2 = 1700000060000;
  call(envelope('db.push', { ops: [{ opId: 'd1', entity: 'assets', kind: 'upsert', at: t1, data: { id: 'a1', code: 'OLD', updatedAt: t1 } }] }));
  await sleep(3);
  const mark = call(envelope('db.pull', {})).serverTime;
  await sleep(3);
  call(envelope('db.push', { ops: [{ opId: 'd2', entity: 'assets', kind: 'upsert', at: t2, data: { id: 'a2', code: 'NEW', updatedAt: t2 } }] }));

  // since یک واترمارک سمت سرور است، نه زمان‌نگاشت کلاینت
  const delta = call(envelope('db.pull', { since: mark }));
  assert.equal(delta.entities.assets.length, 1);
  assert.equal(delta.entities.assets[0].id, 'a2');
  assert.equal(delta.full, false);
});

test('revision با هر نوشتن افزایش می‌یابد و با خواندن نه', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const r0 = call(envelope('db.revision', {})).revision;
  call(envelope('db.pull', {}));
  assert.equal(call(envelope('db.revision', {})).revision, r0);
  call(envelope('db.push', { ops: [{ opId: 'rv1', entity: 'assets', kind: 'upsert', at: Date.now(), data: { id: 'z', updatedAt: Date.now() } }] }));
  assert.equal(call(envelope('db.revision', {})).revision, r0 + 1);
});

/* ==================== رکوردها و تصویر امضا ==================== */

test('امضای بزرگ به فایل Drive منتقل می‌شود و سلول شیت سبک می‌ماند', async () => {
  const { api, env } = await boot({ SIGNATURES_INLINE: 'false' });
  const call = post(api, env);
  const png = 'data:image/png;base64,' + 'A'.repeat(50000);
  const at = Date.now();
  const push = call(envelope('db.push', { ops: [{
    opId: 'sig-1', entity: 'records', kind: 'upsert', at,
    data: { id: 'r1', assetCode: 'DB-01', percent: 88, updatedAt: at,
      signatures: { inspector: { image: png, name: 'علی', title: 'بازرس', signedAt: '1404/06/22' } } },
  }] }));
  assert.equal(push.applied.length, 1);

  const rec = call(envelope('records.get', { id: 'r1' })).record;
  assert.equal(rec.signatures.inspector.external, true);
  assert.ok(rec.signatures.inspector.fileId, 'ارجاع فایل باید ثبت شود');
  assert.equal(rec.signatures.inspector.name, 'علی');

  const sig = call(envelope('records.signature', { fileId: rec.signatures.inspector.fileId }));
  assert.equal(sig.ok, true);
  assert.ok(sig.image.startsWith('data:image/png;base64,'));
  assert.ok(sig.image.length > 1000, 'تصویر باید قابل بازیابی باشد');
});

test('records.list با فیلتر و light mode', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const at = Date.now();
  call(envelope('db.push', { ops: [
    { opId: 'l1', entity: 'records', kind: 'upsert', at, data: { id: 'r1', assetCode: 'A', percent: 50, details: [{ q: 1 }], updatedAt: at, completedAt: new Date(at).toISOString() } },
    { opId: 'l2', entity: 'records', kind: 'upsert', at, data: { id: 'r2', assetCode: 'B', percent: 90, details: [{ q: 2 }], updatedAt: at, completedAt: new Date(at + 1000).toISOString() } },
  ] }));
  const all = call(envelope('records.list', {}));
  assert.equal(all.total, 2);
  assert.equal(all.records[0].assetCode, 'B', 'جدیدترین اول');
  assert.equal(all.records[0].details, undefined, 'در حالت light جزئیات ارسال نمی‌شود');

  const filtered = call(envelope('records.list', { light: false, filter: { assetCode: 'A' } }));
  assert.equal(filtered.total, 1);
  assert.deepEqual(filtered.records[0].details, [{ q: 1 }]);
});

/* ==================== کاربران / ورود ==================== */

test('auth.login با هش درست موفق و با هش غلط ناموفق است', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const at = Date.now();
  call(envelope('db.push', { ops: [{ opId: 'u1', entity: 'users', kind: 'upsert', at,
    data: { id: 'u1', username: 'admin', name: 'مدیر', role: 'admin', passwordHash: 'HASH1', salt: 'SALT', hashAlgo: 'pbkdf2-sha256', iterations: 120000, active: true, pages: ['dashboard', 'users'], updatedAt: at } }] }));

  const ok = call(envelope('auth.login', { username: 'admin', passwordHash: 'HASH1' }));
  assert.equal(ok.ok, true);
  assert.equal(ok.user.role, 'admin');
  assert.deepEqual(ok.user.pages, ['dashboard', 'users'], 'pages باید به آرایه برگردد');

  const bad = call(envelope('auth.login', { username: 'admin', passwordHash: 'WRONG' }));
  assert.equal(bad.ok, false);

  const missing = call(envelope('auth.login', { username: 'nope', passwordHash: 'HASH1' }));
  assert.equal(missing.ok, false);
});

test('auth.login: «مرا به خاطر بسپار» عمر توکن را ۳۰ روز می‌کند، بدون آن فقط ۲۴ ساعت', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const at = Date.now();
  call(envelope('db.push', { ops: [{ opId: 'u1', entity: 'users', kind: 'upsert', at,
    data: { id: 'u1', username: 'admin', name: 'مدیر', role: 'admin', passwordHash: 'HASH1', salt: 'SALT', hashAlgo: 'pbkdf2-sha256', iterations: 120000, active: true, pages: [], updatedAt: at } }] }));

  const now = Date.now();
  const normal = call(envelope('auth.login', { username: 'admin', passwordHash: 'HASH1' }));
  assert.equal(normal.ok, true);
  const normalTtl = normal.sessionExpiresAt - now;
  // باید حدود ۲۴ ساعت باشد (رفتار قبلی، بدون تیک)
  assert.ok(normalTtl > 23 * 60 * 60 * 1000 && normalTtl < 25 * 60 * 60 * 1000,
    `عمر توکنِ بدون remember باید ~۲۴ساعت باشد، بود: ${normalTtl}ms`);

  const remembered = call(envelope('auth.login', { username: 'admin', passwordHash: 'HASH1', remember: true }));
  assert.equal(remembered.ok, true);
  const rememberedTtl = remembered.sessionExpiresAt - now;
  // باید حدود ۳۰ روز باشد
  assert.ok(rememberedTtl > 29 * 24 * 60 * 60 * 1000 && rememberedTtl < 31 * 24 * 60 * 60 * 1000,
    `عمر توکنِ remember باید ~۳۰روز باشد، بود: ${rememberedTtl}ms`);

  // نکته‌ی امنیتی: عمر طولانی به‌معنی عدم امکان ابطال نیست — تغییر رمز
  // sessionVersion را بالا می‌برد و توکنِ قدیمی (even remembered) بلافاصله رد می‌شود.
  const at2 = Date.now();
  call(envelope('db.push', {
    ops: [{ opId: 'u1-pwchange', entity: 'users', kind: 'upsert', at: at2,
      data: { id: 'u1', username: 'admin', name: 'مدیر', role: 'admin', passwordHash: 'HASH2', salt: 'SALT2', hashAlgo: 'pbkdf2-sha256', iterations: 120000, active: true, pages: [], sessionVersion: 2, updatedAt: at2 } }],
    sessionToken: remembered.sessionToken,
  }));
  const afterPwChange = call(envelope('db.push', {
    ops: [{ opId: 'settings-after-pwchange', entity: 'settings', kind: 'set', at: Date.now(), data: { orgName: 'تست' } }],
    sessionToken: remembered.sessionToken,
  }));
  // db.push همیشه ok:true در سطح بالا برمی‌گرداند؛ رد شدنِ عملیات در errors
  // منعکس می‌شود، نه در ok سطح بالا.
  assert.equal(afterPwChange.applied.length, 0, 'نوشتنِ settings با توکنِ باطل‌شده نباید اعمال شود');
  assert.equal(afterPwChange.errors.length, 1, 'باید دقیقاً یک خطا برگردد');
  assert.match(afterPwChange.errors[0].error, /نشست منقضی شده|رمز عبور تغییر کرده/,
    'توکنِ remembered باید بعد از تغییر رمز/sessionVersion بلافاصله رد شود');
});

test('تغییر نقش روی سرور، در pull بعدی به کلاینت می‌رسد', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const t1 = Date.now();
  call(envelope('db.push', { ops: [{ opId: 'r-1', entity: 'users', kind: 'upsert', at: t1, data: { id: 'u2', username: 'bob', role: 'inspector', active: true, updatedAt: t1 } }] }));
  await sleep(3);
  const mark = call(envelope('db.pull', {})).serverTime;
  await sleep(3);
  const t2 = Date.now();
  call(envelope('db.push', { ops: [{ opId: 'r-2', entity: 'users', kind: 'upsert', at: t2, data: { id: 'u2', role: 'manager', sessionVersion: 2, updatedAt: t2 } }] }));
  const u = call(envelope('db.pull', { since: mark })).entities.users[0];
  assert.equal(u.role, 'manager');
  assert.equal(u.sessionVersion, 2);
});

/* ============ مهاجرت schema (ارتقای نسخه روی داده‌ی موجود) ============ */

/**
 * سناریوی واقعی ارتقا: نسخه‌ی جدید کد یک ستون به schema اضافه کرده و روی همان
 * Spreadsheet قبلی deploy می‌شود. چون readTable/writeRow_ موقعیت ستون‌ها را از
 * کد می‌گیرند (نه از ردیف هدر شیت)، بدون هم‌ترازی داده‌ها هر ستون یک خانه
 * جابه‌جا خوانده می‌شود — خرابی خاموش و برگشت‌ناپذیر.
 */
async function bootVersion(sourceText, spreadsheets, props = {}) {
  const os = await import('node:os');
  const fs = await import('node:fs/promises');
  const file = path.join(os.tmpdir(), `code-${Date.now()}-${Math.random().toString(36).slice(2)}.gs`);
  await fs.writeFile(file, sourceText, 'utf8');
  const { api, env } = await loadServer(file, { properties: { API_KEY: KEY, ...props }, spreadsheets });
  await fs.unlink(file).catch(() => {});
  return { api, env };
}

const BASE_SRC = await (async () => {
  const fs = await import('node:fs/promises');
  return fs.readFile(CODE, 'utf8');
})();

test('افزودن ستون جدید در میانه‌ی schema، داده‌ی موجود را جابه‌جا نمی‌کند', async () => {
  const spreadsheets = new Map();

  // نسخه‌ی «قدیمی» = همین کد فعلی
  const old = await bootVersion(BASE_SRC, spreadsheets);
  const callOld = post(old.api, old.env);
  const dbId = old.api.getDb().getId();
  callOld(envelope('db.push', {
    ops: [{
      opId: 'm1', entity: 'records', kind: 'upsert', at: Date.now(),
      data: { id: 'r1', assetCode: 'A-1', percent: 77, status: 'موفق', inspectorName: 'علی', approvedBy: 'مدیر', pdfUrl: 'http://x.pdf' },
    }],
  }));

  // نسخه‌ی «جدید» = یک ستون در میانه اضافه شده
  const NEW_COL = '"signatures", "signRequest", "assignmentId", "approvedBy"';
  assert.ok(BASE_SRC.includes('"signatures", "assignmentId", "approvedBy"'), 'anchor برای تست مهاجرت پیدا نشد');
  const upgraded = BASE_SRC
    .replace('"signatures", "assignmentId", "approvedBy"', NEW_COL)
    .replace('details: "j", signatures: "j",', 'details: "j", signatures: "j", signRequest: "j",');

  const neo = await bootVersion(upgraded, spreadsheets, { DB_SHEET_ID: dbId });
  const callNew = post(neo.api, neo.env);

  const rows = callNew(envelope('records.list', { light: false })).records;
  assert.equal(rows.length, 1);
  const r = rows[0];
  // هر ستون باید همان مقدار قبلی خودش را داشته باشد
  assert.equal(r.assetCode, 'A-1');
  assert.equal(r.inspectorName, 'علی');
  assert.equal(r.percent, 77);
  assert.equal(r.status, 'موفق');
  assert.equal(r.approvedBy, 'مدیر', 'ستون‌های بعد از نقطه‌ی درج باید سر جای خود بمانند');
  assert.equal(r.pdfUrl, 'http://x.pdf');
  assert.equal(r.signRequest, null, 'ستون تازه باید خالی باشد');

  // نوشتن روی نسخه‌ی جدید هم باید درست بچیند
  callNew(envelope('db.push', {
    ops: [{
      opId: 'm2', entity: 'records', kind: 'upsert', at: Date.now() + 1000,
      data: { id: 'r1', approvedBy: 'مدیر جدید', signRequest: { toUserId: 'u9', status: 'pending' } },
    }],
  }));
  const after = post(neo.api, neo.env)(envelope('records.list', { light: false })).records[0];
  assert.equal(after.approvedBy, 'مدیر جدید');
  assert.equal(after.pdfUrl, 'http://x.pdf', 'pdfUrl نباید هنگام نوشتن دوباره جابه‌جا شود');
  assert.deepEqual(after.signRequest, { toUserId: 'u9', status: 'pending' });
});

test('حذف ستون از schema، بقیه‌ی داده‌ها را سالم نگه می‌دارد', async () => {
  const spreadsheets = new Map();
  const old = await bootVersion(BASE_SRC, spreadsheets);
  const dbId = old.api.getDb().getId();
  post(old.api, old.env)(envelope('db.push', {
    ops: [{
      opId: 'd1', entity: 'records', kind: 'upsert', at: Date.now(),
      data: { id: 'r1', assetCode: 'A-9', percent: 42, status: 'ناموفق', inspectorName: 'رضا', pdfUrl: 'http://keep.pdf' },
    }],
  }));

  // نسخه‌ی جدید: ستون approvedAt حذف شده
  const shrunk = BASE_SRC.replace('"approvedBy", "approvedAt", "pdfUrl"', '"approvedBy", "pdfUrl"');
  assert.ok(shrunk !== BASE_SRC, 'anchor حذف ستون پیدا نشد');
  assert.ok(!/"approvedAt"/.test(shrunk.split('COL_TYPES')[0]), 'ستون approvedAt باید از schema حذف شده باشد');

  const neo = await bootVersion(shrunk, spreadsheets, { DB_SHEET_ID: dbId });
  const r = post(neo.api, neo.env)(envelope('records.list', { light: false })).records[0];
  assert.equal(r.assetCode, 'A-9');
  assert.equal(r.inspectorName, 'رضا');
  assert.equal(r.percent, 42);
  assert.equal(r.pdfUrl, 'http://keep.pdf', 'ستون‌های بعد از ستون حذف‌شده باید درست بخوانند');
  assert.equal(r.approvedAt, undefined);
});

test('هم‌ترازی هدر روی شیت خالی و شیتِ داده‌دارِ بدون هدر امن است', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const ss = api.getDb();

  // ۱) شیت موجود ولی کاملاً خالی (هدر پاک شده) → باید هدر از نو نوشته شود
  const assets = ss.getSheetByName('assets');
  assets.getRange(1, 1, 1, assets.getLastColumn() || 1).setValues([['']]);
  assert.doesNotThrow(() => api.maintenanceEnsureSchema());
  assert.equal(ss.getSheetByName('assets').getRange(1, 1).getValue(), 'id');

  // ۲) شیت با داده ولی بدون هدر: داده نباید به‌عنوان هدر تفسیر یا حذف شود
  call(envelope('db.push', { ops: [{ opId: 'e1', entity: 'assets', kind: 'upsert', at: Date.now(), data: { id: 'a1', code: 'C-1', name: 'تابلو' } }] }));
  const before = call(envelope('bootstrap', {})).counts.assets;
  assert.equal(before, 1);
  api.maintenanceEnsureSchema();
  assert.equal(call(envelope('bootstrap', {})).counts.assets, before, 'داده نباید در اثر هم‌ترازی هدر از بین برود');

  // ۳) اجرای مکرر بدون تغییر schema باید بی‌اثر (no-op) بماند
  api.maintenanceEnsureSchema();
  api.maintenanceEnsureSchema();
  assert.equal(call(envelope('bootstrap', {})).counts.assets, before);
  assert.equal(call(envelope('assets.list', {})).assets[0].code, 'C-1');
});

/* ==================== دسته‌بندی‌ها و تنظیمات ==================== */

test('categories.set جایگزین کامل می‌کند و موارد حذف‌شده tombstone می‌شوند', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const { sessionToken } = await seedAdminSession(call);
  call(envelope('db.push', { ops: [{ opId: 'cat1', entity: 'categories', kind: 'set', at: Date.now(), data: ['برق', 'مکانیک', 'ایمنی'] }], sessionToken }));
  assert.equal(call(envelope('bootstrap', {})).counts.categories, 3);
  call(envelope('db.push', { ops: [{ opId: 'cat2', entity: 'categories', kind: 'set', at: Date.now(), data: ['برق', 'عمومی'] }], sessionToken }));
  const live = call(envelope('bootstrap', {})).counts.categories;
  assert.equal(live, 2);
  const rows = call(envelope('db.pull', {})).entities.categories;
  assert.equal(rows.filter(r => r.deleted).length, 2, 'مکانیک و ایمنی حذف شده‌اند');
});

test('settings.set مقدار آستانه و نام سازمان را نگه می‌دارد', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const { sessionToken } = await seedAdminSession(call);
  call(envelope('db.push', { ops: [{ opId: 's1', entity: 'settings', kind: 'set', at: Date.now(), data: { orgName: 'درکاو', passThreshold: 85 } }], sessionToken }));
  const s = call(envelope('settings.get', {})).settings;
  assert.equal(s.orgName, 'درکاو');
  assert.equal(s.passThreshold, 85);
});

test('نوشتن روی settings/categories/users بدون نشست معتبر یا با نقش نامعتبر رد می‌شود', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const { sessionToken: adminToken } = await seedAdminSession(call);

  const noSession = call(envelope('db.push', { ops: [{ opId: 'x1', entity: 'settings', kind: 'set', at: Date.now(), data: { orgName: 'دستکاری‌شده' } }] }));
  assert.equal(noSession.applied.length, 0);
  assert.equal(noSession.errors.length, 1);
  assert.match(noSession.errors[0].error, /وارد شوید/);
  assert.equal(call(envelope('settings.get', {})).settings.orgName, '', 'تنظیمات نباید بدون نشست تغییر کند');

  // یک کاربر غیرادمین با نشست معتبر ادمین ساخته می‌شود؛ او خودش اجازه‌ی
  // تغییر تنظیمات را ندارد (نقش پایین‌تر از admin).
  const at = Date.now();
  call(envelope('db.push', { ops: [{ opId: 'u-insp', entity: 'users', kind: 'upsert', at,
    data: { id: 'insp-1', username: 'insp', role: 'inspector', passwordHash: 'H', active: true, updatedAt: at } }], sessionToken: adminToken }));
  const inspLogin = call(envelope('auth.login', { username: 'insp', passwordHash: 'H' }));
  assert.equal(inspLogin.ok, true);

  const forbidden = call(envelope('db.push', { ops: [{ opId: 'x2', entity: 'settings', kind: 'set', at: Date.now(), data: { orgName: 'دستکاری‌شده' } }], sessionToken: inspLogin.sessionToken }));
  assert.equal(forbidden.applied.length, 0);
  assert.match(forbidden.errors[0].error, /دسترسی کافی نیست/);

  // بازرس نمی‌تواند نقش خودش را از راه ویرایش پروفایل خودش به admin ارتقا دهد
  const escalate = call(envelope('db.push', { ops: [{ opId: 'x3', entity: 'users', kind: 'upsert', at: Date.now(),
    data: { id: 'insp-1', username: 'insp', role: 'admin', active: true, pages: ['dashboard', 'settings', 'users'] } }], sessionToken: inspLogin.sessionToken }));
  assert.equal(escalate.applied[0] && escalate.applied[0].id, 'insp-1', 'ویرایش پروفایل خودش مجاز است');
  const after = call(envelope('users.get', { id: 'insp-1' })).user;
  assert.equal(after.role, 'inspector', 'نقش نباید از راه ویرایش خود ارتقا یابد');
});

/* ==================== سازگاری با نسخه ۷ و مهاجرت ==================== */

const LEGACY = {
  version: 3,
  users: [{ id: 'u-admin', username: 'admin', passwordHash: 'aaa', role: 'admin', name: 'مدیر', active: true }],
  categories: ['برق', 'مکانیک'],
  templates: [{ id: 't1', name: 'قالب ۱', category: 'برق', passThreshold: 80, archived: false, items: [{ id: 'i1', type: 'yesno', label: 'سوال', weight: 10 }] }],
  assets: [{ id: 'a1', code: 'DB-01', name: 'تابلو ۱', templateId: 't1' }, { id: 'a2', code: 'DB-02', name: 'تابلو ۲', templateId: 't1' }],
  assignments: [],
  records: [{ id: 'r1', assetCode: 'DB-01', percent: 92, status: 'موفق', details: [{ id: 'i1', value: 'بله' }] }],
  settings: { orgName: 'سازمان درکاو', passThreshold: 80, managerPinHash: 'pin-hash' },
};

test('cloud_push نسخه قدیمی (کل DB) به ردیف‌های شیت تبدیل می‌شود', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const res = call(envelope('cloud_push', { data: LEGACY, meta: { device: 'test' } }));
  assert.equal(res.ok, true);
  assert.equal(res.applied >= 5, true);
  const counts = call(envelope('bootstrap', {})).counts;
  assert.equal(counts.users, 1);
  assert.equal(counts.assets, 2);
  assert.equal(counts.records, 1);
  assert.equal(counts.categories, 2);
});

test('cloud_pull نسخه قدیمی همان شکل قبلی را برمی‌گرداند', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  call(envelope('cloud_push', { data: LEGACY }));
  const pull = call(envelope('cloud_pull', {}));
  assert.equal(pull.ok, true);
  assert.equal(pull.data.users[0].username, 'admin');
  assert.deepEqual(pull.data.categories, ['برق', 'مکانیک']);
  assert.equal(pull.data.templates[0].items.length, 1);
  assert.equal(pull.data.records[0].percent, 92);
  assert.equal(pull.data.settings.orgName, 'سازمان درکاو');
  assert.equal(pull.data.settings.managerPinHash, 'pin-hash');
});

test('importLegacyData مستقیم (مسیر migrateFromLegacyJson)', async () => {
  const { api, env } = await boot();
  const ss = api.getDb();
  const res = api.importLegacyData(ss, LEGACY, 'سامانه چک‌لیست درکاو');
  assert.equal(res.counts.assets, 2);
  assert.equal(res.counts.records, 1);
  assert.ok(res.revision >= 1);
});

test('داده‌ی قدیمی با users خالی/رکوردهای بدون id هم crash نمی‌کند', async () => {
  const { api, env } = await boot();
  const ss = api.getDb();
  const weird = { users: [], assets: [{ code: 'بدون-آیدی' }], records: [null, { percent: 5 }], categories: [] };
  const res = api.importLegacyData(ss, weird, 'x');
  assert.equal(res.counts.assets, 1);
  assert.equal(res.counts.records, 1);
});

/* ==================== پشتیبان و PDF ==================== */

test('purgeOldBackups فقط فایل‌های پشتیبان سامانه را پاک می‌کند', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  for (let i = 0; i < 3; i++) {
    call(envelope('backup', { payload: { hello: i } }));
  }
  const root = env.__drive.root.getFoldersByName('سامانه چک‌لیست درکاو').next();
  const backupFolder = root.getFoldersByName('پشتیبان کامل').next();
  backupFolder.createFile('فایل-دستی-کاربر.json', '{}', 'text/plain');

  api.purgeOldBackups(backupFolder, 1);
  const remaining = [];
  const it = backupFolder.getFiles();
  while (it.hasNext()) remaining.push(it.next().getName());
  assert.ok(remaining.includes('فایل-دستی-کاربر.json'), 'فایل دستی کاربر نباید پاک شود');
  assert.equal(remaining.filter(n => n.startsWith('پشتیبان_')).length, 1);
});

test('save_record با pdfBase64 فایل PDF می‌سازد و در شیت records هم ثبت می‌شود', async () => {
  const { api, env } = await boot({ ADMIN_EMAIL: 'admin@example.com' });
  const call = post(api, env);
  const b64 = Buffer.from('%PDF-1.4 fake content').toString('base64');
  const res = call(envelope('save_record', {
    pdfBase64: b64,
    record: { id: 'rec-99', assetCode: 'DB-07', templateName: 'قالب', category: 'برق', inspectorName: 'رضا',
      percent: 40, criticalFail: true, status: 'ناموفق (حیاتی)', completedAt: new Date().toISOString() },
  }));
  assert.equal(res.ok, true);
  assert.match(res.pdfUrl, /drive\.google\.com/);
  const listed = call(envelope('records.list', { filter: { assetCode: 'DB-07' } }));
  assert.equal(listed.total, 1);
  assert.equal(listed.records[0].pdfUrl, res.pdfUrl);
  assert.equal(env.__emails.length, 1, 'ایمانیل هشدار بازرسی حیاتی ارسال شد');
});

test('save_record بدون PDF به مسیر HTML و در نهایت JSON می‌افتد', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const res = call(envelope('save_record', { html: '<html><body>گزارش</body></html>', record: { id: 'r-h', assetCode: 'A1', percent: 70 } }));
  assert.equal(res.ok, true);
  const res2 = call(envelope('save_record', { record: { id: 'r-j', assetCode: 'A2', percent: 70 } }));
  assert.equal(res2.ok, true);
});

test('export_zip برای ماه بدون فایل خطای تمیز می‌دهد', async () => {
  const { api, env } = await boot();
  const res = post(api, env)(envelope('export_zip', { year: '1404', month: '05-مرداد' }));
  assert.equal(res.ok, false);
  assert.ok(res.error.length > 0);
});

/* ==================== سلامت ساختار ==================== */

test('همه شیت‌های موردنیاز با هدر درست ساخته می‌شوند', async () => {
  const { api, env } = await boot();
  const ss = api.getDb();
  const names = ss.getSheets().map(s => s.getName());
  ['users', 'templates', 'assets', 'assignments', 'records', 'categories', '_meta', '_ops', '_log']
    .forEach(n => assert.ok(names.includes(n), `شیت ${n} ساخته نشد`));
  const recSheet = ss.getSheetByName('records');
  const header = recSheet.getRange(1, 1, 1, 40).getValues()[0].filter(Boolean);
  assert.deepEqual(header, api.headerFor('records'));
  assert.ok(header.includes('updatedAt') && header.includes('deleted'));
});

test('ردیف خالی دستی در شیت، خروجی را خراب نمی‌کند', async () => {
  const { api, env } = await boot();
  const ss = api.getDb();
  const sh = ss.getSheetByName('assets');
  sh.appendRow(['', '', '', '', '', '', '', '', '', '']); // ردیف کاملاً خالی
  sh.appendRow(['a-manual', 'MAN-1', 'دستی', '', '', '', '', Date.now(), Date.now(), false]);
  const rows = api.readTable(ss, 'assets');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, 'MAN-1');
});

test('action نامعتبر خطای تمیز برمی‌گرداند نه crash', async () => {
  const { api, env } = await boot();
  const res = post(api, env)(envelope('not_a_real_action', {}));
  assert.equal(res.ok, false);
  assert.match(res.error, /نامعتبر/);
});

test('بدنه خالی درخواست مدیریت می‌شود', async () => {
  const { api, env } = await boot();
  const res = JSON.parse(api.doPost({}).getContent());
  assert.equal(res.ok, false);
});

test('cleanName طول را محدود و کاراکترهای خطرناک را حذف می‌کند', async () => {
  const { api } = await boot();
  assert.equal(api.cleanName('a/b\\c:d*e?"f<g>h|i'), 'a_b_c_d_e__f_g_h_i');
  assert.equal(api.cleanName('x'.repeat(300)).length, 80);
  assert.equal(api.cleanName(''), 'بدون‌نام');
});

/* ==================== تقویم شمسی سمت سرور ==================== */

test('تقویم سرور: نوروز و طول اسفند', async () => {
  const { api } = await boot();
  assert.deepEqual(api.gregorianToJalali(2024, 3, 20), { jy: 1403, jm: 1, jd: 1 });
  assert.deepEqual(api.gregorianToJalali(2026, 9, 13), { jy: 1405, jm: 6, jd: 22 });
  assert.deepEqual(api.jalaliToGregorian(1403, 1, 1), [2024, 3, 20]);
  assert.equal(api.isLeapJalaliYear(1403), true);
  assert.equal(api.isLeapJalaliYear(1404), false);
  assert.equal(api.jalaliMonthLength(1403, 12), 30);
  assert.equal(api.jalaliMonthLength(1404, 12), 29);
  assert.equal(api.toJalaliDate(new Date(2026, 8, 13)), '1405/06/22');
  assert.match(api.toJalaliDateTime(new Date(2026, 8, 13, 9, 5)), /^1405\/06\/22 - 09:05$/);
});

test('تقویم سرور برای تاریخ نامعتبر کرش نمی‌کند', async () => {
  const { api } = await boot();
  assert.equal(typeof api.toJalaliDate(new Date('nope')), 'string');
  assert.equal(typeof api.toJalaliDate(''), 'string');
});

/* =====================================================================
   لینک دعوت یک‌بارمصرف (invites)
   ===================================================================== */

test('invites.create فقط برای ادمین کار می‌کند و توکن یک‌بارمصرف می‌سازد', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const { sessionToken } = await seedAdminSession(call);

  const created = call(envelope('invites.create', { note: 'برای بازرس جدید', sessionToken }));
  assert.equal(created.ok, true);
  assert.ok(created.token && created.token.length > 20);
  assert.ok(created.expiresAt > Date.now());
});

test('invites.create بدون نشست ادمین رد می‌شود', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const noSession = call(envelope('invites.create', { note: 'x' }));
  assert.equal(noSession.ok, false);
});

test('auth.redeemInvite بدون apiKey کار می‌کند و apiKey واقعی را برمی‌گرداند', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const { sessionToken } = await seedAdminSession(call);
  const created = call(envelope('invites.create', { sessionToken }));

  // بدون apiKey و بدون امضا، فقط با توکن دعوت
  const out = api.doPost({ postData: { contents: JSON.stringify({ action: 'auth.redeemInvite', payload: { token: created.token } }) } });
  const redeemed = JSON.parse(out.getContent());
  assert.equal(redeemed.ok, true);
  assert.equal(redeemed.apiKey, 'dk_test_key_1234567890');
});

test('auth.redeemInvite یک توکن را فقط یک‌بار می‌پذیرد', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const { sessionToken } = await seedAdminSession(call);
  const created = call(envelope('invites.create', { sessionToken }));

  const redeem = (token) => JSON.parse(api.doPost({ postData: { contents: JSON.stringify({ action: 'auth.redeemInvite', payload: { token } }) } }).getContent());
  const first = redeem(created.token);
  assert.equal(first.ok, true);
  const second = redeem(created.token);
  assert.equal(second.ok, false);
  assert.match(second.error, /قبلاً استفاده شده/);
});

test('auth.redeemInvite توکن نامعتبر یا منقضی را رد می‌کند', async () => {
  const { api, env } = await boot();
  const redeem = (token) => JSON.parse(api.doPost({ postData: { contents: JSON.stringify({ action: 'auth.redeemInvite', payload: { token } }) } }).getContent());
  const bogus = redeem('inv_does_not_exist');
  assert.equal(bogus.ok, false);
  assert.match(bogus.error, /نامعتبر/);
});

test('invites.revoke یک دعوت مصرف‌نشده را غیرقابل‌استفاده می‌کند', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const { sessionToken } = await seedAdminSession(call);
  const created = call(envelope('invites.create', { sessionToken }));
  const list1 = call(envelope('invites.list', { sessionToken }));
  const inviteId = list1.invites.find(i => i.status === 'pending').id;

  const revoked = call(envelope('invites.revoke', { id: inviteId, sessionToken }));
  assert.equal(revoked.ok, true);

  const redeem = JSON.parse(api.doPost({ postData: { contents: JSON.stringify({ action: 'auth.redeemInvite', payload: { token: created.token } }) } }).getContent());
  assert.equal(redeem.ok, false);
  assert.match(redeem.error, /لغو شده/);
});

test('invites.list توکن کامل را افشا نمی‌کند', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const { sessionToken } = await seedAdminSession(call);
  const created = call(envelope('invites.create', { sessionToken }));
  const list = call(envelope('invites.list', { sessionToken }));
  const found = list.invites.find(i => created.token.startsWith(i.tokenPreview.replace('…', '')));
  assert.ok(found, 'دعوت باید در فهرست باشد');
  assert.ok(!JSON.stringify(list).includes(created.token), 'توکن کامل نباید در پاسخ invites.list باشد');
});

/* ==================== ستون signers قالب‌ها ==================== */

test('فیلد signers قالب در شیت ذخیره و از db.pull عدد برمی‌گردد', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const now = Date.now();
  const push = call(envelope('db.push', { ops: [
    { opId: 'tpl-1', entity: 'templates', kind: 'upsert', at: now,
      data: { id: 'tpl-mc', name: 'بازرسی ماشین‌آلات', category: 'مکانیک', passThreshold: 70, archived: false, signers: 2, items: [], updatedAt: now } },
  ] }));
  assert.equal(push.ok, true);
  await sleep(5);
  const pull = call(envelope('db.pull', { since: 0, light: false }));
  const tpl = (pull.entities.templates || []).find(t => t.id === 'tpl-mc');
  assert.ok(tpl, 'قالب باید برگردد');
  assert.equal(tpl.signers, 2, 'signers باید عدد ۲ برگردد، نه رشته');
});

test('قالب بدون signers (داده‌ی قدیمی) بدون فیلد اضافه برمی‌گردد', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const now = Date.now();
  call(envelope('db.push', { ops: [
    { opId: 'tpl-2', entity: 'templates', kind: 'upsert', at: now,
      data: { id: 'tpl-old', name: 'قالب قدیمی', category: 'برق', passThreshold: 80, archived: false, items: [], updatedAt: now } },
  ] }));
  await sleep(5);
  const pull = call(envelope('db.pull', { since: 0, light: false }));
  const tpl = (pull.entities.templates || []).find(t => t.id === 'tpl-old');
  assert.ok(tpl);
  // ستون عددی خالی 0 برمی‌گردد؛ کلاینت (migrateData و templateSignerCount) عدد
  // ۰ را نامعتبر می‌داند و به پیش‌فرض سازمان برمی‌گردد، پس بی‌ضرر است.
  assert.ok(tpl.signers === undefined || tpl.signers === null || tpl.signers === '' || tpl.signers === 0,
    'بدون مقدار نباید عدد معنادار ساختگی بگیرد: ' + JSON.stringify(tpl.signers));
});

test('فیلد period قالب در شیت ذخیره و از db.pull برمی‌گردد', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const now = Date.now();
  const push = call(envelope('db.push', { ops: [
    { opId: 'tpl-p1', entity: 'templates', kind: 'upsert', at: now,
      data: { id: 'tpl-w', name: 'بازرسی هفتگی', category: 'مکانیک', passThreshold: 80, archived: false, signers: 2, period: 'weekly', items: [], updatedAt: now } },
  ] }));
  assert.equal(push.ok, true);
  await sleep(5);
  const pull = call(envelope('db.pull', { since: 0, light: false }));
  const tpl = (pull.entities.templates || []).find(t => t.id === 'tpl-w');
  assert.ok(tpl, 'قالب باید برگردد');
  assert.equal(tpl.period, 'weekly', 'دوره‌ی بازرسی باید عیناً برگردد');
  assert.equal(tpl.signers, 2);
});

test('اقدام اصلاحی (correctives) در شیت ذخیره و از db.pull برمی‌گردد', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const now = Date.now();
  const push = call(envelope('db.push', { ops: [
    { opId: 'cor-1', entity: 'correctives', kind: 'upsert', at: now,
      data: { id: 'cor-abc', recordId: 'rec-1', assetId: 'a1', assetCode: 'PMP-01', templateName: 'پمپ', reason: 'رد آیتم حیاتی',
              assignedToUserId: '', assignedToName: '', status: 'open', note: '', openedAt: now, closedAt: null,
              createdBy: 'u1', createdAt: now, updatedAt: now } },
  ] }));
  assert.equal(push.ok, true);
  await sleep(5);
  const pull = call(envelope('db.pull', { since: 0, light: false }));
  const cor = (pull.entities.correctives || []).find(c => c.id === 'cor-abc');
  assert.ok(cor, 'دستورکار باید برگردد');
  assert.equal(cor.status, 'open');
  assert.equal(cor.recordId, 'rec-1');
  assert.equal(cor.assetCode, 'PMP-01');
  // به‌روزرسانی وضعیت (بستن) هم باید ذخیره شود
  const push2 = call(envelope('db.push', { ops: [
    { opId: 'cor-2', entity: 'correctives', kind: 'upsert', at: now + 1,
      data: { id: 'cor-abc', recordId: 'rec-1', assetId: 'a1', assetCode: 'PMP-01', templateName: 'پمپ', reason: 'رد آیتم حیاتی',
              assignedToUserId: 'u2', assignedToName: 'علی', status: 'closed', note: 'رفع شد', openedAt: now, closedAt: now + 1,
              createdBy: 'u1', createdAt: now, updatedAt: now + 1 } },
  ] }));
  assert.equal(push2.ok, true);
  await sleep(5);
  const pull2 = call(envelope('db.pull', { since: 0, light: false }));
  const cor2 = (pull2.entities.correctives || []).find(c => c.id === 'cor-abc');
  assert.equal(cor2.status, 'closed', 'وضعیت بسته‌شده باید برگردد');
  assert.equal(cor2.assignedToName, 'علی');
});

test('ستون photos سابقه با محتوای عکس ذخیره و برمی‌گردد', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const now = Date.now();
  const photos = [{ image: 'data:image/jpeg;base64,QUJD', name: 'a.jpg', addedAt: now }];
  const push = call(envelope('db.push', { ops: [
    { opId: 'rec-ph', entity: 'records', kind: 'upsert', at: now,
      data: { id: 'rec-photo', templateId: 't1', templateName: 'ت', assetId: 'a1', assetCode: 'X-1',
              date: '1405/06/25', completedAt: new Date().toISOString(), inspectorId: 'u1', inspectorName: 'بازرس',
              percent: 90, score: 9, maxScore: 10, criticalFail: false, details: [], signatures: {}, photos,
              createdAt: now, updatedAt: now } },
  ] }));
  assert.equal(push.ok, true);
  await sleep(5);
  const pull = call(envelope('db.pull', { since: 0, light: false }));
  const rec = (pull.entities.records || []).find(r => r.id === 'rec-photo');
  assert.ok(rec, 'سابقه باید برگردد');
  assert.ok(Array.isArray(rec.photos), 'photos باید آرایه باشد');
  assert.equal(rec.photos[0].image.slice(0, 5), 'data:', 'عکس درون‌خطی کوچک در شیت می‌ماند');
});

test('حالت سبک (light) ستون photos را حذف می‌کند', async () => {
  const { api, env } = await boot();
  const call = post(api, env);
  const now = Date.now();
  const push = call(envelope('db.push', { ops: [
    { opId: 'rec-lt', entity: 'records', kind: 'upsert', at: now,
      data: { id: 'rec-light', templateId: 't1', templateName: 'ت', assetId: 'a1', assetCode: 'X-1',
              date: '1405/06/25', completedAt: new Date().toISOString(), inspectorId: 'u1', inspectorName: 'بازرس',
              percent: 80, score: 8, maxScore: 10, criticalFail: false,
              details: [{ q: 'س', earned: 1, max: 1 }], signatures: {}, photos: [{ image: 'data:x' }],
              createdAt: now, updatedAt: now } },
  ] }));
  assert.equal(push.ok, true);
  await sleep(5);
  const light = call(envelope('db.pull', { since: 0, light: true }));
  const rec = (light.entities.records || []).find(r => r.id === 'rec-light');
  assert.ok(rec, 'سابقه در حالت سبک هم برمی‌گردد');
  assert.equal(rec.photos, undefined, 'photos در حالت سبک حذف می‌شود');
  assert.equal(rec.details, undefined, 'details هم حذف می‌شود');
});
