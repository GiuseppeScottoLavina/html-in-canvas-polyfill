/**
 * Entry of the classic water bundle (dist/hic-live-effects-water.iife.js). Load it AFTER hic-live-effects.iife.js: exposes window.HicLiveEffectsWater = {WaterEffectPlugin, mapWaterPoint, ...}.
 * Module: gpu-effects. Implemented.
 */
import * as water from './effects-water.js';

Object.defineProperty(globalThis, 'HicLiveEffectsWater', { value: Object.freeze({ ...water }), configurable: true });
