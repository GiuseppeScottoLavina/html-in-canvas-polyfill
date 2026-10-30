#!/usr/bin/env node
// G-mobile: the polyfill on phones: Mobile Safari in the iOS Simulator (safaridriver, full Xcode; iOS is verified on simulators only) and Chrome on Android, in the
// Android Emulator or on a PHYSICAL Android device over USB (adb + Chrome DevTools Protocol). Each scenario has a positive control (the sabotaged page must turn every
// declared check class red).
//   node test/mobile/run.mjs [--platform=ios,android] [--only=gate,explainer,...] [--no-control] [--ios-devices=UDID,UDID] [--ipad=UDID|none] [--ios-old=UDID|none]
//                            [--avd=hicmobile] [--android-package=org.chromium.chrome|com.android.chrome] [--no-stand-in] [--android-serial=SERIAL]
// Physical Android device (--android-serial=<serial from `adb devices`, e.g. --platform=android --android-serial=2B051FDH300HBN): USB debugging on and authorised, the screen
// unlocked (the driver wakes it and never unlocks it). The run uses a new tab of the device's own Chrome (>= 130) and closes it; nothing is installed, no browser is stopped,
// no debug app or Chrome command-line file is touched; the rotation settings that the rotation scenario changes are recorded and restored. Verified 2026-10-30 on a
// Pixel 7 Pro (Android 17, Chrome 156) and a Huawei Mate 10 Pro (Android 10, Chrome 156, a display-size override): docs/guides/MOBILE.md.
// Devices, one at a time (each is shut down before the next boots): iPhone 17 on the newest iOS 26.x (required) and on the newest iOS >= 27 runtime (optional: SKIPPED
// when safaridriver cannot pair with it: no driver offers the iOS 27.0 runtime, measured 2026-10-16, docs/guides/MOBILE.md) (all scenarios), an iPad on iOS 26.x
// (classification: iPadOS sends a desktop UA), an iPhone on iOS 18.x (refusal: Safari 18 is below the minimum 26), then the AVD (ANDROID_AVD_HOME or --avd-home) with
// its newest installed browser (Chromium from a snapshot's ChromePublic.apk, else the image's own Chrome); the refusal runs on a browser below 130 (the image's Chrome 124).
// When no installed browser is 130+ the polyfill scenarios run as a labelled STAND-IN on the old Chrome (test/mobile/android.mjs).
// Writes .scratch/results/mobile-<ts>.json (+ failing crops under .scratch/results/mobile-<ts>/), prints one table, exits 1 on any failure.
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { launchIosSimulator, launchIosDevice, EngineUnavailable } from '../harness/lib/webdriver.mjs';
import { startServer } from '../harness/server.mjs';
import { encodePng } from '../harness/lib/png.mjs';
import { PROJECT_ROOT, arg } from '../harness/lib/util.mjs';
import { RECORDER } from '../xbrowser/lib.mjs';
import { SCENARIOS, CONTROL_CLASSES, unsupported, gate, explainer } from './scenarios.mjs';
import { launchAndroid, attachDevice, plainTab, openPackage, AndroidUnavailable } from './android.mjs';

const platforms = (arg('platform') ?? 'ios,android').split(',');
const only = arg('only')?.split(',');
const noControl = process.argv.includes('--no-control');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outRoot = resolve(PROJECT_ROOT, '.scratch/results'); const pngDir = join(outRoot, `mobile-${stamp}`);
mkdirSync(pngDir, { recursive: true });
const WATCHDOG_MS = 90 * 60000;
const watchdog = setTimeout(() => { console.error('G-mobile WATCHDOG: run exceeded 90 min'); process.exit(3); }, WATCHDOG_MS);
const BUNDLES = {
  ios: ['/dist/hic-live-engines.iife.js', '/dist/hic-live-gpu.iife.js', '/dist/hic-live-polyfill.iife.js'].join(','),
  android: ['/dist/hic-live-gpu.iife.js', '/dist/hic-live-polyfill.iife.js'].join(','),
};

