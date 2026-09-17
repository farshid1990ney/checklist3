// تست سفر کامل کاربر (E2E): ورود → ساخت چک‌لیست دوره‌دار → اجرا → امتیاز →
// زنجیره‌ی امضا → پوشش بازرسی → پر شدن دوره → نتیجه در ابر.
// هدف: شبیه‌سازی همان چیزی که کاربر در مرورگر طی می‌کند، روی هسته‌ی خالص +
// شبیه‌ساز سرور، برای یافتن ایرادهای سراسری که تست‌های تک‌لایه نمی‌بینند.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, bootServer, installBrowserStubs, createClient } from './harness.mjs';

installBrowserStubs();
const core = loadCore('e2e-journey');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// اعتبارنامه‌های ارزان (تکرار کم) تا تست سریع بماند؛ ساختار همان تولید است.
const mkCred = async (pw) => core.makeCredential(pw, 2);

// ---- شخصیت‌ها ----
const ADMIN = { id: 'u-admin', username: 'admin', name: 'مدیر سیستم', role: 'admin' };
const ALI = { id: 'u-ali', username: 'ali', name: 'علی محمدی', role: 'inspector' };
const REZA = { id: 'u-reza', username: 'reza', name: 'رضا کریمی', role: 'approver' };
const MGR = { id: 'u-mgr', username: 'mgr', name: 'مدیر داخلی', role: 'manager' };

async function buildSeed() {
  const at = Date.now();
  const [cAdmin, cAli, cReza, cMgr] = await Promise.all([
    mkCred('admin-pass-1'), mkCred('ali-pass-2'), mkCred('reza-pass-3'), mkCred('mgr-pass-4'),
  ]);
  const userRow = (u, c) => Object.assign({}, u, {
    active: true, pages: [], sessionVersion: 1, phone: '', nationalId: '',
    passwordHash: c.passwordHash, salt: c.salt, hashAlgo: c.hashAlgo, iterations: c.iterations,
    updatedAt: at,
  });
  // ده زیرسیستم (ماشین) برای چک‌لیست هفتگی + یک قالب قدیمی بدون دوره/امضا
  const assets = [];
  for (let i = 1; i <= 10; i++) {
    assets.push({
      id: 'a' + i, code: 'M-' + String(i).padStart(2, '0'), name: 'ماشین شماره ' + i,
      location: 'سالن تولید', serial: '', templateId: 't-weekly', category: 'مکانیک', updatedAt: at,
    });
  }
  const data = {
    version: 4,
    users: [ADMIN, ALI, REZA, MGR].map((u, i) => userRow(u, [cAdmin, cAli, cReza, cMgr][i])),
    categories: ['مکانیک', 'برق'],
    templates: [
      {
        id: 't-weekly', name: 'بازرسی هفتگی ماشین‌آلات', category: 'مکانیک',
        passThreshold: 80, archived: false, signers: 2, period: 'weekly',
        items: [
          { id: 'i1', type: 'yesno', label: 'روغن‌کاری انجام شده', weight: 50, critical: true },
          { id: 'i2', type: 'checkbox', label: 'محافظ‌ها نصب‌اند', weight: 30, critical: false },
          { id: 'i3', type: 'rating', label: 'وضعیت کلی', weight: 20, critical: false, scaleMax: 5 },
        ],
        updatedAt: at,
      },
      { // قالب قدیمی: نه دوره دارد نه تعداد امضا — باید در مهاجرت سالم بماند
        id: 't-legacy', name: 'چک‌لیست قدیمی', category: 'برق',
        passThreshold: 70, archived: false,
        items: [{ id: 'li1', type: 'checkbox', label: 'مورد', weight: 10, critical: false }],
        updatedAt: at,
      },
    ],
    assets: assets,
    assignments: [],
    records: [],
    settings: { orgName: 'کارخانه درکاو', passThreshold: 80, signFlowMode: 'chain' },
    revision: 0, lastSyncAt: 0,
  };
  return data;
}

