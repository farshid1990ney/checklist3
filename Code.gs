/**
 * =====================================================================
 *  سامانه چک‌لیست درکاو — لایه سرور (Google Apps Script)
 *  نسخه: 8.0
 * =====================================================================
 *
 *  تغییرات کلیدی نسبت به نسخه ۷:
 *   ۱. منبع حقیقت (single source of truth) از «یک فایل JSON روی Drive» به
 *      «یک Google Spreadsheet با شیت‌های جداگانه» منتقل شد. هر رکورد یک ردیف
 *      مستقل است؛ در نتیجه نوشتن هم‌زمان دو کاربر دیگر کل پایگاه را بازنویسی
 *      نمی‌کند.
 *   ۲. همگام‌سازی مبتنی بر «عملیات» (op-based / event-sourcing سبک):
 *      کلاینت صفی از عملیات (upsert/delete) می‌فرستد و سرور آن‌ها را
 *      idempotent اعمال می‌کند. پاسخ شامل revision و فهرست تعارض‌هاست.
 *   ۳. تشخیص نوشتن کهنه (STALE_WRITE): مقایسه updatedAt در سطح هر موجودیت،
 *      نه در سطح کل پایگاه. آخرین نوشتن فقط برای «همان ردیف» برنده است.
 *   ۴. pull增量 (delta sync): کلاینت فقط ردیف‌هایی را می‌گیرد که از آخرین
 *      همگام‌سازی تغییر کرده‌اند (به‌همراه tombstone برای حذف‌شده‌ها).
 *   ۵. امنیت: کلید API الزامی است و دیگر «اولین کلید ارسالی» خودکار ثبت
 *      نمی‌شود. امضای HMAC درخواست (timestamp + nonce) برای جلوگیری از replay.
 *   ۶. تصویر امضاها به‌جای ذخیره داخل سلول شیت، به‌صورت فایل PNG در Drive
 *      نگه داشته می‌شود و در شیت فقط ارجاع آن می‌ماند (سلول شیت حداکثر
 *      ۵۰٬۰۰۰ کاراکتر ظرفیت دارد).
 *   ۷. endpoint مهاجرت از نسخه قدیمی (JSON) به Sheets.
 *
 *  =====================================================================
 *  راهنمای نصب
 *  =====================================================================
 *  ۱. script.google.com → New project. نام فایل را Code.gs بگذارید و این
 *     کد را داخل آن قرار دهید.
 *  ۲. از Project Settings گزینه «Show appsscript.json manifest file in
 *     editor» را فعال و محتوای فایل appsscript.json همراه پروژه را در آن
 *     بگذارید.
 *  ۳. Project Settings → Script Properties:
 *       API_KEY       (الزامی) یک رشته تصادفی بلند، مثال:
 *                     نتیجه‌ی Execute below در همین اسکریپت: generateApiKey()
 *       ADMIN_EMAIL   (اختیاری) برای اعلان بازرسی ناموفق حیاتی
 *       ROOT_FOLDER_NAME (اختیاری) نام پوشه اصلی در Drive
 *       REQUIRE_SIGNATURE (اختیاری) "true" → اجبار امضای HMAC
 *       RATE_LIMIT_PER_MINUTE (اختیاری) پیش‌فرض 120
 *     اگر API_KEY تنظیم نشده باشد، همه‌ی درخواست‌ها (به‌جز ping/version) رد
 *     می‌شوند. برای راه‌اندازی اولیه می‌توانید موقتاً ALLOW_KEY_BOOTSTRAP
 *     را "true" کنید؛ در این حالت اولین کلید ارسالی ثبت می‌شود. بلافاصله پس
 *     از اولین اتصال موفق، این ویژگی را حذف کنید.
 *  ۴. Deploy → New deployment → Web app:
 *       Execute as: Me    |    Who has access: Anyone
 *  ۵. آدرس /exec را همراه کلید API در «تنظیمات» برنامه وارد کنید.
 *  ۶. (اختیاری) اگر داده‌ی قدیمی روی Drive دارید: تابع migrateFromLegacyJson
 *     را یک‌بار از همین ویرایشگر اجرا کنید.
 * =====================================================================
 */

/* =====================================================================
   ۰. پیکربندی
   ===================================================================== */

var SERVER_VERSION = "8.0";
var LOCK_WAIT_MS = 25000;
var DEFAULT_RATE_LIMIT = 120;
var MAX_CLOCK_SKEW_SECONDS = 300;
var MAX_OPS_PER_REQUEST = 400;
var MAX_OPS_LOG_ROWS = 5000;
var MAX_LOG_ROWS = 20000;
var SIGNATURE_INLINE_LIMIT = 40000; // کاراکتر؛ بزرگ‌تر از این به Drive می‌رود

/* =====================================================================
   ۱. تعریف مدل داده (شیت‌ها و ستون‌ها)
   =====================================================================
   هر موجودیت یک شیت دارد. ستون‌های مشترک sync در انتهای هر شیت آمده‌اند:
     createdAt / updatedAt (عدد = میلی‌ثانیه از epoch «ساعت کلاینت») → مبنای
                            تشخیص Last-Write-Wins برای هر ردیف
     syncedAt              (عدد = میلی‌ثانیه از epoch «ساعت سرور»، هنگام نوشتن)
                            → مبنای delta sync. چون updatedAt از ساعت کلاینت
                            می‌آید، نمی‌توان پنجره‌ی «از آخرین همگام‌سازی به بعد»
                            را با آن بست؛ این ستون دقیقاً همان کاری را می‌کند که
                            «شماره ترتیب» در پایگاه‌های replication انجام می‌دهد.
     deleted               (بولی = tombstone)
   نوع هر ستون برای تبدیل درست هنگام خواندن/نوشتن اعلام می‌شود:
     s = رشته | n = عدد | b = بولی | j = JSON | csv = فهرست جداشده با کاما
   ------------------------------------------------------------------ */

var SYNC_COLS = ["createdAt", "updatedAt", "syncedAt", "deleted"];

var SCHEMA = {
  users: {
    sheet: "users",
    cols: ["id", "username", "name", "role", "passwordHash", "salt", "hashAlgo", "iterations",
           "pages", "active", "sessionVersion", "phone", "nationalId"]
  },
  templates: {
    sheet: "templates",
    // ⚠️ «signers» و «period» عمداً در انتهای ستون‌ها اضافه شده‌اند: خواندن از
    // روی موقعیت ستون‌های کد انجام می‌شود و افزودن ستون در میانه، داده‌ی شیت‌های
    // موجود را یک خانه جابه‌جا می‌خواند.
    // (تعداد امضاکنندگانِ هر چک‌لیست: ۱/۲/۳ — دوره‌ی بازرسی: روزانه تا سالیانه)
    cols: ["id", "name", "category", "passThreshold", "items", "archived", "signers", "period"]
  },
  assets: {
    sheet: "assets",
    cols: ["id", "code", "name", "location", "serial", "templateId", "category"]
  },
  assignments: {
    sheet: "assignments",
    cols: ["id", "assignedToUserId", "assignedToName", "assetId", "assetCode", "templateId",
           "note", "dueDate", "status", "recordId", "createdBy", "completedAt"]
  },
  records: {
    sheet: "records",
    cols: ["id", "assetId", "assetCode", "assetName", "templateId", "templateName", "category",
           "location", "inspectorId", "inspectorName", "dateJalali", "startedAt", "completedAt",
           "percent", "score", "maxScore", "status", "criticalFail", "notes", "details",
           "signatures", "assignmentId", "approvedBy", "approvedAt", "pdfUrl",
           "signRequest", "photos"]
  },
  correctives: {
    sheet: "correctives",
    // اقدام‌های اصلاحی: بازرسی ناموفقِ حیاتی به‌صورت خودکار یک دستورکار می‌سازد
    // و تا بسته‌شدن پیگیری می‌شود. ستون‌های همگام‌سازی به انتهای شیت اضافه می‌شوند.
    cols: ["id", "recordId", "assetId", "assetCode", "templateName", "reason",
           "assignedToUserId", "assignedToName", "status", "note", "openedAt", "closedAt", "createdBy"]
  },
  categories: {
    sheet: "categories",
    cols: ["id", "name", "order"]
  }
};

// نوع ستون‌ها (برای serialize/deserialize)
var COL_TYPES = {
  // users
  active: "b", sessionVersion: "n", iterations: "n",
  // templates
  passThreshold: "n", items: "j", archived: "b", signers: "n",
  // assignments
  status: "s",
  // records
  percent: "n", score: "n", maxScore: "n", criticalFail: "b", details: "j", signatures: "j", photos: "j",
  // correctives
  openedAt: "n", closedAt: "n",
  signRequest: "j",
  // categories
  order: "n",
  // users
  pages: "csv",
  // sync
  createdAt: "n", updatedAt: "n", syncedAt: "n", deleted: "b"
};

// ستون‌هایی که در پاسخ‌های «سبک» حذف می‌شوند
var HEAVY_COLS = { records: ["details", "signatures", "photos"] };

var ENTITY_NAMES = ["users", "templates", "assets", "assignments", "records", "correctives", "categories"];

/* =====================================================================
   ۲. توابع کمکی عمومی
   ===================================================================== */

function responseJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function nowMs() { return new Date().getTime(); }

function toMs(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return v;
  var n = Number(v);
  if (!isNaN(n) && n > 1000000000000) return n;      // epoch ms
  if (!isNaN(n) && n > 1000000000) return n * 1000;  // epoch s
  var t = Date.parse(String(v));
  return isNaN(t) ? 0 : t;
}

/* تبدیل مقدار فیلتر تاریخ به epoch ms (رفع ایراد P3-۱۵).

   `toMs` معمولی برای فیلترهای `from`/`to` کافی نیست: اگر فراخوان تاریخ شمسی
   بفرستد (که در این سامانه طبیعی‌ترین ورودی است)، `Date.parse("1403/01/01")`
   سال **۱۴۰۳ میلادی** را برمی‌گرداند — یعنی ۶۳۲ سال خطا. نتیجه‌اش این است که
   فیلتر یا همه‌چیز را برمی‌گرداند یا هیچ‌چیز را، بدون هیچ پیام خطایی.

   حالا رشته‌ی `YYYY/MM/DD` با سالِ بازه‌ی شمسی (۱۳۰۰ تا ۱۵۰۰) به‌درستی تبدیل
   می‌شود. `endOfDay` برای کرانِ بالای فیلتر (`to`) استفاده می‌شود تا «تا تاریخ
   فلان» واقعاً کل آن روز را شامل شود، نه فقط لحظه‌ی نیمه‌شبِ اولش. */
function toFilterMs_(v, endOfDay) {
  if (v === null || v === undefined || v === "") return 0;
  var s = String(v).trim();
  var m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) {
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    var dateOnly = true;
    if (y >= 1300 && y <= 1500) {
      var g = jalaliToGregorian(y, mo, d);
      // ساعت محلی اسکریتپ (در مانیفست Asia/Tehran است) مبناست، نه UTC؛
      // وگرنه یک روز جابه‌جا می‌شد.
      var t = new Date(g[0], g[1] - 1, g[2], endOfDay ? 23 : 0, endOfDay ? 59 : 0,
        endOfDay ? 59 : 0, endOfDay ? 999 : 0).getTime();
      return isNaN(t) ? 0 : t;
    }
    var gms = new Date(y, mo - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0,
      endOfDay ? 59 : 0, endOfDay ? 999 : 0).getTime();
    void dateOnly;
    return isNaN(gms) ? 0 : gms;
  }
  return toMs(v);
}

function toBool(v) {
  if (typeof v === "boolean") return v;
  if (v === null || v === undefined) return false;
  var s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "بله";
}

function toNum(v) {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  if (v === null || v === undefined || v === "") return 0;
  var n = Number(String(v).replace(/[۰-۹]/g, function (d) { return "۰۱۲۳۴۵۶۷۸۹".indexOf(d); })
                           .replace(/[٠-٩]/g, function (d) { return "٠١٢٣٤٥٦٧٨٩".indexOf(d); }));
  return isFinite(n) ? n : 0;
}

function safeJsonParse(text, fallback) {
  if (text === null || text === undefined || text === "") return fallback;
  if (typeof text === "object") return text;
  try { return JSON.parse(text); } catch (e) { return fallback; }
}

function cleanName(str, maxLen) {
  // نیم‌فاصله (U+200C) کاراکتر معتبر فارسی است و نباید حذف شود
  var s = String(str === null || str === undefined ? "" : str)
    .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  var limit = maxLen || 80;
  if (s.length > limit) s = s.slice(0, limit);
  return s || "بدون‌نام";
}

function sha256Hex(text) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text));
  return raw.map(function (b) { return ("0" + ((b < 0 ? b + 256 : b)).toString(16)).slice(-2); }).join("");
}

function hmacSha256Hex(secret, text) {
  var raw = Utilities.computeHmacSha256Signature(String(text), String(secret));
  return raw.map(function (b) { return ("0" + ((b < 0 ? b + 256 : b)).toString(16)).slice(-2); }).join("");
}

function constantTimeEquals(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* --- تاریخ شمسی (فقط برای نام پوشه‌ها و ستون‌های نمایشی) ---
   ⚠️ این پیاده‌سازی دقیقاً همان الگوریتم jalaali (مبتنی بر breaks) است که سمت
   کلاینت استفاده می‌شود. الگوریتم کلاسیک قبلی در بعضی سال‌ها یک روز اختلاف
   داشت (مثلاً 2029-03-20 را 1407/01/01 می‌داد درحالی‌که 1408/01/01 است) و
   باعث می‌شد PDFها در پوشه‌ی ماه/سال اشتباه ذخیره شوند.                     */

var JALALI_BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];

function jdiv(a, b) { return Math.trunc(a / b); }
function jmod(a, b) { return a - b * Math.floor(a / b); }

