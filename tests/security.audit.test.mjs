// ممیزی امنیتی (لایه‌ی سرور و هسته): کنترل دسترسی سمت سرور (RBAC)،
// جلوگیری از ارتقای نقش، نشست/توکن، ابطال با نسخه‌ی نشست، امضای درخواست و ضدریپلی.
// (تست‌های مربوط به گریز XSS در گزارش‌ها در render.smoke.test.mjs است،
//  چون آنجا لودر کامل اپ وجود دارد.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, bootServer, installBrowserStubs, createClient } from './harness.mjs';

installBrowserStubs();
const core = loadCore('security-audit');
const KEY = 'dk_test_key_1234567890';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ADMIN = { id: 'u-admin', username: 'admin', name: 'مدیر', role: 'admin' };
const ALI = { id: 'u-ali', username: 'ali', name: 'علی', role: 'inspector' };

const mkCred = async (pw) => core.makeCredential(pw, 2);

function seedData(creds) {
  const at = Date.now();
  const row = (u, c) => Object.assign({}, u, {
    active: true, pages: [], sessionVersion: 1, phone: '', nationalId: '',
    passwordHash: c.passwordHash, salt: c.salt, hashAlgo: c.hashAlgo, iterations: c.iterations, updatedAt: at,
  });
  return {
    version: 4, users: [row(ADMIN, creds[0]), row(ALI, creds[1])], categories: ['برق'],
    templates: [{ id: 't1', name: 'قالب', category: 'برق', passThreshold: 80, archived: false, items: [], updatedAt: at }],
    assets: [], assignments: [], records: [],
    settings: { orgName: 'سازمان', passThreshold: 80 }, revision: 0, lastSyncAt: 0,
  };
}

async function postSeed(api, data, signed) {
  const payload = { action: 'cloud_push', apiKey: KEY, payload: { data } };
  if (signed) {
    payload.ts = Date.now();
    payload.nonce = 'seed-' + Math.random().toString(36).slice(2);
    payload.sig = await core.hmacSha256Hex(KEY, [payload.action, payload.ts, payload.nonce].join('|'));
  }
  const res = JSON.parse(api.doPost({ postData: { contents: JSON.stringify(payload) } }).getContent());
  assert.equal(res.ok, true, 'seed: ' + JSON.stringify(res));
  return data;
}

