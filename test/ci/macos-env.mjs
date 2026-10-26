// The facts of a macOS machine that decide which headed suites it can judge: the displays (size, scale, refresh rate as Chrome renders it), a WebGPU adapter in
// headed and in headless Chrome, the OS pointer helpers (python3 with Quartz and AppKit) and the session (locked or not). Printed as one JSON object and
// written to .scratch/results/macos-env.json, so every CI run records the display it was judged on.
//   node test/ci/macos-env.mjs [--require=raf120,webgpu,pointer]
// --require fails (exit 1) when a listed capability is missing: `raf120` a headed page renders at >= 110 Hz, `webgpu` headed Chrome has an adapter,
// `pointer` the OS pointer can be read and moved (the harness parks it, test/harness/lib/os-pointer.mjs).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as H from '../harness/index.mjs';
import { osPointer } from '../harness/lib/os-pointer.mjs';
import { frontmostApp } from '../harness/lib/os-activation.mjs';

const require_ = (H.arg('require') ?? '').split(',').filter(Boolean);
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 30000 }).trim(); } catch (e) { return `unavailable (${String(e.message).split('\n')[0]})`; } };

/** Every step is bounded and logged: a step that never answers (a requestAnimationFrame that never fires, an adapter request that never settles) is recorded as such. */
const step = async (/** @type {string} */ what, /** @type {() => Promise<any>} */ fn, ms = 30000) => {
  const t0 = Date.now();
  /** @type {any} */ let timer;
  try {
    const v = await Promise.race([fn(), new Promise((_, bad) => { timer = setTimeout(() => bad(new Error(`no answer within ${ms} ms`)), ms); })]);
    console.error(`  ${what}: ${Date.now() - t0} ms`);
    return v;
  } catch (e) { console.error(`  ${what}: FAILED after ${Date.now() - t0} ms: ${String(e).slice(0, 300)}`); return { error: String(e).slice(0, 300) }; } finally { clearTimeout(timer); }
};

/** @param {boolean} headless */
async function chromeFacts(headless) {
  console.error(`Chrome ${headless ? 'headless' : 'headed'}:`);
  const srv = await H.startServer();
  const browser = await H.launchChrome({ name: `macos-env-${headless ? 'headless' : 'headed'}`, extraArgs: headless ? ['--headless=new'] : [] });
  try {
    const page = await browser.newPage();
    const out = { headless, chrome: browser.version?.Browser, pointerPark: browser.pointerPark };
    await step('navigate', () => page.navigate(`${srv.url}/examples/index.html`)); // a secure context (localhost), where navigator.gpu exists
    if (!headless) out.focus = await step('foreground', async () => (await page.ensureForeground({ timeout: 4000 })).mode, 15000);
    out.viewport = await step('viewport', () => page.viewport());
    out.focusState = await step('focus state', () => page.focusState());
    out.gpuAdapter = await step('WebGPU adapter', () => page.evaluate(`(async () => { if (!navigator.gpu) return 'no navigator.gpu';
      const a = await navigator.gpu.requestAdapter(); return a ? { vendor: a.info?.vendor, architecture: a.info?.architecture, device: a.info?.device, description: a.info?.description } : null; })()`), 20000);
    out.webgl = await step('WebGL renderer', () => page.evaluate(`(() => { const g = document.createElement('canvas').getContext('webgl2'); if (!g) return null;
      const d = g.getExtension('WEBGL_debug_renderer_info'); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER); })()`));
    if (!headless) {
      out.raf = await step('rAF cadence (240 frames)', async () => { const r = await page.measureRaf({ frames: 240 }); return { p50Ms: r.p50, p95Ms: r.p95, maxMs: r.max, impliedHz: r.hz }; }, 30000);
    }
    out.gpu = await step('GPU info', async () => (await browser.info()).gpu?.map((/** @type {any} */ d) => ({ vendor: d.vendorString, device: d.deviceString })) ?? null);
    return out;
  } finally { await Promise.race([browser.close(), H.sleep(15000)]); await srv.close(); }
}

// the whole record never takes more than 3 minutes
setTimeout(() => { console.error('macos-env: did not finish within 3 min'); process.exit(1); }, 180000).unref();
const pointer = osPointer();
const out = {
  at: new Date().toISOString(),
  os: run('sw_vers', []).replace(/\n/g, ' | '), cpu: run('sysctl', ['-n', 'machdep.cpu.brand_string']), cores: run('sysctl', ['-n', 'hw.ncpu']),
  displays: run('system_profiler', ['SPDisplaysDataType']).split('\n').filter((l) => /Chipset|Resolution|UI Looks like|Refresh|Main Display|Metal|Display Type|Vendor/i.test(l)).map((l) => l.trim()),
  quartz: pointer ? { pointerAt: pointer.at, displays: pointer.displays } : 'python3 with Quartz is not available: the OS pointer can be neither read nor parked',
  frontmost: frontmostApp(),
  power: run('pmset', ['-g']).split('\n').filter((l) => /sleep|displaysleep|lowpowermode/i.test(l)).map((l) => l.trim()),
  screenLocked: run('python3', ['-c', 'import Quartz;d=Quartz.CGSessionCopyCurrentDictionary();print(bool(d and d.get("CGSSessionScreenIsLocked")), bool(d and d.get("kCGSSessionOnConsoleKey")))']),
  headed: await chromeFacts(false).catch((e) => ({ error: String(e).slice(0, 500) })),
  headlessChrome: await chromeFacts(true).catch((e) => ({ error: String(e).slice(0, 500) })),
};
const caps = {
  raf120: (out.headed.raf?.impliedHz ?? 0) >= 110,
  webgpu: typeof out.headed.gpuAdapter === 'object' && !!out.headed.gpuAdapter && !out.headed.gpuAdapter.error,
  webgpuHeadless: typeof out.headlessChrome.gpuAdapter === 'object' && !!out.headlessChrome.gpuAdapter && !out.headlessChrome.gpuAdapter.error,
  pointer: !!pointer,
};
out.capabilities = caps;
mkdirSync(resolve(H.PROJECT_ROOT, '.scratch/results'), { recursive: true });
writeFileSync(resolve(H.PROJECT_ROOT, '.scratch/results/macos-env.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
const missing = require_.filter((k) => !caps[/** @type {keyof typeof caps} */ (k)]);
if (missing.length) { console.error(`missing capabilities: ${missing.join(', ')}`); process.exit(1); }
