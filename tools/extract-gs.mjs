#!/usr/bin/env node
// بازسازی Code.gs از روی بلوک جاسازی‌شده در index.html (عکسِ کار tools/build.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const S = '/*__CODE_GS_START__*/', E = '/*__CODE_GS_END__*/';
const i = html.indexOf(S), j = html.indexOf(E);
if (i < 0 || j < 0) throw new Error('markers not found');
const block = html.slice(i + S.length, j);
const m = block.match(/const APPS_SCRIPT_CODE = `([\s\S]*)`;\s*$/);
if (!m) throw new Error('template literal not found');
let gs = m[1];
// معکوس escapeهای build: اول \$ { بعد \` و در آخر \\
gs = gs.replace(/\\\$\{/g, '${').replace(/\\`/g, '`').replace(/\\\\/g, '\\');
fs.writeFileSync(path.join(root, 'Code.gs'), gs.replace(/\s+$/, '\n'));
console.log('Code.gs reconstructed:', gs.length, 'chars');