test('escapeHtml همه‌ی نویسه‌های خطرناک و متن فارسی را درست هندل می‌کند', () => {
  assert.equal(core.escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(core.escapeHtml('بازرسی دوره‌ای ۱۴۰۵'), 'بازرسی دوره‌ای ۱۴۰۵');
  assert.equal(core.escapeHtml(null), '');
  assert.equal(core.escapeHtml(undefined), '');
  assert.equal(core.escapeHtml(123), '123');
  assert.equal(core.escapeHtml('a&b<c>d"e\'f'), 'a&amp;b&lt;c&gt;d&quot;e&#39;f');
});

test('کنترل دسترسی سرور: ارتقای نقش، نوشتن تنظیمات و توکن جعلی رد می‌شوند', async () => {
  const { api } = await bootServer();
  const creds = await Promise.all([mkCred('pw-admin-1'), mkCred('pw-ali-2')]);
  const seed = await postSeed(api, seedData(creds), false);
  const mk = (name) => createClient({ core, api, name, seed: JSON.parse(JSON.stringify(seed)) });

  const admin = mk('dev-admin');
  const ali = mk('dev-ali');
  const vA = await core.verifyCredential(seed.users[0], 'pw-admin-1');
  const vU = await core.verifyCredential(seed.users[1], 'pw-ali-2');
  await admin.login('admin', vA.hash);
  const aliLogin = await ali.login('ali', vU.hash);
  assert.ok(aliLogin.sessionToken);

  // ۱) بازرس نمی‌تواند تنظیمات سازمان را عوض کند
  const r1 = ali.call('db.push', {
    sessionToken: ali.sessionToken,
    ops: [{ opId: 'hack-1', clientId: 'dev-ali', entity: 'settings', kind: 'set', at: Date.now(), data: { orgName: 'هک شد' } }],
  });
  assert.equal((r1.applied || []).length, 0, 'نوشتن تنظیمات توسط بازرس نباید اعمال شود');
  assert.equal((r1.errors || []).length, 1);

  // ۲) بازرس نمی‌تواند نقش خودش را ادمین کند (خودویرایشی پین می‌شود)
  ali.call('db.push', {
    sessionToken: ali.sessionToken,
    ops: [{ opId: 'hack-2', clientId: 'dev-ali', entity: 'users', kind: 'upsert', at: Date.now(),
      data: { id: 'u-ali', role: 'admin', username: 'ali', name: 'علی', active: true, pages: ['users', 'settings'] } }],
  });
  await sleep(5);
  const pull = ali.call('db.pull', { since: 0, light: true });
  const aliRow = (pull.entities.users || []).find(u => u.id === 'u-ali');
  assert.equal(aliRow.role, 'inspector', 'نقش باید پین بماند؛ ارتقا ممنوع');
  assert.ok(!(aliRow.pages || []).includes('settings'), 'صفحه‌ی حساس هم نباید اضافه شده باشد');

  // ۳) بدون توکن نشست، نوشتن روی کاربران رد می‌شود
  const r3 = ali.call('db.push', {
    ops: [{ opId: 'hack-3', clientId: 'dev-ali', entity: 'users', kind: 'upsert', at: Date.now(),
      data: { id: 'u-ali', name: 'علی', active: true } }],
  });
  assert.equal((r3.applied || []).length, 0);
  assert.ok((r3.errors || []).length === 1);

  // ۴) توکن جعلی/دستکاری‌شده رد می‌شود
  const parts = aliLogin.sessionToken.split('.');
  const forged = parts[0] + '.' + 'AAAA' + parts[1].slice(4);
  const r4 = ali.call('db.push', {
    sessionToken: forged,
    ops: [{ opId: 'hack-4', clientId: 'dev-ali', entity: 'settings', kind: 'set', at: Date.now(), data: { orgName: 'جعلی' } }],
  });
  assert.equal((r4.applied || []).length, 0);
  assert.equal((r4.errors || []).length, 1);

  // ۵) بعد از افزایش نسخه‌ی نشست (مثلاً تغییر رمز)، توکن قدیمی باطل می‌شود (sv)
  const bump = admin.call('db.push', {
    sessionToken: admin.sessionToken,
    ops: [{ opId: 'adm-1', clientId: 'dev-admin', entity: 'users', kind: 'upsert', at: Date.now(),
      data: { id: 'u-ali', username: 'ali', name: 'علی', role: 'inspector', active: true, pages: [], sessionVersion: 7 } }],
  });
  assert.equal((bump.applied || []).length, 1, 'ادمین می‌تواند نسخه‌ی نشست را بالا ببرد');
  await sleep(5);
  const r5 = ali.call('db.push', {
    sessionToken: ali.sessionToken, // توکن قدیمی با sv=1
    ops: [{ opId: 'hack-5', clientId: 'dev-ali', entity: 'categories', kind: 'set', at: Date.now(), data: ['برق'] }],
  });
  assert.equal((r5.applied || []).length, 0, 'توکن با نسخه‌ی نشست قدیمی باید رد شود');

  // ۶) نوشتن رکورد/تجهیز (غیرمحافظت‌شده) برای بازرس آزاد است — رفتار عادی نباید شکسته باشد
  const r6 = ali.call('db.push', {
    sessionToken: ali.sessionToken,
    ops: [{ opId: 'ok-1', clientId: 'dev-ali', entity: 'assets', kind: 'upsert', at: Date.now(),
      data: { id: 'a-new', code: 'DB-99', name: 'تابلو', location: '', serial: '', templateId: 't1', category: 'برق' } }],
  });
  assert.equal((r6.applied || []).length, 1, 'نوشتن موجودیت غیرمحافظت‌شده باید برای بازرس آزاد بماند');
});

test('امضای درخواست: کلید/امضای بد رد می‌شود؛ بازپخش (replay) با نونس رد می‌شود', async () => {
  const { api } = await bootServer({ REQUIRE_SIGNATURE: 'true' });
  const creds = await Promise.all([mkCred('pw-admin-1'), mkCred('pw-ali-2')]);
  await postSeed(api, seedData(creds), true); // seed هم باید امضاشده باشد

  // عملیات احرازهویت‌شده (نه ping که عمداً بدون کلید است)
  const mkEnvelope = async (action, payload) => {
    const ts = Date.now();
    const nonce = 'n-' + Math.random().toString(36).slice(2);
    const sig = await core.hmacSha256Hex(KEY, [action, ts, nonce].join('|'));
    return { action, apiKey: KEY, ts, nonce, sig, payload: payload || {} };
  };
  const post = (env) => JSON.parse(api.doPost({ postData: { contents: JSON.stringify(env) } }).getContent());

  // درخواست معتبر
  const env1 = await mkEnvelope('db.revision', {});
  assert.equal(post(env1).ok, true, 'درخواست امضاشده‌ی معتبر باید قبول شود');

  // بازپخش همان درخواست → رد (replay)
  const rep = post(env1);
  assert.equal(rep.ok, false, 'بازپخش درخواست باید رد شود');
  assert.ok(String(rep.error || '').includes('replay') || String(rep.error || '').includes('پیش‌تر'));

  // امضای اشتباه
  const env2 = await mkEnvelope('db.revision', {});
  env2.sig = 'deadbeef'.repeat(8);
  assert.equal(post(env2).ok, false, 'امضای اشتباه باید رد شود');

  // مهر زمانی خیلی قدیمی (خارج از پنجره‌ی مجاز)
  const env3 = await mkEnvelope('db.revision', {});
  env3.ts = Date.now() - 30 * 60 * 1000;
  env3.sig = await core.hmacSha256Hex(KEY, [env3.action, env3.ts, env3.nonce].join('|'));
  assert.equal(post(env3).ok, false, 'درخواست با ساعت خیلی قدیمی باید رد شود');

  // کلید API اشتباه
  const env4 = await mkEnvelope('db.revision', {});
  env4.apiKey = 'wrong-key';
  assert.equal(post(env4).ok, false, 'کلید اشتباه باید رد شود');
});
