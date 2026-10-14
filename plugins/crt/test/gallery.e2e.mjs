#!/usr/bin/env node
// Gallery click-through for the CRT plugin (headless Chrome, trusted input): see plugins/_shared/gallery-click.mjs.
//   npm run build && node plugins/crt/test/gallery.e2e.mjs
import { UNIFORM_FLOATS, bezelWidth, cornerRadius, mapCrtPoint, meta } from '../index.js';
import { runGalleryClickThrough } from '../../_shared/gallery-click.mjs';

/** @type {Float32Array|null} */ let state = null;
await runGalleryClickThrough({
  name: 'crt',
  async setup(ctx) {
    // the barrel of the default options, for the canvas size of the page (the same numbers render() writes)
    const { w, h } = ctx.canvas;
    state = new Float32Array(UNIFORM_FLOATS);
    state[2] = w; state[3] = h; state[4] = meta.defaults.curvature * 0.5; state[5] = bezelWidth(w, h); state[6] = cornerRadius(w, h);
  },
  mapFor: () => (p) => mapCrtPoint(/** @type {Float32Array} */ (state), p),
  // the CRT flickers on its own: no pointer needed to animate it
  animate: async () => {},
});
