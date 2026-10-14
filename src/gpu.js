/**
 * The GPU bundle: WebGL texElementSubImage2D / texElementImage2D and GPUQueue drawElementImageToTexture / copyElementImageToTexture over the retained
 * surfaces (api/texture-patch.js), outside the Chrome core. Importing it registers the installer on Symbol.for('hic.gpu-patches'); when the core is already installed it
 * replaces the core's stubs at once. The package entry (src/index.js) imports it; classic pages that upload elements as textures load hic-live-gpu.iife.js.
 */

import { installTexturePatches } from './api/texture-patch.js';

const bundle = { installTexturePatches };
/** @type {any} */ (globalThis)[Symbol.for('hic.gpu-patches')] = bundle;
const installed = /** @type {any} */ (globalThis).HicLivePolyfill?.getInstalled?.();
installed?.[Symbol.for('hic.effects-seam')]?.[Symbol.for('hic.gpu-late')]?.(bundle);

export { installTexturePatches };
