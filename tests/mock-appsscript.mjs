// شبیه‌ساز حداقلی محیط Google Apps Script برای اجرای تست‌های Code.gs در Node.
// هدف: منطق واقعی سرور (LWW، delta sync، idempotency، مهاجرت) تست شود، نه خود API گوگل.
import crypto from 'node:crypto';

/* ---------------- Spreadsheet ---------------- */

class Range {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet; this.row = row; this.col = col;
    this.numRows = numRows; this.numCols = numCols;
  }
  _cell(r, c) {
    const rows = this.sheet._rows;
    while (rows.length < r) rows.push([]);
    while (rows[r - 1].length < c) rows[r - 1].push('');
    return rows[r - 1];
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const row = [];
      for (let c = 0; c < this.numCols; c++) {
        const rr = this.sheet._rows[this.row - 1 + r];
        row.push(rr && rr[this.col - 1 + c] !== undefined ? rr[this.col - 1 + c] : '');
      }
      out.push(row);
    }
    return out;
  }
  setValues(vals) {
    for (let r = 0; r < vals.length; r++) {
      const target = this._cell(this.row + r, this.col);
      for (let c = 0; c < vals[r].length; c++) target[this.col - 1 + c] = vals[r][c];
    }
    return this;
  }
  setValue(v) { this._cell(this.row, this.col)[this.col - 1] = v; return this; }
  getValue() { return this.getValues()[0][0]; }
}

class Sheet {
  constructor(name, id) { this._name = name; this._rows = []; this._id = id; this._frozen = 0; }
  getName() { return this._name; }
  getSheetId() { return this._id; }
  setFrozenRows(n) { this._frozen = n; return this; }
  getLastRow() {
    let last = 0;
    for (let i = 0; i < this._rows.length; i++) {
      if (this._rows[i].some(c => c !== '' && c !== null && c !== undefined)) last = i + 1;
    }
    return last;
  }
  getLastColumn() {
    let max = 0;
    this._rows.forEach(r => {
      let last = 0;
      for (let i = 0; i < r.length; i++) if (r[i] !== '' && r[i] !== null && r[i] !== undefined) last = i + 1;
      if (last > max) max = last;
    });
    return max;
  }
  getRange(row, col, numRows = 1, numCols = 1) { return new Range(this, row, col, numRows, numCols); }
  appendRow(arr) {
    this._rows.push(arr.slice());
    return this._rows.length;
  }
  deleteRow(i) { this._rows.splice(i - 1, 1); }
  deleteRows(i, n) { this._rows.splice(i - 1, n); }
}

class Spreadsheet {
  constructor(name, id) { this._name = name; this._id = id; this._sheets = [new Sheet('Sheet1', 1)]; this._seq = 1; }
  getId() { return this._id; }
  getName() { return this._name; }
  getUrl() { return `https://docs.google.com/spreadsheets/d/${this._id}/edit`; }
  getSheets() { return this._sheets.slice(); }
  getSheetByName(n) { return this._sheets.find(s => s.getName() === n) || null; }
  getActiveSheet() { return this._sheets[0]; }
  insertSheet(name) { const s = new Sheet(name, ++this._seq); this._sheets.push(s); return s; }
  deleteSheet(s) { this._sheets = this._sheets.filter(x => x !== s); }
}

/* ---------------- Drive ---------------- */

class Blob_ {
  constructor(bytes, mime, name) { this._bytes = bytes; this._mime = mime; this._name = name; }
  getBytes() { return this._bytes; }
  getDataAsString() { return Buffer.from(this._bytes).toString('utf8'); }
  getContentType() { return this._mime; }
  getName() { return this._name; }
  setName(n) { this._name = n; return this; }
  copyBlob() { return new Blob_(this._bytes.slice(), this._mime, this._name); }
  getAs(mime) {
    if (mime === 'application/pdf') return new Blob_(Buffer.from('%PDF-1.4 mock'), 'application/pdf', this._name.replace(/\.[^.]+$/, '') + '.pdf');
    return this.copyBlob();
  }
}

class DriveFile {
  constructor(name, content, mime, id) {
    this._name = name; this._mime = mime || 'text/plain'; this._id = id;
    this._bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
    this._trashed = false; this._created = new Date();
  }
  getId() { return this._id; }
  getName() { return this._name; }
  getMimeType() { return this._mime; }
  getUrl() { return `https://drive.google.com/file/d/${this._id}/view`; }
  getDateCreated() { return this._created; }
  getBlob() { return new Blob_(this._bytes, this._mime, this._name); }
  setContent(c) {
    if (c && typeof c === 'object' && c.getBytes) { this._bytes = Buffer.from(c.getBytes()); this._mime = c.getContentType() || this._mime; this._name = c.getName() || this._name; }
    else this._bytes = Buffer.from(String(c), 'utf8');
    return this;
  }
  setTrashed(t) { this._trashed = !!t; return this; }
  isTrashed() { return this._trashed; }
}

