#!/usr/bin/env node
// Regenerates the block between <!-- BEGIN GENERATED --> and <!-- END GENERATED --> of docs/PERFORMANCE-COMPARISON.md from the newest
// complete result file of each subject in .scratch/results (bench-compare-<subject>-<stamp>.json). Hand-written sections outside the markers
// (analysis, optimisation plan) are kept.   node test/bench/compare/report.mjs [--files=a.json,b.json,c.json]
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESULTS_DIR, ROOT } from './lib/session.mjs';

const DOC = resolve(ROOT, 'docs/PERFORMANCE-COMPARISON.md');
const SUBJ = ['ours', 'competitor', 'native'];
const ALL = ['typing', 'slider', 'click', 'scroll', 'resize', 'idle', 'firstpaint', 'memory', 'largedom', 'bundle'];

function newest() {
  const arg = process.argv.find((a) => a.startsWith('--files='));
  if (arg) return Object.fromEntries(arg.slice(8).split(',').map((f) => { const j = JSON.parse(readFileSync(f, 'utf8')); return [j.subject, { ...j, file: basename(f), from: {} }]; }));
  // per subject: newest file that has the environment, then every scenario from the newest file that holds it (a rerun of one scenario replaces only that one)
  const out = {};
  const files = readdirSync(RESULTS_DIR).filter((f) => f.startsWith('bench-compare-') && !f.includes('profile')).sort().reverse();
  for (const s of SUBJ) {
    for (const f of files.filter((x) => x.startsWith(`bench-compare-${s}-`))) {
      const j = JSON.parse(readFileSync(resolve(RESULTS_DIR, f), 'utf8'));
      if (j.quick || !j.environment) continue;
      if (!out[s]) out[s] = { ...j, scenarios: {}, from: {}, loads: [], file: f, files: new Set() };
      for (const k of ALL) if (!out[s].scenarios[k] && j.scenarios?.[k]) { out[s].scenarios[k] = j.scenarios[k]; out[s].from[k] = f; out[s].files.add(f); out[s].loads.push(...(j.loads ?? []).filter((l) => l.label.startsWith(k === 'largedom' ? 'large' : k) || l.label.startsWith('start'))); }
    }
    if (out[s] && !ALL.every((k) => out[s].scenarios[k])) console.warn(`report: ${s} misses ${ALL.filter((k) => !out[s].scenarios[k]).join(', ')}`);
  }
  return out;
}

const n = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '–' : typeof v === 'number' ? v.toFixed(d) : String(v));
const lat = (s, extra = '') => (!s || !s.n ? `no sample${extra}` : `${n(s.p50)} / ${n(s.p95)} / ${n(s.max)}${extra}`);
const rt = (r) => (!r || r.error ? '–' : `${n(r.p95, 2)} / ${n(r.max, 1)} ms, ${r.over8_33ms} > 8.33, busy ${n(r.busyPct)} %`);
const g = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);

