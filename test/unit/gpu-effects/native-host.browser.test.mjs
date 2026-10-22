// The effect host in NATIVE mode (no record: the browser implements HTML-in-Canvas) on a real WebGPU device, over an EMULATED native API:
// the canvas gets updateElementGeometry / clearElementGeometry / getElementImageDefaultSize / getElementTransform / requestPaint as own
// members, GPUQueue.prototype.drawElementImageToTexture copies a 2D surface the test paints, and the test dispatches the `paint` events the
// browser would. What it checks is the host's timing: uploads happen in the paint event (where a native element image is fresh), a paint
// after this frame's rAF render uploads without rendering that frame twice. On Chrome Canary the real thing runs in
// test/native-effects/run.mjs. Skipped LOUDLY without WebGPU.
import { test, assert, frames } from '/test/unit/lib/t.js';
import { gpuAvailable } from './lib/rig.mjs';
import { createEffectHost } from '/src/effects/effect-host.js';
import { definePlugin } from '/src/effects/plugin-abi.js';
import { createBus } from '/src/util/bus.js';

const GPU = await gpuAvailable();
console.error(`native-mode host tests: WebGPU ${GPU ? 'available' : 'NOT available'}`);
const gtest = (name, fn, opts) => (GPU ? test(name, fn, opts) : test.skip(`SKIPPED: no WebGPU - ${name}`, fn));

const W = 240, H = 160;

async function nativeRig(t) {
  const holder = document.createElement('div');
  // without a native implementation the children of a canvas get no box, so the source sits next to it and the canvas claims it (contains)
  holder.innerHTML = `<canvas style="display:block;width:${W}px;height:${H}px"></canvas><div id="src" style="width:${W}px;height:${H}px">source</div>`;
  document.body.append(holder);
  const canvas = holder.querySelector('canvas');
  const source = holder.querySelector('#src');
  const surface = document.createElement('canvas');
  surface.width = W; surface.height = H;
  const ctx2d = surface.getContext('2d');
  const geometry = [];
  Object.assign(canvas, {
    updateElementGeometry: (el, o) => geometry.push(['update', o.canvasTransform]),
    clearElementGeometry: () => geometry.push(['clear']),
    getElementImageDefaultSize: () => ({ width: canvas.width, height: canvas.height }),
    getElementTransform: (el) => { if (el !== source) throw new DOMException('not drawable', 'InvalidStateError'); return new DOMMatrix(); },
    requestPaint: () => {},
    contains: (el) => el === source,
  });
  let stamp = 0;
  const draws = [];
  const had = Object.prototype.hasOwnProperty.call(GPUQueue.prototype, 'drawElementImageToTexture');
  if (!had) {
    GPUQueue.prototype.drawElementImageToTexture = function (s, d) {
      draws.push({ stamp, t: document.timeline.currentTime });
      this.copyExternalImageToTexture({ source: surface }, { texture: d.texture }, [Math.min(W, d.texture.width), Math.min(H, d.texture.height)]);
    };
  }
  const reports = [];
  const env = {
    window, document, options: { maxDpr: 1, defaultFrameCap: 0 }, bus: createBus(),
    reporter: { caught: (error, where) => reports.push({ error, where }), unsupported: (entry) => reports.push({ unsupported: entry }) },
    registry: { get: () => undefined },
    now: () => performance.now(),
  };
  const deps = { store: null, scheduler: null, geometry: null, tracker: null };
  t.cleanup(() => { if (!had) delete GPUQueue.prototype.drawElementImageToTexture; holder.remove(); });
  const rig = {
    canvas, source, geometry, draws, reports, env, deps,
    /** the browser painted a changed source: new pixels, then the paint event naming it */
    paint(changed = [source]) {
      stamp += 1;
      ctx2d.fillStyle = `rgb(${(stamp * 40) % 256}, 0, 0)`;
      ctx2d.fillRect(0, 0, W, H);
      const e = new Event('paint');
      Object.defineProperty(e, 'changedElements', { value: changed });
      canvas.dispatchEvent(e);
      return stamp;
    },
    stamp: () => stamp,
  };
  return rig;
}

