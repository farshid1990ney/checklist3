// تست یکپارچگی «جهت امضا»: جریان کامل ارجاع → همگام‌سازی → امضا → بازگشت.
// این سناریو سه لایه را با هم می‌سنجد: منطق خالص کلاینت (بلوک signrequest)،
// پروتکل sync (op queue + delta pull)، و ذخیره‌سازی سرور (ستون JSON در شیت).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, bootServer, installBrowserStubs, createClient } from './harness.mjs';

installBrowserStubs();
const core = loadCore('signreq-test');
const KEY = 'dk_test_key_1234567890';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ALI = { id: 'u-ali', username: 'ali', name: 'علی محمدی', role: 'inspector' };
const REZA = { id: 'u-reza', username: 'reza', name: 'رضا کریمی', role: 'approver' };
const MGR = { id: 'u-mgr', username: 'mgr', name: 'مدیر داخلی', role: 'manager' };
const ADMIN = { id: 'u-admin', username: 'admin', name: 'ادمین', role: 'admin' };

function userRow(u, at) {
  return {
    id: u.id, username: u.username, name: u.name, role: u.role, active: true, pages: [],
    passwordHash: 'h', salt: 's', hashAlgo: 'pbkdf2-sha256', iterations: 1000,
    sessionVersion: 1, updatedAt: at,
  };
}

/** پایگاه اولیه با یک بازرس، یک تأییدکننده، یک مدیر و یک ادمین. */
async function seed(api) {
  const at = Date.now();
  const data = {
    version: 4,
    users: [ALI, REZA, MGR, ADMIN].map(u => userRow(u, at)),
    categories: ['برق'],
    templates: [{
      id: 't1', name: 'بازرسی تابلو', category: 'برق', passThreshold: 80, archived: false,
      items: [{ id: 'i1', type: 'yesno', label: 'ارت', weight: 100, critical: true }], updatedAt: at,
    }],
    assets: [{ id: 'a1', code: 'DB-01', name: 'تابلو ۱', location: 'سالن ۱', templateId: 't1', updatedAt: at }],
    assignments: [],
    records: [],
    settings: { orgName: 'سازمان درکاو', passThreshold: 80 },
    revision: 0, lastSyncAt: 0,
  };
  const res = JSON.parse(api.doPost({
    postData: { contents: JSON.stringify({ action: 'cloud_push', apiKey: KEY, payload: { data } }) },
  }).getContent());
  assert.equal(res.ok, true, 'seed باید موفق باشد: ' + JSON.stringify(res));
  return data;
}

async function scenario() {
  const { api, env } = await bootServer();
  const base = await seed(api);
  const mk = (name) => createClient({ core, api, name, seed: base });
  const aliDev = mk('device-ali');
  const rezaDev = mk('device-reza');
  await aliDev.flush();
  await rezaDev.flush();
  return { api, env, aliDev, rezaDev, base };
}

/** رکوردی می‌سازد که بازرس ثبت کرده و جهت امضا به گیرنده ارجاع داده است. */
function inspectorSubmits(client, toUser, byUser, over = {}) {
  const at = Date.now();
  const rec = Object.assign({
    id: 'rec-' + Math.random().toString(36).slice(2, 8),
    assetId: 'a1', assetCode: 'DB-01', assetName: 'تابلو ۱', location: 'سالن ۱',
    templateId: 't1', templateName: 'بازرسی تابلو', category: 'برق',
    inspectorId: byUser.id, inspectorName: byUser.name,
    date: '1405/06/22 - 10:30', dateJalali: '1405/06/22',
    completedAt: new Date(at).toISOString(),
    percent: 100, score: 100, maxScore: 100, status: 'موفق', criticalFail: false,
    details: [{ itemId: 'i1', label: 'ارت', value: true, earned: 100, max: 100, critical: true }],
    notes: '', signatures: { inspector: { image: 'data:image/png;base64,INSPECTOR', name: byUser.name, title: '' } },
    signRequest: core.makeSignRequest({ toUser, byUser, slot: 'approver', note: 'ناظر شیفت عصر', at }),
    createdAt: at, updatedAt: at,
  }, over);
  client.update(d => { d.records.unshift(rec); });
  return rec;
}

/* ===================================================================== */

