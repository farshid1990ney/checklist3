import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, bootServer, installBrowserStubs, createClient, seedServer } from './harness.mjs';

installBrowserStubs();
const core = loadCore('test-client');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function scenario() {
  const { api, env } = await bootServer();
  const seed = await seedServer(core, api);
  const A = createClient({ core, api, name: 'device-A-mobile', seed });
  const B = createClient({ core, api, name: 'device-B-laptop', seed });
  // هر دو دستگاه به‌عنوان همان ادمین (u-admin) وارد می‌شوند — سناریوی واقعی
  // «یک ادمین، دو دستگاه» — تا نشست سرور معتبر برای نوشتن‌های محافظت‌شده
  // (settings/categories/users) روی هر دو داشته باشند.
  await A.login('admin', 'h');
  await B.login('admin', 'h');
  await A.flush();
  await B.flush();
  return { api, env, A, B, seed };
}

/* =====================================================================
   سناریوی اصلی مرور (ایراد ۱-۱): دو کاربر، دو دستگاه، نوشتن هم‌زمان
   در نسخه قدیمی، push کل پایگاه باعث می‌شد کار نفر اول کامل از بین برود.
   ===================================================================== */

test('نوشتن هم‌زمان دو دستگاه: هیچ‌کدام از داده‌های طرف مقابل از بین نمی‌رود', async () => {
  const { api, A, B } = await scenario();

  // هر دو دستگاه هم‌زمان کار می‌کنند، بدون اینکه از تغییرات هم خبر داشته باشند
  A.update(d => {
    d.assets.push({ id: 'a2', code: 'DB-02', name: 'تابلو ۲ (ساخت A)', templateId: 't1', updatedAt: Date.now() });
    d.assets[0].name = 'ویرایش A';
  });
  await sleep(5);
  B.update(d => {
    d.records.unshift({
      id: 'r1', assetId: 'a1', assetCode: 'DB-01', templateId: 't1', templateName: 'بازرسی تابلو',
      inspectorName: 'علی', percent: 95, status: 'موفق', criticalFail: false, score: 95, maxScore: 100,
      details: [{ itemId: 'i1', value: 'بله' }], completedAt: new Date().toISOString(), updatedAt: Date.now(),
    });
    d.assets[0].name = 'ویرایش B';
  });

  // B زودتر می‌فرستد، بعد A
  const rb = await B.flush();
  assert.ok(!rb.error, 'ارسال B باید موفق باشد: ' + (rb.error && rb.error.message));
  const ra = await A.flush();
  assert.ok(!ra.error, 'ارسال A باید موفق باشد: ' + (rb.error && ra.error && ra.error.message));

  // هر دو دوباره دریافت می‌کنند تا همگرا شوند
  await B.flush();
  await A.flush();

  for (const [label, c] of [['A', A], ['B', B]]) {
    const assets = c.data.assets;
    assert.ok(assets.find(a => a.id === 'a2'), `تجهیز ساخته‌شده توسط A باید روی دستگاه ${label} باشد`);
    assert.ok(c.data.records.find(r => r.id === 'r1'), `سابقه ثبت‌شده توسط B باید روی دستگاه ${label} باشد`);
  }
  // هر دو روی یک مقدار برای فیلد متعارض همگرا می‌شوند
  assert.equal(A.data.assets.find(a => a.id === 'a1').name, B.data.assets.find(a => a.id === 'a1').name);
  // برنده‌ی LWW آخرین «ویرایش» است (updatedAt)، نه آخرین «ارسال»؛ B بعد از A ویرایش کرده
  assert.equal(A.data.assets.find(a => a.id === 'a1').name, 'ویرایش B', 'B دیرتر ویرایش کرد، پس نسخه او برنده است');

  // و سرور هم همان وضعیت را دارد
  const serverAssets = JSON.parse(api.doPost({ postData: { contents: JSON.stringify({ action: 'assets.list', apiKey: 'dk_test_key_1234567890', payload: {} }) } }).getContent()).assets;
  assert.equal(serverAssets.filter(a => !a.deleted).length, 2);
});