/** دقیقاً همان رکوردی که RunnerPage.submit می‌سازد (میدان‌به‌میدان). */
function runnerRecord(core, { user, template, asset, answers, chainUsers, at }) {
  const result = core.scoreRecord(template, answers);
  const now = at || new Date();
  let signRequest = null;
  const slots = core.signSlotsForCount(core.templateSignerCount(template, { signFlowMode: 'chain' }));
  if (slots.length) {
    const chainSel = {};
    slots.forEach((slot, i) => { chainSel[slot] = chainUsers[i].id; });
    const err = core.validateSignChain(chainSel, chainUsers.concat([user]), user, { signFlowMode: 'chain' }, slots);
    assert.equal(err, null, 'زنجیره‌ی امضا باید معتبر باشد');
    signRequest = core.makeSignChain({
      steps: slots.map(slot => ({ toUser: chainUsers.find(u => u.id === chainSel[slot]), slot, note: '' })),
      byUser: user,
    });
  }
  return {
    id: 'rec-' + asset.id,
    assetId: asset.id, assetCode: asset.code, assetName: asset.name, assetTitle: asset.name,
    location: asset.location, templateId: template.id, templateName: template.name,
    category: template.category, inspectorId: user.id, inspectorName: user.name,
    signRequest,
    date: core.gregorianToJalaliStr(now) + ' - 09:00', dateJalali: core.gregorianToJalaliStr(now),
    startedAt: now.toISOString(), completedAt: now.toISOString(),
    dueDate: '', answers, details: result.details, percent: result.percent, status: result.status,
    criticalFail: !!result.criticalFail, score: Math.round(result.earned || 0), maxScore: result.totalWeight || 0,
    notes: '', signatures: { inspector: { image: 'data:image/png;base64,SIG', name: user.name, title: '' } },
    signerCount: core.templateSignerCount(template, { signFlowMode: 'chain' }),
    assignmentId: null, createdAt: now.getTime(), updatedAt: now.getTime(),
  };
}