function jalCal(jy) {
  var breaks = JALALI_BREAKS;
  var bl = breaks.length, gy = jy + 621, leapJ = -14, jp = breaks[0], jm, jump = 0, leap, n, i;
  if (jy < jp || jy >= breaks[bl - 1]) throw new Error("سال شمسی خارج از بازه معتبر: " + jy);
  for (i = 1; i < bl; i += 1) {
    jm = breaks[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ += jdiv(jump, 33) * 8 + jdiv(jump % 33, 4);
    jp = jm;
  }
  n = jy - jp;
  leapJ += jdiv(n, 33) * 8 + jdiv((n % 33) + 3, 4);
  if ((jump % 33) === 4 && (jump - n) === 4) leapJ += 1;
  var leapG = jdiv(gy, 4) - jdiv((jdiv(gy, 100) + 1) * 3, 4) - 150;
  var march = 20 + leapJ - leapG;
  if ((jump - n) < 6) n = n - jump + jdiv(jump + 4, 33) * 33;
  leap = jmod(jmod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap: leap, gy: gy, march: march };
}

function g2d(gy, gm, gd) {
  var d = jdiv((gy + jdiv(gm - 8, 6) + 100100) * 1461, 4)
    + jdiv(153 * ((gm + 9) % 12) + 2, 5) + gd - 34840408;
  d = d - jdiv(jdiv(gy + 100100 + jdiv(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

function d2g(jdn) {
  var j = 4 * jdn + 139361631;
  j = j + jdiv(jdiv(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  var i = jdiv((j % 1461), 4) * 5 + 308;
  var gd = jdiv(i % 153, 5) + 1;
  var gm = (jdiv(i, 153) % 12) + 1;
  var gy = jdiv(j, 1461) - 100100 + jdiv(8 - gm, 6);
  return [gy, gm, gd];
}

function jalaliToGregorian(jy, jm, jd) {
  var r = jalCal(jy);
  var jdn = g2d(r.gy, 3, r.march) + (jm - 1) * 31 - jdiv(jm, 7) * (jm - 7) + jd - 1;
  return d2g(jdn);
}

function gregorianToJalali(gy, gm, gd) {
  var jdn = g2d(gy, gm, gd);
  var gy0 = d2g(jdn)[0];
  var jy = gy0 - 621;
  var r = jalCal(jy);
  var jdn1f = g2d(r.gy, 3, r.march);
  var k = jdn - jdn1f, jm, jd;
  if (k >= 0) {
    if (k <= 185) return { jy: jy, jm: 1 + jdiv(k, 31), jd: jmod(k, 31) + 1 };
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  jm = 7 + jdiv(k, 30);
  jd = jmod(k, 30) + 1;
  return { jy: jy, jm: jm, jd: jd };
}

/** سال کبیسه شمسی؟ (leap === 0 یعنی کبیسه) */
function isLeapJalaliYear(jy) {
  try { return jalCal(jy).leap === 0; } catch (e) { return false; }
}

function jalaliMonthLength(jy, jm) {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isLeapJalaliYear(jy) ? 30 : 29;
}

function pad2(n) { n = String(n); return n.length === 1 ? "0" + n : n; }

function jalaliOf(dateObj) {
  var d = (dateObj instanceof Date) ? dateObj : new Date(toMs(dateObj) || nowMs());
  if (isNaN(d.getTime())) d = new Date();
  try {
    return gregorianToJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
  } catch (e) {
    return { jy: d.getFullYear() - 621, jm: 1, jd: 1 }; // خارج از بازه‌ی معتبر تقویم
  }
}

function toJalaliDate(dateObj) {
  var j = jalaliOf(dateObj);
  return j.jy + "/" + pad2(j.jm) + "/" + pad2(j.jd);
}

function toJalaliDateTime(dateObj) {
  var d = (dateObj instanceof Date) ? dateObj : new Date(toMs(dateObj) || nowMs());
  return toJalaliDate(d) + " - " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function jalaliYear(dateObj) { return String(jalaliOf(dateObj).jy); }

function jalaliMonthFolder(dateObj) {
  var names = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
               "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
  var jm = jalaliOf(dateObj).jm;
  return pad2(jm) + "-" + names[jm - 1];
}

/* =====================================================================
   ۳. Properties و دسترسی به Spreadsheet پایگاه داده
   ===================================================================== */

function props() { return PropertiesService.getScriptProperties(); }

function prop(name, fallback) {
  var v = props().getProperty(name);
  return (v === null || v === undefined || v === "") ? fallback : v;
}

function rateLimitPerMinute() { return toNum(prop("RATE_LIMIT_PER_MINUTE", DEFAULT_RATE_LIMIT)) || DEFAULT_RATE_LIMIT; }

function rootFolderName(payload) {
  return String((payload && payload.folderName) || prop("ROOT_FOLDER_NAME", "سامانه چک‌لیست درکاو"));
}

/** یک کلید API تصادفی امن می‌سازد و در Script Properties ثبت می‌کند. */
function generateApiKey() {
  var key = "dk_" + Utilities.getUuid().replace(/-/g, "") + sha256Hex(String(Math.random()) + nowMs()).slice(0, 16);
  props().setProperty("API_KEY", key);
  Logger.log("کلید API ساخته و ثبت شد: " + key);
  return key;
}

/** Spreadsheet پایگاه داده را برمی‌گرداند و در نبود آن، می‌سازد. */
function getDb() {
  var id = prop("DB_SHEET_ID", "");
  var ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create("Darkav-DB");
    props().setProperty("DB_SHEET_ID", ss.getId());
    var file = DriveApp.getFileById(ss.getId());
    try {
      var root = getOrCreateFolder(DriveApp.getRootFolder(), prop("ROOT_FOLDER_NAME", "سامانه چک‌لیست درکاو"));
      root.addFile(file);
      DriveApp.getRootFolder().removeFile(file);
    } catch (eMove) { /* اگر جابه‌جایی نشد، فایل در ریشه می‌ماند */ }
  }
  ensureSheets(ss);
  return ss;
}

function ensureSheets(ss) {
  var needed = [];
  ENTITY_NAMES.forEach(function (k) { needed.push(SCHEMA[k].sheet); });
  needed = needed.concat(["_meta", "_ops", "_log", "invites"]);

  var existing = {};
  ss.getSheets().forEach(function (sh) { existing[sh.getName()] = sh; });

  needed.forEach(function (name) {
    var sh = existing[name];
    if (!sh) {
      sh = ss.insertSheet(name);
    }
    ensureHeader(sh, name, true);
  });

  // حذف شیت پیش‌فرض خالی که هنگام ساخت Spreadsheet ایجاد می‌شود
  try {
    var defaultSheet = ss.getSheetByName("Sheet1");
    if (defaultSheet && ss.getSheets().length > 1 && needed.indexOf("Sheet1") === -1) {
      ss.deleteSheet(defaultSheet);
    }
  } catch (eDel) {}
}

function headerFor(sheetName) {
  if (sheetName === "_meta") return ["key", "value", "updatedAt"];
  if (sheetName === "_ops") return ["opId", "clientId", "at", "entity", "entityId", "kind", "result", "detail"];
  if (sheetName === "_log") return ["at", "iso", "action", "actor", "clientId", "ok", "detail"];
  // شیت «invites»: عمداً هیچ‌جا در ENTITY_NAMES/db.pull نیست — چون هر ردیفش تا
  // قبل از مصرف، عملاً یک اعتبارنامه (bearer token) است و نباید مثل بقیه‌ی
  // جدول‌ها به‌طور کامل به هر دارنده‌ی API_KEY پخش شود.
  if (sheetName === "invites") return ["id", "token", "role", "note", "createdBy", "createdAt", "expiresAt", "usedAt", "usedByUserId"];
  var def = null;
  ENTITY_NAMES.forEach(function (k) { if (SCHEMA[k].sheet === sheetName) def = SCHEMA[k]; });
  if (!def) return ["id"];
  return def.cols.concat(SYNC_COLS);
}

/*
 * هم‌ترازی هدر شیت با schema کد.

   ⚠️ نکته‌ی حیاتی: readTable/writeRow_ موقعیت ستون‌ها را از headerFor() (یعنی
   از کد) می‌گیرند، نه از ردیف هدر شیت. پس اگر schema عوض شود و داده‌ی موجود
   جابه‌جا نشود، هر ستون به‌صورت خاموش یک خانه جابه‌جا خوانده می‌شود — مثلاً
   بعد از افزودن یک ستون در میانه، مقدار pdfUrl به‌جای «approvedBy» خوانده
   می‌شود. این همان چیزی است که در تست migrationHeader_dataIsRemappedByColumnName
   پوشش داده شده.

   بنابراین هنگام تغییر هدر، ردیف‌های داده بر اساس «نام ستون» به چیدمان جدید
   نگاشت می‌شوند (نه بر اساس موقعیت). ستون تازه مقدار خالی می‌گیرد و ستون
   حذف‌شده دور ریخته می‌شود.

   HEADER_ENSURED فقط در طول یک اجرا زنده است (در Apps Script هر اجرا scope
   تازه دارد)، پس بررسی هدر به ازای هر شیت حداکثر یک بار در هر درخواست انجام
   می‌شود و هزینه‌ی خواندن اضافه ندارد.
*/
var HEADER_ENSURED = {};

function ensureHeader(sh, sheetName, force) {
  if (!force && HEADER_ENSURED[sheetName]) return HEADER_ENSURED[sheetName];

  var header = headerFor(sheetName);
  var lastCol = Math.max(header.length, sh.getLastColumn());
  var first = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var existing = [];
  for (var i = 0; i < lastCol; i++) {
    var v = first[i];
    existing.push(v === undefined || v === null ? "" : String(v));
  }

  var same = lastCol === header.length && header.every(function (h, k) { return existing[k] === h; });
  if (!same) migrateHeader_(sh, sheetName, existing, header);

  HEADER_ENSURED[sheetName] = header;
  return header;
}

function migrateHeader_(sh, sheetName, existing, header) {
  var lastCol = existing.length;
  var lastRow = sh.getLastRow();
  var hasNames = existing.some(function (h) { return h !== ""; });

  if (lastRow >= 2 && hasNames) {
    var indexByName = {};
    existing.forEach(function (name, idx) {
      if (name && indexByName[name] === undefined) indexByName[name] = idx;
    });

    // خواندن هم تکه‌تکه انجام می‌شود (رفع ایراد #21): پیش‌تر فقط نوشتن chunked
    // بود ولی `getValues` کل شیت را یک‌جا در حافظه می‌آورد. برای شیت ۱۰٬۰۰۰
    // ردیفی با ۳۰ ستون یعنی ۳۰۰٬۰۰۰ سلول هم‌زمان در حافظه، که به سقف حافظه‌ی
    // Apps Script می‌خورد و مهاجرت کرش می‌کرد.
    var CHUNK = 500;
    var totalRows = lastRow - 1;
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    var migrated = 0;
    for (var start = 0; start < totalRows; start += CHUNK) {
      var n = Math.min(CHUNK, totalRows - start);
      var block = sh.getRange(2 + start, 1, n, lastCol).getValues();
      var part = block.map(function (row) {
        return header.map(function (col) {
          var src = indexByName[col];
          return src === undefined ? "" : row[src];
        });
      });
      sh.getRange(2 + start, 1, n, header.length).setValues(part);
      migrated += n;
    }

    // ستون‌های اضافی سمت راست (از schema حذف شده‌اند) پاک می‌شوند تا خواندن
    // بعدی دوباره هدر را «متفاوت» نبیند.
    if (lastCol > header.length && lastRow >= 1) {
      var width = lastCol - header.length;
      var blanks = [];
      for (var r = 0; r < lastRow; r++) {
        var line = [];
        for (var c = 0; c < width; c++) line.push("");
        blanks.push(line);
      }
      sh.getRange(1, header.length + 1, blanks.length, width).setValues(blanks);
    }

    Logger.log("migrateHeader: شیت «" + sheetName + "» از " + lastCol +
      " ستون به " + header.length + " ستون هم‌تراز شد (" + migrated + " ردیف داده).");
  } else {
    sh.getRange(1, 1, 1, header.length).setValues([header]);
  }
  sh.setFrozenRows(1);
}

function getSheet(ss, sheetName) {
  var sh = ss.getSheetByName(sheetName);
  if (!sh) sh = ss.insertSheet(sheetName);
  ensureHeader(sh, sheetName);
  return sh;
}

/* =====================================================================
   ۴. موتور خواندن/نوشتن جدول‌ها
   ===================================================================== */

function serializeCell(col, value) {
  var t = COL_TYPES[col] || "s";
  if (value === null || value === undefined) return t === "n" ? 0 : (t === "b" ? false : (t === "csv" ? "" : ""));
  if (t === "n") return toNum(value);
  if (t === "b") return toBool(value);
  if (t === "csv") return Array.isArray(value) ? value.join(",") : String(value);
  if (t === "j") return (typeof value === "string") ? value : JSON.stringify(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function deserializeCell(col, value) {
  var t = COL_TYPES[col] || "s";
  if (t === "n") return toNum(value);
  if (t === "b") return toBool(value);
  if (t === "csv") {
    if (value === "" || value === null || value === undefined) return [];
    if (Array.isArray(value)) return value;
    return String(value).split(",").map(function (x) { return x.trim(); }).filter(Boolean);
  }
  if (t === "j") {
    if (value === "" || value === null || value === undefined) return null;
    return safeJsonParse(value, null);
  }
  if (value instanceof Date) return value.toISOString();
  return (value === null || value === undefined) ? "" : String(value);
}

/** کل ردیف‌های یک شیت را به‌صورت آرایه‌ای از آبجکت برمی‌گرداند. */
function readTable(ss, entityName, opts) {
  var def = SCHEMA[entityName];
  var sh = getSheet(ss, def.sheet);
  var header = headerFor(def.sheet);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var lastCol = Math.max(header.length, sh.getLastColumn());
  var values = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var light = opts && opts.light && HEAVY_COLS[entityName];
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    // ردیف‌های کاملاً خالی نادیده گرفته می‌شوند (ایراد ۲-۶)
    var empty = true;
    for (var c = 0; c < header.length; c++) {
      if (row[c] !== "" && row[c] !== null && row[c] !== undefined) { empty = false; break; }
    }
    if (empty) continue;
    var obj = {};
    for (var k = 0; k < header.length; k++) {
      var col = header[k];
      if (light && light.indexOf(col) !== -1) continue;
      obj[col] = deserializeCell(col, row[k]);
    }
    if (!obj.id) continue;
    out.push(obj);
  }
  return out;
}

/* ---------------------------------------------------------------------------
   کش نگاشت id → rowIndex (رفع ایراد P1-۲)

   پیش‌تر هر عملیاتِ یک `db.push` جداگانه کل ستون id را می‌خواند: با ۶۰ عملیات
   یعنی ۶۰ پیمایش کامل شیت. روی پایگاه ۵٬۰۰۰ رکوردی این ~۳۰۰٬۰۰۰ خواندن سلول
   در یک درخواست بود و به سقف زمانی ۶ دقیقه‌ای Apps Script می‌خورد.

   حالا نگاشت یک بار در نخستین مراجعه ساخته می‌شود و تا پایان درخواست زنده
   می‌ماند. چون حذف فیزیکی در جریان push اتفاق نمی‌افتد (فقط tombstone) و
   `writeRow_` هنگام append نگاشت تازه را اضافه می‌کند، شماره‌ی ردیف‌ها معتبر
   می‌ماند. کش فقط داخل `handleDbPush` فعال است؛ بقیه‌ی مسیرها مثل قبل کار
   می‌کنند.
   --------------------------------------------------------------------------- */
var ROW_INDEX_CACHE_ = null;

function beginRowIndexCache_() { ROW_INDEX_CACHE_ = {}; }
function endRowIndexCache_() { ROW_INDEX_CACHE_ = null; }

function rowIndexCacheFor_(entityName) {
  if (!ROW_INDEX_CACHE_) return null;
  var c = ROW_INDEX_CACHE_[entityName];
  if (!c) { c = { map: {}, built: false }; ROW_INDEX_CACHE_[entityName] = c; }
  return c;
}

/** بعد از append باید نگاشت به‌روز بماند، وگرنه مراجعه‌ی بعدی ردیف را پیدا نمی‌کند */
function noteAppendedRow_(entityName, id, rowIndex) {
  if (!ROW_INDEX_CACHE_ || !id) return;
  var c = ROW_INDEX_CACHE_[entityName];
  if (c && c.built) c.map[String(id)] = rowIndex;
}

function rowIndexOfId(ss, entityName, id) {
  var key = String(id);
  var cache = rowIndexCacheFor_(entityName);
  if (cache && cache.built) {
    var hit = cache.map[key];
    return hit === undefined ? -1 : hit;
  }
  var def = SCHEMA[entityName];
  var sh = getSheet(ss, def.sheet);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) {
    if (cache) { cache.map = {}; cache.built = true; }
    return -1;
  }
  var col = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  var found = -1;
  if (cache) {
    cache.map = {};
    for (var j = 0; j < col.length; j++) {
      var k = String(col[j][0]);
      if (k && cache.map[k] === undefined) cache.map[k] = j + 2;
    }
    cache.built = true;
    found = cache.map[key] === undefined ? -1 : cache.map[key];
  } else {
    for (var i = 0; i < col.length; i++) if (String(col[i][0]) === key) { found = i + 2; break; }
  }
  return found;
}

/** خواندن یک ردیف مشخص — جایگزین سبکِ «خواندن کل جدول» برای lookup تک‌رکوردی */
function readRowAt_(ss, entityName, rowIndex) {
  if (rowIndex < 2) return null;
  var def = SCHEMA[entityName];
  var header = headerFor(def.sheet);
  var sh = getSheet(ss, def.sheet);
  var vals = sh.getRange(rowIndex, 1, 1, header.length).getValues()[0];
  var obj = {};
  for (var i = 0; i < header.length; i++) obj[header[i]] = deserializeCell(header[i], vals[i]);
  return obj.id ? obj : null;
}

function writeRow_(ss, entityName, obj, rowIndex) {
  var def = SCHEMA[entityName];
  var sh = getSheet(ss, def.sheet);
  var header = headerFor(def.sheet);
  var row = header.map(function (col) { return serializeCell(col, obj[col]); });
  if (rowIndex && rowIndex > 1) {
    sh.getRange(rowIndex, 1, 1, header.length).setValues([row]);
  } else {
    sh.appendRow(row);
    rowIndex = sh.getLastRow();
    noteAppendedRow_(entityName, obj && obj.id, rowIndex);
  }
  return rowIndex;
}

/**
 * upsert با سیاست «آخرین نوشتن برنده» در سطح همان ردیف.
 * اگر نسخه‌ی موجود روی سرور جدیدتر باشد، نوشتن رد می‌شود و تعارض گزارش می‌گردد.
 */
function upsertEntity(ss, entityName, incoming, options) {
  var opts = options || {};
  if (!incoming || !incoming.id) return { applied: false, reason: "NO_ID" };
  var def = SCHEMA[entityName];
  var header = headerFor(def.sheet);
  var sh = getSheet(ss, def.sheet);
  var rowIndex = rowIndexOfId(ss, entityName, incoming.id);

  var incUpdated = toMs(incoming.updatedAt) || nowMs();
  var incCreated = toMs(incoming.createdAt) || incUpdated;

  if (rowIndex > 1) {
    var existingRow = sh.getRange(rowIndex, 1, 1, header.length).getValues()[0];
    var existing = {};
    header.forEach(function (col, i) { existing[col] = deserializeCell(col, existingRow[i]); });
    var srvUpdated = toMs(existing.updatedAt);
    if (!opts.force && srvUpdated > incUpdated) {
      return { applied: false, reason: "SERVER_NEWER", serverUpdatedAt: srvUpdated, row: rowIndex };
    }
    var merged = existing;
    header.forEach(function (col) {
      if (incoming[col] !== undefined) merged[col] = incoming[col];
    });
    merged.createdAt = toMs(merged.createdAt) || incCreated;
    merged.updatedAt = incUpdated;
    merged.syncedAt = nowMs();
    if (incoming.deleted === undefined) merged.deleted = toBool(existing.deleted);
    writeRow_(ss, entityName, merged, rowIndex);
    return { applied: true, reason: "UPDATED", row: rowIndex, updatedAt: incUpdated };
  }

  var fresh = {};
  header.forEach(function (col) { if (incoming[col] !== undefined) fresh[col] = incoming[col]; });
  fresh.id = String(incoming.id);
  fresh.createdAt = incCreated;
  fresh.updatedAt = incUpdated;
  fresh.syncedAt = nowMs();
  fresh.deleted = toBool(incoming.deleted);
  writeRow_(ss, entityName, fresh, 0);
  return { applied: true, reason: "INSERTED", row: sh.getLastRow(), updatedAt: incUpdated };
}

/* مهرِ زمانیِ tombstone (رفع ایراد P0-۳: نشت حذف)

   اگر ساعت کلاینت عقب باشد و `atMs` با همان ساعتِ عقب فرستاده شود، tombstone با
   `updatedAt` قدیمی ثبت می‌شد. بعداً اگر همان رکورد روی دستگاه دیگری زنده شود و
   با `updatedAt` جدیدتر push گردد، LWW آن را برنده می‌کند و **رکورد حذف‌شده
   دوباره زنده می‌شود**.

   حالا مهر حذف هرگز از این سه مقدار کمتر نیست:
     ۱) `atMs` ارسالی کلاینت (ترتیب واقعی حذف‌ها بین چند عملیات یک دسته حفظ شود)
     ۲) ساعت سرور (`nowMs`) — سپر اصلی در برابر clock skew
     ۳) `updatedAt` فعلی همان ردیف روی سرور — تا حذف، از نسخه‌ی موجود قدیمی‌تر نشود

   نتیجه: حذف همیشه «دیرتر» از هر چیزی است که تا此刻 روی سرور بوده، پس هیچ
   push بعدی با مهر قدیمی‌تر نمی‌تواند آن را برگرداند. (کلاینتی با ساعتِ
   آینده‌دار همچنان می‌تواند برنده شود — این محدودیت ذاتی LWW است و در README
   بند ۷ آمده.) */
function tombstoneMs_(ss, entityName, atMs, rowIndex) {
  var ts = Math.max(toMs(atMs) || 0, nowMs());
  if (rowIndex > 1) {
    var cur = readRowAt_(ss, entityName, rowIndex);
    if (cur) ts = Math.max(ts, toMs(cur.updatedAt) || 0);
  }
  return ts;
}

function deleteEntity(ss, entityName, id, atMs) {
  var rowIndex = rowIndexOfId(ss, entityName, id);
  if (rowIndex < 2) {
    // tombstone برای موجودیتی که هرگز روی سرور نبوده: ثبت می‌شود تا به بقیه‌ی
    // دستگاه‌ها هم اعلام شود این رکورد حذف شده است.
    var ts0 = tombstoneMs_(ss, entityName, atMs, -1);
    var tomb = { id: String(id), deleted: true, createdAt: ts0, updatedAt: ts0 };
    upsertEntity(ss, entityName, tomb, { force: true });
    return { applied: true, reason: "TOMBSTONE_CREATED" };
  }

  // نوشتن **اتمی** (رفع ایراد #20)
  //
  // پیش‌تر سه سلول با سه `setValue` جداگانه نوشته می‌شدند. چون `db.pull` عمداً
  // قفل نمی‌گیرد (فقط می‌خواند و قفل‌کردنش توان عملیاتی را نصف می‌کرد)، یک pull
  // هم‌زمان می‌توانست ردیف را وسط نوشتن ببیند: مثلاً `deleted=true` ولی
  // `updatedAt` هنوز قدیمی — که در کلاینت به‌شکل «رکورد حذف شده اما مهرش از
  // نسخه‌ی محلی قدیمی‌تر است» ظاهر می‌شد.
  //
  // حالا کل ردیف با یک `setValues` نوشته می‌شود، پس خواننده یا ردیف کاملاً
  // قدیمی را می‌بیند یا کاملاً جدید را؛ حالت میانی وجود ندارد.
  var cur = readRowAt_(ss, entityName, rowIndex) || {};
  var ts = Math.max(toMs(atMs) || 0, nowMs(), toMs(cur.updatedAt) || 0);
  cur.id = String(id);
  cur.deleted = true;
  cur.updatedAt = ts;
  cur.syncedAt = nowMs();
  writeRow_(ss, entityName, cur, rowIndex);
  return { applied: true, reason: "TOMBSTONED", row: rowIndex, updatedAt: ts };
}

/* =====================================================================
   ۵. _meta (revision، تنظیمات، شمارنده‌ها)
   ===================================================================== */

function metaGet(ss, key, fallback) {
  var sh = getSheet(ss, "_meta");
  var last = sh.getLastRow();
  if (last < 2) return fallback;
  var vals = sh.getRange(2, 1, last - 1, 2).getValues();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(key)) {
    return (vals[i][1] === "" || vals[i][1] === null) ? fallback : vals[i][1];
  }
  return fallback;
}

function metaSet(ss, key, value) {
  var sh = getSheet(ss, "_meta");
  var last = sh.getLastRow();
  var rowIndex = -1;
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(key)) { rowIndex = i + 2; break; }
  }
  var row = [String(key), (value === null || value === undefined) ? "" : String(value), nowMs()];
  if (rowIndex > 1) sh.getRange(rowIndex, 1, 1, 3).setValues([row]);
  else sh.appendRow(row);
  return value;
}

function getRevision(ss) { return toNum(metaGet(ss, "revision", 0)); }

function bumpRevision(ss) {
  var r = getRevision(ss) + 1;
  metaSet(ss, "revision", r);
  metaSet(ss, "updatedAt", nowMs());
  return r;
}

function getSettings(ss) {
  var s = safeJsonParse(metaGet(ss, "settings", "{}"), {});
  return {
    orgName: s.orgName || "",
    passThreshold: toNum(s.passThreshold === undefined ? 80 : s.passThreshold),
    logoFileId: s.logoFileId || "",
    managerPinHash: s.managerPinHash || "",
    managerPinSalt: s.managerPinSalt || "",
    managerPinAlgo: s.managerPinAlgo || "",
    managerPinIterations: toNum(s.managerPinIterations || 0),
    categories: s.categories || null
  };
}

function setSettings(ss, patch) {
  var s = safeJsonParse(metaGet(ss, "settings", "{}"), {});
  Object.keys(patch || {}).forEach(function (k) {
    if (patch[k] !== undefined) s[k] = patch[k];
  });
  metaSet(ss, "settings", JSON.stringify(s));
  return s;
}

/* =====================================================================
   ۶. امنیت: کلید API، امضای درخواست، محدودسازی نرخ
   ===================================================================== */

/* حداقل کیفیت کلید API در حالت bootstrap.
   آنتروپی با تعداد نویسه‌های متمایز تقریب زده می‌شود: کلیدی مثل "aaaaaaaa..."
   با وجود طول کافی، فقط ۱ نویسه‌ی متمایز دارد و قابل حدس است. */
var MIN_BOOTSTRAP_KEY_LEN = 32;
var MIN_BOOTSTRAP_KEY_DISTINCT = 8;

function weakKeyReason_(key) {
  var k = String(key || "");
  if (k.length < MIN_BOOTSTRAP_KEY_LEN) {
    return "کلید API بیش از حد کوتاه است (حداقل " + MIN_BOOTSTRAP_KEY_LEN +
      " نویسه لازم است؛ ارسال‌شده: " + k.length + "). یک کلید تصادفی قوی بسازید.";
  }
  var seen = {};
  for (var i = 0; i < k.length; i++) seen[k.charAt(i)] = true;
  var distinct = Object.keys(seen).length;
  if (distinct < MIN_BOOTSTRAP_KEY_DISTINCT) {
    return "کلید API آنتروپی کافی ندارد (فقط " + distinct +
      " نویسه‌ی متمایز؛ حداقل " + MIN_BOOTSTRAP_KEY_DISTINCT + " لازم است).";
  }
  if (/^[a-zA-Z\u0600-\u06FF]+$/.test(k) && k.toLowerCase() === k.toUpperCase()) {
    // بدون عدد/نماد — قابل قبول است ولی هشدار ثبت می‌شود
    Logger.log("checkApiKey: کلید bootstrap فقط حرف دارد؛ کلید ترکیبی قوی‌تر است.");
  }
  return "";
}

function checkApiKey(provided) {
  var saved = String(prop("API_KEY", "")).trim();
  var given = String(provided || "").trim();
  if (!saved) {
    // دیگر «اولین کلید ارسالی» به‌طور خودکار ثبت نمی‌شود (ایراد ۱-۵)، مگر آن‌که
    // صریحاً اجازه‌ی راه‌اندازی اولیه داده شده باشد.
    if (String(prop("ALLOW_KEY_BOOTSTRAP", "")).toLowerCase() === "true" && given) {
      // بدون این بررسی، هر کسی می‌توانست زودتر از همه کلید ضعیفی مثل "a" بفرستد
      // و آن را به‌عنوان API_KEY کل سامانه ثبت کند (پنجره‌ی حمله‌ی کلاسیک در
      // حالت bootstrap). حداقل طول و آنتروپی الزامی شد.
      var weak = weakKeyReason_(given);
      if (weak) return { ok: false, error: weak };
      props().setProperty("API_KEY", given);
      Logger.log("checkApiKey: کلید API در حالت bootstrap ثبت شد. ALLOW_KEY_BOOTSTRAP را حذف کنید.");
      return { ok: true, bootstrapped: true };
    }
    return { ok: false, error: "کلید API در Script Properties تنظیم نشده است. ابتدا API_KEY را ثبت کنید." };
  }
  if (!given) return { ok: false, error: "کلید API ارسال نشده است." };
  if (constantTimeEquals(given, saved)) return { ok: true };
  return { ok: false, error: "کلید API نامعتبر است." };
}

/**
 * امضای درخواست: HMAC-SHA256(apiKey, action|ts|nonce)
 * از replay (بازپخش درخواست ضبط‌شده) با پنجره‌ی زمانی و nonce یک‌بارمصرف
 * جلوگیری می‌کند. اگر REQUIRE_SIGNATURE فعال نباشد، نبودِ امضا خطا نیست.
 */
function checkSignature(payload) {
  var required = String(prop("REQUIRE_SIGNATURE", "")).toLowerCase() === "true";
  var sig = String(payload.sig || payload.signature || "");
  if (!sig) {
    return required ? { ok: false, error: "امضای درخواست (sig) ارسال نشده است." } : { ok: true, skipped: true };
  }
  var ts = toNum(payload.ts);
  if (!ts) return { ok: false, error: "timestamp درخواست نامعتبر است." };
  var skew = Math.abs(nowMs() - ts) / 1000;
  if (skew > MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, error: "ساعت دستگاه با سرور بیش از حد اختلاف دارد (" + Math.round(skew) + " ثانیه)." };
  }
  var nonce = String(payload.nonce || "");
  if (!nonce) return { ok: false, error: "nonce درخواست ارسال نشده است." };
  var cache = CacheService.getScriptCache();
  var nonceKey = "nonce_" + sha256Hex(nonce).slice(0, 40);
  if (cache.get(nonceKey)) return { ok: false, error: "این درخواست پیش‌تر پردازش شده است (replay)." };
  var expected = hmacSha256Hex(String(prop("API_KEY", "")), [payload.action, ts, nonce].join("|"));
  if (!constantTimeEquals(expected, sig)) return { ok: false, error: "امضای درخواست معتبر نیست." };
  try { cache.put(nonceKey, "1", MAX_CLOCK_SKEW_SECONDS * 2); } catch (eCache) {}
  return { ok: true };
}

function checkRateLimit(key) {
  var cache = CacheService.getScriptCache();
  var bucket = Math.floor(nowMs() / 60000);
  var cacheKey = "rl_" + sha256Hex(String(key)).slice(0, 24) + "_" + bucket;
  var count = toNum(cache.get(cacheKey));
  var max = rateLimitPerMinute();
  if (count >= max) {
    return { ok: false, error: "تعداد درخواست‌ها بیش از حد مجاز است (" + max + " در دقیقه)؛ کمی صبر کنید." };
  }
  try { cache.put(cacheKey, String(count + 1), 120); } catch (ePut) {}
  return { ok: true };
}

/* =====================================================================
   ۶-ب. نشست کاربر و کنترل دسترسی مبتنی بر نقش (RBAC سمت سرور)
   =====================================================================
   قبل از این نسخه، صفحات «تنظیمات» و «کاربران» فقط سمت کلاینت (React) با
   `if (!perms.isAdmin) return <NoAccess/>` محافظت می‌شدند. چون تمام درخواست‌ها
   با یک API_KEY مشترکِ کل سازمان امضا می‌شوند (نه با هویت شخصی)، هر کاربری که
   آن کلید را در مرورگر خودش می‌بیند (DevTools → Network/Application) می‌توانست
   مستقیماً به وب‌سرویس درخواست بزند و همان محدودیت را دور بزند — مثلاً نقش خودش
   را در جدول کاربران به admin تغییر دهد یا URL/تنظیمات را دستکاری کند.
   این بخش یک لایه‌ی نشست واقعی (session token) و بررسی نقش سمت سرور اضافه
   می‌کند که مستقل از UI است و نمی‌توان با دستکاری کلاینت دور زد.
   ------------------------------------------------------------------ */

var SESSION_TTL_MS = 24 * 60 * 60 * 1000; // ۲۴ ساعت — ورود معمولی (بدون «مرا به خاطر بسپار»)
// ورود با «مرا به خاطر بسپار»: چون نشست در localStorage ماندگار می‌ماند ولی
// توکن سرور تا امروز همیشه فقط ۲۴ ساعت معتبر بود، کاربرانی که تب را می‌بستند
// و روز بعد (یا آخر هفته) برمی‌گشتند، هرچند در UI هنوز «واردشده» دیده
// می‌شدند، اولین نوشتنِ واقعی روی سرور رد می‌شد — و چون رمز هرگز محلی ذخیره
// نمی‌شود، تنها راه گرفتن توکن تازه، ورودِ دستی دوباره (کاربرنام+رمز) بود.
// یعنی «مرا به خاطر بسپار» عملاً فقط چند ساعت فرقی با حالت عادی نداشت.
// راه‌حل: توکنِ ورودهای «به‌خاطر سپرده‌شده» عمر بلندتری (۳۰ روز) می‌گیرد.
// امنیت با این کار ضعیف نمی‌شود، چون ابطال واقعی از راه TTL نیست: هر درخواست
// sessionVersion توکن را با مقدار زنده‌ی ردیف کاربر مقایسه می‌کند
// (resolveSession_)، پس تغییر رمز/غیرفعال‌سازی/ابطال دستی هنوز فوری اثر
// می‌کند، صرف‌نظر از TTL باقی‌مانده‌ی توکن.
var SESSION_TTL_REMEMBER_MS = 30 * 24 * 60 * 60 * 1000; // ۳۰ روز

/**
 * توکن نشست: base64url(JSON claims) + "." + HMAC-SHA256(API_KEY, همان بخش اول)
 * claims = { uid, sv (sessionVersion در لحظه‌ی ورود), exp }.
 * نقش (role) عمداً داخل توکن ذخیره نمی‌شود — هر بار از ردیف زنده‌ی کاربر در
 * شیت خوانده می‌شود (resolveSession_) تا تنزل نقش/غیرفعال‌سازی فوراً اثر کند،
 * نه فقط بعد از انقضای توکن.
 * @param {boolean} [remember] اگر true باشد (کاربر «مرا به خاطر بسپار» را زده)
 *   از SESSION_TTL_REMEMBER_MS (۳۰ روز) استفاده می‌شود، وگرنه SESSION_TTL_MS (۲۴ ساعت).
 */
function issueSessionToken_(user, remember) {
  var ttl = remember ? SESSION_TTL_REMEMBER_MS : SESSION_TTL_MS;
  var claims = { uid: String(user.id), sv: toNum(user.sessionVersion) || 1, exp: nowMs() + ttl };
  var body = Utilities.base64EncodeWebSafe(JSON.stringify(claims));
  var sig = hmacSha256Hex(String(prop("API_KEY", "")), body);
  return { token: body + "." + sig, exp: claims.exp };
}

function parseSessionToken_(token) {
  var parts = String(token || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, error: "نشست نامعتبر است." };
  var expected = hmacSha256Hex(String(prop("API_KEY", "")), parts[0]);
  if (!constantTimeEquals(expected, parts[1])) return { ok: false, error: "نشست نامعتبر است (امضا نامعتبر)." };
  var claims;
  try {
    claims = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (eDecode) {
    return { ok: false, error: "نشست نامعتبر است (رمزگشایی ناموفق)." };
  }
  if (!claims || !claims.uid) return { ok: false, error: "نشست نامعتبر است." };
  if (toNum(claims.exp) < nowMs()) return { ok: false, error: "نشست منقضی شده؛ دوباره وارد شوید.", expired: true };
  return { ok: true, claims: claims };
}

/**
 * توکن نشست را از body می‌خواند، صحت/انقضای آن را بررسی می‌کند و ردیف زنده‌ی
 * کاربر را برمی‌گرداند (نه اطلاعات ذخیره‌شده در خود توکن) تا نقش/وضعیت active
 * همیشه به‌روز باشد.
 */
function resolveSession_(ss, body) {
  var token = String((body && (body.sessionToken || body.session || body.token)) || "");
  if (!token) return { ok: false, error: "برای این عملیات ابتدا باید وارد شوید.", code: "NO_SESSION" };
  var parsed = parseSessionToken_(token);
  if (!parsed.ok) return { ok: false, error: parsed.error, code: parsed.expired ? "SESSION_EXPIRED" : "SESSION_INVALID" };
  var user = findEntity(ss, "users", parsed.claims.uid);
  if (!user || user.deleted || !toBool(user.active)) {
    return { ok: false, error: "حساب کاربری غیرفعال یا حذف شده است.", code: "SESSION_INVALID" };
  }
  if (toNum(user.sessionVersion) !== toNum(parsed.claims.sv)) {
    return { ok: false, error: "نشست منقضی شده (رمز عبور تغییر کرده)؛ دوباره وارد شوید.", code: "SESSION_EXPIRED" };
  }
  return { ok: true, user: user };
}

function requireRole_(session, roles) {
  if (!session.ok) return session;
  if (roles.indexOf(session.user.role) === -1) {
    return { ok: false, error: "دسترسی کافی نیست (این عملیات فقط برای نقش " + roles.join(" یا ") + " مجاز است).", code: "FORBIDDEN" };
  }
  return { ok: true, user: session.user };
}

// موجودیت‌هایی که تغییرشان نیازمند نقش خاص است + نقش‌های مجاز برای هرکدام.
// دامنه‌ی این فهرست عمداً محدود به همان چیزی است که در UI هم «فقط ادمین»
// علامت خورده (صفحه‌ی تنظیمات و صفحه‌ی مدیریت کاربران): «settings» و «users».
// «categories» چون از همان صفحه‌ی تنظیمات مدیریت می‌شود و تغییرش سراسری و
// جایگزین‌کننده است (kind=set) هم به همین سطح افزوده شده. «templates»،
// «assets»، «assignments» و «records» عمداً اینجا نیستند — این‌ها بخشی از
// جریان کاری روزمره‌ی نقش‌های غیرادمین (سرپرست/بازرس) هستند و محدودسازی
// نقششان نیاز به تحلیل جداگانه‌ی هر مورد دارد؛ گسترده‌کردن RBAC به آن‌ها
// بدون بررسی مجزا می‌تواند گردش کار عادی را بشکند.
var GUARDED_ENTITY_ROLES_ = {
  users: ["admin"],
  settings: ["admin"],
  categories: ["admin", "manager"]
};

/**
 * پیش از اعمال هر نوشتن روی یک موجودیت محافظت‌شده فراخوانی می‌شود.
 * برمی‌گرداند: { ok:true } یا { ok:false, error }.
 * استثنا: کاربر همیشه اجازه دارد رکورد خودش را در جدول users ویرایش کند
 * (مثلاً تغییر رمز عبور)، اما اگر ادمین نباشد، فیلدهای حساس (role/active/
 * pages/username) را نمی‌تواند از راه این مسیر تغییر دهد — این‌ها به مقدار
 * فعلی سرور «پین» می‌شوند تا ارتقای خودکار نقش (privilege escalation) از راه
 * ویرایش پروفایل خود ممکن نباشد.
 */
/**
 * آیا حداقل یک کاربر «ادمین» فعال در پایگاه هست؟ اگر نه (راه‌اندازی اولیه‌ی
 * پایگاه تازه)، اولین نوشتن روی کاربران بدون نشست هم پذیرفته می‌شود — دقیقاً
 * همان فلسفه‌ی ALLOW_KEY_BOOTSTRAP برای API_KEY: یک پنجره‌ی اعتماد یک‌باره‌ی
 * راه‌اندازی، نه یک راه دور زدن دائمی. کلاینت هنگام اولین اتصال، ادمین
 * پیش‌فرض محلی («u-admin») را دقیقاً از همین مسیر به سرور می‌فرستد؛ بدون این
 * استثنا هیچ‌کس هرگز نمی‌توانست اولین حساب ادمین را روی یک Sheet خالی بسازد.
 */
function hasAdminUser_(ss) {
  var users = readTable(ss, "users");
  for (var i = 0; i < users.length; i++) {
    if (!users[i].deleted && toBool(users[i].active) && users[i].role === "admin") return true;
  }
  return false;
}

function guardEntityWrite_(ss, entity, kind, data, body) {
  var roles = GUARDED_ENTITY_ROLES_[entity];
  if (!roles) return { ok: true };

  if (entity === "users" && kind !== "delete" && !hasAdminUser_(ss)) {
    return { ok: true, bootstrap: true };
  }

  var session = resolveSession_(ss, body);

  if (entity === "users" && kind !== "delete" && session.ok && data && String(data.id) === String(session.user.id)) {
    if (session.user.role !== "admin") {
      var current = findEntity(ss, "users", session.user.id) || {};
      ["role", "active", "pages", "username"].forEach(function (f) {
        if (current[f] !== undefined) data[f] = current[f]; else delete data[f];
      });
    }
    return { ok: true, selfEdit: true };
  }

  var check = requireRole_(session, roles);
  if (!check.ok) return { ok: false, error: check.error };
  return { ok: true };
}

/* =====================================================================
   ۶-ج. لینک دعوت یک‌بارمصرف
   =====================================================================
   مشکلی که این بخش حل می‌کند: برای این‌که یک کاربر عادی روی دستگاه تازه‌اش
   بتواند اصلاً به سرور وصل شود، باید API_KEY سازمانی را جایی وارد کند. تا حالا
   تنها راه این بود که ادمین آن کلید را مستقیم (پیامک/تلگرام/چت) به او بدهد —
   یعنی یک راز کل‌سازمانی دست هرکسی که قرار است حتی یک بار وصل شود می‌افتد و
   هیچ‌وقت هم قابل ردیابی/لغو مجزا نیست.
   به‌جایش، ادمین یک «توکن دعوت» تصادفی و کوتاه‌عمر (پیش‌فرض ۷۲ ساعت) می‌سازد.
   کاربر تازه با بازکردن لینکی که این توکن را دارد (نه خودِ API_KEY را)، یک
   درخواست auth.redeemInvite می‌زند؛ سرور توکن را یک‌بار مصرف می‌کند و در ازایش
   API_KEY واقعی را برمی‌گرداند تا کلاینت مثل قبل آن را محلی ذخیره کند. اگر
   توکن قبلاً مصرف شده، منقضی شده، یا لغو شده باشد، هیچ‌چیز برنمی‌گردد.
   ------------------------------------------------------------------ */

var INVITE_DEFAULT_TTL_HOURS = 72;
var INVITE_MAX_TTL_HOURS = 24 * 30; // حداکثر یک ماه، برای جلوگیری از دعوت‌های ابدی

function generateInviteToken_() {
  return "inv_" + Utilities.getUuid().replace(/-/g, "") +
    sha256Hex(String(Math.random()) + nowMs() + Math.random()).slice(0, 24);
}

/** تمام سطرهای شیت invites را با نام ستون می‌خواند (جدول کوچک است، اسکن کامل کافی‌ست). */
function readInviteRows_(ss) {
  var sh = getSheet(ss, "invites");
  var last = sh.getLastRow();
  var header = headerFor("invites");
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, header.length).getValues();
  return vals.map(function (row, i) {
    var o = { rowIndex_: i + 2 };
    header.forEach(function (col, j) { o[col] = row[j]; });
    return o;
  });
}

function findInviteRowByToken_(ss, token) {
  var rows = readInviteRows_(ss);
  for (var i = 0; i < rows.length; i++) if (String(rows[i].token) === String(token)) return rows[i];
  return null;
}

/**
 * ادمین یک توکن دعوت تازه می‌سازد. فقط نقش admin مجاز است (مثل settings/users).
 */
function handleInviteCreate(ss, body) {
  var session = resolveSession_(ss, body);
  var check = requireRole_(session, ["admin"]);
  if (!check.ok) return err(check.error);

  var ttlHours = Math.min(INVITE_MAX_TTL_HOURS, Math.max(1, toNum(body.ttlHours) || INVITE_DEFAULT_TTL_HOURS));
  var token = generateInviteToken_();
  var at = nowMs();
  var row = {
    id: "invite-" + Utilities.getUuid(),
    token: token,
    role: String(body.role || ""), // فقط یادداشتی/نمایشی؛ نقش واقعی هنگام ساخت کاربر تعیین می‌شود
    note: String(body.note || "").slice(0, 300),
    createdBy: session.user.username,
    createdAt: at,
    expiresAt: at + ttlHours * 3600000,
  };
  getSheet(ss, "invites").appendRow([row.id, row.token, row.role, row.note, row.createdBy, row.createdAt, row.expiresAt, "", ""]);
  return { ok: true, status: "success", token: token, expiresAt: row.expiresAt, createdAt: at };
}

/** فهرست دعوت‌های ساخته‌شده برای مدیریت (فقط ادمین). توکن کامل هرگز در فهرست برنمی‌گردد. */
function handleInviteList(ss, body) {
  var session = resolveSession_(ss, body);
  var check = requireRole_(session, ["admin"]);
  if (!check.ok) return err(check.error);
  var now = nowMs();
  var rows = readInviteRows_(ss).map(function (r) {
    var used = !!r.usedAt;
    var revoked = String(r.usedByUserId) === "REVOKED";
    var expired = !used && toNum(r.expiresAt) < now;
    return {
      id: r.id, tokenPreview: String(r.token).slice(0, 10) + "…", note: r.note, createdBy: r.createdBy,
      createdAt: toNum(r.createdAt), expiresAt: toNum(r.expiresAt),
      status: revoked ? "revoked" : used ? "used" : expired ? "expired" : "pending",
    };
  }).sort(function (a, b) { return b.createdAt - a.createdAt; });
  return { ok: true, status: "success", invites: rows };
}

/** لغو یک دعوت هنوز مصرف‌نشده (فقط ادمین). با id کار می‌کند، نه توکن کامل. */
function handleInviteRevoke(ss, body) {
  var session = resolveSession_(ss, body);
  var check = requireRole_(session, ["admin"]);
  if (!check.ok) return err(check.error);
  var sh = getSheet(ss, "invites");
  var rows = readInviteRows_(ss);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(body.id)) {
      if (rows[i].usedAt) return err("این دعوت قبلاً مصرف یا لغو شده است.");
      sh.getRange(rows[i].rowIndex_, 8, 1, 2).setValues([[nowMs(), "REVOKED"]]);
      return { ok: true, status: "success" };
    }
  }
  return err("دعوت پیدا نشد.");
}

/**
 * بازکردن لینک دعوت: تنها عملیاتی که بدون API_KEY فراخوانی می‌شود. توکن را
 * بررسی می‌کند (وجود/انقضا/مصرف‌نشدگی) و در صورت معتبربودن، همان لحظه آن را
 * «مصرف‌شده» علامت می‌زند (ضد استفاده‌ی مجدد از یک لینک) و API_KEY واقعی را
 * برمی‌گرداند. یک قفل کوتاه می‌گیرد تا دو درخواست هم‌زمان با یک توکن، هردو را
 * با موفقیت مصرف نکنند.
 */
function handleInviteRedeem(ss, body) {
  var token = String((body && body.token) || "").trim();
  if (!token) return err("توکن دعوت ارسال نشده است.");

  var lock = LockService.getScriptLock();
  var locked = false;
  try { locked = lock.tryLock(3000); } catch (eLock) { locked = false; }
  try {
    var row = findInviteRowByToken_(ss, token);
    if (!row) return err("لینک دعوت نامعتبر است.", { code: "INVITE_INVALID" });
    if (row.usedAt) {
      var revoked = String(row.usedByUserId) === "REVOKED";
      return err(revoked ? "این لینک دعوت لغو شده است." : "این لینک دعوت قبلاً استفاده شده است.", { code: "INVITE_USED" });
    }
    if (toNum(row.expiresAt) < nowMs()) return err("این لینک دعوت منقضی شده است؛ از ادمین یک لینک تازه بخواهید.", { code: "INVITE_EXPIRED" });

    getSheet(ss, "invites").getRange(row.rowIndex_, 8, 1, 2).setValues([[nowMs(), "redeemed"]]);
    writeAuditLog("auth.redeemInvite", { payload: { note: row.note } }, 0, "invite:" + row.id);
    return {
      ok: true, status: "success",
      apiKey: String(prop("API_KEY", "")),
      orgName: getSettings(ss).orgName || "",
    };
  } finally {
    try { if (locked) lock.releaseLock(); } catch (eUnlock) {}
  }
}

/* =====================================================================
   ۷. ورودی اصلی: doPost / doGet
   ===================================================================== */

function doPost(e) {
  var lock = LockService.getScriptLock();
  var locked = false;
  var started = nowMs();
  var payload = null;
  var action = "unknown";
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return responseJson({ ok: false, status: "error", error: "بدنه درخواست خالی است." });
    }
    payload = JSON.parse(e.postData.contents);
    action = String(payload.action || "db.push");

    // عملیات عمومی (بدون کلید)
    if (action === "ping" || action === "test") return responseJson(handlePing(payload));
    if (action === "version" || action === "health") {
      return responseJson({ ok: true, status: "success", version: SERVER_VERSION, time: new Date().toISOString() });
    }
    // بازکردن لینک دعوت: تنها عملیاتی که بدون API_KEY پذیرفته می‌شود، چون خودِ
    // این عملیات مسیر گرفتن API_KEY است (رفع نیاز به اشتراک‌گذاری دستی کلید
    // با کاربران عادی). امنیتش از راه یک توکن یک‌بارمصرفِ کوتاه‌عمر تأمین
    // می‌شود، نه از راه apiKey/امضا؛ به همین دلیل هم جدا محدود به نرخ می‌شود.
    if (action === "auth.redeemInvite") {
      var rlInvite = checkRateLimit("invite_" + sha256Hex(String((payload.payload || payload).token || "")).slice(0, 16));
      if (!rlInvite.ok) return responseJson(err(rlInvite.error));
      return responseJson(handleInviteRedeem(getDb(), payload.payload || payload));
    }

    var auth = checkApiKey(payload.apiKey);
    if (!auth.ok) return responseJson(err(auth.error));
    var sig = checkSignature(payload);
    if (!sig.ok) return responseJson(err(sig.error));
    var rl = checkRateLimit(payload.apiKey);
    if (!rl.ok) return responseJson(err(rl.error));

    var isWrite = WRITE_ACTIONS[action] !== false;
    if (isWrite) locked = lock.tryLock(LOCK_WAIT_MS);
    if (isWrite && !locked) return responseJson(err("سرور در حال پردازش درخواست دیگری است؛ لحظاتی دیگر تلاش کنید."));

    var body = payload.payload || payload;
    var result = routeAction(action, body, payload);
    result = result || err("پاسخی تولید نشد.");
    // اگر هندلر خودش زمان مرجع تعیین کرده (مثل db.pull) بازنویسی نمی‌شود
    if (result.serverTime === undefined) result.serverTime = started;
    result.version = SERVER_VERSION;
    result.ms = nowMs() - started;
    return responseJson(result);

  } catch (err_) {
    return responseJson(err("خطا در سرور: " + (err_ && err_.message ? err_.message : String(err_))));
  } finally {
    try { if (locked) lock.releaseLock(); } catch (e2) {}
    try { writeAuditLog(action, payload, nowMs() - started); } catch (e3) {}
  }
}