test('همگرایی: پس از چند چرخه، هر دو دستگاه وضعیت یکسان دارند', async () => {
  const { A, B } = await scenario();
  for (let i = 0; i < 3; i++) {
    A.update(d => { d.assets.push({ id: 'ax' + i, code: 'AX-' + i, name: 'تجهیز A' + i, updatedAt: Date.now() }); });
    B.update(d => { d.templates.push({ id: 'tx' + i, name: 'قالب B' + i, items: [], passThreshold: 70, updatedAt: Date.now() }); });
    await A.flush(); await B.flush(); await A.flush(); await B.flush();
  }
  const norm = (d) => core.stableStringify({
    assets: d.assets.map(a => a.id).sort(),
    templates: d.templates.map(t => t.id).sort(),
    users: d.users.map(u => u.id).sort(),
    categories: d.categories.slice().sort(),
  });
  assert.equal(norm(A.data), norm(B.data));
  assert.equal(A.queue.length, 0, 'صف A باید خالی شود');
  assert.equal(B.queue.length, 0, 'صف B باید خالی شود');
});

/* ===================================================================== آفلاین */

test('صف آفلاین: تغییرات هنگام قطعی شبکه نگه داشته و بعداً ارسال می‌شوند (رفع ایراد ۱-۳)', async () => {
  const { A, B } = await scenario();
  A.setOnline(false);

  A.update(d => { d.records.unshift({ id: 'r-off-1', assetCode: 'DB-01', percent: 80, status: 'موفق', details: [], updatedAt: Date.now() }); });
  A.update(d => { d.records.unshift({ id: 'r-off-2', assetCode: 'DB-01', percent: 60, status: 'ناموفق', details: [], updatedAt: Date.now() }); });
  A.update(d => { d.assets.push({ id: 'a-off', code: 'DB-99', name: 'تجهیز آفلاین', updatedAt: Date.now() }); });

  const failed = await A.flush();
  assert.ok(failed.error, 'در حالت آفلاین flush باید خطا بدهد');
  assert.equal(A.queue.length, 3, 'هر سه تغییر باید در صف بمانند');

  // در همین فاصله دستگاه دیگر کار خودش را می‌کند
  B.update(d => { d.assets.push({ id: 'b-online', code: 'DB-50', name: 'تجهیز B', updatedAt: Date.now() }); });
  await B.flush();

  A.setOnline(true);
  const ok = await A.flush();
  assert.ok(!ok.error, 'پس از بازگشت اتصال باید ارسال شود');
  assert.equal(A.queue.length, 0);
  await B.flush();

  assert.ok(B.data.records.find(r => r.id === 'r-off-1'), 'سوابق آفلاین A باید به B برسد');
  assert.ok(B.data.records.find(r => r.id === 'r-off-2'));
  assert.ok(B.data.assets.find(a => a.id === 'a-off'));
  assert.ok(A.data.assets.find(a => a.id === 'b-online'), 'و تغییرات B هم به A برسد');
});

test('ارسال دوباره‌ی یک op (retry) باعث ثبت تکراری نمی‌شود (idempotency)', async () => {
  const { api, A } = await scenario();
  A.update(d => { d.assets.push({ id: 'a-dup', code: 'DUP', name: 'تکراری', updatedAt: Date.now() }); });
  const ops = A.queue;
  assert.equal(ops.length, 1);

  const call = (payload) => JSON.parse(api.doPost({ postData: { contents: JSON.stringify({ action: 'db.push', apiKey: 'dk_test_key_1234567890', payload }) } }).getContent());
  const r1 = call({ ops });
  const r2 = call({ ops });
  const r3 = call({ ops });
  assert.equal(r1.applied.length, 1);
  assert.equal(r2.applied.length, 0);
  assert.equal(r2.skipped.length, 1);
  assert.equal(r3.applied.length, 0);
  await A.flush();
  assert.equal(A.data.assets.filter(a => a.id === 'a-dup').length, 1);
});

