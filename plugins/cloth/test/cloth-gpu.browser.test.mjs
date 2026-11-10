// The cloth plugin on the real GPU (headless Chrome, the real effects host): its input mapper against the pixels the GPU produced
// (plugins/_shared/gpu-check.mjs), with the identity and the mapper of a frame a few steps earlier as controls; the cloth at rest is the
// page, pixel for pixel; each action through the effect handle; a device loss while the cloth is held; and the GPU time.
import { assert } from '/test/unit/lib/t.js';
import { agreement, changedPixels, checkMapperAgainstGpu, gpuAvailable, gpuTest, identity, lossSpy, markerScene, presentOnce, runActionOnGpu, until } from '/plugins/_shared/gpu-check.mjs';
import { isNoTarget, meta, plugin, stateOf } from '/plugins/cloth/index.js';
import { CLOTH, FLAT, GONE, S } from '/plugins/cloth/surface.js';
import { measurePassGpuTime } from '/plugins/_shared/gpu-time.mjs';
import { plugin as template } from '/plugins/_template/index.js';

console.error(`cloth-gpu tests: WebGPU ${(await gpuAvailable()) ? 'available' : 'NOT available'}`);

const W = 480;
const H = 320;
const scene = markerScene({ w: W, h: H });
// The oracle calls a pixel bright when its red channel is over 110. For the mapper checks the cloth is lit evenly (no shadow, no sheen)
// and its back is dark, so that a bright pixel can only be a white marker on the printed side, whatever fold it lies in.
const PLAIN = { ...meta.defaults, shadow: 0, sheen: 0, through: 0.04, back: '#000' };

/** @param {any} rig @param {string} type @param {number[]} at @param {number} [buttons] */
function pointer(rig, type, [x, y], buttons = 1) {
  const r = rig.canvas.getBoundingClientRect();
  rig.layerEl.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, cancelable: true, isPrimary: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons, clientX: r.left + x, clientY: r.top + y }));
}
/**
 * Take the cloth at `from` and pull it to `to` over `ms` of the frame clock, presenting a frame every 16 ms (synthetic events reach the
 * plugin's capture listeners like trusted ones). The clock runs up to now, so the frame that the test presents next follows on it.
 * @param {number[]} from @param {number[]} to @param {number} [ms]
 */
const pull = (from, to, ms = 640) => (/** @type {any} */ rig) => {
  const frames = Math.round(ms / 16), t0 = performance.now() - frames * 16;
  pointer(rig, 'pointerdown', from);
  for (let k = 1; k <= frames; k += 1) {
    const f = Math.min(1, k / (frames * 0.6));
    pointer(rig, 'pointermove', [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f]);
    rig.tick(t0 + k * 16);
  }
};
const CORNER = [470, 312];
const LIFTED = [300, 150];

gpuTest('held and pulled: the mapper predicts every presented pixel (the page point on the printed side, no target on the back and on the wall); identity does not', async (t) => {
  // minBrightShare 0.5: the lifted corner shows its back, and the wall shows where it was
  const v = await checkMapperAgainstGpu(t, plugin, PLAIN, { scene, before: pull(CORNER, LIFTED), minBrightShare: 0.5 });
  console.error(`cloth mapper vs GPU (pulled): decided=${v.real.decided} wrong=${v.real.wrong} bright=${v.real.bright} | identity wrong=${v.identity.wrong}`);
  assert.ok(v.ok, v.why);
});
