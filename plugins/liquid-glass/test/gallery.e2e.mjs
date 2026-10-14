#!/usr/bin/env node
// Gallery click-through for the liquid-glass plugin (headless Chrome, trusted input): see plugins/_shared/gallery-click.mjs.
// The lens is brought next to a control by the pointer, pinned with the keyboard (its "Pin lens" checkbox), and then the control is
// clicked where the pinned lens draws it.
//   npm run build && node plugins/liquid-glass/test/gallery.e2e.mjs
import * as H from '../../../test/harness/index.mjs';
import { UNIFORM_FLOATS, mapLensPoint, meta, writeLensGeometry } from '../index.js';
import { TARGETS, runGalleryClickThrough } from '../../_shared/gallery-click.mjs';

/** the mapper of the default lens at rest, centred on (cx, cy), on a w x h canvas */
function lensMapper(/** @type {number} */ w, /** @type {number} */ h, /** @type {number} */ cx, /** @type {number} */ cy) {
  const s = new Float32Array(UNIFORM_FLOATS);
  s[2] = w; s[3] = h;
  writeLensGeometry(s, { cx, cy, vx: 0, vy: 0, size: meta.defaults.size, aspect: 1.45, refraction: meta.defaults.refraction });
  return (/** @type {any} */ p) => mapLensPoint(s, p);
}

const plan = {
  name: 'liquid-glass',
  /** @type {(p: any) => (p: any) => {x: number, y: number}} */
  mapFor: () => (p) => ({ x: p.x, y: p.y }),
  async setup(/** @type {any} */ ctx) {
    const { w, h } = ctx.canvas;
    // a lens position near a control from which the lens draws that control away from its DOM position
    let pick = null;
    for (const target of TARGETS) {
      const box = ctx.boxes.find((/** @type {any} */ b) => `#${b.id}` === target.sel);
      if (!box) continue;
      for (let r = 40; r <= 120 && !pick; r += 10) {
        for (let a = 0; a < 16 && !pick; a += 1) {
          const cx = Math.round(box.x + box.w / 2 + r * Math.cos((a * Math.PI) / 8));
          const cy = Math.round(box.y + box.h / 2 + r * Math.sin((a * Math.PI) / 8));
          if (cx < 0 || cy < 0 || cx > w || cy > h) continue;
          const map = lensMapper(w, h, cx, cy);
          const found = ctx.findDrawn(() => map, [target]);
          if (found) pick = { cx, cy, target };
        }
      }
      if (pick) break;
    }
    if (!pick) throw new Error('no lens position draws a control away from its DOM position');
    // the lens follows the pointer there and comes to rest exactly under it, then it is pinned with the keyboard
    await ctx.moveTo(pick.cx, pick.cy);
    await H.sleep(1500);
    await ctx.page.evaluate(`document.querySelector('#effect-controls input[id$="-pinned"]').focus()`);
    await ctx.page.key(' ');
    await H.sleep(200);
    const pinned = await ctx.page.evaluate(`document.querySelector('#effect-controls input[id$="-pinned"]').checked`);
    if (!pinned) throw new Error('the lens could not be pinned');
    await ctx.page.evaluate(`document.activeElement.blur()`);
    const map = lensMapper(w, h, pick.cx, pick.cy);
    plan.mapFor = () => map;
    plan.targets = [pick.target];
  },
  /** @type {typeof TARGETS|undefined} */
  targets: undefined,
  // unpinned again: the pointer drags the lens across the form while frames are counted
  async animate(/** @type {any} */ ctx) {
    await ctx.page.evaluate(`(() => { const b = document.querySelector('#effect-controls input[id$="-pinned"]'); b.checked = false; b.dispatchEvent(new Event('change')); })()`);
    for (let k = 0; k < 60; k += 1) { await ctx.moveTo(200 + (k % 20) * 40, 150 + (k % 7) * 40); await H.sleep(30); }
  },
};
await runGalleryClickThrough(plan);
