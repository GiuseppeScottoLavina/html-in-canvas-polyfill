/**
 * Optional entry for dedicated workers: load it at the top of a worker (`importScripts('hic-live-worker.iife.min.js')`, or `import '.../worker'` in a module worker) whose
 * page runs the core bundle. ElementImages posted to the worker then arrive as ElementImage objects, and its OffscreenCanvas 2D contexts take drawElementImage, with
 * updateElementGeometry / clearElementGeometry / getElementImageDefaultSize on the OffscreenCanvas; the geometry of the draws reaches the page's canvas
 * (elementgeometryupdate). Elsewhere (a window) it does nothing. Module: api-surface.
 */
import { installWorkerScope } from './api/worker-scope.js';

installWorkerScope(globalThis);
export { installWorkerScope };
