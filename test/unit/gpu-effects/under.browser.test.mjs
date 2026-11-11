// The under page of an effect host (EffectHostOptions.under) on a real WebGPU device: a second drawable with its own texture (frame.under), uploaded
// when its own version advances; a mapper's {x, y, under: true} sends a press to it (the interposer hit-tests inside the under element only), and
// typing then reaches its field. Controls: the same mapping on a host without `under` is NO_TARGET (the press lands nowhere), and a host without
// `under` asks nothing about a second element (no second provider, no second upload, no second geometry). Skipped LOUDLY without WebGPU.
import { test, assert, fixture } from '/test/unit/lib/t.js';
import { gpuAvailable, px } from './lib/rig.mjs';
import { createEffectHost } from '/src/effects/effect-host.js';
import { definePlugin } from '/src/effects/plugin-abi.js';
import { createBus } from '/src/util/bus.js';
import { BUS } from '/src/contracts/events.js';

const GPU = await gpuAvailable();
console.error(`under-page tests: WebGPU ${GPU ? 'available' : 'NOT available'}`);
const gtest = (name, fn, opts) => (GPU ? test(name, fn, opts) : test.skip(`SKIPPED: no WebGPU - ${name}`, fn));

const W = 320, H = 200;
/** both fields sit at the same place of their page: natively, a press there hits the field of the page on top (the main page) */
const FIELD = 'position:absolute;left:40px;top:100px;width:120px;height:24px;margin:0;box-sizing:border-box;font:14px monospace';
const PAGE = 'position:absolute;left:0;top:0;width:320px;height:200px';

/** A rig with two drawables in one fake live layer, each with its own 2D surface and SnapshotVersion. */
function makeUnderRig() {
  const root = fixture(`<canvas id="c" width="${W}" height="${H}" style="display:block;width:${W}px;height:${H}px"></canvas>`
    + `<div id="layer" style="${PAGE}"><div id="under" style="${PAGE};z-index:1"><input id="uf" style="${FIELD}"></div>`
    + `<div id="main" style="${PAGE};z-index:2"><input id="mf" style="${FIELD}"></div></div>`, { position: 'relative', width: `${W}px`, height: `${H}px` });
  const canvas = /** @type {HTMLCanvasElement} */ (root.querySelector('#c'));
  const layerEl = /** @type {HTMLElement} */ (root.querySelector('#layer'));
  const main = /** @type {HTMLElement} */ (root.querySelector('#main'));
  const under = /** @type {HTMLElement} */ (root.querySelector('#under'));
  const bus = createBus();
  const reports = [];
  const layer = {
    element: layerEl,
    isMounted: () => true,
    drawableElements: () => [main, under],
    elementAtPoint: (p, within) => document.elementsFromPoint(p.x, p.y).find((el) => el !== layerEl && layerEl.contains(el) && (!within || within.contains(el))) ?? null,
  };
  const record = { id: 1, canvas, layer, contentBox: { width: W, height: H, gridScaleX: 1, gridScaleY: 1 } };
  const versions = new Map();
  /** every element the host asked the store about */
  const asked = new Set();
  let id = 0;
  const store = {
    version: (el) => { asked.add(el); return versions.get(el) ?? null; },
    rasterSource: (v, r) => {
      const x0 = Math.max(0, r.sx), y0 = Math.max(0, r.sy), x1 = Math.min(v.width, r.sx + r.sw), y1 = Math.min(v.height, r.sy + r.sh);
      return x1 > x0 && y1 > y0 ? { source: v.surface, sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0 } : null;
    },
  };
  const env = {
    window, document, options: { maxDpr: 1, defaultFrameCap: 0 }, bus, store,
    reporter: { caught: (error, where) => reports.push({ error, where }), unsupported: (entry) => reports.push({ unsupported: entry }) },
    registry: { get: (c) => (c === canvas ? record : undefined) },
    now: () => performance.now(),
  };
  const hooks = [];
  const scheduler = { addFrameHook: (rec, hook) => { hooks.push(hook); return () => hooks.splice(hooks.indexOf(hook), 1); }, wake() {}, requestPaint() {} };
  const geometry = { calls: [], update: (rec, el, o) => geometry.calls.push(['update', el.id, o.canvasTransform]), clear: (rec, el) => geometry.calls.push(['clear', el.id]), get: () => new DOMMatrix() };
  const tracker = { setMappedTarget() {}, setMappedPress() {}, mappedTarget: () => null, snapshot: () => ({}), onChange: () => () => {} };
  return {
    canvas, layerEl, main, under, reports, env, asked, geometry,
    deps: { store, scheduler, geometry, tracker },
    uf: /** @type {HTMLInputElement} */ (root.querySelector('#uf')),
    mf: /** @type {HTMLInputElement} */ (root.querySelector('#mf')),
    /** paint one page a flat colour and publish its next version */
    commit(el, rgb) {
      const surface = document.createElement('canvas');
      surface.width = W; surface.height = H;
      const g = surface.getContext('2d');
      g.fillStyle = `rgb(${rgb.join(',')})`; g.fillRect(0, 0, W, H);
      const v = { id: ++id, element: new WeakRef(el), width: W, height: H, surface, dirty: null };
      versions.set(el, v);
      bus.emit(BUS.SOURCE_VERSION, { record, version: v });
    },
    tick(now = performance.now()) { let r; for (const h of [...hooks]) r = h(now, { frameCap: 0, due: true }); return r; },
    snap() {
      const c = document.createElement('canvas');
      c.width = canvas.width; c.height = canvas.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(canvas, 0, 0);
      return g.getImageData(0, 0, c.width, c.height);
    },
    /** a synthetic press at canvas point (x, y), on what the browser hits there natively */
    press(x, y) {
      const r = canvas.getBoundingClientRect();
      const cx = r.left + x, cy = r.top + y;
      const target = document.elementFromPoint(cx, cy) ?? layerEl;
      const base = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 };
      const down = new PointerEvent('pointerdown', { ...base, buttons: 1 });
      target.dispatchEvent(down);
      // what the browser would do on mousedown when pointerdown was not cancelled (synthetic events have no default actions)
      if (!down.defaultPrevented) target.closest('input')?.focus();
      target.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));
      return { target, prevented: down.defaultPrevented };
    },
  };
}

