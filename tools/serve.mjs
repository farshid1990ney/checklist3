#!/usr/bin/env node
/**
 * سرور ایستای ساده برای پیش‌نمایش محلی.
 *
 *     npm run serve              # نسخه‌ی آماده‌ی استقرار (deploy/index.html)
 *     npm run serve -- --src     # نسخه‌ی توسعه (index.html با JSX + Babel)
 *     PORT=9000 npm run serve
 *
 * نکته‌ی مهم درباره‌ی crypto.subtle:
 *   مرورگر فقط در «secure context» به crypto.subtle دسترسی می‌دهد — یعنی HTTPS
 *   یا http://localhost. اگر صفحه را با file:// باز کنید یا روی http://192.168.x.x
 *   سرو کنید، crypto.subtle تعریف‌نشده است. نسخه‌ی ۸ برای آن حالت fallback خالص
 *   JS دارد (sha256BytesPure / pbkdf2Sha256Pure)، ولی برای اطمینان همیشه روی
 *   HTTPS یا localhost تست کنید.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const useSrc = process.argv.includes('--src');
const port = Number(process.env.PORT) || 8080;

const target = useSrc ? path.join(root, 'index.html') : path.join(root, 'deploy', 'index.html');
if (!fs.existsSync(target)) {
  console.error(`✖ فایل پیدا نشد: ${path.relative(root, target)}`);
  if (!useSrc) console.error('  اول `npm run build` را اجرا کنید تا deploy/index.html ساخته شود.');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  // هیچ بررسی Host انجام نمی‌دهیم تا پشت پروکسی/پیش‌نمایش هم کار کند.
  const url = (req.url || '/').split('?')[0];
  if (url !== '/' && url !== '/index.html') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 — فقط / سرو می‌شود');
    return;
  }
  const body = fs.readFileSync(target);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
});

server.listen(port, '0.0.0.0', () => {
  const kb = (fs.statSync(target).size / 1024).toFixed(0);
  console.log(`✔ سرو شد: ${path.relative(root, target)} (${kb} KB)`);
  console.log(`✔ http://localhost:${port}/`);
  console.log(`  حالت: ${useSrc ? 'توسعه (JSX + Babel در مرورگر)' : 'استقرار (JSX از پیش کامپایل‌شده)'}`);
});
