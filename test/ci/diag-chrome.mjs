// TEMPORARY diagnosis of Chrome on the hosted macOS runner: which launch configurations get a working renderer.
import * as H from '../harness/index.mjs';
import { execFileSync } from 'node:child_process';

const STABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const configs = [
  ['stable headless', STABLE, ['--headless=new']],
  ['stable headless unsafe-webgpu', STABLE, ['--headless=new', '--enable-unsafe-webgpu']],
  ['stable headed', STABLE, []],
  ['stable headed unsafe-webgpu', STABLE, ['--enable-unsafe-webgpu']],
  ['stable headed unsafe-webgpu + vulkan swiftshader', STABLE, ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader']],
];
const bounded = (p, ms) => Promise.race([p, new Promise((_, bad) => setTimeout(() => bad(new Error(`timeout ${ms} ms`)), ms))]);
for (const [name, path, args] of configs) {
  console.log(`\n=== ${name}`);
  let browser;
  try {
    browser = await H.launchChrome({ name: 'diag', chrome: path, extraArgs: args });
    const { targetInfos } = await browser.conn.send('Target.getTargets');
    console.log('targets', targetInfos.map((t) => `${t.type} ${t.url}`).join(' | '));
    const page = await bounded(browser.newPage(), 20000);
    console.log('page ok; eval:', await bounded(page.evaluate('navigator.userAgent'), 10000));
    console.log('gpu:', JSON.stringify(await bounded(page.evaluate(`(async () => { const a = await navigator.gpu?.requestAdapter(); return a ? a.info?.description || a.info?.vendor || 'adapter' : null; })()`), 20000).catch((e) => String(e))));
    if (!args.includes('--headless=new')) {
      await page.ensureForeground({ timeout: 4000 }).then((r) => console.log('focus', r.mode));
      const r = await bounded(page.measureRaf({ frames: 120 }), 20000).catch((e) => ({ error: String(e) }));
      console.log('raf', JSON.stringify({ p50: r.p50, p95: r.p95, hz: r.hz, error: r.error }));
      console.log('viewport', JSON.stringify(await page.viewport()));
    }
    const info = await browser.info();
    console.log('gpu devices', JSON.stringify(info.gpu?.map((d) => d.deviceString)), 'features', JSON.stringify(info.featureStatus));
  } catch (e) {
    console.log('FAILED', String(e).slice(0, 300));
  } finally {
    if (browser) {
      console.log('stderr tail:\n' + browser.getStderr().split('\n').slice(-25).join('\n'));
      try { console.log(execFileSync('ps', ['-o', 'pid,stat,etime,command', '-g', String(browser.pid)], { encoding: 'utf8' }).split('\n').map((l) => l.slice(0, 220)).join('\n')); } catch { /* none */ }
      await Promise.race([browser.close(), H.sleep(10000)]);
    }
  }
}
process.exit(0);