/** Available simulator devices with their runtime version, from simctl. */
function simDevices() {
  const r = spawnSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  const out = [];
  for (const [runtime, list] of Object.entries(JSON.parse(r.stdout).devices ?? {})) {
    const m = /iOS-(\d+)-(\d+)/.exec(runtime); if (!m) continue;
    for (const d of list) out.push({ udid: d.udid, name: d.name, ios: +m[1] + +m[2] / 10, state: d.state });
  }
  return out;
}
const newest = (list) => list.sort((a, b) => b.ios - a.ios)[0];

async function runScenarios(s, srv, label, platform, control, scenarios, extra = {}) {
  const rows = []; const numbers = {};
  for (const [name, fn] of Object.entries(scenarios)) {
    if (only && !only.includes(name)) continue;
    if (control && !(CONTROL_CLASSES[name] ?? []).length) continue;
    const checks = [];
    const ctx = {
      s, srv, files, bundle: BUNDLES[platform], control, numbers, platform, ...extra,
      check: (l, ok, data, cls) => { checks.push({ label: l, ok: !!ok, cls, data }); if (!control) console.log(`  ${ok ? 'ok  ' : 'FAIL'} [${label}] ${l}${ok ? '' : ' ' + JSON.stringify(data)?.slice(0, 300)}`); },
      save: (n, img) => writeFileSync(join(pngDir, `${label.replace(/\W+/g, '_')}${control ? '-control' : ''}-${n}.png`), encodePng(img)),
    };
    const t0 = Date.now(); let threw = null;
    try { await fn(ctx); } catch (e) { threw = String(e.stack ?? e).slice(0, 600); if (!control) console.log(`  FAIL [${label}] ${name} threw: ${threw}`); }
    rows.push({ scenario: name, checks, threw, ms: Date.now() - t0 });
  }
  return { rows, numbers };
}

/** Merge a real and a control run into per-scenario verdicts. */
function verdicts(real, control) {
  const out = {};
  for (const row of real.rows) {
    const ok = !row.threw && row.checks.length > 0 && row.checks.every((c) => c.ok);
    // a scenario that only reported a documented skip (class n/a) has nothing to control
    const want = row.checks.every((c) => c.cls === 'n/a') ? [] : (CONTROL_CLASSES[row.scenario] ?? []);
    let ctl = noControl ? 'skipped' : 'n/a';
    if (!noControl && want.length) {
      const cr = control?.rows.find((r) => r.scenario === row.scenario);
      const red = new Set((cr?.checks ?? []).filter((c) => !c.ok).map((c) => c.cls));
      const missing = cr?.threw ? want : want.filter((c) => !red.has(c));
      ctl = missing.length ? `DID NOT FAIL: ${missing.join(',')}${cr?.threw ? ' (control threw: ' + cr.threw.slice(0, 120) + ')' : ''}` : `red [${want.join(',')}]`;
    }
    out[row.scenario] = { pass: ok && (noControl || !want.length || ctl.startsWith('red')), control: ctl, failed: row.checks.filter((c) => !c.ok).map((c) => c.label), threw: row.threw, ms: row.ms };
  }
  return out;
}

const physicalSerial = arg('android-serial');
const iosDevices = platforms.includes('ios') ? arg('ios-device')?.split(',').filter(Boolean) : undefined;
const noteParts = [
  ...(platforms.includes('ios') ? [iosDevices ? `physical iOS device${iosDevices.length > 1 ? 's' : ''} ${iosDevices.join(', ')}` : 'iOS on simulators'] : []),
  ...(platforms.includes('android') ? [physicalSerial ? `physical Android device ${physicalSerial}` : 'Android on the emulator'] : []),
];
const report = { gate: 'G-mobile', at: new Date().toISOString(), note: noteParts.join('; '), devices: {}, pass: true };
// files: URL paths the scenarios map onto files of their own (scrollCompose's mutant bundles under .scratch)
const files = {};
// a physical iOS device cannot reach the Mac's loopback: the server then listens on the Mac's address on the local network (--lan-host, default en0's), for this run only
const physicalIos = iosDevices;
const lanHost = physicalIos ? (arg('lan-host') ?? spawnSync('ipconfig', ['getifaddr', 'en0'], { encoding: 'utf8' }).stdout.trim()) : null;
if (physicalIos && !lanHost) throw new Error('--ios-device needs the Mac on a local network the device shares (no address on en0; pass --lan-host=<ip>)');
const srv = await startServer({ inject: RECORDER, files, ...(lanHost ? { host: lanHost } : {}) });
const port = Number(new URL(srv.url).port);