export function buildRows(R) {
  const rows = [];
  const row = (metric, fn, note = '') => rows.push([metric, ...SUBJ.map((s) => { try { return R[s] ? fn(R[s].scenarios, R[s]) : 'not run'; } catch { return '–'; } }), note]);
  const ty = (page, cfg) => (S) => { const c = S.typing[page].configs[cfg]; const bad = c.timedOut ? ` (**${c.timedOut}/${c.samples} keys never drawn**)` : ''; const f = c.correct; const wrong = (!f.finalStateOk || f.revertedKeys) ? ' WRONG' : ''; return lat(c.latencyMs, bad + wrong); };
  for (const [page, cfgs] of [['explainer', ['fits@120ms', 'fits@30ms', 'overflow@120ms', 'overflow@30ms']], ['f1', ['fits@120ms', 'fits@30ms']]]) {
    for (const c of cfgs) row(`1. keydown→pixel ms, ${page} ${c.replace('@', ' every ')} (p50 / p95 / max)`, ty(page, c));
  }
  row('1. typing: RunTask p95 / max, explainer fits every 30 ms', (S) => rt(S.typing.explainer.configs['fits@30ms'].traced.runTask));
  row('1. typing: final input pixels vs plain DOM (Δ>16 share)', (S) => `explainer ${n(S.typing.explainer.finalPixels.fraction * 100, 2)} % / F1 ${n(S.typing.f1.finalPixels.fraction * 100, 2)} %` + (S.typing.explainer.finalPixels.ok && S.typing.f1.finalPixels.ok ? '' : ' WRONG'));
  row('2. slider input→pixel ms (p50 / p95 / max)', (S) => lat(S.slider.latencyMs, S.slider.timedOut ? ` (${S.slider.timedOut} never)` : ''));
  row('2. slider: canvas updates/s (probe) · paint events/s (traced)', (S) => `${n(S.slider.pixelUpdatesPerSecond)} · ${n(S.slider.traced.paints.perSecond)}`);
  row('2. slider: RunTask p95 / max', (S) => rt(S.slider.traced.runTask));
  row('3. click→focus pixel ms (p50 / p95 / max)', (S) => lat(S.click.focusLatencyMs) + (S.click.correct.focusedByClick < S.click.correct.of ? ` (focus ${S.click.correct.focusedByClick}/${S.click.correct.of})` : ''));
  row('3. click→blur pixel ms (p50 / p95 / max)', (S) => lat(S.click.blurLatencyMs));
  row('4. wheel→pixel ms, inner list (p50 / p95 / max)', (S) => lat(S.scroll.wheelLatencyMs, S.scroll.timedOut ? ` (**${S.scroll.timedOut}/${S.scroll.samples} never drawn**)` : ''));
  row('4. wheel stream: canvas updates/s · settle after last scroll', (S) => `${n(S.scroll.stream.canvasUpdatesPerSecond)} · ${n(S.scroll.stream.settleAfterLastScrollMs, 0)} ms`);
  row('4. scroll: final list pixels vs plain DOM', (S) => `${n(S.scroll.finalPixels.fraction * 100, 2)} %${S.scroll.finalPixels.ok ? '' : ' WRONG'}`);
  row('4. scroll stream: RunTask p95 / max', (S) => rt(S.scroll.traced.runTask));
  row('5. resize drag: blank frames / sampled', (S) => `${S.resize.blankFrames} / ${S.resize.sampledFrames}`);
  row('5. resize: convergence after last resize event ms (p50 / p95 / max, 30 drags)', (S) => lat(S.resize.convergenceMs));
  row('5. resize: final pixels vs plain DOM', (S) => `${n(S.resize.finalPixels.fraction * 100, 2)} %${S.resize.finalPixels.ok ? '' : ' WRONG'}`);
  row('5. resize: RunTask p95 / max (4 drags)', (S) => rt(S.resize.traced.runTask));
  for (const m of ['nothing-focused', 'input-focused']) {
    row(`6. idle (${m}): renderer CPU % p50 / p95 · GPU CPU % p50`, (S) => `${n(S.idle[m].rendererCpuPct.p50, 2)} / ${n(S.idle[m].rendererCpuPct.p95, 2)} · ${n(S.idle[m].gpuCpuPct.p50, 2)}`);
    row(`6. idle (${m}): RunTask/s · main busy % · paint events/s`, (S) => `${n(S.idle[m].runTaskPerSecond)} · ${n(S.idle[m].busyPct, 2)} · ${n(S.idle[m].paintsPerSecond, 1)}`);
  }
  for (const p of ['explainer', 'f1']) {
    row(`7. first paint ${p}, cold (new renderer) ms p50 / p95 / max`, (S) => lat(S.firstpaint[p].coldMs));
    row(`7. first paint ${p}, warm (same tab) ms p50 / p95 / max`, (S) => lat(S.firstpaint[p].warmMs));
  }
  for (const p of ['f1', 'f4-1000']) row(`8. memory ${p}: JS heap MB (after GC) · renderer RSS MB · GPU RSS MB`, (S) => `${n(S.memory[p].jsHeapMB.p50, 2)} (${n(S.memory[p].jsHeapAfterGcMB, 2)}) · ${n(S.memory[p].rendererRssMB.p50, 0)} · ${n(S.memory[p].gpuRssMB.p50, 0)}`);
  for (const k of ['200', '500', '1000', '2000']) {
    row(`9. F4 ${k} nodes: update→pixel ms p50 / p95 / max`, (S) => lat(S.largedom[k].latencyMs) + (S.largedom[k].finalPixels.ok ? '' : ' WRONG'));
    row(`9. F4 ${k} nodes: main thread ms per update · RunTask max · tasks > 8.33`, (S) => `${n(S.largedom[k].mainThreadMsPerUpdate)} · ${n(S.largedom[k].runTask.max)} · ${S.largedom[k].runTask.over8_33ms}/${S.largedom[k].samples}`);
  }
  row('10. bundle bytes (min) · parse+compile+install ms p50 / p95 / max', (S) => `${S.bundle.bytes} · ${lat(S.bundle.execMs)}`);
  row('10. bundle: first `paint` event after script start ms p50', (S) => n(S.bundle.firstPaintEventMs.p50));
  return rows;
}