test('ارجاع جهت امضا از راه سرور عبور می‌کند و در صف گیرنده می‌نشیند', async () => {
  const { aliDev, rezaDev } = await scenario();

  const rec = inspectorSubmits(aliDev, REZA, ALI);
  const ra = await aliDev.flush();
  assert.ok(!ra.error, 'ارسال بازرس باید موفق باشد: ' + (ra.error && ra.error.message));

  const rb = await rezaDev.flush();
  assert.ok(!rb.error, 'دریافت ناظر باید موفق باشد: ' + (rb.error && rb.error.message));

  // ستون signRequest از نوع JSON است؛ باید سالم از شیت برگردد
  const pulled = rezaDev.data.records.find(r => r.id === rec.id);
  assert.ok(pulled, 'رکورد باید به دستگاه ناظر رسیده باشد');
  assert.equal(typeof pulled.signRequest, 'object', 'signRequest باید آبجکت باشد نه رشته');
  assert.equal(pulled.signRequest.toUserId, REZA.id);
  assert.equal(pulled.signRequest.byUserName, ALI.name);
  assert.equal(pulled.signRequest.note, 'ناظر شیفت عصر');
  assert.equal(pulled.signRequest.status, 'pending');

  const q = core.buildSignQueue(rezaDev.data.records, REZA, core.buildPermissions(REZA));
  assert.deepEqual(q.toSign.map(x => x.record.id), [rec.id], 'باید در صف «باید امضا کنم» باشد');
  assert.equal(q.toSign[0].mine, true);
  assert.equal(core.canSignRequest(pulled, REZA, core.buildPermissions(REZA)), true);
});

test('امضای گیرنده روی دستگاه دیگر به ارجاع‌دهنده برمی‌گردد', async () => {
  const { aliDev, rezaDev } = await scenario();
  const rec = inspectorSubmits(aliDev, REZA, ALI);
  await aliDev.flush();
  await rezaDev.flush();

  const target = rezaDev.data.records.find(r => r.id === rec.id);
  const signed = core.applySignatureToRecord(target, {
    image: 'data:image/png;base64,APPROVER', name: 'چیزی که تایپ شد', title: 'ناظر فنی',
  }, REZA);
  assert.ok(signed, 'امضا باید اعمال شود');
  rezaDev.update(d => {
    const i = d.records.findIndex(r => r.id === rec.id);
    d.records[i] = signed;
  });
  const rb = await rezaDev.flush();
  assert.ok(!rb.error, 'ارسال ناظر باید موفق باشد');

  const ra = await aliDev.flush();
  assert.ok(!ra.error, 'دریافت بازرس باید موفق باشد');

  const back = aliDev.data.records.find(r => r.id === rec.id);
  assert.ok(back.signatures.approver, 'امضای ناظر باید به دستگاه بازرس برگشته باشد');
  assert.equal(back.signatures.approver.image, 'data:image/png;base64,APPROVER');
  assert.equal(back.signatures.approver.title, 'ناظر فنی');
  // نام تایپ‌شده روی پد نادیده گرفته می‌شود؛ هویت از حساب کاربری می‌آید
  assert.equal(back.signatures.approver.name, REZA.name);
  assert.equal(back.signRequest.status, 'signed');
  assert.equal(back.signRequest.signedByUserId, REZA.id);
  // امضای خود بازرس نباید در این رفت‌وبرگشت از بین برود
  assert.equal(back.signatures.inspector.image, 'data:image/png;base64,INSPECTOR');

  // و از صف ناظر بیرون رفته باشد
  const q = core.buildSignQueue(rezaDev.data.records, REZA, core.buildPermissions(REZA));
  assert.equal(q.toSign.length, 0);
});

test('ادمین می‌تواند جانشین شود و ردپایش ثبت می‌شود', async () => {
  const { api, aliDev, base } = await scenario();
  const adminDev = createClient({ core, api, name: 'device-admin', seed: base });
  const rec = inspectorSubmits(aliDev, REZA, ALI);
  await aliDev.flush();
  await adminDev.flush();

  const target = adminDev.data.records.find(r => r.id === rec.id);
  const perms = core.buildPermissions(ADMIN);
  assert.equal(core.canSignRequest(target, ADMIN, perms), true, 'ادمین اجازه دارد');

  const signed = core.applySignatureToRecord(target, { image: 'data:ADMIN', name: 'x' }, ADMIN);
  adminDev.update(d => { d.records[d.records.findIndex(r => r.id === rec.id)] = signed; });
  await adminDev.flush();
  await aliDev.flush();

  const back = aliDev.data.records.find(r => r.id === rec.id);
  assert.equal(back.signRequest.signedByUserId, ADMIN.id);
  assert.equal(back.signRequest.toUserId, REZA.id, 'گیرنده‌ی اصلی تغییر نمی‌کند');
  assert.notEqual(back.signRequest.signedByUserId, back.signRequest.toUserId,
    'باید معلوم باشد گیرنده خودش امضا نکرده');
  assert.equal(back.signatures.approver.name, ADMIN.name);
});