/* ===================================================================== حذف */

test('حذف روی یک دستگاه، رکورد را روی دستگاه دیگر هم حذف می‌کند', async () => {
  const { A, B } = await scenario();
  A.update(d => { d.assets = d.assets.filter(a => a.id !== 'a1'); });
  await A.flush();
  await B.flush();
  assert.equal(B.data.assets.find(a => a.id === 'a1'), undefined);
});

test('حذف و ویرایش هم‌زمان: حذف برنده است و رکورد زنده نمی‌شود', async () => {
  const { A, B } = await scenario();
  A.update(d => { d.assets = d.assets.filter(a => a.id !== 'a1'); });
  await A.flush();
  await sleep(5);
  // B هنوز نسخه قدیمی را دارد و همان رکورد را ویرایش می‌کند
  B.update(d => { const i = d.assets.findIndex(a => a.id === 'a1'); if (i > -1) d.assets[i].name = 'ویرایش پس از حذف'; });
  await B.flush();
  await A.flush();
  await B.flush();
  assert.equal(B.data.assets.find(a => a.id === 'a1'), undefined, 'رکورد حذف‌شده نباید برگردد');
  assert.equal(A.data.assets.find(a => a.id === 'a1'), undefined);
});

/* ===================================================================== کاربران و نقش‌ها */

test('تغییر نقش توسط ادمین، روی دستگاه دیگر اعمال می‌شود (رفع ایراد ۲-۱)', async () => {
  const { A, B } = await scenario();
  A.update(d => {
    const u = d.users.find(x => x.id === 'u-ali');
    u.role = 'manager';
    u.sessionVersion = (Number(u.sessionVersion) || 1) + 1;
  });
  await A.flush();
  await B.flush();
  const ali = B.data.users.find(u => u.id === 'u-ali');
  assert.equal(ali.role, 'manager');
  assert.equal(ali.sessionVersion, 2);
  const perms = core.buildPermissions(ali);
  assert.equal(perms.canManage, true, 'نقش جدید باید فوراً در مجوزها اثر کند');
});

test('غیرفعال‌کردن کاربر روی دستگاه دیگر هم دیده می‌شود', async () => {
  const { A, B } = await scenario();
  A.update(d => { const u = d.users.find(x => x.id === 'u-ali'); u.active = false; });
  await A.flush(); await B.flush();
  assert.equal(B.data.users.find(u => u.id === 'u-ali').active, false);
});

/* ===================================================================== امضاها */

test('تصویر امضا از شیت بیرون می‌ماند ولی از طریق ارجاع قابل بازیابی است', async () => {
  const { api, A } = await bootServer({ SIGNATURES_INLINE: 'false' }).then(async ({ api, env }) => {
    const seed = await seedServer(core, api);
    const A = createClient({ core, api, name: 'sig-client', seed });
    await A.flush();
    return { api, A };
  });

  const png = 'data:image/png;base64,' + 'A'.repeat(60000);
  A.update(d => {
    d.records.unshift({
      id: 'r-sig', assetCode: 'DB-01', templateId: 't1', templateName: 'بازرسی تابلو',
      inspectorName: 'علی', percent: 100, status: 'موفق', details: [{ itemId: 'i1', value: 'بله' }],
      signatures: { inspector: { image: png, name: 'علی رضایی', title: 'بازرس', signedAt: '1405/06/22 - 10:30' } },
      completedAt: new Date().toISOString(), updatedAt: Date.now(),
    });
  });
  await A.flush();
  assert.equal(A.queue.length, 0);

  // کلاینت دیگر رکورد را می‌گیرد؛ تصویر به‌صورت ارجاع است
  const B = createClient({ core, api, name: 'sig-client-2', seed: null });
  await B.reset();
  const rec = B.data.records.find(r => r.id === 'r-sig');
  assert.ok(rec, 'سابقه باید روی دستگاه دوم باشد');
  assert.equal(rec.signatures.inspector.name, 'علی رضایی');
  assert.equal(rec.signatures.inspector.external, true);
  assert.ok(rec.signatures.inspector.fileId);
  assert.ok(!rec.signatures.inspector.image, 'تصویر سنگین نباید داخل ردیف شیت باشد');

  const sig = JSON.parse(api.doPost({ postData: { contents: JSON.stringify({ action: 'records.signature', apiKey: 'dk_test_key_1234567890', payload: { fileId: rec.signatures.inspector.fileId } }) } }).getContent());
  assert.equal(sig.ok, true);
  assert.ok(sig.image.startsWith('data:image/png;base64,'));
  assert.ok(sig.image.length > 50000, 'تصویر باید کامل بازیابی شود');
});

