// Runs the pure-logic node:test files (test/unit/**/*.test.mjs minus *.browser.test.mjs) in one `node --test` call.
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
/** @type {string[]} */ const files = [];
const walk = (/** @type {string} */ d) => {
  for (const n of readdirSync(d).sort()) {
    const p = resolve(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith('.test.mjs') && !n.endsWith('.browser.test.mjs')) files.push(p);
  }
};
walk(root);
if (!files.length) { console.log('no pure unit tests yet'); process.exit(0); }
process.exit(spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' }).status ?? 1);