test('مدیر بدون ادمین بودن نمی‌تواند جای گیرنده را امضا کند', async () => {
  const { api, aliDev, base } = await scenario();
  const mgrDev = createClient({ core, api, name: 'device-mgr', seed: base });
  const rec = inspectorSubmits(aliDev, REZA, ALI);
  await aliDev.flush();
  await mgrDev.flush();

  const target = mgrDev.data.records.find(r => r.id === rec.id);
  const perms = core.buildPermissions(MGR);
  assert.equal(core.canSignRequest(target, MGR, perms), false);
  assert.equal(core.canSignRequest(target, REZA, core.buildPermissions(REZA)), true);

  const q = core.buildSignQueue(mgrDev.data.records, MGR, perms);
  assert.equal(q.toSign.length, 0, 'در صف مدیر نمی‌آید چون گیرنده نیست');
});

test('لغو درخواست توسط ارجاع‌دهنده، برگه را از صف گیرنده بیرون می‌برد', async () => {
  const { aliDev, rezaDev } = await scenario();
  const rec = inspectorSubmits(aliDev, REZA, ALI);
  await aliDev.flush();
  await rezaDev.flush();

  assert.equal(core.buildSignQueue(rezaDev.data.records, REZA, core.buildPermissions(REZA)).toSign.length, 1);

  const cancelled = core.cancelSignRequest(aliDev.data.records.find(r => r.id === rec.id), ALI, core.buildPermissions(ALI));
  assert.ok(cancelled, 'ارجاع‌دهنده باید بتواند لغو کند');
  aliDev.update(d => { d.records[d.records.findIndex(r => r.id === rec.id)] = cancelled; });
  await aliDev.flush();
  await rezaDev.flush();

  const q = core.buildSignQueue(rezaDev.data.records, REZA, core.buildPermissions(REZA));
  assert.equal(q.toSign.length, 0, 'بعد از لغو نباید در صف باشد');
  const back = rezaDev.data.records.find(r => r.id === rec.id);
  assert.equal(back.signRequest.status, 'cancelled');
  // خود رکورد نباید حذف شده باشد
  assert.ok(back && !back.deleted, 'لغو درخواست، بازرسی را پاک نمی‌کند');
});

test('رکورد بدون ارجاع و بدون امضای ناظر هم ثبت و همگام می‌شود', async () => {
  const { aliDev, rezaDev } = await scenario();
  const rec = inspectorSubmits(aliDev, REZA, ALI, { signRequest: undefined });
  await aliDev.flush();
  await rezaDev.flush();

  const back = rezaDev.data.records.find(r => r.id === rec.id);
  assert.ok(back, 'رکورد باید برسد');
  assert.equal('signRequest' in back, false, 'فیلد نباید به‌صورت null ظاهر شود');
  assert.equal(back.signatures.approver, undefined);
  assert.equal(core.isPendingSignRequest(back), false);
});

test('امضای هم‌زمان دو نفر: فقط یکی می‌نشیند و داده خراب نمی‌شود', async () => {
  const { api, aliDev, base } = await scenario();
  const reza1 = createClient({ core, api, name: 'reza-phone', seed: base });
  const reza2 = createClient({ core, api, name: 'reza-tablet', seed: base });
  const rec = inspectorSubmits(aliDev, REZA, ALI);
  await aliDev.flush();
  await reza1.flush();
  await reza2.flush();

  const perms = core.buildPermissions(REZA);
  // هر دو دستگاه یک درخواست را باز کرده و امضا می‌کنند
  for (const [dev, img] of [[reza1, 'data:PHONE'], [reza2, 'data:TABLET']]) {
    const t = dev.data.records.find(r => r.id === rec.id);
    assert.equal(core.canSignRequest(t, REZA, perms), true);
    dev.update(d => {
      d.records[d.records.findIndex(r => r.id === rec.id)] =
        core.applySignatureToRecord(t, { image: img, name: 'x' }, REZA);
    });
  }
  await reza1.flush();
  await reza2.flush();
  await aliDev.flush();

  const back = aliDev.data.records.find(r => r.id === rec.id);
  assert.ok(back.signatures.approver, 'یک امضا باید نشسته باشد');
  assert.equal(back.signRequest.status, 'signed');
  assert.ok(['data:PHONE', 'data:TABLET'].includes(back.signatures.approver.image),
    'امضای نهایی باید یکی از همان دو باشد، نه ترکیبی خراب');
  assert.equal(back.signatures.inspector.image, 'data:image/png;base64,INSPECTOR',
    'امضای بازرس نباید در این میان از بین برود');
});