/* ===================================================================== دستگاه تازه و مهاجرت */

test('دستگاه تازه با bootstrap کامل داده‌ها را می‌گیرد', async () => {
  const { api, A } = await scenario();
  A.update(d => {
    for (let i = 0; i < 25; i++) d.records.unshift({ id: 'rb' + i, assetCode: 'DB-01', percent: i * 4, status: 'موفق', details: [], updatedAt: Date.now(), completedAt: new Date().toISOString() });
  });
  await A.flush();

  const fresh = createClient({ core, api, name: 'fresh-device', seed: null });
  assert.equal(fresh.data.records.length, 0);
  await fresh.reset();
  assert.equal(fresh.data.records.length, 25);
  assert.equal(fresh.data.assets.length, 1);
  assert.equal(fresh.data.users.length, 2);
  assert.deepEqual(fresh.data.categories, ['برق', 'مکانیک']);
  assert.equal(fresh.data.settings.orgName, 'سازمان درکاو');
});

test('delta pull در پایگاه بزرگ فقط تغییرات را منتقل می‌کند', async () => {
  const { api, A } = await scenario();
  A.update(d => {
    for (let i = 0; i < 50; i++) d.records.unshift({ id: 'rr' + i, assetCode: 'DB-01', percent: 50, status: 'موفق', details: [], updatedAt: Date.now() });
  });
  await A.flush();

  const B = createClient({ core, api, name: 'delta-client', seed: null });
  await B.reset();
  assert.equal(B.data.records.length, 50);

  A.update(d => { d.records[0].percent = 77; });
  await A.flush();
  const r = await B.flush();
  assert.ok(r.stats, 'باید آمار ادغام برگردد');
  assert.ok(r.stats.updated >= 1 && r.stats.added === 0, `فقط همان یک رکورد به‌روز می‌شود: ${JSON.stringify(r.stats)}`);
  assert.equal(B.data.records.find(x => x.id === r0Id(A)).percent, 77);
});

function r0Id(client) { return client.data.records[0].id; }

test('مهاجرت از JSON قدیمی به Sheets از راه endpoint', async () => {
  const { api } = await bootServer();
  const legacy = {
    version: 3,
    users: [{ id: 'u1', username: 'admin', passwordHash: 'x', role: 'admin', name: 'مدیر', active: true }],
    categories: ['برق'],
    templates: [{ id: 't1', name: 'قالب', items: [{ id: 'i1', type: 'yesno', label: 'س', weight: 10 }], passThreshold: 80 }],
    assets: [{ id: 'a1', code: 'DB-01', name: 'تابلو', templateId: 't1' }],
    assignments: [],
    records: [{ id: 'r1', assetCode: 'DB-01', percent: 90, status: 'موفق', details: [] }],
    settings: { orgName: 'قدیمی', passThreshold: 75, managerPinHash: 'pin' },
  };
  const res = JSON.parse(api.doPost({ postData: { contents: JSON.stringify({ action: 'migrate.import_json', apiKey: 'dk_test_key_1234567890', payload: { data: legacy } }) } }).getContent());
  assert.equal(res.ok, true);
  assert.equal(res.migration.counts.assets, 1);
  assert.equal(res.migration.counts.records, 1);

  const client = createClient({ core, api, name: 'after-migration', seed: null });
  await client.reset();
  assert.equal(client.data.settings.orgName, 'قدیمی');
  assert.equal(client.data.settings.passThreshold, 75);
  assert.equal(client.data.records[0].percent, 90);
  assert.equal(core.buildPermissions(client.data.users[0]).isAdmin, true);
});

