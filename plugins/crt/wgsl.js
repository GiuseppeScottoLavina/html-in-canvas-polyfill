/**
 * WGSL loader of this plugin (plugins/_lib/wgsl.js). The build (scripts/build.mjs) replaces this module with one that returns the .wgsl
 * files of this folder as inlined strings. Every plugin folder that ships .wgsl files carries a copy of this file (plugins/README.md).
 */
import { wgslLoader } from '../_lib/wgsl.js';

export const wgsl = wgslLoader(import.meta.url);
