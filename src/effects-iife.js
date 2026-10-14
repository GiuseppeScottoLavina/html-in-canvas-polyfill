/**
 * Entry of the classic effects bundle (dist/hic-live-effects.iife.js). Load it AFTER the core bundle: it defines window.HTMLInCanvasEffects (host + plugin ABI + presenter + interposer),
 * bound late to the installed core. Module: gpu-effects. Implemented.
 */
import { installEffects } from './effects.js';

installEffects(window);
