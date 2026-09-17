// شبیه‌سازی چهار روال اصلی محصول از ابتدا تا انتها:
//   الف) تهیه‌ی چک‌لیست (ساخت قالب با آیتم/امضا/دوره و ذخیره در ابر)
//   ب) تعریف کاربران (ساخت کاربر، ورود، دسترسی‌ها، غیرفعال‌سازی)
//   ج) ثبت چک‌لیست (اجرا، امتیاز، زنجیره‌ی امضا تا تکمیل)
//   د) خروجی (فیلترهای سرور، نام‌گذاری فایل، مسیر ذخیره)
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, bootServer, installBrowserStubs, createClient } from './harness.mjs';

installBrowserStubs();
const core = loadCore('flows-test');
const KEY = 'dk_test_key_1234567890';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ADMIN = { id: 'u-admin', username: 'admin', name: 'مدیر سیستم', role: 'admin' };
const mkCred = async (pw) => core.makeCredential(pw, 2);

async function boot(api) {
  const at = Date.now();
  const cA = await mkCred('admin-pw-1');
  const data = {
    version: 4,
    users: [Object.assign({}, ADMIN, {
      active: true, pages: [], sessionVersion: 1, phone: '', nationalId: '',
      passwordHash: cA.passwordHash, salt: cA.salt, hashAlgo: cA.hashAlgo, iterations: cA.iterations, updatedAt: at,
    })],
    categories: ['مکانیک'], templates: [], assets: [], assignments: [], records: [],
    settings: { orgName: 'کارخانه', passThreshold: 80, signFlowMode: 'chain' },
    revision: 0, lastSyncAt: 0,
  };
  const res = JSON.parse(api.doPost({ postData: { contents: JSON.stringify({ action: 'cloud_push', apiKey: KEY, payload: { data } }) } }).getContent());
  assert.equal(res.ok, true, 'seed');
  return data;
}

test('روال الف — تهیه‌ی چک‌لیست: ساخت قالب کامل و ذخیره در ابر', async () => {
  const { api } = await bootServer();
  const seed = await boot(api);
  const dev = createClient({ core, api, name: 'device-admin', seed });
  const vA = await core.verifyCredential(seed.users[0], 'admin-pw-1');
  await dev.login('admin', vA.hash);

  // همان چیزی که ادیتور قالب می‌سازد (پیش‌نویس + آیتم‌ها + زیرسیستم‌ها)
  dev.update(d => {
    d.templates.push({
      id: 'tpl-pump', name: 'سرویس پمپ‌ها', category: 'مکانیک', passThreshold: 75,
      signers: 2, period: 'quarterly', archived: false,
      items: [
        { id: 'i1', type: 'yesno', label: 'نشتی روغن ندارد؟', weight: 40, critical: true },
        { id: 'i2', type: 'checkbox', label: 'پیچ‌های پایه آچارکشی شده', weight: 20, critical: false },
        { id: 'i3', type: 'rating', label: 'صدای بلبرینگ', weight: 20, critical: false, scaleMax: 5 },
        { id: 'i4', type: 'select', label: 'وضعیت کوپلینگ', weight: 20, critical: false, options: ['سالم', 'فرسوده'], correctValue: 'سالم' },
        { id: 'i5', type: 'numeric', label: 'دمای یاتاقان', weight: 0, critical: false },
        { id: 'i6', type: 'text', label: 'توضیحات', weight: 0, critical: false },
      ],
      updatedAt: Date.now(),
    });
    ['P-01', 'P-02', 'P-03'].forEach((code, i) => {
      d.assets.push({ id: 'p' + (i + 1), code, name: 'پمپ ' + code, location: 'موتورخانه', serial: '', templateId: 'tpl-pump', category: 'مکانیک' });
    });
  });
  const res = await dev.flush();
  assert.ok(!res.error, res.error && res.error.message);
  await sleep(5);

  // دستگاه دوم (بازرس) همان قالب را از ابر می‌گیرد
  const dev2 = createClient({ core, api, name: 'device-inspector', seed: JSON.parse(JSON.stringify(seed)) });
  await dev2.flush();
  const tpl = dev2.data.templates.find(t => t.id === 'tpl-pump');
  assert.ok(tpl, 'قالب باید از ابر برسد');
  assert.equal(tpl.signers, 2);
  assert.equal(core.resolveTemplatePeriod(tpl), 'quarterly');
  assert.equal(tpl.items.length, 6, 'آیتم‌ها از ستون JSON شیت برمی‌گردند');
  assert.equal(dev2.data.assets.filter(a => a.templateId === 'tpl-pump').length, 3, 'زیرسیستم‌ها متصل‌اند');
  // امتیازدهی روی همین قالب: آیتم اطلاعاتی (عددی/متنی) در مخرج نمی‌آید
  const score = core.scoreRecord(tpl, { i1: 'بله', i2: true, i3: 5, i4: 'سالم', i5: '65', i6: 'ok' });
  assert.equal(score.percent, 100);
  const score2 = core.scoreRecord(tpl, { i1: 'خیر', i2: true, i3: 5, i4: 'سالم' });
  assert.equal(score2.criticalFail, true, 'رد آیتم حیاتی');
});

