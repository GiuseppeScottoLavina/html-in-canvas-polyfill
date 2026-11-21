/**
 * Entry of the classic effects bundle (dist/hic-live-effects.iife.js). Load it AFTER the core bundle: it defines window.HTMLInCanvasEffects (host + plugin ABI + presenter + interposer),
 * bound late to the installed core. Module: gpu-effects.
 * Unlike the module entry (src/effects.js), it carries no seam of its own over a browser's own HTML-in-Canvas: the native detection and the options of the core
 * would add 16 KB minified to every page that loads it with the core. Over a native implementation without the core, use the module entries (the loader and
 * the effects share that code there).
 */
import { createLateEffects, installEffectsGlobal } from './effects/index.js';

installEffectsGlobal(window, createLateEffects(window));