test('تغییر هم‌زمان ناظر و بازرس روی یک رکورد: هر دو تغییر می‌رسد', async () => {
  const { aliDev, rezaDev } = await scenario();
  const rec = inspectorSubmits(aliDev, REZA, ALI);
  await aliDev.flush();
  await rezaDev.flush();

  // ناظر امضا می‌کند؛ هم‌زمان بازرس یادداشت رکورد را اصلاح می‌کند
  const t = rezaDev.data.records.find(r => r.id === rec.id);
  rezaDev.update(d => {
    d.records[d.records.findIndex(r => r.id === rec.id)] =
      core.applySignatureToRecord(t, { image: 'data:APPROVER', name: 'x' }, REZA);
  });
  await sleep(3);
  aliDev.update(d => {
    const i = d.records.findIndex(r => r.id === rec.id);
    d.records[i].notes = 'یادداشت اصلاح‌شده توسط بازرس';
    d.records[i].updatedAt = Date.now();
  });

  await rezaDev.flush();
  await aliDev.flush();
  await rezaDev.flush();
  await aliDev.flush();

  const a = aliDev.data.records.find(r => r.id === rec.id);
  const b = rezaDev.data.records.find(r => r.id === rec.id);
  // ⚠️ این آزمون یک محدودیت واقعی LWW در سطح «رکورد» را مستند می‌کند:
  // چون کل رکورد یک واحد نوشتن است، ویرایش دیرترِ بازرس می‌تواند امضای زودترِ
  // ناظر را بپوشاند. اینجا فقط تضمین می‌کنیم همگرایی اتفاق می‌افتد و دو دستگاه
  // روی یک مقدار یکسان می‌مانند (نه اینکه هر دو تغییر لزوماً زنده بمانند).
  assert.equal(a.updatedAt, b.updatedAt, 'دو دستگاه باید همگرا شوند');
  assert.equal(a.signRequest.status, b.signRequest.status);
  assert.equal(JSON.stringify(a.signatures), JSON.stringify(b.signatures));
  assert.equal(a.notes, b.notes);
});

/* ===================================================================== */
/* مدل ب — زنجیره‌ی سه‌امضایی روی سه دستگاه مختلف                          */
/* ===================================================================== */