/* ===================================================================== دسته‌بندی و تنظیمات */

test('تغییر دسته‌بندی‌ها روی هر دو دستگاه همگرا می‌شود', async () => {
  const { A, B } = await scenario();
  A.update(d => { d.categories.push('ایمنی و آتش‌نشانی'); });
  await A.flush(); await B.flush();
  assert.deepEqual(B.data.categories, ['برق', 'مکانیک', 'ایمنی و آتش‌نشانی']);

  B.update(d => { d.categories = d.categories.filter(c => c !== 'مکانیک'); });
  await B.flush(); await A.flush();
  assert.deepEqual(A.data.categories, ['برق', 'ایمنی و آتش‌نشانی']);
  assert.deepEqual(B.data.categories, ['برق', 'ایمنی و آتش‌نشانی']);
});

test('تنظیمات سازمان همگام می‌شود ولی کلید API نه (مگر با اجازه صریح)', async () => {
  const { A, B } = await scenario();
  A.update(d => { d.settings.orgName = 'نام جدید'; d.settings.cloudApiKey = 'SECRET'; });
  await A.flush(); await B.flush();
  assert.equal(B.data.settings.orgName, 'نام جدید');
  assert.notEqual(B.data.settings.cloudApiKey, 'SECRET');
});

/* =====================================================================
   RBAC سمت سرور: تنزل نقش فوراً جلوی نوشتن‌های حساس را می‌گیرد، حتی اگر
   نشست (sessionToken) کاربر هنوز منقضی نشده باشد — چون نقش هر بار از ردیف
   زنده‌ی کاربر خوانده می‌شود، نه از خود توکن.
   ===================================================================== */
test('تنزل نقش یک ادمین روی سرور، فوراً جلوی نوشتن تنظیمات از همان نشست را می‌گیرد', async () => {
  const { api, env } = await bootServer();
  const seed = await seedServer(core, api);
  const A = createClient({ core, api, name: 'device-A', seed });
  await A.login('admin', 'h'); // توکن معتبر گرفته شد؛ هنوز منقضی نیست

  // یک ادمین دیگر (شبیه‌سازی از راه cloud_push مستقیم روی شیت) نقش u-admin را
  // به inspector تنزل می‌دهد — دقیقاً سناریوی «کاربری که دیگر ادمین نیست»
  const patchOut = api.doPost({ postData: { contents: JSON.stringify({
    action: 'cloud_push', apiKey: 'dk_test_key_1234567890',
    payload: { data: Object.assign({}, seed, { users: seed.users.map(u => u.id === 'u-admin' ? Object.assign({}, u, { role: 'inspector' }) : u) }) },
  }) } });
  assert.equal(JSON.parse(patchOut.getContent()).ok, true);

  A.update(d => { d.settings.orgName = 'دستکاری بعد از تنزل نقش'; });
  await A.flush();
  // نوشتن اعمال نشد (هنوز در صف مانده، چون سرور رد کرده و recordOp صدا نخورده)
  assert.equal(A.queue.length, 1, 'نوشتن باید رد شود و در صف بماند تا ورود دوباره');

  const B = createClient({ core, api, name: 'device-B-check', seed: null });
  await B.reset();
  assert.equal(B.data.settings.orgName, 'سازمان درکاو', 'تنظیمات نباید توسط ادمین تنزل‌یافته تغییر کرده باشد');
});
