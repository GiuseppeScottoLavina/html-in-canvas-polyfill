// TEMPORARY: does WebGPU present continuously on the hosted macOS runner (Apple Paravirtual device)? One canvas cleared to a new colour every rAF.
import * as H from '../harness/index.mjs';

const PAGE = `(async () => {
  const out = { steps: [] };
  const t0 = performance.now();
  const step = (s) => out.steps.push([Math.round(performance.now() - t0), s]);
  const adapter = await navigator.gpu.requestAdapter(); step('adapter ' + (adapter ? adapter.info.vendor : null));
  const device = await adapter.requestDevice(); step('device');
  device.lost.then((i) => step('LOST ' + i.reason + ' ' + i.message));
  device.addEventListener('uncapturederror', (e) => step('error ' + e.error.message));
  const c = document.createElement('canvas'); c.width = 400; c.height = 300; document.body.append(c);
  const ctx = c.getContext('webgpu'); ctx.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'premultiplied' });
  let frames = 0, done = 0, pending = 0;
  const end = performance.now() + 3000;
  await new Promise((res) => {
    const f = () => {
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: (frames % 60) / 60, g: 0.3, b: 0.6, a: 1 } }] });
      pass.end(); device.queue.submit([enc.finish()]); frames++; pending++;
      device.queue.onSubmittedWorkDone().then(() => { done++; pending--; });
      if (performance.now() < end) requestAnimationFrame(f); else res();
    };
    requestAnimationFrame(f);
  });
  step('loop end');
  await Promise.race([device.queue.onSubmittedWorkDone(), new Promise((r) => setTimeout(r, 3000))]); step('drain');
  Object.assign(out, { frames, done, pending });
  return out;
})()`;

for (const headless of [false, true]) {
  const srv = await H.startServer();
  const browser = await H.launchChrome({ name: 'diag-webgpu', extraArgs: headless ? ['--headless=new'] : [] });
  try {
    const page = await browser.newPage();
    await page.navigate(`${srv.url}/examples/index.html`);
    if (!headless) await page.ensureForeground({ timeout: 4000 });
    const r = await Promise.race([page.evaluate(PAGE), H.sleep(20000).then(() => 'TIMEOUT')]);
    console.log(headless ? 'headless' : 'headed', JSON.stringify(r));
    await page.navigate(`${srv.url}/examples/plugins/?effect=water`);
    await H.sleep(4000);
    const g = await Promise.race([page.evaluate(`(async () => {
      const h = window.__gallery && window.__gallery.host; if (!h) return 'no gallery host';
      const cv = document.querySelector('canvas'); let ev = 0; document.addEventListener('effectframe', () => ev++, true);
      let raf = 0; const t0 = performance.now(); await new Promise((r) => { const f = () => { raf++; performance.now() - t0 < 2000 ? requestAnimationFrame(f) : r(); }; requestAnimationFrame(f); });
      const s0 = h.stats(); await new Promise((r) => setTimeout(r, 2000)); const s1 = h.stats();
      return { raf, ev, s0, s1, cap: cv && cv.getAttribute('framecap'), vis: document.visibilityState, focus: document.hasFocus() };
    })()`), H.sleep(15000).then(() => 'TIMEOUT')]);
    console.log('  gallery water', JSON.stringify(g));
  } catch (e) { console.log('FAILED', String(e).slice(0, 300)); } finally {
    await Promise.race([browser.close(), H.sleep(10000)]); await srv.close();
  }
}
process.exit(0);