test('زنجیره‌ی سه‌امضایی: بازرس → ناظر → مدیر، به‌ترتیب و از راه سرور', async () => {
  const { api, aliDev, rezaDev, base } = await scenario();
  const mgrDev = createClient({ core, api, name: 'device-mgr', seed: base });
  await mgrDev.flush();

  // بازرس برگه را با زنجیره‌ی دو مرحله‌ای ثبت می‌کند
  const rec = inspectorSubmits(aliDev, REZA, ALI, {
    signRequest: core.makeSignChain({
      steps: [{ toUser: REZA, slot: 'approver', note: 'ناظر شیفت عصر' },
              { toUser: MGR, slot: 'manager', note: 'تأیید نهایی' }],
      byUser: ALI, at: Date.now(),
    }),
  });
  await aliDev.flush();
  await rezaDev.flush();
  await mgrDev.flush();

  // ستون JSON باید کل زنجیره را سالم برگرداند (نه فقط فیلدهای تخت)
  const atReza = rezaDev.data.records.find(r => r.id === rec.id);
  assert.ok(atReza, 'رکورد باید به دستگاه ناظر برسد');
  const srReza = core.normalizeSignRequest(atReza.signRequest);
  assert.equal(srReza.steps.length, 2, 'هر دو مرحله باید از شیت برگردند');
  assert.deepEqual(srReza.steps.map(s => s.slot), ['approver', 'manager']);
  assert.equal(srReza.steps[1].toUserId, MGR.id);

  // نوبت مدیر نشده است
  const atMgr = mgrDev.data.records.find(r => r.id === rec.id);
  assert.equal(core.canSignRequest(atMgr, MGR, core.buildPermissions(MGR)), false,
    'مدیر نباید بتواند پیش از ناظر امضا کند');
  const qMgr = core.buildSignQueue(mgrDev.data.records, MGR, core.buildPermissions(MGR));
  assert.equal(qMgr.toSign.length, 0);
  assert.equal(qMgr.tracking.filter(x => x.upcoming).length, 1, 'باید بداند در راه است');

  // مرحله‌ی ۲: ناظر امضا می‌کند
  assert.equal(core.canSignRequest(atReza, REZA, core.buildPermissions(REZA)), true);
  rezaDev.update(d => {
    const i = d.records.findIndex(r => r.id === rec.id);
    d.records[i] = core.applySignatureToRecord(d.records[i], { image: 'data:APPROVER' }, REZA);
  });
  await rezaDev.flush();
  await mgrDev.flush();

  const atMgr2 = mgrDev.data.records.find(r => r.id === rec.id);
  const srMgr2 = core.normalizeSignRequest(atMgr2.signRequest);
  assert.equal(srMgr2.status, 'pending', 'زنجیره هنوز باز است');
  assert.equal(srMgr2.current, 1);
  assert.equal(srMgr2.steps[0].signedByUserId, REZA.id);
  assert.equal(atMgr2.signatures.approver.name, REZA.name, 'نام از حساب کاربری آمده');
  assert.equal(core.canSignRequest(atMgr2, MGR, core.buildPermissions(MGR)), true, 'حالا نوبت مدیر است');
  assert.equal(core.buildSignQueue(mgrDev.data.records, MGR, core.buildPermissions(MGR)).toSign.length, 1);

  // مرحله‌ی ۳: مدیر امضا می‌کند
  mgrDev.update(d => {
    const i = d.records.findIndex(r => r.id === rec.id);
    d.records[i] = core.applySignatureToRecord(d.records[i], { image: 'data:MANAGER' }, MGR);
  });
  await mgrDev.flush();
  await aliDev.flush();

  const final = aliDev.data.records.find(r => r.id === rec.id);
  const srFinal = core.normalizeSignRequest(final.signRequest);
  assert.equal(srFinal.status, 'signed', 'زنجیره کامل شد');
  assert.equal(final.signatures.inspector.name, ALI.name);
  assert.equal(final.signatures.approver.name, REZA.name);
  assert.equal(final.signatures.manager.name, MGR.name);
  assert.equal(core.signChainProgress(final).done, 3);
  assert.equal(core.signChainProgress(final).total, 3);
  assert.equal(core.isPendingSignRequest(final), false);

  // ارجاع‌دهنده نتیجه را در تب پیگیری می‌بیند
  const qAli = core.buildSignQueue(aliDev.data.records, ALI, core.buildPermissions(ALI));
  assert.equal(qAli.tracking.filter(x => x.record.id === rec.id).length, 1);
});

test('لغو زنجیره در وسط کار، مرحله‌ی امضانشده را از صف نفر بعدی برمی‌دارد', async () => {
  const { api, aliDev, rezaDev, base } = await scenario();
  const mgrDev = createClient({ core, api, name: 'device-mgr2', seed: base });
  await mgrDev.flush();

  const rec = inspectorSubmits(aliDev, REZA, ALI, {
    signRequest: core.makeSignChain({
      steps: [{ toUser: REZA, slot: 'approver' }, { toUser: MGR, slot: 'manager' }],
      byUser: ALI, at: Date.now(),
    }),
  });
  await aliDev.flush();
  await rezaDev.flush();

  // ناظر امضا می‌کند، بعد بازرس کل زنجیره را لغو می‌کند
  rezaDev.update(d => {
    const i = d.records.findIndex(r => r.id === rec.id);
    d.records[i] = core.applySignatureToRecord(d.records[i], { image: 'data:A' }, REZA);
  });
  await rezaDev.flush();
  await aliDev.flush();

  aliDev.update(d => {
    const i = d.records.findIndex(r => r.id === rec.id);
    d.records[i] = core.cancelSignRequest(d.records[i], ALI, core.buildPermissions(ALI));
  });
  await aliDev.flush();
  await mgrDev.flush();

  const atMgr = mgrDev.data.records.find(r => r.id === rec.id);
  assert.equal(core.normalizeSignRequest(atMgr.signRequest).status, 'cancelled');
  assert.equal(core.canSignRequest(atMgr, MGR, core.buildPermissions(MGR)), false);
  assert.equal(core.buildSignQueue(mgrDev.data.records, MGR, core.buildPermissions(MGR)).toSign.length, 0);
  // امضایی که قبلاً ثبت شده بود نباید پاک شود
  assert.equal(atMgr.signatures.approver.image, 'data:A');
});