function doGet(e) {
  return responseJson({
    ok: true, status: "success", version: SERVER_VERSION,
    message: "وب‌سرویس سامانه چک‌لیست درکاو فعال است.",
    time: new Date().toISOString()
  });
}

function err(message, extra) {
  var o = { ok: false, status: "error", error: String(message || "خطای نامشخص") };
  o.message = o.error;
  if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
  return o;
}

// کدام actionها «خواندنی» هستند (قفل نوشتن نمی‌گیرند)
var WRITE_ACTIONS = {
  "db.pull": false, "db.revision": false, "bootstrap": false, "settings.get": false,
  "records.list": false, "records.get": false, "records.signature": false,
  "users.get": false, "auth.login": false, "list_records": false, "export_zip": false,
  "invites.list": false
};

function routeAction(action, body, envelope) {
  var ss = getDb();
  var rootName = rootFolderName(envelope || body);

  switch (action) {
    case "bootstrap":        return handleBootstrap(ss, body);
    case "db.pull":          return handleDbPull(ss, body);
    case "db.push":          return handleDbPush(ss, body);
    case "db.revision":      return { ok: true, status: "success", revision: getRevision(ss) };
    case "db.snapshot":      return handleSnapshot(ss, body);

    case "auth.login":       return handleAuthLogin(ss, body);
    case "invites.create":   return handleInviteCreate(ss, body);
    case "invites.list":     return handleInviteList(ss, body);
    case "invites.revoke":   return handleInviteRevoke(ss, body);
    case "users.get":        return handleUsersGet(ss, body);
    case "users.upsert":     return handleSimpleUpsert(ss, "users", body.user || body, body);
    case "users.delete":     return handleSimpleDelete(ss, "users", body.id, body);
    case "users.list":       return { ok: true, status: "success", revision: getRevision(ss), users: readTable(ss, "users") };

    case "templates.upsert": return handleSimpleUpsert(ss, "templates", body.template || body, body);
    case "templates.delete": return handleSimpleDelete(ss, "templates", body.id, body);
    case "templates.list":   return { ok: true, status: "success", revision: getRevision(ss), templates: readTable(ss, "templates") };

    case "assets.upsert":    return handleSimpleUpsert(ss, "assets", body.asset || body, body);
    case "assets.delete":    return handleSimpleDelete(ss, "assets", body.id, body);
    case "assets.list":      return { ok: true, status: "success", revision: getRevision(ss), assets: readTable(ss, "assets") };

    case "assignments.upsert": return handleSimpleUpsert(ss, "assignments", body.assignment || body, body);
    case "assignments.delete": return handleSimpleDelete(ss, "assignments", body.id, body);
    case "assignments.list":   return { ok: true, status: "success", revision: getRevision(ss), assignments: readTable(ss, "assignments") };

    case "records.append":   return handleRecordUpsert(ss, rootName, body.record || body);
    case "records.upsert":   return handleRecordUpsert(ss, rootName, body.record || body);
    case "records.update":   return handleRecordPatch(ss, rootName, body);
    case "records.delete":   return handleSimpleDelete(ss, "records", body.id);
    case "records.list":     return handleRecordsList(ss, body);
    case "records.get":      return handleRecordGet(ss, body);
    case "records.signature": return handleSignatureGet(ss, body);

    case "categories.set":   return handleCategoriesSet(ss, body);
    case "settings.get":     return { ok: true, status: "success", settings: getSettings(ss) };
    case "settings.set":     return handleSettingsSet(ss, body);

    // ---- سازگاری با نسخه ۷ ----
    case "save_record": case "record": case "save_pdf": case "save_html_pdf":
      return handleSaveRecord(ss, rootName, body);
    case "backup":           return handleBackup(rootName, body);
    case "cloud_push":       return handleLegacyCloudPush(ss, body);
    case "cloud_pull":       return handleLegacyCloudPull(ss);
    case "cloud_meta":       return handleLegacyCloudMeta(ss);
    case "list_records":     return handleLegacyListRecords(ss, rootName, body);
    case "delete_record":    return handleLegacyDeleteRecord(body);
    case "approve_record":   return handleLegacyApproveRecord(rootName, body);
    case "export_zip":       return handleExportZip(rootName, body);

    // ---- مهاجرت ----
    case "migrate.import_json": return handleMigrateImport(ss, rootName, body);

    default:
      return err("action نامعتبر است: " + action);
  }
}

