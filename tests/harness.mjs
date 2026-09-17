import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadServer } from './mock-appsscript.mjs';
import * as immerLib from 'immer';

// مسیر واقعی تولید: DataProvider از immer.produceWithPatches استفاده می‌کند و
// مجموعه‌های دست‌خورده را از patchها می‌گیرد. اگر اینجا به‌جایش کپی JSON بزنیم،
// تست‌ها دیگر همان کدی را اجرا نمی‌کنند که در مرورگر اجرا می‌شود (و باگ‌هایی
// مثل draft-escaping یا نبود enablePatches را از دست می‌دهیم).
immerLib.setAutoFreeze(false);
immerLib.enablePatches();
const produceWithPatches = immerLib.produceWithPatches;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');
export const HTML = path.join(ROOT, 'index.html');
export const CODE = path.join(ROOT, 'Code.gs');

export const CORE_BLOCKS = ['crypto', 'digits', 'jalali', 'cloudconfig', 'migrate', 'sync', 'scoring', 'coverage', 'roles', 'permissions', 'signrequest', 'opsanitize', 'loginaid'];

export const CORE_EXPORTS = [
  'sha256Hex', 'hmacSha256Hex', 'randomHex', 'uid', 'derivePasswordHash', 'makeCredential',
  'verifyCredential', 'verifyManagerPinHash', 'timingSafeEqualStr', 'HASH_ALGO', 'PBKDF2_ITERATIONS',
  'toEnglishDigits', 'toPersianDigits', 'sanitizeNumericInput', 'escapeHtml',
  'toJalali', 'toGregorian', 'safeToJalali', 'safeToGregorian', 'gregorianToJalaliStr',
  'jalaliMonthLength', 'jalaliMonthName', 'isValidJalaliDateStr', 'jalaliStrToDate', 'nowJalaliDateTime',
  'pad2', 'isLeapJalaliYear', 'isCompleteJalaliDraft',
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

const PRELUDE = `
const APP_VERSION = 4;
const CLIENT_ID = 'test-client';
const DEFAULT_APPS_SCRIPT_URL = '';
const SESSION_API_KEY = 'test_session_api_key';
const sessionStorage = globalThis.__sessionStorage;
`;

export function extractCore() {
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

export function loadCore(clientId = 'test-client') {
  const code = extractCore();
  const prelude = PRELUDE.replace("'test-client'", JSON.stringify(clientId));
  const factory = new Function(prelude + '\n' + code + `\n; return { ${CORE_EXPORTS.join(', ')} };`);
  return factory();
}

export async function bootServer(properties = {}) {
  const { api, env } = await loadServer(CODE, { properties: { API_KEY: 'dk_test_key_1234567890', ...properties } });
  return { api, env };
}

/** حافظه‌ی شبه‌مرورگری برای تست‌ها */
export function installBrowserStubs() {
  const store = new Map();
  globalThis.__sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  return store;
}

/* =====================================================================
   کلاینت شبیه‌سازی‌شده: همان منطق همگام‌سازی که در DataProvider اجرا می‌شود
   ===================================================================== */

export function createClient({ core, api, name, seed }) {
  let data = core.migrateData(seed ? JSON.parse(JSON.stringify(seed)) : {
    version: 4, users: [], categories: [], templates: [], assets: [], assignments: [], records: [],
    settings: { orgName: 'org', passThreshold: 80 }, revision: 0, lastSyncAt: 0,
  });
  let queue = [];
  let lastSyncAt = 0;
  let revision = 0;
  let sessionToken = '';
  const clientId = name;
  const log = { pushed: 0, pulled: 0, conflicts: [] };
  let online = true;

  const call = (action, payload) => {
    if (!online) { const e = new Error('offline'); e.network = true; throw e; }
    const out = api.doPost({ postData: { contents: JSON.stringify({ action, apiKey: 'dk_test_key_1234567890', clientId: name, payload }) } });
    const json = JSON.parse(out.getContent());
    if (!json.ok) { const e = new Error(json.error); e.code = json.code; throw e; }
    return json;
  };

  return {
    get data() { return data; },
    get queue() { return queue.slice(); },
    get log() { return log; },
    get sessionToken() { return sessionToken; },
    setOnline(v) { online = !!v; },
    call,

    /**
     * معادل ورود واقعی کاربر: نشست امضاشده‌ی سرور را می‌گیرد تا نوشتن‌های
     * محافظت‌شده (settings/categories/users) از این دستگاه اجازه‌ی اجرا پیدا
     * کنند — دقیقاً مثل login() واقعی در index.html.
     */
    async login(username, passwordHash) {
      const res = call('auth.login', { username, passwordHash });
      sessionToken = res.sessionToken || '';
      return res;
    },
    setSessionToken(t) { sessionToken = t || ''; },

    /** معادل update() در DataProvider: تغییر محلی + تولید op */
    update(fn) {
      const prev = data;
      const [next, patches] = produceWithPatches(prev, fn);
      if (next === prev) return [];
      data = next;
      const touched = core.collectTouchedCollections(patches);
      const ops = core.diffState(prev, next, touched, false);
      ops.forEach(o => { o.clientId = clientId; });
      queue = queue.concat(ops);
      return ops;
    },

    /** معادل flush(): اول صف را push می‌کند، بعد delta pull و merge */
    async flush() {
      let guard = 0;
      while (queue.length && guard++ < 20) {
        const batch = queue.slice(0, 60);
        let res;
        try { res = call('db.push', { ops: batch, baseRevision: revision, sessionToken }); }
        catch (e) { return { error: e }; }
        const done = new Set();
        (res.applied || []).forEach(x => { done.add(x.opId); log.pushed++; });
        (res.skipped || []).forEach(x => done.add(x.opId));
        (res.conflicts || []).forEach(x => { done.add(x.opId); log.conflicts.push(x); });
        queue = queue.filter(o => !done.has(o.opId));
        if (res.revision) revision = res.revision;
        if (!done.size) break;
      }
      let pull;
      try { pull = call('db.pull', { since: lastSyncAt, light: false }); }
      catch (e) { return { error: e }; }
      if (pull && pull.entities) {
        const merged = core.mergeRemote(data, pull);
        data = merged.data;
        lastSyncAt = Number(pull.serverTime) || Date.now();
        revision = Number(pull.revision) || revision;
        log.pulled = merged.stats.added + merged.stats.updated + merged.stats.removed;
        return { stats: merged.stats, revision };
      }
      return { revision };
    },

    /** دریافت کامل و جایگزینی (بازنشانی از ابر) */
    async reset() {
      const res = call('db.pull', { since: 0, light: false });
      data = core.snapshotToLocal(res, null);
      queue = [];
      lastSyncAt = Number(res.serverTime) || Date.now();
      revision = Number(res.revision) || 0;
      return data;
    },
  };
}

/** داده‌ی اولیه‌ی مشترک برای سناریوهای چندنفره */
export async function seedServer(core, api) {
  const at = Date.now();
  const seed = {
    version: 4,
    users: [
      { id: 'u-admin', username: 'admin', name: 'مدیر', role: 'admin', active: true, pages: [], passwordHash: 'h', salt: 's', hashAlgo: 'pbkdf2-sha256', iterations: 1000, sessionVersion: 1, updatedAt: at },
      { id: 'u-ali', username: 'ali', name: 'علی', role: 'inspector', active: true, pages: ['dashboard', 'runner', 'records'], passwordHash: 'h2', salt: 's2', hashAlgo: 'pbkdf2-sha256', iterations: 1000, sessionVersion: 1, updatedAt: at },
    ],
    categories: ['برق', 'مکانیک'],
    templates: [{ id: 't1', name: 'بازرسی تابلو', category: 'برق', passThreshold: 80, archived: false, items: [{ id: 'i1', type: 'yesno', label: 'ارت', weight: 50, critical: true }, { id: 'i2', type: 'checkbox', label: 'درب', weight: 50 }], updatedAt: at }],
    assets: [{ id: 'a1', code: 'DB-01', name: 'تابلو ۱', location: 'سالن ۱', templateId: 't1', category: 'برق', updatedAt: at }],
    assignments: [],
    records: [],
    settings: { orgName: 'سازمان درکاو', passThreshold: 80 },
    revision: 0, lastSyncAt: 0,
  };
  const out = api.doPost({ postData: { contents: JSON.stringify({ action: 'cloud_push', apiKey: 'dk_test_key_1234567890', payload: { data: seed } }) } });
  const res = JSON.parse(out.getContent());
  assert.equal(res.ok, true, 'seed باید موفق باشد');
  return seed;
}
