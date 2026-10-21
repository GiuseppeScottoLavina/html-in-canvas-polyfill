#!/usr/bin/env node
// Read a field test report (the JSON file a tester sent back from examples/field-test/):
//   node scripts/field-report.mjs <report.json> [--crops=<dir>]
// Prints the device, the polyfill state, the capture state and every check with its verdict; with --crops, writes the PNG crops of the
// report to <dir> (one file per crop: <check id>.<canvas|plain|diff|canvas-backing-store>.png) so they can be looked at side by side.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!file) { console.error('usage: node scripts/field-report.mjs <report.json> [--crops=<dir>]'); process.exit(2); }
const cropsDir = process.argv.find((a) => a.startsWith('--crops='))?.slice(8);
const r = JSON.parse(readFileSync(file, 'utf8'));
if (r.schema !== 'hic-field-test/1') { console.error(`not a field test report (schema ${r.schema})`); process.exit(2); }

const env = r.environment ?? {}, b = env.browser ?? {}, d = env.display ?? {}, ua = b.uaData ?? {};
const brands = (ua.fullVersionList ?? ua.brands ?? []).map((x) => `${x.brand} ${x.version}`).join(', ');
console.log(`report     ${r.startedAt} .. ${r.finishedAt} (${r.tool})`);
console.log(`browser    ${brands || b.userAgent}`);
console.log(`platform   ${ua.platform ?? b.platform} ${ua.platformVersion ?? ''} ${ua.architecture ?? ''}${ua.bitness ? '/' + ua.bitness : ''} ${ua.model ?? ''}`.trimEnd());
console.log(`display    DPR ${d.devicePixelRatio}, screen ${d.screen?.width}x${d.screen?.height}, viewport ${d.viewport?.innerWidth}x${d.viewport?.innerHeight}, ${d.refresh?.hz} Hz, gamut ${env.media?.colorGamut}, scheme ${env.media?.prefersColorScheme}, forced colours ${env.media?.forcedColors}`);
console.log(`scrollbars ${env.scrollbars?.type} (gutter ${env.scrollbars?.gutterCssPx} css px); fonts: ${(env.fonts?.available ?? []).join(', ')}`);
console.log(`colours    Highlight ${env.systemColors?.Highlight?.style} / HighlightText ${env.systemColors?.HighlightText?.style}, AccentColor ${env.systemColors?.AccentColor?.style ?? '-'}`);
console.log(`gpu        WebGPU ${env.webgpu?.available ? JSON.stringify(env.webgpu.info) : 'no (' + env.webgpu?.reason + ')'}; WebGL ${env.webgl?.unmaskedRenderer ?? env.webgl?.renderer ?? '-'}`);
console.log(`polyfill   ${r.polyfill?.version ?? '-'} mode ${r.polyfill?.mode ?? '-'}${r.polyfill?.refused ? ' REFUSED: ' + r.polyfill.refused.message : ''}${r.polyfill?.scriptLoaded === false ? ' (script not loaded)' : ''}`);
console.log(`capture    ${r.capture?.state}${r.capture?.reason ? ' (' + r.capture.reason + ')' : ''}${r.capture?.calibrations?.length ? `, last calibration ${JSON.stringify(r.capture.calibrations.at(-1)).slice(0, 160)}` : ''}`);
console.log(`steps      ${Object.entries(r.steps ?? {}).map(([k, v]) => `${k}:${v.status}`).join(' ')}`);
console.log(`verdicts   ${JSON.stringify(r.summary?.verdicts)}`);
console.log('');
for (const c of r.checks ?? []) console.log(`${c.verdict.padEnd(7)} ${c.id.padEnd(26)} ${c.text}`);
if (r.errors?.length) { console.log('\npage errors:'); for (const e of r.errors) console.log(`  ${e.where ?? ''} ${e.name ?? ''}: ${e.message}`); }
const warnings = (r.console ?? []).filter((m) => /hic-live-polyfill/.test(m.text));
if (warnings.length) { console.log('\npolyfill console messages:'); for (const m of warnings) console.log(`  ${m.level}: ${m.text}`); }
if (cropsDir) {
  const dir = resolve(cropsDir); mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const [id, url] of Object.entries(r.crops?.images ?? {})) { writeFileSync(join(dir, `${id}.png`), Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64')); n++; }
  console.log(`\n${n} crops written to ${dir}${r.crops?.omitted?.length ? ` (${r.crops.omitted.length} omitted: ${r.crops.omitted.map((o) => o.id).join(', ')})` : ''}`);
}