/** A plugin that renders nothing and logs every render call; `continuous` renders every frame. */
const logPlugin = (log, continuous = false) => definePlugin({
  type: 'log', apiVersion: 2, version: 1,
  create: () => ({ continuous, render(frame) { log.push({ now: frame.now, delta: frame.delta, frameIndex: frame.frameIndex, sourceVersion: frame.sourceVersion }); } }),
});

gtest('native mode: the source is uploaded and rendered inside the paint event that announced it', async (t) => {
  const rig = await nativeRig(t);
  const host = await createEffectHost(rig.env, rig.deps, rig.canvas, rig.source, { interposer: false });
  t.cleanup(() => host.destroy());
  const log = [];
  await host.addPlugin(logPlugin(log));
  await frames(3);
  const effectFrames = [];
  rig.canvas.addEventListener('effectframe', (e) => effectFrames.push(e.detail.frameIndex));
  const s = rig.paint();
  assert.equal(rig.draws.at(-1)?.stamp, s, 'drawElementImageToTexture ran in the paint event, on the new pixels');
  assert.equal(effectFrames.length, 1, 'and the frame was rendered there');
  const n = rig.draws.length;
  rig.paint([]);
  assert.equal(rig.draws.length, n, 'a paint that names nothing is no new source: no upload');
  assert.ok(rig.geometry.some(([k, m]) => k === 'update' && m.a === 1 && m.d === 1), 'the stretch is applied with updateElementGeometry (hit-testable)');
});

gtest('native mode: a paint after this frame\'s rAF render uploads the fresh source without rendering the frame again; the next frame shows it', async (t) => {
  const rig = await nativeRig(t);
  const host = await createEffectHost(rig.env, rig.deps, rig.canvas, rig.source, { interposer: false });
  t.cleanup(() => host.destroy());
  const log = [];
  await host.addPlugin(logPlugin(log, true));
  rig.paint();
  await frames(4);
  // outside the rAF phase, the host's next rAF (continuous: always pending) is already registered: ours runs after it in the same frame, like the browser's paint step
  await new Promise((r) => setTimeout(r, 0));
  const before = log.length;
  const uploadsBefore = host.stats().uploads;
  let stamp = 0;
  await new Promise((resolve) => requestAnimationFrame(() => { stamp = rig.paint(); resolve(undefined); }));
  const inFrame = log.slice(before);
  assert.equal(inFrame.length, 1, `one render in the frame, by the rAF (${JSON.stringify(inFrame)})`);
  assert.equal(host.stats().uploads, uploadsBefore + 1, 'the source was uploaded in the paint event');
  assert.equal(rig.draws.at(-1).stamp, stamp, 'with the pixels of that paint');
  await frames(1);
  const next = log.slice(before + 1);
  assert.ok(next.length >= 1 && next[0].sourceVersion > inFrame[0].sourceVersion && next[0].frameIndex === inFrame[0].frameIndex + 1, `the next frame renders the new source (${JSON.stringify(next)})`);
});

gtest('native mode: the framecap attribute bounds the effect frames; a source without the native API is refused loudly', async (t) => {
  const rig = await nativeRig(t);
  rig.canvas.setAttribute('framecap', '20');
  const host = await createEffectHost(rig.env, rig.deps, rig.canvas, rig.source, { interposer: false });
  t.cleanup(() => host.destroy());
  await host.addPlugin(logPlugin([], true));
  rig.paint();
  let n = 0;
  const on = () => { n += 1; };
  rig.canvas.addEventListener('effectframe', on);
  await new Promise((r) => setTimeout(r, 1000));
  rig.canvas.removeEventListener('effectframe', on);
  assert.ok(n >= 14 && n <= 22, `about 20 effect frames in one second, got ${n}`);

  const other = document.createElement('div');
  await assert.rejects(createEffectHost(rig.env, rig.deps, rig.canvas, other, {}), /not an eligible drawable/);
  delete rig.canvas.updateElementGeometry;
  await assert.rejects(createEffectHost(rig.env, rig.deps, rig.canvas, rig.source, {}), /lacks updateElementGeometry/);
});