test('روال ب — تعریف کاربران: ساخت، ورود، دسترسی و غیرفعال‌سازی', async () => {
  const { api } = await bootServer();
  const seed = await boot(api);
  const admin = createClient({ core, api, name: 'device-admin', seed });
  const vA = await core.verifyCredential(seed.users[0], 'admin-pw-1');
  await admin.login('admin', vA.hash);

  const credInsp = await mkCred('sara-pw-2');
  const credAppr = await mkCred('hamid-pw-3');
  const credView = await mkCred('negah-pw-4');
  const mkUser = (u, c, pages) => Object.assign({}, u, {
    active: true, pages, sessionVersion: 1, phone: '0912', nationalId: '',
    passwordHash: c.passwordHash, salt: c.salt, hashAlgo: c.hashAlgo, iterations: c.iterations,
    updatedAt: Date.now(),
  });
  const SARA = mkUser({ id: 'u-sara', username: 'sara', name: 'سرا احمدی', role: 'inspector' }, credInsp, ['dashboard', 'runner', 'records', 'coverage']);
  const HAMID = mkUser({ id: 'u-hamid', username: 'hamid', name: 'حمید رضایی', role: 'approver' }, credAppr, []);
  const NEGAR = mkUser({ id: 'u-negar', username: 'negar', name: 'نگار دیدبان', role: 'viewer' }, credView, []);

  admin.update(d => { d.users.push(SARA, HAMID, NEGAR); });
  const r = await admin.flush();
  assert.ok(!r.error, r.error && r.error.message);
  await sleep(5);

  // ورود هر سه کاربر با هش سمت کلاینت
  const c1 = createClient({ core, api, name: 'device-sara', seed: JSON.parse(JSON.stringify(seed)) });
  const v1 = await core.verifyCredential(SARA, 'sara-pw-2');
  const l1 = await c1.login('sara', v1.hash);
  assert.ok(l1.sessionToken, 'بازرس وارد می‌شود');

  const c2 = createClient({ core, api, name: 'device-hamid', seed: JSON.parse(JSON.stringify(seed)) });
  const v2 = await core.verifyCredential(HAMID, 'hamid-pw-3');
  assert.ok((await c2.login('hamid', v2.hash)).sessionToken, 'تأییدکننده وارد می‌شود');

  const c3 = createClient({ core, api, name: 'device-negar', seed: JSON.parse(JSON.stringify(seed)) });
  const v3 = await core.verifyCredential(NEGAR, 'negah-pw-4');
  assert.ok((await c3.login('negar', v3.hash)).sessionToken, 'مشاهده‌گر وارد می‌شود');

  // رمز اشتباه رد می‌شود
  const vBad = await core.verifyCredential(SARA, 'wrong-pass');
  assert.equal(vBad.ok, false);
  await assert.rejects(async () => c1.login('sara', vBad.hash || 'x'), /اشتباه/);

  // دسترسی مؤثر هر نقش
  const pagesSara = core.effectivePages(SARA);
  assert.ok(pagesSara.includes('runner') && pagesSara.includes('coverage'), 'بازرس: اجرا + پوشش');
  assert.ok(!pagesSara.includes('users') && !pagesSara.includes('settings'), 'صفحه‌ی حساس به بازرس نمی‌رسد');
  const pagesNegar = core.effectivePages(NEGAR);
  assert.ok(!pagesNegar.includes('runner'), 'مشاهده‌گر اصلاً صفحه‌ی اجرا ندارد');
  const pagesAdmin = core.effectivePages(seed.users[0]);
  assert.ok(pagesAdmin.includes('users') && pagesAdmin.includes('settings'), 'ادمین همه را دارد');

  // غیرفعال‌سازی: ورود کاربر غیرفعال باید رد شود
  admin.update(d => {
    const idx = d.users.findIndex(u => u.id === 'u-sara');
    d.users[idx].active = false;
    d.users[idx].updatedAt = Date.now();
  });
  await admin.flush();
  await sleep(5);
  const c4 = createClient({ core, api, name: 'device-sara-2', seed: JSON.parse(JSON.stringify(seed)) });
  const v1b = await core.verifyCredential(SARA, 'sara-pw-2');
  await assert.rejects(async () => c4.login('sara', v1b.hash), /اشتباه|غیرفعال/);
});

