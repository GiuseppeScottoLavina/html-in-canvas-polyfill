/**
 * The ENGINES bundle: what the polyfill draws itself on Gecko (Firefox) and WebKit (Safari) only, outside the Chrome core: the form-control skins ported from
 * the engines' painters (native-controls.js, webkit-skins.js, gecko-skins.js), the WebKit classic scrollbars and the WebKit shadow rewrite. Importing it registers the
 * painter on Symbol.for('hic.engine-skins'), which the core's capture looks up (snapshot/capture/engine-skins.js); load order relative to the core does not matter.
 * The package entry (src/index.js) imports it, so bundler users get every engine; the classic core IIFE does not (hic-live-engines.iife.js for Firefox / Safari).
 */

import { consumeSkinPending, onSkinReady, paintNativeControl } from './snapshot/capture/native-controls.js';
import { registerEngineSkins } from './snapshot/capture/engine-skins.js';
import { paintWebkitBars, webkitDarkBars } from './snapshot/capture/webkit-bars.js';
import { webkitShadowStyle } from './snapshot/capture/webkit-shadow.js';

registerEngineSkins({ paintNativeControl, consumeSkinPending, onSkinReady, webkitShadowStyle, paintWebkitBars, webkitDarkBars });

export { paintNativeControl, consumeSkinPending, onSkinReady, webkitShadowStyle, paintWebkitBars, webkitDarkBars };
