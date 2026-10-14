/**
 * ResizeObserver on the canvas (content box) -> layer.syncPresentation + BUS.RESIZE.
 * Module: schedule (src/schedule/observers/*).
 */

import { BUS } from '../../contracts/events.js';
import { onCanvasSuspension } from '../../util/suspension.js';
import { watchPresentation } from './presentation-watch.js';

/** @typedef {import('../../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../../contracts/types.js').ContentBox} ContentBox */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */

/** Canvas attributes written by the polyfill or owned by other observers: they never change the presentation. */
const IGNORED_ATTRIBUTE = /^(data-hic-|aria-owns$|content$|drawable$|layoutsubtree$|framecap$)/;

/** @param {ContentBox|undefined} box @returns {ContentBox|null} a copy, so a box that the live layer mutates in place can still be compared */
function copyBox(box) {
  return box ? { width: box.width, height: box.height, gridScaleX: box.gridScaleX, gridScaleY: box.gridScaleY } : null;
}

/** @param {ContentBox|null} a @param {ContentBox} b */
function sameBox(a, b) {
  return !!a && a.width === b.width && a.height === b.height && a.gridScaleX === b.gridScaleX && a.gridScaleY === b.gridScaleY;
}

/**
 * Also re-checks the presentation (layer.syncPresentation: border/padding/inherited/custom properties, cheap when nothing changed) on the events of presentation-watch.js
 * (no idle timer) and on canvas attribute changes; patches nothing.
 * On a content-box change it updates record.contentBox SYNCHRONOUSLY in its callback; the width/height setter path reads the box from the layer directly (record.layer.syncPresentation) instead of waiting for this observer, because the app's own observer may run first.
 * It never runs the clone: it publishes BUS.RESIZE (unless the layer already did during syncPresentation) and 'resize' damage when the css size changed, and the pump does the work in a later tick (measured: 3-11 ms clones in this callback were the only over-budget tasks of a drag).
 * @param {HicEnv} env
 * @param {CanvasRecord} record
 * @returns {() => void}
 */
export function observeCanvasResize(env, record) {
  const win = /** @type {Window & typeof globalThis} */ (env.window);
  const canvas = record.canvas;
  let emittedBySync = false;
  let shifted = false;
  const offBus = env.bus.on(BUS.RESIZE, (/** @type {{record: CanvasRecord}} */ e) => {
    if (e.record !== record) return;
    emittedBySync = true;
    shifted = true;
  });

  /** A resize, whoever announced it (this observer, or the layer during a width/height write): a drawable positioned by the box (auto margins, percentages, flex) moved while its drawn matrix did not, and the hit-test correction needs the new layout offset. */
  function refresh() {
    measure();
    if (!shifted) return;
    shifted = false;
    try { record.layer?.revalidateGeometry(); } catch (err) { env.reporter.caught(err, 'schedule.resize'); }
  }

  function measure() {
    const layer = record.layer;
    if (!layer || record.state !== 'active' || !layer.isMounted()) return;
    const previous = copyBox(record.contentBox);
    emittedBySync = false;
    let box;
    try {
      box = layer.syncPresentation();
    } catch (err) {
      env.reporter.caught(err, 'schedule.resize');
      return;
    }
    if (sameBox(previous, box)) return;
    record.contentBox = box;
    if (!emittedBySync) env.bus.emit(BUS.RESIZE, { record, contentBox: box, previous });
    if (!previous || previous.width !== box.width || previous.height !== box.height) env.scheduler.damage(record, 'resize', null, null);
  }

  const ro = new win.ResizeObserver(refresh);
  ro.observe(canvas, { box: 'content-box' });
  const mo = new win.MutationObserver((batch) => {
    if (batch.some((m) => !IGNORED_ATTRIBUTE.test(m.attributeName ?? ''))) refresh();
  });
  mo.observe(canvas, { attributes: true });
  const offWatch = watchPresentation(env, record, refresh);
  const offSuspension = onCanvasSuspension(env, record, () => ro.disconnect(), () => ro.observe(canvas, { box: 'content-box' }));

  return () => {
    offSuspension();
    ro.disconnect();
    mo.disconnect();
    offWatch();
    offBus();
  };
}