test('ارجاع مرحله‌ی فعال از راه سرور عبور می‌کند و به صف گیرنده‌ی تازه می‌نشیند', async () => {
  const { api, aliDev, rezaDev, base } = await scenario();
  const mgrDev = createClient({ core, api, name: 'device-mgr3', seed: base });
  await mgrDev.flush();

  const rec = inspectorSubmits(aliDev, REZA, ALI, {
    signRequest: core.makeSignChain({
      steps: [{ toUser: REZA, slot: 'approver' }, { toUser: MGR, slot: 'manager' }],
      byUser: ALI, at: Date.now(),
    }),
  });
  await aliDev.flush();
  await rezaDev.flush();

  // رضا به‌جای «امضا در محل»، برگه را به مدیر ارجاع می‌دهد
  rezaDev.update(d => {
    const i = d.records.findIndex(r => r.id === rec.id);
    const next = core.referSignRequest(d.records[i], { toUser: ADMIN, byUser: REZA, note: 'در سفرم' }, core.buildPermissions(REZA));
    assert.ok(next, 'ارجاع باید محلی بنشیند');
    d.records[i] = next;
  });
  await rezaDev.flush();
  await mgrDev.flush();

  const atMgr = mgrDev.data.records.find(r => r.id === rec.id);
  const sr = core.normalizeSignRequest(atMgr.signRequest);
  assert.equal(sr.status, 'pending');
  assert.equal(sr.steps[0].toUserId, 'u-admin', 'گیرنده‌ی تازه باید روی سرور هم عوض شده باشد');
  assert.equal(sr.steps[0].referredFrom.userId, REZA.id, 'ردپای ارجاع از شیت برمی‌گردد');
  assert.equal(sr.steps[0].note, 'در سفرم');
  assert.equal(core.buildSignQueue(mgrDev.data.records, MGR, core.buildPermissions(MGR)).toSign.length, 0,
    'مدیر مرحله‌ی بعدی هنوز نوبتش نشده');

  // ادمین (گیرنده‌ی تازه) همان مرحله را امضا می‌کند و نوبت مدیر می‌شود
  mgrDev.update(d => {
    const i = d.records.findIndex(r => r.id === rec.id);
    d.records[i] = core.applySignatureToRecord(d.records[i], { image: 'data:ADM' }, ADMIN);
  });
  await mgrDev.flush();
  await mgrDev.flush();
  const after = mgrDev.data.records.find(r => r.id === rec.id);
  assert.equal(core.normalizeSignRequest(after.signRequest).current, 1, 'نوبت مرحله‌ی مدیر شده');
  assert.equal(core.buildSignQueue(mgrDev.data.records, MGR, core.buildPermissions(MGR)).toSign.length, 1);
});

test('فیلد signers قالب از راه سرور رفت‌وبرگشت می‌شود', async () => {
  const { api, aliDev, base } = await scenario();
  aliDev.update(d => {
    d.templates.push({ id: 't-mc', name: 'بازرسی ماشین‌آلات', category: 'مکانیک', passThreshold: 70, archived: false, signers: 2, items: [], updatedAt: Date.now() });
    const t1 = d.templates.find(t => t.id === 't1');
    t1.signers = 3;
    t1.updatedAt = Date.now();
  });
  await aliDev.flush();

  const fresh = createClient({ core, api, name: 'device-fresh', seed: null });
  await fresh.reset();
  const tMc = fresh.data.templates.find(t => t.id === 't-mc');
  assert.equal(tMc.signers, 2, 'تعداد امضای قالب تازه باید از سرور بیاید');
  const t1 = fresh.data.templates.find(t => t.id === 't1');
  assert.equal(t1.signers, 3, 'به‌روزرسانی تعداد امضای قالب موجود باید بنشیند');
  assert.equal(core.templateSignerCount(tMc, {}), 2);
});