function controls(R) {
  const out = [];
  for (const s of SUBJ) {
    const S = R[s]?.scenarios; if (!S) continue;
    const c = [['typing', g(S, 'typing.explainer.control.fired')], ['slider', g(S, 'slider.control.fired')], ['click', g(S, 'click.control.fired')], ['scroll', g(S, 'scroll.control.fired')]];
    out.push(`${s}: ${c.map(([k, v]) => `${k} ${v === true ? 'fired' : v === false ? '**DID NOT FIRE**' : '–'}`).join(', ')}`);
  }
  return out;
}

export function writeReport() {
  const R = newest();
  const have = SUBJ.filter((s) => R[s]);
  const lines = [];
  lines.push(`Generated by \`node test/bench/compare/report.mjs\` on ${new Date().toISOString()} from ${have.map((s) => `${s}: ${[...(R[s].files ?? [R[s].file])].map((f) => '`' + f + '`').join(' + ')}`).join('; ')} (local result files under \`.scratch/results/\`, not in the repository; with several files, each scenario comes from the newest file that holds it).`, '');
  lines.push('### Environment', '');
  lines.push('| subject | browser | rAF Hz | DPR | viewport | load avg at start | machine load above threshold: another process > 15 % CPU (scenarios / total) |', '|---|---|---|---|---|---|---|');
  for (const s of have) {
    const e = R[s].environment; const L = R[s].loads ?? [];
    lines.push(`| ${R[s].label} | ${e.chrome} | ${n(e.rafMeasured?.impliedHz)} | ${e.viewport.dpr} | ${e.viewport.innerWidth}x${e.viewport.innerHeight} | ${R[s].load0?.loadAvg} | ${L.filter((l) => l.highLoad).length} / ${L.length} |`);
  }
  lines.push('', `Machine: ${R[have[0]]?.environment?.mac?.cpu ?? '?'}, ${String(R[have[0]]?.environment?.mac?.os ?? '').replace(/\s+/g, ' ')}. Headed, foreground, real focus; one browser at a time.`, '');
  lines.push('### Results (p50 / p95 / max unless stated; latency = trusted event `timeStamp` → rAF time of the first rendering update whose CANVAS pixels show the expected state; add one frame (8.3 ms) for presentation)', '');
  lines.push('| metric | ours | competitor | native | note |', '|---|---|---|---|---|');
  for (const r of buildRows(R)) lines.push(`| ${r.join(' | ')} |`);
  lines.push('', '**Positive controls** (paint events swallowed = frozen renderer; the matcher must report every sample as never drawn): ' + controls(R).join('; ') + '.', '');
  const errs = have.flatMap((s) => Object.entries(R[s].errors ?? {}).map(([k, v]) => `${s}/${k}: ${String(v).split('\n')[0]}`));
  if (errs.length) lines.push('**Scenario errors:** ' + errs.join('; '), '');
  const block = lines.join('\n');
  let doc = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '# Performance comparison\n\n<!-- BEGIN GENERATED -->\n<!-- END GENERATED -->\n';
  doc = doc.replace(/<!-- BEGIN GENERATED -->[\s\S]*<!-- END GENERATED -->/, `<!-- BEGIN GENERATED -->\n${block}\n<!-- END GENERATED -->`);
  writeFileSync(DOC, doc);
  console.log(`report -> ${DOC} (${have.join(', ')})`);
  return R;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeReport();
