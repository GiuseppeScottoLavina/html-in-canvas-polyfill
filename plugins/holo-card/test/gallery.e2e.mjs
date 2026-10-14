#!/usr/bin/env node
// Gallery click-through for the holo-card plugin (headless Chrome, trusted input): see plugins/_shared/gallery-click.mjs.
// The card tilts towards the pointer; the pointer is moved to a point where the TILTED card draws a control away from its DOM position,
// the card comes to rest there, and the click at that point must reach the control.
//   npm run build && node plugins/holo-card/test/gallery.e2e.mjs
import * as H from '../../../test/harness/index.mjs';
import { UNIFORM_FLOATS, mapCardPoint, meta, writeCardPose } from '../index.js';
import { runGalleryClickThrough } from '../../_shared/gallery-click.mjs';

let size = { w: 1, h: 1 };
const tilt = (meta.defaults.tilt * Math.PI) / 180;
await runGalleryClickThrough({
  name: 'holo-card',
  async setup(ctx) { size = { w: ctx.canvas.w, h: ctx.canvas.h }; },
  // the pose at rest with the pointer at p (render(): rx = -tilt * y, ry = tilt * x, with x, y = the pointer in -1..1)
  mapFor(p) {
    const s = new Float32Array(UNIFORM_FLOATS);
    s[2] = size.w; s[3] = size.h;
    writeCardPose(s, -tilt * ((2 * p.y) / size.h - 1), tilt * ((2 * p.x) / size.w - 1), 0.86, size.w, size.h);
    return (q) => mapCardPoint(s, q);
  },
  settleBeforeClick: 1500,
  // the pointer leaves: the card sways on its own (idle sway, default on)
  async animate(ctx) { await ctx.page.mouseMove(5, 5); },
});