class DriveFolder {
  constructor(name, store, id) { this._name = name; this._store = store; this._id = id; this.files = []; this.folders = []; }
  getName() { return this._name; }
  getId() { return this._id; }
  getUrl() { return `https://drive.google.com/drive/folders/${this._id}`; }
  getFilesByName(n) { return iter(this.files.filter(f => f.getName() === n && !f.isTrashed())); }
  getFiles() { return iter(this.files.filter(f => !f.isTrashed())); }
  getFoldersByName(n) { return iter(this.folders.filter(f => f.getName() === n)); }
  getFolders() { return iter(this.folders); }
  createFolder(n) { const f = new DriveFolder(n, this._store, this._store.nextId()); this.folders.push(f); return f; }
  createFile(a, b, c) {
    let file;
    if (a instanceof Blob_) file = new DriveFile(a.getName(), a.getBytes(), a.getContentType(), this._store.nextId());
    else file = new DriveFile(a, b, c, this._store.nextId());
    this.files.push(file);
    return file;
  }
  addFile(f) { if (!this.files.includes(f)) this.files.push(f); return this; }
  removeFile(f) { this.files = this.files.filter(x => x !== f); return this; }
}

function iter(arr) { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; }

class DriveStore {
  constructor() { this.root = new DriveFolder('root', this, 'root'); this._n = 0; this.byId = new Map(); }
  nextId() { const id = 'file-' + (++this._n); return id; }
  register(f) { this.byId.set(f.getId(), f); return f; }
  getRootFolder() { return this.root; }
  getFileById(id) {
    const found = this._find(this.root, id);
    if (!found) throw new Error('File not found: ' + id);
    return found;
  }
  _find(folder, id) {
    for (const f of folder.files) if (f.getId() === id) return f;
    for (const d of folder.folders) { const r = this._find(d, id); if (r) return r; }
    return null;
  }
}

/* ---------------- Properties / Cache / Lock ---------------- */