function handlePing(payload) {
  var rootName = rootFolderName(payload);
  var out = {
    ok: true, status: "success", version: SERVER_VERSION,
    message: "اتصال برقرار است.", folderName: rootName, time: new Date().toISOString()
  };
  try {
    var ss = getDb();
    out.revision = getRevision(ss);
    out.dbUrl = ss.getUrl();
    out.counts = countAll(ss);
  } catch (e) { out.dbError = String(e); }
  return out;
}

function countAll(ss) {
  var counts = {};
  ENTITY_NAMES.forEach(function (k) {
    counts[k] = readTable(ss, k, { light: true }).filter(function (r) { return !r.deleted; }).length;
  });
  return counts;
}

/* =====================================================================
   ۸. bootstrap / pull / push — هسته‌ی همگام‌سازی
   ===================================================================== */

function handleBootstrap(ss, body) {
  var settings = getSettings(ss);
  return {
    ok: true, status: "success",
    revision: getRevision(ss),
    serverTime: nowMs(),
    settings: settings,
    counts: countAll(ss),
    schema: ENTITY_NAMES.reduce(function (acc, k) { acc[k] = headerFor(SCHEMA[k].sheet); return acc; }, {})
  };
}

/**
 * دریافت تغییرات از یک لحظه به بعد (delta sync).
 * body.since: epoch ms یا ISO؛ اگر نبود، snapshot کامل برمی‌گردد.
 * body.light: true → ستون‌های سنگین records (details/signatures) حذف می‌شوند.
 */
