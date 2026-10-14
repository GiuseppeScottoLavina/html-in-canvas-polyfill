// Test kit of the transition plugins (disintegrate, shatter): the plugin through the REAL effects host on a real WebGPU canvas, over a
// form-like picture, with every mapper and device of the instance recorded. Browser only (served by test/unit/run.mjs).
import { makeRig } from '/test/unit/gpu-effects/lib/rig.mjs';
import { createEffectHost } from '/src/effects/effect-host.js';
import { definePlugin } from '/src/effects/plugin-abi.js';

export const W = 480, H = 320, DURATION = 1000;
export const CONTROLS = `<form id="f" novalidate style="position:absolute;inset:0;margin:0">
  <button id="btn" type="button" style="position:absolute;left:40px;top:40px;width:120px;height:40px;margin:0">Go</button>
  <input id="txt" type="text" value="hello" style="position:absolute;left:40px;top:120px;width:200px;height:28px;margin:0;box-sizing:border-box">
  <input id="mail" type="email" value="ada@example.com" style="position:absolute;left:40px;top:180px;width:200px;height:28px;margin:0;box-sizing:border-box">
  <button id="send" type="submit" style="position:absolute;left:280px;top:180px;width:90px;height:28px;margin:0">Send</button></form>`;

/** A form-like picture: gradient, panels, text, so moved pieces always change pixels. @param {CanvasRenderingContext2D} ctx */
export function paint(ctx) {
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#16324f'); grad.addColorStop(1, '#3b1d5a');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#e8f6ff'; ctx.fillRect(40, 40, 120, 40); ctx.fillRect(40, 120, 200, 28); ctx.fillRect(40, 180, 200, 28);
  ctx.fillStyle = '#ffb06b'; ctx.fillRect(280, 180, 90, 28);
  ctx.fillStyle = '#0b1622'; ctx.font = '16px sans-serif'; ctx.fillText('Go', 85, 66); ctx.fillText('hello', 48, 140);
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 30px sans-serif'; ctx.fillText('Touch the interface.', 40, 290);
}

/** @param {ImageData} a @param {ImageData} b */
export function diff(a, b) {
  let over = 0, max = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d > 16) over += 1;
    if (d > max) max = d;
  }
  return { over, max };
}

/** pixels differing by more than 16 levels in the square of half side r around (x, y) @param {ImageData} a @param {ImageData} b @param {number} x @param {number} y @param {number} r */
export function diffNear(a, b, x, y, r) {
  let over = 0;
  for (let j = Math.max(0, y - r); j < Math.min(H, y + r); j += 1) for (let i = Math.max(0, x - r); i < Math.min(W, x + r); i += 1) {
    const k = (j * W + i) * 4;
    if (Math.max(Math.abs(a.data[k] - b.data[k]), Math.abs(a.data[k + 1] - b.data[k + 1]), Math.abs(a.data[k + 2] - b.data[k + 2])) > 16) over += 1;
  }
  return over;
}

/**
 * @param {any} plugin  the plugin definition under test
 * @param {Record<string, unknown>} defaults  options of every addPlugin (the transition durations)
 */
export function transitionRig(plugin, defaults) {
  /** The definition, wrapped so the test sees every mapper and device, with the getters of the instance (continuous) kept live. */
  function wrap() {
    /** @type {Function[]} */ const mappers = [];
    /** @type {any[]} */ const devices = [];
    const def = definePlugin({
      ...plugin,
      async create(/** @type {any} */ ctx, /** @type {any} */ options) {
        devices.push(ctx.device);
        const inst = await plugin.create(ctx, options);
        return new Proxy(inst, {
          get(target, key) {
            if (key !== 'captureInputMapper') return Reflect.get(target, key);
            return (/** @type {any} */ frame) => { const m = /** @type {any} */ (target).captureInputMapper(frame); mappers.push(m); return m; };
          },
        });
      },
    });
    return { def, mappers, devices };
  }

  /** @param {any} t @param {{interposer?: boolean, html?: string}} [o] */
  async function rigHost(t, { interposer = false, html = '' } = {}) {
    const rig = makeRig({ w: W, h: H, paint, html });
    rig.commit();
    const host = await createEffectHost(rig.env, rig.deps, rig.canvas, rig.source, { interposer });
    t.cleanup(() => host.destroy());
    return { rig, host };
  }

  /** What the host presents for this source with no plugin at all. @param {any} t */
  async function reference(t) {
    const { rig, host } = await rigHost(t);
    rig.tick(performance.now());
    const img = rig.snap();
    host.destroy();
    rig.root.remove();
    return img;
  }

  /** @param {any} t @param {Record<string, unknown>} options @param {{interposer?: boolean, html?: string}} [o] */
  async function start(t, options, o) {
    const { rig, host } = await rigHost(t, o);
    const spy = wrap();
    const handle = await host.addPlugin(spy.def, { ...defaults, ...options });
    return { rig, host, handle, ...spy };
  }

  return { wrap, rigHost, reference, start };
}