class Props {
  constructor() { this.m = new Map(); }
  getProperty(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setProperty(k, v) { this.m.set(k, String(v)); return this; }
  deleteProperty(k) { this.m.delete(k); return this; }
  getProperties() { return Object.fromEntries(this.m); }
}

class Cache {
  constructor() { this.m = new Map(); }
  get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  put(k, v) { this.m.set(k, String(v)); }
  remove(k) { this.m.delete(k); }
}

/* ---------------- Utilities / ContentService ---------------- */

const signedBytes = (buf) => Array.from(buf).map(b => (b > 127 ? b - 256 : b));

const Utilities = {
  DigestAlgorithm: { SHA_256: 'SHA_256', SHA_1: 'SHA_1', MD5: 'MD5' },
  computeDigest(alg, text) {
    const a = String(alg).toUpperCase().replace('SHA_', 'sha');
    return signedBytes(crypto.createHash(a === 'sha256' ? 'sha256' : a === 'sha1' ? 'sha1' : 'md5').update(String(text), 'utf8').digest());
  },
  computeHmacSha256Signature(text, key) {
    return signedBytes(crypto.createHmac('sha256', String(key)).update(String(text), 'utf8').digest());
  },
  base64Decode(s) { return signedBytes(Buffer.from(String(s), 'base64')); },
  base64Encode(b) { return Buffer.from(Array.isArray(b) ? b.map(x => (x < 0 ? x + 256 : x)) : b).toString('base64'); },
  base64DecodeWebSafe(s) { return signedBytes(Buffer.from(String(s), 'base64url')); },
  base64EncodeWebSafe(b) { return Buffer.from(Array.isArray(b) ? b.map(x => (x < 0 ? x + 256 : x)) : b).toString('base64url'); },
  newBlob(bytes, mime, name) { return new Blob_(Buffer.from(Array.isArray(bytes) ? bytes.map(x => (x < 0 ? x + 256 : x)) : bytes), mime, name); },
  zip(blobs, name) { return new Blob_(Buffer.from('PK mock zip'), 'application/zip', name); },
  getUuid() { return crypto.randomUUID(); },
  sleep() {},
};

/* ---------------- محیط کامل ---------------- */

export function createAppsScriptEnv(options = {}) {
  // options.spreadsheets را می‌توان بین دو بارگذاری مشترک کرد تا سناریوی
  // «استقرار نسخه‌ی جدید کد روی داده‌ی موجود» قابل تست باشد.
  const spreadsheets = options.spreadsheets || new Map();
  const drive = new DriveStore();
  // ثبت فایل‌های درایو هنگام ساخت
  const origCreateFile = DriveFolder.prototype.createFile;
  DriveFolder.prototype.createFile = function (...args) { const f = origCreateFile.apply(this, args); drive.register(f); return f; };

  const scriptProps = new Props();
  Object.entries(options.properties || {}).forEach(([k, v]) => scriptProps.setProperty(k, v));
  const userProps = new Props();
  const cache = new Cache();
  const logs = [];
  const emails = [];

  let sheetSeq = 0;
  const SpreadsheetApp = {
    create(name) {
      const id = 'ss-' + (++sheetSeq);
      const ss = new Spreadsheet(name, id);
      spreadsheets.set(id, ss);
      // در Apps Script واقعی هر Spreadsheet یک فایل Drive هم هست
      const driveFile = new DriveFile(name + '.gsheet', '', 'application/vnd.google-apps.spreadsheet', id);
      drive.root.files.push(driveFile);
      drive.register(driveFile);
      return ss;
    },
    openById(id) {
      const ss = spreadsheets.get(id);
      if (!ss) throw new Error('Spreadsheet not found: ' + id);
      return ss;
    },
    open(file) { return spreadsheets.get(file.getId()); },
    flush() {},
  };

  let lockHeld = false;
  const LockService = {
    getScriptLock() {
      return {
        tryLock() { if (lockHeld && !options.allowReentrant) return false; lockHeld = true; return true; },
        releaseLock() { lockHeld = false; },
        hasLock() { return lockHeld; },
      };
    },
  };

  let docSeq = 0;
  const DocumentApp = {
    create(name) {
      const id = 'doc-' + (++docSeq);
      const body = { setText() {}, appendParagraph() { return this; }, appendTable() { return this; } };
      const doc = { getId: () => id, getBody: () => body, saveAndClose() {}, getAs: (m) => new Blob_(Buffer.from('%PDF mock'), m, name + '.pdf') };
      return doc;
    },
  };

  const env = {
    PropertiesService: { getScriptProperties: () => scriptProps, getUserProperties: () => userProps },
    CacheService: { getScriptCache: () => cache, getUserCache: () => cache },
    SpreadsheetApp,
    DriveApp: {
      getRootFolder: () => drive.root,
      getFileById: (id) => drive.getFileById(id),
      getFoldersByName: (n) => drive.root.getFoldersByName(n),
    },
    LockService,
    Utilities,
    DocumentApp,
    MailApp: { sendEmail(to, subject, body) { emails.push({ to, subject, body }); } },
    Logger: { log(...a) { logs.push(a.join(' ')); } },
    ContentService: {
      MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
      createTextOutput(text) {
        let mime = 'text/plain';
        return { setMimeType(m) { mime = m; return this; }, getContent: () => text, getMimeType: () => mime };
      },
    },
    MimeType: { PDF: 'application/pdf', HTML: 'text/html', PLAIN_TEXT: 'text/plain', GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet' },
    Session: { getActiveUser: () => ({ getEmail: () => 'tester@example.com' }) },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/MOCK/exec' }) },
    UrlFetchApp: { fetch: () => { throw new Error('not mocked'); } },
    // ابزارهای تست
    __drive: drive, __spreadsheets: spreadsheets, __logs: logs, __emails: emails, __cache: cache, __props: scriptProps,
  };
  return env;
}

/** Code.gs را داخل محیط شبیه‌سازی‌شده بارگذاری و اجرا می‌کند و API آن را برمی‌گرداند. */
export async function loadServer(codePath, options = {}) {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(codePath, 'utf8');
  const env = createAppsScriptEnv(options);
  const names = Object.keys(env);
  const factory = new Function(...names, `"use strict";\n${src}\n; return { ${[
    'doPost', 'doGet', 'getDb', 'routeAction', 'checkApiKey', 'checkSignature', 'checkRateLimit',
    'upsertEntity', 'deleteEntity', 'readTable', 'handleDbPush', 'handleDbPull', 'applyOp',
    'importLegacyData', 'buildLegacySnapshot', 'migrateFromLegacyJson', 'purgeOldBackups',
    'generateApiKey', 'countAll', 'getRevision', 'bumpRevision', 'getSettings', 'setSettings',
    'handleAuthLogin', 'handleRecordsList', 'externalizeSignatures_', 'saveDataUrlFile_',
    'toJalaliDate', 'toJalaliDateTime', 'gregorianToJalali', 'jalaliToGregorian', 'isLeapJalaliYear',
    'jalaliMonthLength', 'cleanName', 'sha256Hex', 'hmacSha256Hex',
    'maintenanceEnsureSchema', 'maintenancePurgeTombstones', 'SCHEMA', 'ENTITY_NAMES', 'headerFor',
    'issueSessionToken_', 'parseSessionToken_', 'resolveSession_', 'requireRole_', 'guardEntityWrite_',
  ].join(', ')} };`);
  const api = factory(...names.map(n => env[n]));
  return { api, env };
}