function handleDbPull(ss, body) {
  // ⚠️ زمان «پیش از» خواندن ثبت می‌شود تا هر نوشتنی که هم‌زمان با این درخواست
  // انجام می‌شود، در همگام‌سازی بعدی از قلم نیفتد.
  var t0 = nowMs();
  var since = toMs(body.since);
  var light = toBool(body.light);
  var out = { ok: true, status: "success", revision: getRevision(ss), serverTime: t0, entities: {}, counts: {} };

  ENTITY_NAMES.forEach(function (k) {
    var all = readTable(ss, k, { light: light });
    // پنجره بر اساس syncedAt (ساعت سرور) بسته می‌شود، نه updatedAt (ساعت کلاینت).
    // از «>=» استفاده می‌شود (نه «>»)؛ ارسال چند ردیف تکراری بی‌ضرر است چون
    // ادغام سمت کلاینت idempotent است، ولی از قلم افتادن یک تغییر فاجعه است.
    var changed = since ? all.filter(function (r) {
      return (toMs(r.syncedAt) || toMs(r.updatedAt)) >= since;
    }) : all;
    out.entities[k] = changed;
    out.counts[k] = changed.length;
  });

  out.settings = getSettings(ss);
  out.full = !since;
  return out;
}

function handleSnapshot(ss, body) { return handleDbPull(ss, { since: 0, light: toBool(body && body.light) }); }

/**
 * اعمال دسته‌ای از عملیات کلاینت.
 * هر op: { opId, clientId, entity, kind: 'upsert'|'delete', id, data|patch, at }
 * - opId تکراری → نادیده (idempotent)
 * - upsert با updatedAt قدیمی‌تر از سرور → تعارض SERVER_NEWER و رد
 */
function handleDbPush(ss, body) {
  var ops = body.ops;
  if (!ops || !ops.length) {
    // حالت سازگار با کلاینت قدیمی: کل داده ارسال شده
    if (body.data) return handleLegacyCloudPush(ss, body);
    return err("هیچ عملیاتی (ops) ارسال نشد.");
  }
  if (ops.length > MAX_OPS_PER_REQUEST) {
    return err("تعداد عملیات در یک درخواست بیش از حد مجاز است (حداکثر " + MAX_OPS_PER_REQUEST + ").");
  }
  var baseRevision = toNum(body.baseRevision || 0);
  var applied = [], conflicts = [], skipped = [], errors = [];
  var touched = false;

  // یک بار نگاشت id→row ساخته می‌شود و بین همه‌ی عملیات‌های این درخواست مشترک است
  beginRowIndexCache_();
  try {
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i] || {};
    try {
      var res = applyOp(ss, op, body);
      if (res.duplicate) skipped.push({ opId: op.opId, reason: "DUPLICATE" });
      else if (res.applied) { applied.push({ opId: op.opId, entity: op.entity, id: res.id, reason: res.reason }); touched = true; }
      else if (res.reason === "SERVER_NEWER") conflicts.push({ opId: op.opId, entity: op.entity, id: res.id, serverUpdatedAt: res.serverUpdatedAt });
      else errors.push({ opId: op.opId, entity: op.entity, id: op.id, error: res.reason });
    } catch (eOp) {
      errors.push({ opId: op.opId, entity: op.entity, id: op.id, error: String(eOp && eOp.message ? eOp.message : eOp) });
    }
  }

  } finally { endRowIndexCache_(); }

  var revision = getRevision(ss);
  if (touched) revision = bumpRevision(ss);

  return {
    ok: true, status: "success",
    revision: revision,
    baseRevision: baseRevision,
    staleBase: baseRevision ? (baseRevision < revision - applied.length) : false,
    applied: applied, conflicts: conflicts, skipped: skipped, errors: errors,
    serverTime: nowMs(),
    message: applied.length + " عملیات اعمال شد."
  };
}