/** Left of LIFT the picture shows the under page (frame.under), right of it the source: the mapper says the same. */
const LIFT = W / 2;
function liftPlugin(seen = {}) {
  return definePlugin({
    type: 'lift', apiVersion: 2, version: 1, outputCapabilities: { directCanvasRenderAttachment: true },
    create(ctx) {
      seen.under = ctx.under;
      const { device, format } = ctx;
      const module = device.createShaderModule({ code: `
        @group(0) @binding(0) var src : texture_2d<f32>;
        @group(0) @binding(1) var und : texture_2d<f32>;
        @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> { var p = array<vec2<f32>,3>(vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.)); return vec4(p[i], 0., 1.); }
        @fragment fn fs(@builtin(position) pos : vec4<f32>) -> @location(0) vec4<f32> {
          let q = vec2<i32>(pos.xy);
          if (pos.x < ${LIFT}.0) { return vec4(textureLoad(und, q, 0).rgb, 1.0); }
          return vec4(textureLoad(src, q, 0).rgb, 1.0); }` });
      const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] } });
      return {
        spatial: true,
        // shows the under page unless the test says otherwise
        get revealsUnder() { return seen.reveals !== false; },
        render(frame) {
          seen.frameUnder = frame.under;
          const underView = frame.under ? frame.under.view : frame.sourceView;
          const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: frame.sourceView }, { binding: 1, resource: underView }] });
          const pass = frame.encoder.beginRenderPass({ colorAttachments: [{ view: frame.destinationView, loadOp: 'clear', storeOp: 'store' }] });
          pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
        },
        captureInputMapper: () => (p) => (p.x < LIFT ? { x: p.x, y: p.y, under: true } : { x: p.x, y: p.y }),
      };
    },
  });
}

const RED = [230, 20, 20], GREEN = [20, 200, 40], BLUE = [20, 40, 220];
const near = (c, rgb) => Math.abs(c[0] - rgb[0]) < 8 && Math.abs(c[1] - rgb[1]) < 8 && Math.abs(c[2] - rgb[2]) < 8;