async function device(label, launch, plan, { optional = false } = {}) {
  let s;
  try { s = await launch(); } catch (e) {
    if (optional && e instanceof EngineUnavailable) { report.devices[label] = { verdict: 'SKIPPED', reason: e.message }; console.log(`[${label}] SKIPPED (optional device): ${e.message}`); return; }
    report.devices[label] = { verdict: 'NOT RUN', reason: e.message }; report.pass = false; console.log(`[${label}] NOT RUN: ${e.message}`); return;
  }
  const D = report.devices[label] = { version: s.version, standIn: !!s.standIn, optional };
  console.log(`[${label}] ${s.version}`);
  try { await plan(s, D); } catch (e) { D.error = String(e.stack ?? e).slice(0, 600); report.pass = false; console.log(`[${label}] ERROR ${D.error}`); } finally { await s.close(); }
  for (const v of Object.values(D.scenarios ?? {})) if (!v.pass) report.pass = false;
}
async function full(s, D, label, platform, scenarios, extra) {
  const real = await runScenarios(s, srv, label, platform, false, scenarios, extra);
  const control = noControl ? null : await runScenarios(s, srv, label, platform, true, scenarios, extra);
  D.scenarios = { ...(D.scenarios ?? {}), ...verdicts(real, control) };
  D.numbers = { ...(D.numbers ?? {}), ...real.numbers };
}