function applyOp(ss, op, body) {
  var opId = String(op.opId || op.id || "");
  if (!opId) opId = "op_" + sha256Hex(JSON.stringify(op)).slice(0, 24);
  if (isDuplicateOp(ss, opId)) return { duplicate: true };

  var entity = String(op.entity || "");
  var kind = String(op.kind || op.type || "upsert").toLowerCase();
  var at = toMs(op.at) || nowMs();
  var result;

  // عملیات «جایگزینی کامل» برای مجموعه‌های کوچک و سراسری
  if (kind === "set") {
    if (entity === "categories" || entity === "settings") {
      var guardSet = guardEntityWrite_(ss, entity, kind, op.data || {}, body);
      // نکته: عمداً recordOp فراخوانی نمی‌شود تا opId «مصرف‌شده» علامت نخورد؛
      // بعد از ورود موفق کاربر، همان op می‌تواند با موفقیت دوباره ارسال شود.
      if (!guardSet.ok) return { applied: false, reason: guardSet.error };
    }
    if (entity === "categories") {
      applyCategoriesSet_(ss, op.data || op.names || []);
      result = { applied: true, reason: "SET", id: "categories" };
    } else if (entity === "settings") {
      applySettingsSet_(ss, op.data || {}, body);
      result = { applied: true, reason: "SET", id: "settings" };
    } else {
      result = { applied: false, reason: "SET_NOT_SUPPORTED" };
    }
    recordOp(ss, opId, op, result);
    return result;
  }

  if (ENTITY_NAMES.indexOf(entity) === -1) return { applied: false, reason: "UNKNOWN_ENTITY" };

  if (kind === "delete" || kind === "remove") {
    var targetId = String(op.id || (op.data && op.data.id) || "");
    if (!targetId) return { applied: false, reason: "NO_ID" };
    var guardDel = guardEntityWrite_(ss, entity, "delete", { id: targetId }, body);
    if (!guardDel.ok) return { applied: false, reason: guardDel.error };
    result = deleteEntity(ss, entity, targetId, at);
    result.id = targetId;
  } else {
    var data = op.data || op.patch || op;
    if (op.patch && op.id) {
      // patch روی ردیف موجود: فقط فیلدهای ارسالی تغییر می‌کنند
      var existing = findEntity(ss, entity, op.id);
      data = existing ? mergeShallow_(existing, op.patch) : mergeShallow_({ id: String(op.id) }, op.patch);
    }
    if (!data.id) data.id = String(op.id || "");
    var guardWrite = guardEntityWrite_(ss, entity, kind, data, body);
    if (!guardWrite.ok) return { applied: false, reason: guardWrite.error };
    if (entity === "records") externalizeSignatures_(ss, data, body);
    if (entity === "records") externalizePhotos_(ss, data, body);
    if (entity === "users") normalizeUser_(data);
    result = upsertEntity(ss, entity, data, { force: toBool(op.force) });
    result.id = String(data.id);
  }

  recordOp(ss, opId, op, result);
  return result;
}

function mergeShallow_(base, patch) {
  var out = {};
  Object.keys(base || {}).forEach(function (k) { out[k] = base[k]; });
  Object.keys(patch || {}).forEach(function (k) { if (patch[k] !== undefined) out[k] = patch[k]; });
  return out;
}

function findEntity(ss, entity, id) {
  // پیش‌تر کل جدول خوانده می‌شد (همه‌ی ستون‌ها، همه‌ی ردیف‌ها) فقط برای پیدا کردن
  // یک رکورد. حالا با کشِ نگاشت، یک lookup + خواندن همان یک ردیف کافی است.
  return readRowAt_(ss, entity, rowIndexOfId(ss, entity, id));
}

function isDuplicateOp(ss, opId) {
  var sh = getSheet(ss, "_ops");
  var last = sh.getLastRow();
  if (last < 2) return false;
  var window_ = Math.min(last - 1, MAX_OPS_LOG_ROWS);
  var vals = sh.getRange(last - window_ + 1, 1, window_, 1).getValues();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(opId)) return true;
  return false;
}

function recordOp(ss, opId, op, result) {
  var sh = getSheet(ss, "_ops");
  sh.appendRow([
    String(opId), String(op.clientId || ""), nowMs(), String(op.entity || ""),
    String(result && result.id ? result.id : (op.id || "")), String(op.kind || "upsert"),
    result && result.applied ? "APPLIED" : (result && result.reason ? result.reason : "NOOP"),
    ""
  ]);
  var last = sh.getLastRow();
  if (last > MAX_OPS_LOG_ROWS + 500) {
    try { sh.deleteRows(2, last - MAX_OPS_LOG_ROWS); } catch (eTrim) {}
  }
}

/* =====================================================================
   ۹. موجودیت‌ها: endpointهای ساده
   ===================================================================== */

function handleSimpleUpsert(ss, entity, data, body) {
  if (!data || !data.id) return err("شناسه (id) ارسال نشد.");
  var guard = guardEntityWrite_(ss, entity, "upsert", data, body || {});
  if (!guard.ok) return err(guard.error);
  if (entity === "users") normalizeUser_(data);
  if (entity === "records") externalizeSignatures_(ss, data, {});
  if (entity === "records") externalizePhotos_(ss, data, {});
  if (!data.updatedAt) data.updatedAt = nowMs();
  var res = upsertEntity(ss, entity, data, {});
  var revision = res.applied ? bumpRevision(ss) : getRevision(ss);
  var out = { ok: true, status: "success", revision: revision, result: res, entity: entity, id: String(data.id) };
  if (!res.applied && res.reason === "SERVER_NEWER") {
    out.ok = false; out.status = "conflict"; out.error = "STALE_WRITE";
    out.serverRow = findEntity(ss, entity, data.id);
  }
  return out;
}

function handleSimpleDelete(ss, entity, id, body) {
  if (!id) return err("شناسه (id) ارسال نشد.");
  var guard = guardEntityWrite_(ss, entity, "delete", { id: id }, body || {});
  if (!guard.ok) return err(guard.error);
  var res = deleteEntity(ss, entity, String(id), nowMs());
  return { ok: true, status: "success", revision: bumpRevision(ss), result: res, entity: entity, id: String(id) };
}

function normalizeUser_(u) {
  if (!u) return;
  // pages همیشه به‌صورت آرایه نگه داشته می‌شود؛ ستون شیت آن را csv ذخیره می‌کند
  if (typeof u.pages === "string") u.pages = u.pages.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
  if (!Array.isArray(u.pages)) u.pages = [];
  if (u.active === undefined) u.active = true;
  u.username = String(u.username || "").trim();
  u.role = String(u.role || "inspector");
  if (u.sessionVersion === undefined) u.sessionVersion = 1;
}

function handleUsersGet(ss, body) {
  var id = body.id || body.userId;
  var username = body.username;
  var users = readTable(ss, "users");
  var found = null;
  for (var i = 0; i < users.length; i++) {
    if (id && String(users[i].id) === String(id)) { found = users[i]; break; }
    if (username && String(users[i].username) === String(username)) { found = users[i]; break; }
  }
  if (!found || found.deleted) return err("کاربر یافت نشد.");
  return { ok: true, status: "success", user: found, revision: getRevision(ss) };
}

/**
 * ورود: هش رمز سمت کلاینت (PBKDF2) ساخته می‌شود و سرور فقط مقایسه می‌کند.
 * PBKDF2 با ۱۰۰ هزار تکرار در Apps Script عملی نیست، بنابراین derivaion
 * حتماً باید سمت مرورگر انجام شود؛ سرور salt و hash را نگه می‌دارد.
 */
function handleAuthLogin(ss, body) {
  var username = String(body.username || "").trim();
  var hash = String(body.passwordHash || body.hash || "");
  if (!username || !hash) return err("نام کاربری و هش رمز ارسال نشد.");
  var users = readTable(ss, "users");
  var u = null;
  for (var i = 0; i < users.length; i++) {
    if (String(users[i].username) === username && !users[i].deleted && toBool(users[i].active)) { u = users[i]; break; }
  }
  if (!u) return err("نام کاربری یا رمز عبور اشتباه است.", { code: "BAD_CREDENTIALS" });
  if (!constantTimeEquals(hash, u.passwordHash)) {
    return err("نام کاربری یا رمز عبور اشتباه است.", { code: "BAD_CREDENTIALS" });
  }
  writeAuditLog("auth.login", { username: username }, 0, username);
  var session = issueSessionToken_(u, toBool(body.remember));
  return {
    ok: true, status: "success", user: u, revision: getRevision(ss),
    sessionVersion: toNum(u.sessionVersion) || 1,
    sessionToken: session.token, sessionExpiresAt: session.exp
  };
}

function handleCategoriesSet(ss, body) {
  var guard = guardEntityWrite_(ss, "categories", "set", body.categories || body.names || {}, body || {});
  if (!guard.ok) return err(guard.error);
  return applyCategoriesSet_(ss, body.categories || body.names || []);
}

/**
 * منطق واقعی جایگزینی کامل دسته‌بندی‌ها، بدون بررسی نقش. `handleCategoriesSet`
 * (مسیر عادی کلاینت از راه db.push/routeAction) این تابع را بعد از تأیید
 * guardEntityWrite_ صدا می‌زند. مسیرهای مهاجرت/import کل پایگاه
 * (handleLegacyCloudPush، importLegacyData) هم مستقیماً از همینجا استفاده
 * می‌کنند — همان‌طور که پیش از این هم بدون بررسی نقش جداگانه انجام می‌شد،
 * چون این‌ها عملیات یک‌باره‌ی راه‌اندازی/migration کل پایگاه‌اند، نه نوشتن‌های
 * روزمره‌ی یک کاربر لاگین‌شده.
 */
function applyCategoriesSet_(ss, list) {
  if (!Array.isArray(list)) return err("فهرست دسته‌بندی‌ها نامعتبر است.");
  var at = nowMs();
  var seen = {};
  list.forEach(function (name, idx) {
    var value = (typeof name === "object" && name) ? name : { name: String(name) };
    var cleanVal = String(value.name || "").trim();
    if (!cleanVal) return;
    var id = value.id || ("cat-" + cleanVal);
    seen[id] = true;
    upsertEntity(ss, "categories", { id: id, name: cleanVal, order: toNum(value.order === undefined ? idx : value.order), updatedAt: at }, {});
  });
  // جایگزینی کامل: دسته‌هایی که در فهرست جدید نیستند tombstone می‌شوند
  readTable(ss, "categories").forEach(function (row) {
    if (!row.deleted && !seen[String(row.id)]) deleteEntity(ss, "categories", String(row.id), at);
  });
  return { ok: true, status: "success", revision: bumpRevision(ss), categories: readTable(ss, "categories") };
}

function handleSettingsSet(ss, body) {
  var guard = guardEntityWrite_(ss, "settings", "set", body.settings || body.patch || {}, body || {});
  if (!guard.ok) return err(guard.error);
  return applySettingsSet_(ss, body.settings || body.patch || {}, body);
}

/**
 * منطق واقعی اعمال تنظیمات، بدون بررسی نقش (همان الگوی applyCategoriesSet_).
 * فراخوان مسئول بررسی guardEntityWrite_ پیش از این است.
 */
function applySettingsSet_(ss, patch, rootBody) {
  var out = {};
  ["orgName", "passThreshold", "managerPinHash", "managerPinSalt", "managerPinAlgo", "managerPinIterations"]
    .forEach(function (k) { if (patch[k] !== undefined) out[k] = patch[k]; });

  // لوگو: اگر data URL بزرگ باشد، به‌صورت فایل در Drive نگه داشته می‌شود
  if (patch.logoDataUrl !== undefined) {
    var dataUrl = String(patch.logoDataUrl || "");
    if (!dataUrl) { out.logoFileId = ""; }
    else if (dataUrl.length > SIGNATURE_INLINE_LIMIT) {
      out.logoFileId = saveDataUrlFile_(getOrCreateFolder(DriveApp.getRootFolder(), rootFolderName(rootBody || {})), "لوگو", "org-logo.png", dataUrl);
    } else { out.logoDataUrlInline = dataUrl; out.logoFileId = ""; }
  }

  if (out.logoDataUrlInline !== undefined) { out.logoDataUrl = out.logoDataUrlInline; delete out.logoDataUrlInline; }
  var settings = setSettings(ss, out);
  return { ok: true, status: "success", settings: settings, revision: bumpRevision(ss) };
}

/* =====================================================================
   ۱۰. سوابق بازرسی (records) + تصویر امضا
   ===================================================================== */

function handleRecordUpsert(ss, rootName, rec) {
  if (!rec || !rec.id) return err("رکورد یا شناسه‌ی آن ارسال نشد.");
  externalizeSignatures_(ss, rec, { rootName: rootName });
  externalizePhotos_(ss, rec, { rootName: rootName });
  if (!rec.updatedAt) rec.updatedAt = nowMs();
  if (!rec.dateJalali && (rec.completedAt || rec.startedAt)) rec.dateJalali = toJalaliDate(rec.completedAt || rec.startedAt);
  var res = upsertEntity(ss, "records", rec, {});
  if (!res.applied && res.reason === "SERVER_NEWER") {
    return err("STALE_WRITE", { code: "STALE_WRITE", serverRow: findEntity(ss, "records", rec.id), revision: getRevision(ss) });
  }
  var revision = res.applied ? bumpRevision(ss) : getRevision(ss);
  var out = { ok: true, status: "success", revision: revision, result: res, id: String(rec.id) };

  // اعلان ایمیلی برای بازرسی ناموفق حیاتی
  try {
    if (toBool(rec.criticalFail) || String(rec.status) === "ناموفق (حیاتی)") notifyCriticalFailure(rec, rec.pdfUrl || "");
  } catch (eMail) {}
  return out;
}

function handleRecordPatch(ss, rootName, body) {
  var id = body.id || (body.record && body.record.id);
  if (!id) return err("شناسه سابقه ارسال نشد.");
  var existing = findEntity(ss, "records", id);
  if (!existing) return err("سابقه یافت نشد.");
  var patch = body.patch || body.record || {};
  var merged = mergeShallow_(existing, patch);
  merged.updatedAt = toMs(patch.updatedAt) || nowMs();
  return handleRecordUpsert(ss, rootName, merged);
}