async function start(t, { withUnder, interposer = true, rig = makeUnderRig() }) {
  rig.commit(rig.main, RED);
  rig.commit(rig.under, GREEN);
  const host = await createEffectHost(rig.env, rig.deps, rig.canvas, rig.main, { interposer, ...(withUnder ? { under: rig.under } : {}) });
  t.cleanup(() => host.destroy());
  const seen = {};
  await host.addPlugin(liftPlugin(seen));
  return { rig, host, seen };
}

gtest('frame.under carries the under page: uploaded on its own version, rendered, and a frame renders when only the under page changed', async (t) => {
  const { rig, host, seen } = await start(t, { withUnder: true, interposer: false });
  rig.tick();
  let img = rig.snap();
  assert.equal(seen.under, true, 'context.under');
  assert.ok(seen.frameUnder && seen.frameUnder.ready === true, 'frame.under is ready after its first upload');
  assert.ok(near(px(img, 60, 60), GREEN), `the lifted half shows the under page: ${px(img, 60, 60)}`);
  assert.ok(near(px(img, 260, 60), RED), `the rest shows the source: ${px(img, 260, 60)}`);
  let s = host.stats();
  assert.equal(s.uploads, 1);
  assert.equal(s.underUploads, 1);
  // only the under page changes: one more under upload, no source upload, and the frame shows it
  rig.commit(rig.under, BLUE);
  const frames = s.frames;
  rig.tick();
  img = rig.snap();
  s = host.stats();
  assert.equal(s.frames, frames + 1, 'a new under version renders a frame');
  assert.equal(s.underUploads, 2);
  assert.equal(s.uploads, 1, 'the source was not uploaded again');
  assert.ok(near(px(img, 60, 60), BLUE), `the new under version is shown: ${px(img, 60, 60)}`);
  // nothing changed: no frame (zero work at rest)
  assert.equal(rig.tick(), false);
  assert.equal(host.stats().frames, frames + 1);
  // both get the fill geometry, the source LAST (the top of the hit-test order)
  const updates = rig.geometry.calls.filter((c) => c[0] === 'update').map((c) => c[1]);
  assert.deepEqual(updates, ['under', 'main']);
  host.destroy();
  assert.deepEqual(rig.geometry.calls.filter((c) => c[0] === 'clear').map((c) => c[1]).sort(), ['main', 'under']);
});

gtest('a press mapped to the under page focuses the under field and typing reaches it; control: the same mapping without `under` lands nowhere', async (t) => {
  {
    const { rig, host } = await start(t, { withUnder: true });
    rig.tick();
    assert.deepEqual(host.mapPoint({ x: 100, y: 112 }), { x: 100, y: 112, under: true });
    const { target, prevented } = rig.press(100, 112);
    assert.equal(target, rig.mf, 'natively the press hits the field of the main page (it is on top)');
    assert.ok(prevented, 're-targeted');
    assert.equal(document.activeElement, rig.uf, 'the under field took the focus');
    document.execCommand('insertText', false, 'abc');
    assert.equal(rig.uf.value, 'abc');
    assert.equal(rig.mf.value, '', 'the main field got nothing');
    // a press on the part that shows the source still reaches the main page
    rig.mf.style.left = '200px';
    rig.press(240, 112);
    assert.equal(document.activeElement, rig.mf);
    rig.mf.blur();
    host.destroy();
  }
  {
    const { rig, host } = await start(t, { withUnder: false });
    rig.tick();
    assert.equal(host.mapPoint({ x: 100, y: 112 }), null, 'NO_TARGET without an under page');
    const { target, prevented } = rig.press(100, 112);
    assert.equal(target, rig.mf);
    assert.ok(prevented, 'the press is swallowed');
    assert.notEqual(document.activeElement, rig.uf);
    assert.notEqual(document.activeElement, rig.mf);
  }
});