test('روال ج — ثبت چک‌لیست: اجرا تا تکمیل زنجیره‌ی امضا', async () => {
  const { api } = await bootServer();
  const seed = await boot(api);
  const admin = createClient({ core, api, name: 'device-admin', seed });
  const vA = await core.verifyCredential(seed.users[0], 'admin-pw-1');
  await admin.login('admin', vA.hash);

  const credInsp = await mkCred('sara-pw-2');
  const credAppr = await mkCred('hamid-pw-3');
  const SARA = { id: 'u-sara', username: 'sara', name: 'سرا احمدی', role: 'inspector', active: true, pages: [], sessionVersion: 1, phone: '', nationalId: '', ...credInsp, updatedAt: Date.now() };
  const HAMID = { id: 'u-hamid', username: 'hamid', name: 'حمید رضایی', role: 'approver', active: true, pages: [], sessionVersion: 1, phone: '', nationalId: '', ...credAppr, updatedAt: Date.now() };
  admin.update(d => {
    d.users.push(SARA, HAMID);
    d.templates.push({
      id: 'tpl-b', name: 'بازرسی تابلو', category: 'مکانیک', passThreshold: 80, signers: 2, period: 'monthly', archived: false,
      items: [{ id: 'i1', type: 'yesno', label: 'ارت', weight: 60, critical: true }, { id: 'i2', type: 'checkbox', label: 'درب', weight: 40, critical: false }],
      updatedAt: Date.now(),
    });
    d.assets.push({ id: 'a-b1', code: 'DB-77', name: 'تابلو ۷۷', location: 'سالن ۲', serial: '', templateId: 'tpl-b', category: 'مکانیک' });
  });
  await admin.flush();
  await sleep(5);

  const sara = createClient({ core, api, name: 'device-sara', seed: JSON.parse(JSON.stringify(seed)) });
  const hamid = createClient({ core, api, name: 'device-hamid', seed: JSON.parse(JSON.stringify(seed)) });
  await sara.login('sara', (await core.verifyCredential(SARA, 'sara-pw-2')).hash);
  await hamid.login('hamid', (await core.verifyCredential(HAMID, 'hamid-pw-3')).hash);
  await sara.flush(); await hamid.flush();

  const tpl = sara.data.templates.find(t => t.id === 'tpl-b');
  const asset = sara.data.assets.find(a => a.id === 'a-b1');
  // ۱) اجرا و ثبت توسط بازرس (همان ساختار رکوردِ صفحه‌ی اجرا)
  const result = core.scoreRecord(tpl, { i1: 'بله', i2: true });
  const now = new Date();
  const slots = core.signSlotsForCount(core.templateSignerCount(tpl, sara.data.settings));
  assert.deepEqual(slots, ['approver'], 'چک‌لیست دو امضا: فقط شیار ناظر بعد از بازرس');
  const signRequest = core.makeSignChain({
    steps: [{ toUser: HAMID, slot: 'approver', note: 'تحویل شیفت' }],
    byUser: SARA,
  });
  const rec = {
    id: 'rec-flow-c', assetId: asset.id, assetCode: asset.code, assetName: asset.name, assetTitle: asset.name,
    location: asset.location, templateId: tpl.id, templateName: tpl.name, category: tpl.category,
    inspectorId: SARA.id, inspectorName: SARA.name, signRequest,
    date: core.gregorianToJalaliStr(now) + ' - 11:00', dateJalali: core.gregorianToJalaliStr(now),
    startedAt: now.toISOString(), completedAt: now.toISOString(), dueDate: '',
    answers: { i1: 'بله', i2: true }, details: result.details, percent: result.percent, status: result.status,
    criticalFail: false, score: result.earned, maxScore: result.totalWeight, notes: 'همه‌چیز مرتب بود',
    signatures: { inspector: { image: 'data:image/png;base64,SARA', name: SARA.name, title: '' } },
    signerCount: 2, assignmentId: null, createdAt: now.getTime(), updatedAt: now.getTime(),
  };
  assert.equal(rec.percent, 100);
  sara.update(d => { d.records.unshift(rec); });
  await sara.flush();
  await sleep(5);
  await hamid.flush();

  // ۲) برگه در صف امضای ناظر ظاهر می‌شود
  const hamidRec = hamid.data.records.find(x => x.id === 'rec-flow-c');
  assert.ok(hamidRec, 'رکورد به دستگاه ناظر رسیده');
  const q = core.buildSignQueue(hamid.data.records, HAMID, core.buildPermissions(HAMID));
  assert.equal(q.toSign.length, 1, 'یک برگه در صف ناظر');

  // ۳) امضای ناظر → زنجیره کامل
  const signed = core.applySignatureToRecord(hamidRec, { image: 'data:image/png;base64,HAMID', name: HAMID.name }, HAMID, Date.now());
  assert.ok(signed.signatures.approver, 'امضای ناظر نشست');
  assert.equal(core.activeSignStep(signed.signRequest), null, 'زنجیره کامل شد');
  hamid.update(d => {
    const idx = d.records.findIndex(x => x.id === 'rec-flow-c');
    d.records[idx] = signed;
  });
  await hamid.flush();
  await sleep(5);
  await sara.flush();
  const finalRec = sara.data.records.find(x => x.id === 'rec-flow-c');
  assert.ok(finalRec.signatures.approver, 'بازرس هم امضای ناظر را می‌بیند');

  // ۴) پوشش: این زیرسیستم در دوره‌ی جاری انجام شده است
  const cov = core.templateCoverage(tpl, sara.data.assets, sara.data.records, new Date());
  assert.equal(cov.done.length, 1);
  assert.equal(cov.pending.length, 0);
});