test('سفر کامل: ورود تا پوشش و نتیجه', async (t) => {
  const seed = await buildSeed();
  const { api } = await bootServer();
  // seed از مسیر مهاجرت کل پایگاه
  const push = JSON.parse(api.doPost({ postData: { contents: JSON.stringify({
    action: 'cloud_push', apiKey: 'dk_test_key_1234567890', payload: { data: seed },
  }) } }).getContent());
  assert.equal(push.ok, true, 'seed: ' + JSON.stringify(push));

  const mk = (name) => createClient({ core, api, name, seed });

  await t.test('۱) ورود: اعتبارسنجی رمز + نشست سرور + دام ارقام فارسی', async () => {
    const adminDev = mk('device-admin');
    // بررسی رمز دقیقاً مثل صفحه‌ی ورود
    const verdict = await core.verifyCredential(seed.users[0], 'admin-pass-1');
    assert.equal(verdict.ok, true);
    const res = await adminDev.login('admin', verdict.hash);
    assert.ok(res.sessionToken, 'نشست باید توکن بگیرد');
    // رمز غرد/اشتباه رد می‌شود
    const bad = await core.verifyCredential(seed.users[0], 'wrong');
    assert.equal(bad.ok, false);
    // دام کیبورد فارسی باید تشخیص داده شود
    const hints = core.diagnoseLoginInput('admin', '۱۲۳۴');
    assert.ok(hints.some(h => h.includes('ارقام فارسی')));
  });

  await t.test('۲) مهاجرت: قالب بدون دوره، ماهانه می‌شود؛ دوره‌ی هفتگی حفظ می‌شود', async () => {
    const dev = mk('device-check');
    const migrated = dev.data; // از مسیر migrate درون هارنس رد شده
    const weekly = migrated.templates.find(x => x.id === 't-weekly');
    const legacy = migrated.templates.find(x => x.id === 't-legacy');
    assert.equal(core.resolveTemplatePeriod(weekly), 'weekly');
    assert.equal(core.resolveTemplatePeriod(legacy), 'monthly');
    assert.equal(weekly.signers, 2);
    assert.equal(core.templateSignerCount(legacy, migrated.settings), 3, 'قالب قدیمی → پیش‌فرض زنجیره‌ای ۳');
  });

  const adminDev = mk('device-admin-2');
  const aliDev = mk('device-ali');
  const rezaDev = mk('device-reza');
  const vAli = await core.verifyCredential(seed.users[1], 'ali-pass-2');
  const vReza = await core.verifyCredential(seed.users[2], 'reza-pass-3');
  await aliDev.login('ali', vAli.hash);
  await rezaDev.login('reza', vReza.hash);
  const adminVerdict = await core.verifyCredential(seed.users[0], 'admin-pass-1');
  await adminDev.login('admin', adminVerdict.hash);

  const T = aliDev.data.templates.find(x => x.id === 't-weekly');
  const assets = aliDev.data.assets.filter(a => a.templateId === 't-weekly');
  assert.equal(assets.length, 10);

  // امروز سه‌شنبه ۲۵ شهریور ۱۴۰۵ است؛ شنبه‌ی این هفته = ۲۱ شهریور
  const TODAY = new Date('2026-09-16T09:30:00Z');
  const GOOD_ANSWERS = { i1: 'بله', i2: true, i3: 4 };
  const BAD_ANSWERS = { i1: 'خیر', i2: true, i3: 2 }; // آیتم حیاتی رد → ناموفق حیاتی

  await t.test('۳) اجرا و امتیاز: سه دستگاه بازرسی می‌شود', () => {
    for (let i = 0; i < 3; i++) {
      const answers = i === 2 ? BAD_ANSWERS : GOOD_ANSWERS;
      const rec = runnerRecord(core, {
        user: ALI, template: T, asset: assets[i], answers,
        chainUsers: [REZA], at: TODAY,
      });
      aliDev.update(d => { d.records.unshift(rec); });
    }
    const recs = aliDev.data.records;
    assert.equal(recs.length, 3);
    const good = recs.find(r => r.assetId === 'a1');
    assert.equal(good.percent, 96, 'بله=۵۰ + تیک=۳۰ + امتیاز ۴/۵×۲۰=۱۶');
    assert.equal(good.status, 'موفق');
    const failed = recs.find(r => r.assetId === 'a3');
    assert.equal(failed.criticalFail, true, 'رد آیتم حیاتی → ناموفق حیاتی');
    assert.ok(failed.signRequest, 'چک‌لیست دو امضا باید زنجیره بسازد');
    assert.equal(failed.signRequest.toUserId, 'u-reza');
  });

  await t.test('۴) پوشش بازرسی: ۳ از ۱۰ انجام؛ باقی‌مانده درست است', () => {
    const cov = core.templateCoverage(T, aliDev.data.assets, aliDev.data.records, TODAY);
    assert.equal(cov.period, 'weekly');
    assert.equal(cov.total, 10);
    assert.equal(cov.done.length, 3);
    assert.equal(cov.pending.length, 7);
    assert.equal(cov.percent, 30);
    assert.ok(cov.key.endsWith('-W'));
    const doneCodes = cov.done.map(x => x.asset.code).sort();
    assert.deepEqual(doneCodes, ['M-01', 'M-02', 'M-03']);
    // متادیتای نمایشی برای صفحه پوشش
    const first = cov.done.find(x => x.asset.id === 'a1');
    assert.equal(first.record.inspectorName, 'علی محمدی');
    assert.ok(first.record.dateJalali, 'dateJalali برای نمایش تاریخ');
  });

  await t.test('۵) همگام‌سازی: رکوردها و دوره در ابر و دستگاه دوم یکسان‌اند', async () => {
    const res = await aliDev.flush();
    assert.ok(!res.error, 'خطای همگام‌سازی: ' + (res.error && res.error.message));
    assert.equal(aliDev.queue.length, 0, 'صف باید خالی شود');
    await sleep(5);
    await rezaDev.flush();
    const t2 = rezaDev.data.templates.find(x => x.id === 't-weekly');
    assert.equal(t2.period, 'weekly', 'ستون period از شیت برمی‌گردد');
    const cov = core.templateCoverage(t2, rezaDev.data.assets, rezaDev.data.records, TODAY);
    assert.equal(cov.done.length, 3, 'پوشش از داده‌ی ابری هم همان ۳ از ۱۰ است');
    assert.equal(cov.pending.length, 7);
  });

  await t.test('۶) زنجیره‌ی امضا: رضا امضا می‌کند و نوبت جلو می‌رود', () => {
    const rec = rezaDev.data.records.find(r => r.assetId === 'a1');
    assert.ok(rec.signRequest, 'درخواست امضا به دستگاه رضا رسیده است');
    const q = core.buildSignQueue(rezaDev.data.records, REZA, core.buildPermissions(REZA));
    assert.equal(q.toSign.length, 3, 'سه برگه در انتظار امضای رضا (یکی برای هر رکورد)');
    const signed = core.applySignatureToRecord(rec, { image: 'data:image/png;base64,REZA', name: REZA.name }, REZA, Date.now());
    assert.ok(signed, 'امضای رضا باید اعمال شود');
    assert.equal(signed.signatures.approver.name, 'رضا کریمی');
    // برای چک‌لیست ۲ امضا، بعد از امضای ناظر زنجیره تمام می‌شود: مرحله‌ی فعالی نمی‌ماند
    assert.equal(core.activeSignStep(signed.signRequest), null, 'زنجیره باید کامل شده باشد');
    // و برگه دیگر در صف امضای رضا نیست
    const q2 = core.buildSignQueue([signed], REZA, core.buildPermissions(REZA));
    assert.equal(q2.toSign.length, 0);
  });

  await t.test('۷) پایان دوره: هفته‌ی بعد همه‌ی ده دستگاه دوباره باقی‌مانده‌اند', () => {
    const NEXT_WEEK = new Date('2026-09-24T09:30:00Z'); // پنج‌شنبه هفته‌ی بعد
    const cov = core.templateCoverage(T, aliDev.data.assets, aliDev.data.records, NEXT_WEEK);
    assert.equal(cov.done.length, 0, 'رکورد هفته‌ی قبل برای دوره‌ی جدید شمرده نمی‌شود');
    assert.equal(cov.pending.length, 10);
    assert.notEqual(cov.key, core.templateCoverage(T, aliDev.data.assets, aliDev.data.records, TODAY).key);
  });

  await t.test('۸) تکرار بازرسی یک تجهیز در یک دوره فقط یک‌بار شمرده می‌شود', () => {
    const rec = runnerRecord(core, {
      user: ALI, template: T, asset: assets[0], answers: GOOD_ANSWERS,
      chainUsers: [REZA], at: TODAY,
    });
    const records = aliDev.data.records.concat([rec]);
    const cov = core.templateCoverage(T, aliDev.data.assets, records, TODAY);
    assert.equal(cov.done.length, 3, 'تکرار نباید پوشش را دوباره حساب کند');
    const again = cov.done.find(x => x.asset.id === 'a1');
    assert.ok(again.record, 'آخرین رکورد نگه داشته می‌شود');
  });

  await t.test('۹) جمع داشبورد با جمع صفحه پوشش یکی است', () => {
    // دقیقاً منطق کارت داشبورد
    const covs = aliDev.data.templates.filter(x => !x.archived)
      .map(x => core.templateCoverage(x, aliDev.data.assets, aliDev.data.records, TODAY))
      .filter(x => x.total > 0);
    const total = covs.reduce((s, x) => s + x.total, 0);
    const done = covs.reduce((s, x) => s + x.done.length, 0);
    assert.equal(total, 10);
    assert.equal(done, 3);
    const cov = core.templateCoverage(T, aliDev.data.assets, aliDev.data.records, TODAY);
    assert.equal(total, cov.total);
    assert.equal(done, cov.done.length);
  });

  await t.test('۱۰) دوره‌های دیگر: ماهانه/فصلی/سالیانه روی همان رکوردها', () => {
    const variants = [
      ['monthly', '1405/06'], ['quarterly', '1405/S2'], ['annual', '1405'], ['daily', '1405/06/25'],
    ];
    for (const [period, expectedKey] of variants) {
      const tpl = Object.assign({}, T, { period }); // شناسه همان است تا رکوردها مچ شوند
      const cov = core.templateCoverage(tpl, aliDev.data.assets, aliDev.data.records, TODAY);
      assert.equal(cov.key, expectedKey, period);
      assert.equal(cov.done.length, 3, period + ': رکوردهای امروز در این دوره هم معتبرند');
    }
  });

  await t.test('۱۱) خروجی پایانی: برچسب بازه‌ی جاری برای نمایش', () => {
    assert.equal(core.periodWindowLabel('weekly', TODAY).includes('هفته‌ی'), true);
    assert.equal(core.periodWindowLabel('monthly', TODAY), 'شهریور ۱۴۰۵');
    assert.equal(core.periodWindowLabel('quarterly', TODAY), 'فصل تابستان ۱۴۰۵');
    assert.equal(core.periodWindowLabel('annual', TODAY), 'سال ۱۴۰۵');
  });

  await t.test('۱۲) هشدار تأخیر: هفته‌ی بعد ۷ دستگاه عقب‌افتاده‌اند و اواخر هفته «در خطر»ند', () => {
    // رکوردهای علی در هفته‌ی شروع ۲۱ شهریور ثبت شده‌اند.
    // سه‌شنبه‌ی هفته‌ی بعد (شروع ۲۸ شهریور): دوره‌ی قبل همان هفته‌ی رکوردهاست،
    // پس M-01 تا M-03 عقب‌افتاده نیستند ولی ۷ دستگاه بی‌بازرسی عقب‌افتاده‌اند.
    const TUES_NEXT = new Date('2026-09-22T09:30:00Z');
    const al = core.coverageAlerts(T, aliDev.data.assets, aliDev.data.records, TUES_NEXT);
    assert.equal(al.total, 10);
    assert.equal(al.done, 0, 'در دوره‌ی تازه هنوز بازرسی نشده');
    assert.equal(al.overdue.length, 7, 'هفت دستگاه بی‌بازرسی از دوره‌ی قبل → عقب‌افتاده');
    assert.deepEqual(al.overdue.map(a => a.code).sort(), ['M-04', 'M-05', 'M-06', 'M-07', 'M-08', 'M-09', 'M-10']);
    assert.equal(al.atRisk.length, 0, 'اوایل هفته هنوز در خطر نیست');
    // پنج‌شنبه‌ی همان هفته: بیش از ۷۰٪ دوره گذشته → باقی‌مانده‌ها در خطر تأخیر
    const THU = new Date('2026-09-24T09:30:00Z');
    const al2 = core.coverageAlerts(T, aliDev.data.assets, aliDev.data.records, THU);
    assert.ok(al2.elapsed >= core.AT_RISK_RATIO, 'نسبت سپری‌شدن باید از آستانه رد شده باشد');
    assert.equal(al2.atRisk.length, 10, 'همه‌ی باقی‌مانده‌ها در خطر تأخیرند');
    assert.equal(al2.overdue.length, 7, 'عقب‌افتادگی تغییر نمی‌کند');
    // با بازرسی در هفته‌ی تازه، عقب‌افتادگی همان دستگاه پاک می‌شود
    const rec = runnerRecord(core, { user: ALI, template: T, asset: assets[3], answers: GOOD_ANSWERS, chainUsers: [REZA], at: TUES_NEXT });
    const al3 = core.coverageAlerts(T, aliDev.data.assets, aliDev.data.records.concat([rec]), TUES_NEXT);
    assert.equal(al3.overdue.length, 6, 'بازرسی تازه، دستگاه را از عقب‌افتادگی درمی‌آورد');
  });

  await t.test('۱۳) پیوست عکس: عکس‌های کوچک با سابقه همگام می‌شوند', async () => {
    const rec = runnerRecord(core, {
      user: ALI, template: T, asset: assets[4], answers: GOOD_ANSWERS,
      chainUsers: [REZA], at: TODAY,
    });
    rec.photos = [{ image: 'data:image/jpeg;base64,QUJD', name: 'motor.jpg', addedAt: Date.now() }];
    aliDev.update(d => { d.records.unshift(rec); });
    const res = await aliDev.flush();
    assert.ok(!res.error, 'همگام‌سازی با عکس: ' + (res.error && res.error.message));
    await sleep(5);
    await rezaDev.flush();
    const got = rezaDev.data.records.find(r => r.id === rec.id);
    assert.ok(got, 'سابقه به دستگاه دوم رسیده');
    assert.ok(Array.isArray(got.photos), 'ستون photos باید برگردد');
    assert.equal(got.photos[0].image, 'data:image/jpeg;base64,QUJD', 'عکس کوچک درون‌خطی می‌ماند');
    assert.equal(got.photos[0].name, 'motor.jpg');
  });

  await t.test('۱۴) اقدام اصلاحی: بازرسی حیاتیِ ردشده دستورکار می‌سازد و تا بسته‌شدن همگام می‌ماند', async () => {
    // دقیقاً همان منطقی که در ثبت بازرسی اجرا می‌شود:
    const failed = aliDev.data.records.find(r => r.assetId === 'a3');
    assert.equal(failed.criticalFail, true);
    const at = Date.now();
    const cor = {
      id: 'cor-a3', recordId: failed.id, assetId: failed.assetId, assetCode: failed.assetCode,
      templateName: failed.templateName,
      reason: 'بازرسی ناموفق (حیاتی) — ' + failed.details.filter(x => x.critical && (x.earned === null || x.earned === 0)).map(x => x.label).join('؛ '),
      assignedToUserId: '', assignedToName: '', status: 'open', note: '',
      openedAt: at, closedAt: null, createdBy: ALI.id, createdAt: at, updatedAt: at,
    };
    aliDev.update(d => { d.correctives.unshift(cor); });
    const res = await aliDev.flush();
    assert.ok(!res.error, 'همگام‌سازی اقدام اصلاحی: ' + (res.error && res.error.message));
    await sleep(5);
    await rezaDev.flush();
    const got = rezaDev.data.correctives.find(c => c.id === 'cor-a3');
    assert.ok(got, 'دستورکار باید به دستگاه ناظر برسد');
    assert.equal(got.status, 'open');
    assert.ok(got.reason.includes('روغن‌کاری'), 'دلیل باید نام آیتم حیاتی ردشده را داشته باشد');
    // مدیر دستورکار را می‌بندد و وضعیت در هر دو دستگاه یکسان می‌شود
    rezaDev.update(d => {
      const c = d.correctives.find(x => x.id === 'cor-a3');
      c.status = 'closed'; c.closedAt = Date.now(); c.assignedToName = 'رضا کریمی'; c.updatedAt = Date.now();
    });
    const res2 = await rezaDev.flush();
    assert.ok(!res2.error, 'بستن دستورکار: ' + (res2.error && res2.message));
    await sleep(5);
    await aliDev.flush();
    const final = aliDev.data.correctives.find(c => c.id === 'cor-a3');
    assert.equal(final.status, 'closed', 'وضعیت بسته به دستگاه بازرس برمی‌گردد');
    assert.equal(final.assignedToName, 'رضا کریمی');
  });
});