gtest('without `under` nothing of a second page exists: no second provider, upload, texture or geometry (control: with it, all of them)', async (t) => {
  const counts = {};
  for (const withUnder of [false, true]) {
    const { rig, host, seen } = await start(t, { withUnder, interposer: false });
    rig.tick();
    rig.commit(rig.under, BLUE);
    rig.tick();
    const s = host.stats();
    counts[withUnder] = { asked: rig.asked.has(rig.under), underUploads: s.underUploads, underVersion: s.underVersion, frameUnder: seen.frameUnder ?? null, contextUnder: seen.under, geometry: rig.geometry.calls.map((c) => c[1]) };
    host.destroy();
  }
  assert.deepEqual(counts.false, { asked: false, underUploads: 0, underVersion: null, frameUnder: null, contextUnder: false, geometry: ['main'] });
  assert.equal(counts.true.asked, true);
  assert.equal(counts.true.underUploads, 2);
  assert.equal(typeof counts.true.underVersion, 'number');
  assert.ok(counts.true.frameUnder);
  assert.equal(counts.true.contextUnder, true);
  assert.deepEqual(counts.true.geometry, ['under', 'main']);
});

gtest('`under` must be another drawable of the canvas: not the source, not inside it, not around it, not a stranger', async (t) => {
  const rig = makeUnderRig();
  rig.commit(rig.main, RED);
  const stranger = document.createElement('div');
  rig.main.append(stranger);
  const outside = document.createElement('div');
  document.body.append(outside);
  t.cleanup(() => outside.remove());
  const names = [];
  for (const under of [rig.main, stranger, rig.layerEl, outside]) {
    try { (await createEffectHost(rig.env, rig.deps, rig.canvas, rig.main, { under })).destroy(); names.push('created'); } catch (e) { names.push(e.name); }
  }
  assert.deepEqual(names, ['InvalidStateError', 'InvalidStateError', 'InvalidStateError', 'InvalidStateError']);
  try { await createEffectHost(rig.env, rig.deps, rig.canvas, rig.main, { under: {} }); names.push('created'); } catch (e) { names.push(e.name); }
  assert.equal(names[4], 'TypeError');
  // positive control: the real under page is accepted
  const host = await createEffectHost(rig.env, rig.deps, rig.canvas, rig.main, { under: rig.under });
  host.destroy();
});

gtest('the under page is inert while the newest frame shows none of it; a focused field of it is blurred before it turns inert', async (t) => {
  const { rig, host, seen } = await start(t, { withUnder: true, interposer: false });
  assert.equal(rig.under.inert, true, 'inert before the first frame');
  seen.reveals = false;
  rig.tick();
  assert.equal(rig.under.inert, true, 'a frame that shows none of it keeps it inert');
  rig.uf.focus();
  assert.notEqual(document.activeElement, rig.uf, 'an inert field cannot take the focus (Tab, a screen reader, script)');
  seen.reveals = true;
  rig.commit(rig.main, BLUE);
  rig.tick();
  assert.equal(rig.under.inert, false, 'a frame that shows some of it lifts inert');
  rig.uf.focus();
  assert.equal(document.activeElement, rig.uf, 'control: the shown field takes the focus');
  const blurs = [];
  rig.uf.addEventListener('blur', () => blurs.push(rig.under.inert));
  seen.reveals = false;
  rig.commit(rig.main, RED);
  rig.tick();
  assert.deepEqual(blurs, [false], 'blurred once, while the page was not inert yet');
  assert.equal(rig.under.inert, true);
  assert.notEqual(document.activeElement, rig.uf);
  host.destroy();
  assert.equal(rig.under.inert, false, 'destroy gives the attribute back');
});

gtest('an inert the author set is left alone; without `under` the host sets inert nowhere', async (t) => {
  {
    const rig = makeUnderRig();
    rig.under.setAttribute('inert', '');
    const { host, seen } = await start(t, { withUnder: true, interposer: false, rig });
    rig.tick();
    assert.equal(rig.under.inert, true);
    seen.reveals = true;
    rig.commit(rig.main, BLUE);
    rig.tick();
    assert.equal(rig.under.inert, true, 'the author\'s inert stays while the page is shown');
    host.destroy();
    assert.equal(rig.under.inert, true, 'and after destroy');
  }
  {
    const { rig, host } = await start(t, { withUnder: false, interposer: false });
    rig.tick();
    assert.equal(rig.under.inert, false);
    assert.equal(rig.main.inert, false);
    host.destroy();
  }
});