function handleRecordsList(ss, body) {
  var filter = body.filter || {};
  var light = body.light === undefined ? true : toBool(body.light);
  var rows = readTable(ss, "records", { light: light }).filter(function (r) { return !r.deleted; });

  if (filter.assetId) rows = rows.filter(function (r) { return String(r.assetId) === String(filter.assetId); });
  if (filter.assetCode) rows = rows.filter(function (r) { return String(r.assetCode) === String(filter.assetCode); });
  if (filter.templateId) rows = rows.filter(function (r) { return String(r.templateId) === String(filter.templateId); });
  if (filter.inspectorId) rows = rows.filter(function (r) { return String(r.inspectorId) === String(filter.inspectorId); });
  if (filter.category) rows = rows.filter(function (r) { return String(r.category) === String(filter.category); });
  if (filter.status) rows = rows.filter(function (r) { return String(r.status) === String(filter.status); });
  // from/to هم epoch می‌پذیرند هم رشته‌ی تاریخ شمسی یا میلادی (YYYY/MM/DD)
  var from = toFilterMs_(filter.from, false), to = toFilterMs_(filter.to, true);
  if (from) rows = rows.filter(function (r) { return toMs(r.completedAt || r.startedAt || r.updatedAt) >= from; });
  if (to) rows = rows.filter(function (r) { return toMs(r.completedAt || r.startedAt || r.updatedAt) <= to; });

  rows.sort(function (a, b) { return toMs(b.completedAt || b.updatedAt) - toMs(a.completedAt || a.updatedAt); });
  var total = rows.length;
  var offset = toNum(body.offset), limit = toNum(body.limit) || 200;
  if (limit > 1000) limit = 1000;
  return {
    ok: true, status: "success", total: total, offset: offset, limit: limit,
    revision: getRevision(ss), records: rows.slice(offset, offset + limit)
  };
}

function handleRecordGet(ss, body) {
  var id = body.id;
  if (!id) return err("شناسه سابقه ارسال نشد.");
  var rec = findEntity(ss, "records", id);
  if (!rec || rec.deleted) return err("سابقه یافت نشد.");
  return { ok: true, status: "success", record: rec, revision: getRevision(ss) };
}


/** پیوست‌های عکس بزرگ را از سلول شیت به درایو منتقل می‌کند (مثل امضاها).
 *  عکس کوچک (زیر سقف) همان‌جا اینلاین می‌ماند تا کلاینت آفلاین هم ببیند. */
function externalizePhotos_(ss, rec, body) {
  if (!rec || !rec.photos || !rec.photos.length) return;
  var rootName = (body && body.rootName) || prop("ROOT_FOLDER_NAME", "سامانه چک‌لیست درکاو");
  rec.photos.forEach(function (ph, idx) {
    if (!ph || typeof ph !== "object") return;
    var img = ph.image || ph.dataUrl;
    if (!img || typeof img !== "string" || img.indexOf("data:") !== 0) return;
    if (img.length <= SIGNATURE_INLINE_LIMIT) { ph.image = img; delete ph.dataUrl; return; }
    try {
      var folder = getOrCreateFolder(getOrCreateFolder(DriveApp.getRootFolder(), rootName), "عکس‌های بازرسی");
      var name = cleanName(rec.id || "record", 40) + "_p" + idx + ".jpg";
      var fileId = saveDataUrlFile_(folder, "", name, img);
      rec.photos[idx] = { fileId: fileId, name: ph.name || "", addedAt: ph.addedAt || "", external: true };
    } catch (eExt) {
      rec.photos[idx] = { name: ph.name || "", addedAt: ph.addedAt || "", external: true, lost: true };
    }
  });
}

/** تصویر امضا را از سلول شیت بیرون می‌کشد و در Drive ذخیره می‌کند. */
function externalizeSignatures_(ss, rec, body) {
  if (!rec || !rec.signatures) return;
  var sigs = rec.signatures;
  if (typeof sigs === "string") sigs = safeJsonParse(sigs, null);
  if (!sigs || typeof sigs !== "object") return;

  var rootName = (body && body.rootName) || prop("ROOT_FOLDER_NAME", "سامانه چک‌لیست درکاو");
  Object.keys(sigs).forEach(function (role) {
    var s = sigs[role];
    if (!s || typeof s !== "object") return;
    var img = s.image || s.dataUrl;
    if (!img || typeof img !== "string" || img.indexOf("data:") !== 0) return;
    if (img.length <= SIGNATURE_INLINE_LIMIT && String(prop("SIGNATURES_INLINE", "true")).toLowerCase() === "true") {
      s.image = img; delete s.dataUrl; return;   // کوچک است؛ همان‌جا می‌ماند
    }
    try {
      var folder = getOrCreateFolder(getOrCreateFolder(DriveApp.getRootFolder(), rootName), "امضاها");
      var name = cleanName(rec.id || "record", 40) + "_" + cleanName(role, 20) + ".png";
      var fileId = saveDataUrlFile_(folder, "", name, img);
      sigs[role] = {
        fileId: fileId, name: s.name || "", title: s.title || "", signedAt: s.signedAt || "",
        external: true
      };
    } catch (eExt) {
      // اگر ذخیره در Drive نشد، تصویر را حذف می‌کنیم تا سلول شیت نشکند
      sigs[role] = { name: s.name || "", title: s.title || "", signedAt: s.signedAt || "", external: true, lost: true };
    }
  });
  rec.signatures = sigs;
}

function saveDataUrlFile_(folder, subName, fileName, dataUrl) {
  var target = subName ? getOrCreateFolder(folder, subName) : folder;
  var parts = String(dataUrl).split(",");
  var mime = (parts[0].match(/data:([^;]+)/) || [, "image/png"])[1];
  var bytes = Utilities.base64Decode(parts[1] || "");
  var blob = Utilities.newBlob(bytes, mime, fileName);
  var existing = target.getFilesByName(fileName);
  if (existing.hasNext()) {
    var f = existing.next();
    f.setContent(blob);
    return f.getId();
  }
  return target.createFile(blob).getId();
}

function handleSignatureGet(ss, body) {
  var fileId = body.fileId;
  if (!fileId) return err("fileId ارسال نشد.");
  try {
    var f = DriveApp.getFileById(String(fileId));
    var b64 = Utilities.base64Encode(f.getBlob().getBytes());
    var mime = f.getMimeType() || "image/png";
    return { ok: true, status: "success", image: "data:" + mime + ";base64," + b64, name: f.getName() };
  } catch (e) { return err("فایل امضا یافت نشد."); }
}

function notifyCriticalFailure(rec, fileUrl) {
  var adminEmail = prop("ADMIN_EMAIL", "");
  if (!adminEmail) {
    // پیش‌تر بی‌صدا برمی‌گشت و عیب‌یابی «چرا هشدار نیامد؟» را غیرممکن می‌کرد.
    Logger.log("notifyCriticalFailure: ADMIN_EMAIL تنظیم نشده؛ هشدار ایمیل برای رکورد " +
      ((rec && (rec.assetCode || rec.id)) || "?") + " ارسال نشد.");
    return;
  }
  var subject = "⚠ بازرسی ناموفق حیاتی: " + (rec.assetCode || "") + " - " + (rec.templateName || rec.templateTitle || "");
  var bodyTxt = "یک بازرسی با نتیجه «ناموفق حیاتی» ثبت شد.\n\n" +
    "تجهیز: " + (rec.assetCode || "—") + "\n" +
    "بازرس: " + (rec.inspectorName || rec.inspector || "—") + "\n" +
    "درصد: " + (rec.percent || 0) + "%\n" +
    "زمان: " + toJalaliDateTime(rec.completedAt || new Date()) + "\n" +
    (fileUrl ? "لینک فایل: " + fileUrl : "");
  MailApp.sendEmail(adminEmail, subject, bodyTxt);
}

/* =====================================================================
   ۱۱. ذخیره‌ی PDF سابقه (سازگار با نسخه ۷ + مسیر جدید pdfBase64)
   ===================================================================== */

