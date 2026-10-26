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

/** @param {boolean} headless */
async function chromeFacts(headless) {
  const srv = await H.startServer();
  const browser = await H.launchChrome({ name: `macos-env-${headless ? 'headless' : 'headed'}`, extraArgs: headless ? ['--headless=new'] : [] });
  try {
    const page = await browser.newPage();
    await page.navigate(`${srv.url}/examples/index.html`);  // a secure context (localhost), where navigator.gpu exists
    const focus = headless ? null : await page.ensureForeground({ timeout: 4000 });
    const facts = await H.environmentFacts(browser, page, { measureRaf: !headless, rafFrames: 240 });
    return { headless, focus: focus ? focus.mode : null, chrome: facts.chrome, viewport: facts.viewport, gpuAdapter: facts.gpuAdapter, webgpu: facts.webgpu, raf: facts.rafMeasured,
      gpu: (await browser.info()).gpu?.map((d) => ({ vendor: d.vendorString, device: d.deviceString })) ?? null, pointerPark: browser.pointerPark };
  } finally { await browser.close(); await srv.close(); }
}

const pointer = osPointer();
const out = {
  at: new Date().toISOString(),
  os: run('sw_vers', []).replace(/\n/g, ' | '), cpu: run('sysctl', ['-n', 'machdep.cpu.brand_string']), cores: run('sysctl', ['-n', 'hw.ncpu']),
  displays: run('system_profiler', ['SPDisplaysDataType']).split('\n').filter((l) => /Chipset|Resolution|UI Looks like|Refresh|Main Display|Metal|Display Type|Vendor/i.test(l)).map((l) => l.trim()),
  quartz: pointer ? { pointerAt: pointer.at, displays: pointer.displays } : 'python3 with Quartz is not available: the OS pointer can be neither read nor parked',
  frontmost: frontmostApp(),
  screenLocked: run('python3', ['-c', 'import Quartz;d=Quartz.CGSessionCopyCurrentDictionary();print(bool(d and d.get("CGSSessionScreenIsLocked")), bool(d and d.get("kCGSSessionOnConsoleKey")))']),
  headed: await chromeFacts(false).catch((e) => ({ error: String(e).slice(0, 500) })),
  headlessChrome: await chromeFacts(true).catch((e) => ({ error: String(e).slice(0, 500) })),
};
const caps = {
  raf120: (out.headed.raf?.impliedHz ?? 0) >= 110,
  webgpu: !!out.headed.gpuAdapter && !out.headed.gpuAdapter.error,
  webgpuHeadless: !!out.headlessChrome.gpuAdapter && !out.headlessChrome.gpuAdapter.error,
  pointer: !!pointer,
};
out.capabilities = caps;
mkdirSync(resolve(H.PROJECT_ROOT, '.scratch/results'), { recursive: true });
writeFileSync(resolve(H.PROJECT_ROOT, '.scratch/results/macos-env.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
const missing = require_.filter((k) => !caps[/** @type {keyof typeof caps} */ (k)]);
if (missing.length) { console.error(`missing capabilities: ${missing.join(', ')}`); process.exit(1); }