try {
  // --ios-device=<udid>[,<udid>]: physical iPhones / iPads over USB (xcrun devicectl list devices) instead of simulators; a device below iOS 26 runs the refusal
  if (physicalIos) {
    for (const udid of physicalIos) {
      const info = (k) => spawnSync('ideviceinfo', ['-u', udid, '-k', k], { encoding: 'utf8' }).stdout.trim();
      const ios = parseFloat(info('ProductVersion')) || 0, model = info('ProductType') || 'iOS device';
      const label = `${/^iPad/.test(model) ? 'iPadOS' : 'iOS'} ${info('ProductVersion')} ${model} (physical)`;
      await device(label, () => launchIosDevice({ udid }), async (s, D) => {
        Object.assign(D, { physical: true, model, ios });
        await full(s, D, label, 'ios', ios >= 26 ? SCENARIOS : { unsupported });
      });
    }
  } else if (platforms.includes('ios')) {
    const sims = simDevices();
    const iphones = sims.filter((d) => /^iPhone 17$/.test(d.name));
    const picked = arg('ios-devices')?.split(',').map((u) => sims.find((d) => d.udid === u)).filter(Boolean)
      ?? [newest(iphones.filter((d) => d.ios >= 26 && d.ios < 27)), newest(iphones.filter((d) => d.ios >= 27))].filter(Boolean);
    if (!picked.length) { report.devices.ios = { verdict: 'NOT RUN', reason: 'no iPhone 17 simulator on iOS >= 26 (full Xcode with an iOS 26 runtime is needed)' }; report.pass = false; }
    // the first device (the newest iOS 26.x, the minimum) is required; a newer runtime is optional (SKIPPED with the reason when safaridriver cannot pair with it)
    for (const [i, d] of picked.entries()) {
      const label = `iOS ${d.ios} ${d.name}`;
      await device(label, () => launchIosSimulator({ udid: d.udid }), (s, D) => full(s, D, label, 'ios', SCENARIOS), { optional: i > 0 });
    }
    const ipadArg = arg('ipad');
    const ipad = ipadArg === 'none' ? null : ipadArg ? sims.find((d) => d.udid === ipadArg) : newest(sims.filter((d) => /^iPad Air 11/.test(d.name) && d.ios >= 26 && d.ios < 27));
    if (ipad) { const label = `iPadOS ${ipad.ios} ${ipad.name}`; await device(label, () => launchIosSimulator({ udid: ipad.udid }), (s, D) => full(s, D, label, 'ios', { gate, explainer })); }
    const oldArg = arg('ios-old');
    const old = oldArg === 'none' ? null : oldArg ? sims.find((d) => d.udid === oldArg) : newest(sims.filter((d) => /^iPhone/.test(d.name) && d.ios >= 18 && d.ios < 19));
    if (old) { const label = `iOS ${old.ios} ${old.name} (refusal)`; await device(label, () => launchIosSimulator({ udid: old.udid }), (s, D) => full(s, D, label, 'ios', { unsupported })); }
  }
  if (platforms.includes('android')) {
    // --android-serial=<serial>: a physical device over USB (adb devices) instead of the emulator
    const physical = physicalSerial;
    const label = physical ? `Android device ${physical}` : 'Android Emulator';
    await device(label, () => (physical ? attachDevice({ serial: physical, serverPorts: [port], pkg: arg('android-package') }) : launchAndroid({ avd: arg('avd') ?? 'hicmobile', avdHome: arg('avd-home') ?? process.env.ANDROID_AVD_HOME, serverPorts: [port], standIn: !process.argv.includes('--no-stand-in'), pkg: arg('android-package') })), async (s, D) => {
      D.browsers = s.browsers;
      if (physical) Object.assign(D, { physical: true, model: s.model, android: s.android });
      if (s.standIn) D.standInNote = `Chrome ${s.chromeVersion} with the anchor-positioning flag and a Chromium ${130} user agent: a stand-in for Chrome for Android >= 130, NOT a verification of it`;
      if (s.chromeMajor >= 130 || s.standIn) {
        // a usable native implementation (Chromium 158 ships it without a flag): the polyfill scenarios force the polyfill's path, nativeFirst checks the step-aside
        await s.navigate(new URL('/test/fixtures/mobile/index.html?mode=ref&iso=0', srv.url).href);
        D.native = await s.evaluate(`import('/src/api/native-detect.js').then((m) => { const n = m.probeNative(window); return { kind: n.kind, usable: m.nativeUsable(n), probe: n.probe, missing: n.missing }; })`);
        const forced = !!D.native?.usable;
        await full(s, D, label, 'android', SCENARIOS, { standIn: s.standIn, forced, plainBundle: BUNDLES.android, bundle: forced ? `${BUNDLES.android},/test/mobile/force-polyfill.js` : BUNDLES.android });
      }
      // the refusal on a real browser below 130: the same one (stand-in run: its real agent in a second tab) or the image's own Chrome 124 after a Chromium run
      const old = s.chromeMajor < 130 ? null : (s.browsers ?? []).find((b) => b.major < 130);
      if (s.chromeMajor < 130 || old) {
        const t = old ? await openPackage(s, old.pkg) : await plainTab(s);
        if (old) D.refusalBrowser = t.version;
        try { await full(t, D, label + ' (real agent)', 'android', { unsupported }); } finally { await t.close(); }
      }
    });
  }
} catch (e) { if (!(e instanceof EngineUnavailable || e instanceof AndroidUnavailable)) throw e; } finally { await srv.close(); clearTimeout(watchdog); }

const table = [];
for (const [label, D] of Object.entries(report.devices)) {
  if (!D.scenarios) { table.push({ device: label, scenario: '-', verdict: D.verdict ?? 'ERROR', control: '', first_failure: (D.reason ?? D.error ?? '').slice(0, 100) }); continue; }
  for (const [sc, r] of Object.entries(D.scenarios)) table.push({ device: label + (D.standIn ? ' [stand-in]' : ''), scenario: sc, verdict: r.pass ? 'PASS' : 'FAIL', control: r.control.slice(0, 30), first_failure: (r.threw ?? r.failed[0] ?? '').slice(0, 80) });
}
console.table(table);
writeFileSync(join(outRoot, `mobile-${stamp}.json`), JSON.stringify({ ...report, table }, null, 1));
if (noControl) report.pass = false;
console.log(report.pass ? `G-mobile PASS (${report.note})` : 'G-mobile FAIL' + (noControl ? ' (--no-control never passes)' : ''));
process.exit(report.pass ? 0 : 1);
