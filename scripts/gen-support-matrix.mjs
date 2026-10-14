// Regenerates the generated block of docs/SUPPORT-MATRIX.md from src/contracts/features.js (single source of truth).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { FEATURES } = await import(pathToFileURL(join(root, 'src/contracts/features.js')).href);
const BEGIN = '<!-- BEGIN GENERATED FEATURES -->';
const END = '<!-- END GENERATED FEATURES -->';
const groups = [['supported', 'Supported'], ['limited', 'Limited (works, with documented deviations)'], ['deviation', 'Deviations from the standard behaviour'], ['unsupported', 'Unsupported (refused loudly)']];
const esc = (s) => s.replace(/\|/g, '\\|');
let out = '';
for (const [status, title] of groups) {
  const rows = FEATURES.filter((f) => f.status === status);
  out += `### ${title}\n\n| id | what | reason / the one thing to know |\n|---|---|---|\n`;
  for (const f of rows) out += `| \`${f.id}\` | ${esc(f.summary)} | ${esc(f.reason)} |\n`;
  out += '\n';
}
const path = join(root, 'docs/SUPPORT-MATRIX.md');
const doc = readFileSync(path, 'utf8');
const i = doc.indexOf(BEGIN), j = doc.indexOf(END);
if (i < 0 || j < 0) throw new Error('markers missing in SUPPORT-MATRIX.md');
writeFileSync(path, doc.slice(0, i + BEGIN.length) + '\n\n' + out + doc.slice(j));
console.log('SUPPORT-MATRIX.md regenerated:', FEATURES.length, 'features');