function handleSaveRecord(ss, rootName, data) {
  var rec = data.record;
  if (!rec) return err("فیلد record ارسال نشده است.");
  var d = new Date(toMs(rec.completedAt || rec.startedAt) || nowMs());
  var cat = cleanName(rec.category || "عمومی", 40);

  var rootFolder = getOrCreateFolder(DriveApp.getRootFolder(), rootName);
  var yearFolder = getOrCreateFolder(rootFolder, jalaliYear(d));
  var monthFolder = getOrCreateFolder(yearFolder, jalaliMonthFolder(d));
  var catFolder = getOrCreateFolder(monthFolder, cat);

  var jDateStr = toJalaliDate(d).replace(/\//g, "-");
  var assetPart = rec.assetCode ? cleanName(rec.assetCode, 30) + "_" : "";
  var titlePart = cleanName(rec.templateTitle || rec.templateName || "checklist", 50);
  var idPart = String(rec.id || "").slice(-6);
  var baseName = (jDateStr + "_" + assetPart + titlePart + "_" + idPart).slice(0, 160);

  var mainFile;
  if (data.pdfBase64 && String(data.pdfBase64).length > 200) {
    // مسیر درست و دقیق: PDF در مرورگر کاربر (html2pdf.js) ساخته شده است
    mainFile = saveBase64Pdf(catFolder, baseName, data.pdfBase64);
  } else if (data.html && String(data.html).length > 20) {
    // مسیر پشتیبان: تبدیل HTML به PDF توسط موتور گوگل
    // توجه: Blob.getAs('application/pdf') روی HTML کار می‌کند، اما پشتیبانی
    // CSS آن محدود است (flexbox/grid نه؛ table و inline style بله).
    mainFile = createPdfFromHtml(catFolder, baseName, String(data.html), rec);
  } else {
    mainFile = catFolder.createFile(baseName + ".json", JSON.stringify(rec, null, 2), MimeType.PLAIN_TEXT);
  }

  // ثبت در شیت records هم (تا منبع حقیقت یکجا بماند)
  var savedRec = null;
  try {
    savedRec = {
      id: String(rec.id || ("rec-" + nowMs())),
      assetCode: rec.assetCode || "", assetName: rec.assetTitle || "",
      templateName: rec.templateTitle || rec.templateName || "", category: rec.category || "",
      location: rec.location || "", inspectorName: rec.inspector || rec.inspectorName || "",
      dateJalali: toJalaliDate(d), startedAt: rec.startedAt || "", completedAt: rec.completedAt || d.toISOString(),
      percent: toNum(rec.percent), score: toNum(rec.score), maxScore: toNum(rec.maxScore),
      criticalFail: toBool(rec.criticalFail), status: rec.status || "",
      pdfUrl: mainFile.getUrl(), updatedAt: nowMs()
    };
    upsertEntity(ss, "records", savedRec, {});
    bumpRevision(ss);
  } catch (eRec) { savedRec = null; }

  var sheetUrl = "";
  try { sheetUrl = recordToSpreadsheet(ss); } catch (eSheet) {}

  try {
    if (toBool(rec.criticalFail) || String(rec.status) === "ناموفق (حیاتی)") notifyCriticalFailure(rec, mainFile.getUrl());
  } catch (eMail) {}

  return {
    ok: true, status: "success", message: "چک‌لیست در Google Drive ذخیره شد.", saved: 1,
    fileName: mainFile.getName(), fileUrl: mainFile.getUrl(), pdfUrl: mainFile.getUrl(),
    url: mainFile.getUrl(), sheetUrl: sheetUrl, revision: getRevision(ss)
  };
}

function saveBase64Pdf(folder, baseName, pdfBase64) {
  var bytes = Utilities.base64Decode(String(pdfBase64).replace(/^data:application\/pdf;base64,/, ""));
  var blob = Utilities.newBlob(bytes, MimeType.PDF, baseName + ".pdf");
  var existing = folder.getFilesByName(baseName + ".pdf");
  if (existing.hasNext()) {
    var f = existing.next();
    f.setContent(blob);
    return f;
  }
  return folder.createFile(blob);
}

function createPdfFromHtml(folder, baseName, html, rec) {
  try {
    var htmlBlob = Utilities.newBlob(html, MimeType.HTML, baseName + ".html");
    var pdfBlob = htmlBlob.getAs(MimeType.PDF);
    pdfBlob.setName(baseName + ".pdf");
    var existing = folder.getFilesByName(baseName + ".pdf");
    if (existing.hasNext()) { var f = existing.next(); f.setContent(pdfBlob); return f; }
    return folder.createFile(pdfBlob);
  } catch (e) {
    // آخرین راه: ساخت سند گوگل و تبدیل آن به PDF (جدول‌ها ساده می‌شوند)
    var doc = DocumentApp.create(baseName);
    try {
      doc.getBody().setText("");
      doc.getBody().appendParagraph(String(rec && rec.templateName ? rec.templateName : "گزارش بازرسی"));
      doc.getBody().appendParagraph("تجهیز: " + String(rec && rec.assetCode ? rec.assetCode : "—"));
      doc.getBody().appendParagraph("بازرس: " + String(rec && rec.inspectorName ? rec.inspectorName : "—"));
      doc.getBody().appendParagraph("درصد موفقیت: " + String(rec && rec.percent ? rec.percent : 0) + "%");
      doc.getBody().appendParagraph("توضیح: تبدیل HTML به PDF ممکن نشد؛ این نسخه خلاصه است.");
      doc.saveAndClose();
      var pdf = doc.getAs(MimeType.PDF).setName(baseName + ".pdf");
      var file = folder.createFile(pdf);
      DriveApp.getFileById(doc.getId()).setTrashed(true);
      return file;
    } catch (e2) {
      return folder.createFile(baseName + ".html", html, MimeType.HTML);
    }
  }
}

function recordToSpreadsheet(ss) {
  var sh = getSheet(ss, "records");
  return SpreadsheetApp.openById(ss.getId()).getUrl() + "#gid=" + sh.getSheetId();
}

/* =====================================================================
   ۱۲. سازگاری با نسخه ۷ (cloud_push / cloud_pull / backup / ...)
   ===================================================================== */

/** کلاینت قدیمی کل DB را می‌فرستد؛ ما آن را به عملیات per-entity تبدیل می‌کنیم. */
function handleLegacyCloudPush(ss, body) {
  var data = body.data;
  if (!data || typeof data !== "object") return err("فیلد data ارسال نشد.");
  var at = toMs(body.meta && body.meta.at) || nowMs();
  var applied = 0, conflicts = [];

  ENTITY_NAMES.forEach(function (entity) {
    var list = data[entity];
    if (!Array.isArray(list)) return;
    list.forEach(function (item) {
      if (!item || !item.id) return;
      item.updatedAt = toMs(item.updatedAt) || at;
      if (entity === "users") normalizeUser_(item);
      if (entity === "records") externalizeSignatures_(ss, item, body);
      if (entity === "records") externalizePhotos_(ss, item, body);
      var res = upsertEntity(ss, entity, item, {});
      if (res.applied) applied++;
      else if (res.reason === "SERVER_NEWER") conflicts.push({ entity: entity, id: String(item.id) });
    });
  });

  if (data.settings) {
    var patch = {};
    if (data.settings.orgName !== undefined) patch.orgName = data.settings.orgName;
    if (data.settings.passThreshold !== undefined) patch.passThreshold = data.settings.passThreshold;
    if (data.settings.managerPinHash) {
      patch.managerPinHash = data.settings.managerPinHash;
      patch.managerPinSalt = data.settings.managerPinSalt || "";
      patch.managerPinAlgo = data.settings.managerPinHashAlgo || "sha256";
      patch.managerPinIterations = toNum(data.settings.managerPinIterations || 0);
    }
    if (Object.keys(patch).length) setSettings(ss, patch);
  }
  if (Array.isArray(data.categories) && data.categories.length) {
    applyCategoriesSet_(ss, data.categories); // مهاجرت کل پایگاه: سطح اعتماد bootstrap، نه RBAC عادی
  }

  var revision = bumpRevision(ss);
  return {
    ok: true, status: "success", message: "اطلاعات در پایگاه ابری ذخیره شد.",
    revision: revision, applied: applied, conflicts: conflicts, updatedAt: new Date().toISOString()
  };
}

/** برای کلاینت قدیمی: کل DB را در همان قالب قبلی برمی‌گردانیم. */
function handleLegacyCloudPull(ss) {
  var data = buildLegacySnapshot(ss);
  return { ok: true, status: "success", message: "دریافت از ابر انجام شد.", data: data, revision: getRevision(ss), meta: null, deleted: null };
}

function handleLegacyCloudMeta(ss) {
  return { ok: true, status: "success", exists: true, revision: getRevision(ss), updatedAt: new Date(nowMs()).toISOString(), counts: countAll(ss), meta: null };
}

function buildLegacySnapshot(ss) {
  var settings = getSettings(ss);
  var cats = readTable(ss, "categories").filter(function (c) { return !c.deleted; })
    .sort(function (a, b) { return toNum(a.order) - toNum(b.order); })
    .map(function (c) { return c.name; });

  var users = readTable(ss, "users").filter(function (u) { return !u.deleted; }).map(function (u) {
    var o = {
      id: u.id, username: u.username, name: u.name, role: u.role, active: toBool(u.active),
      passwordHash: u.passwordHash, salt: u.salt, hashAlgo: u.hashAlgo || "sha256",
      iterations: toNum(u.iterations), sessionVersion: toNum(u.sessionVersion) || 1,
      phone: u.phone || "", nationalId: u.nationalId || "",
      pages: typeof u.pages === "string" ? String(u.pages).split(",").filter(Boolean) : (u.pages || [])
    };
    return o;
  });

  var templates = readTable(ss, "templates").filter(function (t) { return !t.deleted; }).map(function (t) {
    return {
      id: t.id, name: t.name, category: t.category, passThreshold: toNum(t.passThreshold),
      archived: toBool(t.archived), items: Array.isArray(t.items) ? t.items : []
    };
  });

  var assets = readTable(ss, "assets").filter(function (a) { return !a.deleted; }).map(function (a) {
    return { id: a.id, code: a.code, name: a.name, location: a.location, serial: a.serial, templateId: a.templateId, category: a.category || "" };
  });

  var assignments = readTable(ss, "assignments").filter(function (a) { return !a.deleted; });
  var records = readTable(ss, "records").filter(function (r) { return !r.deleted; });

  return {
    version: 4,
    users: users, categories: cats, templates: templates, assets: assets,
    assignments: assignments, records: records,
    settings: {
      orgName: settings.orgName, passThreshold: settings.passThreshold,
      managerPinHash: settings.managerPinHash, managerPinSalt: settings.managerPinSalt,
      managerPinHashAlgo: settings.managerPinAlgo, managerPinIterations: settings.managerPinIterations,
      logoFileId: settings.logoFileId
    },
    revision: getRevision(ss),
    exportedAt: new Date().toISOString()
  };
}

function handleBackup(rootName, body) {
  var rootFolder = getOrCreateFolder(DriveApp.getRootFolder(), rootName);
  var backupFolder = getOrCreateFolder(rootFolder, "پشتیبان کامل");
  var backupName = "پشتیبان_" + toJalaliDate(new Date()).replace(/\//g, "-") + "_" + nowMs() + ".json";
  var payload = body.payload || body.data || {};
  var backupFile = backupFolder.createFile(backupName, JSON.stringify(payload, null, 2), MimeType.PLAIN_TEXT);
  purgeOldBackups(backupFolder, 20);
  return { ok: true, status: "success", message: "نسخه پشتیبان در Google Drive ذخیره شد.", fileUrl: backupFile.getUrl() };
}

/** فقط فایل‌هایی که واقعاً پشتیبان این سامانه هستند پاک می‌شوند (ایراد ۴-۱۱). */
function purgeOldBackups(folder, keep) {
  var files = folder.getFiles();
  var list = [];
  while (files.hasNext()) {
    var f = files.next();
    var n = f.getName();
    if (!/^پشتیبان_\d{4}-\d{2}-\d{2}_\d+\.json$/.test(n)) continue; // فایل دستی کاربر حفظ می‌شود
    list.push(f);
  }
  list.sort(function (a, b) { return b.getDateCreated().getTime() - a.getDateCreated().getTime(); });
  for (var i = keep; i < list.length; i++) { try { list[i].setTrashed(true); } catch (e) {} }
  return list.length;
}

function handleLegacyListRecords(ss, rootName, body) {
  // در نسخه ۸ منبع حقیقت شیت records است، نه شیت تجمیعی قدیمی
  return handleRecordsList(ss, { filter: body || {}, light: false, limit: toNum(body && body.limit) || 200, offset: toNum(body && body.offset) || 0 });
}

function handleLegacyDeleteRecord(body) {
  var fileUrl = body.fileUrl;
  if (!fileUrl) return err("fileUrl ارسال نشده است.");
  var idMatch = String(fileUrl).match(/[-\w]{25,}/);
  if (!idMatch) return err("شناسه فایل از روی لینک قابل استخراج نیست.");
  try {
    DriveApp.getFileById(idMatch[0]).setTrashed(true);
    return { ok: true, status: "success", message: "فایل به سطل زباله گوگل درایو منتقل شد." };
  } catch (e) { return err("فایل یافت نشد یا قابل حذف نیست."); }
}

function handleLegacyApproveRecord(rootName, body) {
  var rootFolder = getOrCreateFolder(DriveApp.getRootFolder(), rootName);
  var approvalFolder = getOrCreateFolder(rootFolder, "تاییدیه‌ها");
  var entry = {
    fileUrl: body.fileUrl || "", recordId: body.recordId || "",
    decision: body.decision === "reject" ? "رد شده" : "تایید شده",
    approverName: body.approverName || "—", note: body.note || "",
    approvedAt: toJalaliDateTime(new Date())
  };
  var name = "تاییدیه_" + toJalaliDate(new Date()).replace(/\//g, "-") + "_" + String(body.recordId || "").slice(-6) + ".json";
  var file = approvalFolder.createFile(name, JSON.stringify(entry, null, 2), MimeType.PLAIN_TEXT);
  return { ok: true, status: "success", message: "تاییدیه ثبت شد.", fileUrl: file.getUrl(), entry: entry };
}

function handleExportZip(rootName, body) {
  var year = body.year, month = body.month;
  if (!year || !month) return err("سال و ماه شمسی باید ارسال شود.");
  var rootFolder = getOrCreateFolder(DriveApp.getRootFolder(), rootName);
  var yearFolders = rootFolder.getFoldersByName(String(year));
  if (!yearFolders.hasNext()) return err("پوشه‌ی این سال یافت نشد.");
  var monthFolders = yearFolders.next().getFoldersByName(String(month));
  if (!monthFolders.hasNext()) return err("پوشه‌ی این ماه یافت نشد.");

  var blobs = [];
  collectPdfBlobs(monthFolders.next(), blobs);
  if (blobs.length === 0) return err("هیچ فایل PDF ای برای این بازه یافت نشد.");
  var zipBlob = Utilities.zip(blobs, year + "_" + month + ".zip");
  var exportFolder = getOrCreateFolder(rootFolder, "خروجی‌های فشرده");
  var zipFile = exportFolder.createFile(zipBlob);
  return { ok: true, status: "success", message: "فایل ZIP ساخته شد.", fileUrl: zipFile.getUrl(), count: blobs.length };
}

function collectPdfBlobs(folder, blobs) {
  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    if (f.getMimeType() === MimeType.PDF) blobs.push(f.getBlob());
  }
  var sub = folder.getFolders();
  while (sub.hasNext()) collectPdfBlobs(sub.next(), blobs);
}

/* =====================================================================
   ۱۳. مهاجرت از نسخه قدیمی (فایل JSON روی Drive) به Sheets
   ===================================================================== */

/**
 * اجرای دستی از ویرایشگر Apps Script:
 * فایل darkav-cloud-db.json را در پوشه «پایگاه ابری» پیدا و وارد شیت‌ها می‌کند.
 */
function migrateFromLegacyJson() {
  var rootName = prop("ROOT_FOLDER_NAME", "سامانه چک‌لیست درکاو");
  var root = getOrCreateFolder(DriveApp.getRootFolder(), rootName);
  var cloud = root.getFoldersByName("پایگاه ابری");
  if (!cloud.hasNext()) { Logger.log("پوشه «پایگاه ابری» یافت نشد."); return null; }
  var files = cloud.next().getFilesByName("darkav-cloud-db.json");
  if (!files.hasNext()) { Logger.log("فایل darkav-cloud-db.json یافت نشد."); return null; }
  var json = JSON.parse(files.next().getBlob().getDataAsString());
  var legacy = json && json.data ? json.data : json;
  var ss = getDb();
  var lock = LockService.getScriptLock(); lock.tryLock(LOCK_WAIT_MS);
  try {
    var res = importLegacyData(ss, legacy, rootName);
    Logger.log(JSON.stringify(res, null, 2));
    return res;
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

function handleMigrateImport(ss, rootName, body) {
  var legacy = body.data || body.payload;
  if (!legacy) return err("داده‌ای برای مهاجرت ارسال نشد.");
  var res = importLegacyData(ss, legacy, rootName);
  return { ok: true, status: "success", message: "مهاجرت انجام شد.", migration: res, revision: getRevision(ss) };
}

function importLegacyData(ss, legacy, rootName) {
  var at = nowMs();
  var counts = {};

  ENTITY_NAMES.forEach(function (entity) {
    if (entity === "categories") { counts[entity] = 0; return; } // از راه handleCategoriesSet وارد می‌شود
    var list = legacy[entity];
    if (!Array.isArray(list)) { counts[entity] = 0; return; }
    var n = 0;
    list.forEach(function (item) {
      if (!item) return;
      if (!item.id) item.id = entity.slice(0, 3) + "-" + sha256Hex(JSON.stringify(item)).slice(0, 12);
      item.updatedAt = toMs(item.updatedAt) || at;
      item.createdAt = toMs(item.createdAt) || item.updatedAt;
      if (entity === "users") {
        normalizeUser_(item);
        if (!item.hashAlgo) item.hashAlgo = "sha256";
      }
      if (entity === "records") externalizeSignatures_(ss, item, { rootName: rootName });
      if (entity === "records") externalizePhotos_(ss, item, { rootName: rootName });
      var res = upsertEntity(ss, entity, item, {});
      if (res.applied) n++;
    });
    counts[entity] = n;
  });

  var s = legacy.settings || {};
  setSettings(ss, {
    orgName: s.orgName || "",
    passThreshold: toNum(s.passThreshold === undefined ? 80 : s.passThreshold),
    managerPinHash: s.managerPinHash || "",
    managerPinSalt: s.managerPinSalt || "",
    managerPinAlgo: s.managerPinHashAlgo || (s.managerPinHash ? "sha256" : ""),
    managerPinIterations: toNum(s.managerPinIterations || 0)
  });
  if (Array.isArray(legacy.categories)) applyCategoriesSet_(ss, legacy.categories); // مهاجرت کل پایگاه

  var revision = bumpRevision(ss);
  return { counts: counts, revision: revision, importedAt: new Date().toISOString() };
}

/* =====================================================================
   ۱۴. لاگ حسابرسی
   ===================================================================== */

function writeAuditLog(action, payload, ms, actorOverride) {
  try {
    var ss = getDb();
    var sh = getSheet(ss, "_log");
    var p = payload || {};
    var actor = actorOverride || (p.payload && (p.payload.actor || p.payload.username)) ||
      (p.record && (p.record.inspector || p.record.inspectorName)) || "";
    var ok = true;
    sh.appendRow([nowMs(), new Date().toISOString(), String(action), String(actor),
      String(p.clientId || ""), ok ? "OK" : "ERROR", String(ms || 0) + "ms"]);
    var last = sh.getLastRow();
    if (last > MAX_LOG_ROWS + 1000) { try { sh.deleteRows(2, last - MAX_LOG_ROWS); } catch (e) {} }
  } catch (e) { /* لاگ هرگز نباید عملیات اصلی را بشکند */ }
}

/* =====================================================================
   ۱۵. توابع کمکی Drive
   ===================================================================== */

function getOrCreateFolder(parent, name) {
  var clean = cleanName(name, 100);
  var folders = parent.getFoldersByName(clean);
  if (folders.hasNext()) return folders.next();
  return parent.createFolder(clean);
}

/* =====================================================================
   ۱۶. ابزارهای نگهداری (اجرای دستی)
   ===================================================================== */

/** ساختار شیت‌ها را از نو بررسی/ایجاد می‌کند. */
function maintenanceEnsureSchema() {
  var ss = getDb();
  ensureSheets(ss);
  Logger.log("شیت‌ها آماده‌اند: " + ss.getSheets().map(function (s) { return s.getName(); }).join(", "));
  return ss.getUrl();
}

/** خلاصه وضعیت پایگاه. */
function maintenanceStatus() {
  var ss = getDb();
  var out = { revision: getRevision(ss), url: ss.getUrl(), counts: countAll(ss), settings: getSettings(ss) };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/** tombstoneهای قدیمی‌تر از N روز را برای همیشه پاک می‌کند. */
function maintenancePurgeTombstones(days) {
  var ss = getDb();
  var cutoff = nowMs() - (toNum(days) || 30) * 86400000;
  var removed = {};
  ENTITY_NAMES.forEach(function (entity) {
    var def = SCHEMA[entity];
    var sh = getSheet(ss, def.sheet);
    var header = headerFor(def.sheet);
    var last = sh.getLastRow();
    if (last < 2) { removed[entity] = 0; return; }
    var vals = sh.getRange(2, 1, last - 1, header.length).getValues();
    var iDeleted = header.indexOf("deleted"), iUpdated = header.indexOf("updatedAt");
    var toDelete = [];
    for (var i = 0; i < vals.length; i++) {
      if (toBool(vals[i][iDeleted]) && toMs(vals[i][iUpdated]) < cutoff) toDelete.push(i + 2);
    }
    for (var k = toDelete.length - 1; k >= 0; k--) sh.deleteRow(toDelete[k]);
    removed[entity] = toDelete.length;
  });
  Logger.log(JSON.stringify(removed));
  return removed;
}