test('روال د — خروجی: فیلترهای سرور، نام فایل و ساختار پوشه‌ها', async () => {
  const { api, env } = await bootServer();
  const seed = await boot(api);
  const dev = createClient({ core, api, name: 'device-admin', seed });
  await dev.login('admin', (await core.verifyCredential(seed.users[0], 'admin-pw-1')).hash);

  const at = Date.now();
  const mkRec = (id, over) => Object.assign({
    id, assetId: 'a1', assetCode: 'DB-01', assetName: 'تابلو', templateId: 'tpl-b', templateName: 'بازرسی تابلو',
    category: 'مکانیک', inspectorId: 'u-sara', inspectorName: 'سرا احمدی',
    dateJalali: core.gregorianToJalaliStr(new Date(at)), completedAt: new Date(at).toISOString(),
    percent: 90, score: 90, maxScore: 100, status: 'موفق', criticalFail: false, notes: '', details: [],
    createdAt: at, updatedAt: at,
  }, over);
  dev.update(d => {
    d.records.push(
      mkRec('r1'),
      mkRec('r2', { assetId: 'a2', assetCode: 'DB-02', templateId: 'tpl-c', templateName: 'قالب دیگر', status: 'ناموفق (حیاتی)', percent: 30, criticalFail: true, completedAt: new Date(at - 40 * 86400000).toISOString(), updatedAt: at - 40 * 86400000 }),
      mkRec('r3', { assetId: 'a3', assetCode: 'DB-03', percent: 85 }),
    );
  });
  await dev.flush();
  await sleep(5);

  // فیلتر قالب
  const byTpl = dev.call('records.list', { filter: { templateId: 'tpl-b' }, light: true });
  assert.equal(byTpl.total, 2, 'فقط رکوردهای همین قالب');
  // فیلتر وضعیت
  const byStatus = dev.call('records.list', { filter: { status: 'ناموفق (حیاتی)' }, light: true });
  assert.equal(byStatus.total, 1);
  assert.equal(byStatus.records[0].id, 'r2');
  // فیلتر تجهیز + بازه‌ی زمانی
  const byAsset = dev.call('records.list', { filter: { assetId: 'a1', from: new Date(at - 86400000).toISOString().slice(0, 10) }, light: true });
  assert.equal(byAsset.total, 1);
  // صفحه‌بندی
  const page = dev.call('records.list', { filter: {}, light: true, limit: 2, offset: 0 });
  assert.equal(page.records.length, 2);
  assert.equal(page.total, 3);

  // مسیر ذخیره در درایو (شبیه‌ساز): پوشه‌ی سال/ماه/دسته + نام‌گذاری درست
  // مثل کلاینت واقعی: folderName در سطح پاکت (نه داخل payload) قرار می‌گیرد
  const save = JSON.parse(api.doPost({ postData: { contents: JSON.stringify({
    action: 'save_record', apiKey: KEY,
    folderName: 'کارخانه - سامانه چک‌لیست درکاو',
    payload: {
      pdfBase64: 'JVBERi0xLjQK' + 'A'.repeat(300),
      record: mkRec('rec-abcdef123456', { assetCode: 'DB-01' }),
    },
  }) } }).getContent());
  assert.equal(save.ok, true, JSON.stringify(save));
  assert.ok(save.pdfUrl, 'لینک فایل برمی‌گردد');
  const name = save.fileName;
  assert.ok(name.endsWith('.pdf'), 'فایل PDF ذخیره شده');
  assert.ok(name.endsWith('f123456'.slice(-6) + '.pdf') || name.includes('123456'.slice(-6)), '۶ رقم آخر شناسه در نام فایل: ' + name);
  assert.ok(name.includes('DB-01'), 'کد تجهیز در نام فایل: ' + name);
  assert.ok(/^\d{4}-\d{2}-\d{2}_/.test(name), 'تاریخ شمسی در ابتدای نام: ' + name);
  const root = env.__drive.root;
  const yearFolders = root.getFoldersByName('کارخانه - سامانه چک‌لیست درکاو');
  assert.ok(yearFolders.hasNext(), 'پوشه‌ی ریشه ساخته شده');
});
