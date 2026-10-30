/**
 * A script write to the state of a form control -> damage of the control.
 * Module: schedule (src/schedule/observers/*).
 *
 * The value of a field or slider, the checkedness of a checkbox or radio and the selected option of a select are IDL state that reflects no attribute: `range.value = '30'`
 * changes the control's pixels (natively the control is repainted) but no MutationObserver record, no event and no other damage announces it. Without this observer such a
 * control was repainted only when some other damage happened to cover it, so a slider set by script could keep its old thumb next to the new one (a two-thumb slider).
 * The setters and the methods that write that state are wrapped through the ledger: a write that changed the state queues the control, and one microtask later (after the
 * script's synchronous work: one layout read per batch, like a MutationObserver callback) each queued control is damaged like an attribute change of it (the rect memory's
 * reach: a control whose box changed size, `field-sizing: content`, repaints the whole drawable). A radio that gets checked unchecks the others of its group, an option
 * that gets selected repaints its select and `form.reset()` repaints the form. Writes that leave the state as it was (a framework that sets the same value again) damage nothing.
 */

import { createDamageBatch, getRectMemory } from './damage-rect.js';

/** @typedef {import('../../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../../contracts/types.js').PatchLedger} PatchLedger */

/** @param {any} el @returns {unknown} */
const valueOf = (el) => el.value;
/** setters per constructor: [property, the state the write may change] */
const SETTERS = /** @type {const} */ ([
  ['HTMLInputElement', [['value', valueOf], ['valueAsNumber', valueOf], ['valueAsDate', valueOf], ['checked', (/** @type {any} */ el) => el.checked], ['indeterminate', (/** @type {any} */ el) => el.indeterminate]]],
  ['HTMLTextAreaElement', [['value', valueOf]]],
  ['HTMLSelectElement', [['value', (/** @type {any} */ el) => el.selectedIndex], ['selectedIndex', (/** @type {any} */ el) => el.selectedIndex]]],
  ['HTMLOptionElement', [['selected', (/** @type {any} */ el) => el.selected]]],
]);
/** methods per constructor that write the value */
const METHODS = /** @type {const} */ ([['HTMLInputElement', ['stepUp', 'stepDown', 'setRangeText']], ['HTMLTextAreaElement', ['setRangeText']]]);

/**
 * @param {HicEnv} env
 * @param {PatchLedger} ledger
 * @returns {() => void}
 */
export function observeControlState(env, ledger) {
  const win = /** @type {any} */ (env.window);
  const memory = getRectMemory(env);
  /** @type {Set<Element>} */
  const queued = new Set();
  let stopped = false;

  /** @param {Element} el */
  const changed = (el) => {
    if (stopped || !el.isConnected) return;
    if (queued.size === 0) queueMicrotask(flush);
    queued.add(el);
  };

  for (const [ctor, keys] of SETTERS) {
    const proto = win[ctor]?.prototype;
    for (const [key, read] of keys) {
      const d = proto && Object.getOwnPropertyDescriptor(proto, key);
      if (!d?.set) continue;
      const set = d.set;
      ledger.define(proto, key, { ...d, set: /** @this {any} */ function (/** @type {unknown} */ value) { const before = read(this); set.call(this, value); if (!Object.is(read(this), before)) changed(this); } });
    }
  }
  for (const [ctor, keys] of METHODS) {
    const proto = win[ctor]?.prototype;
    for (const key of keys) {
      if (typeof proto?.[key] !== 'function') continue;
      ledger.wrap(proto, key, (original) => /** @this {any} */ function (/** @type {unknown[]} */ ...args) {
        const before = this.value;
        const result = Reflect.apply(original, this, args);
        if (this.value !== before) changed(this);
        return result;
      });
    }
  }
  if (typeof win.HTMLFormElement?.prototype?.reset === 'function') {
    ledger.wrap(win.HTMLFormElement.prototype, 'reset', (original) => /** @this {any} */ function (/** @type {unknown[]} */ ...args) {
      const result = Reflect.apply(original, this, args);
      changed(this);
      return result;
    });
  }

  /** @param {Element} el @returns {Element[]} the elements whose pixels the write changed */
  function affected(el) {
    const any = /** @type {any} */ (el);
    if (el.localName === 'option') { const select = el.closest('select'); return select ? [select] : []; }
    if (el.localName !== 'input' || any.type !== 'radio' || !any.name) return [el];
    // the other radios of the group (same name, same form owner, same tree) lose their checkedness
    const scope = any.form ?? el.getRootNode();
    return Array.from(/** @type {ParentNode} */ (scope).querySelectorAll('input[type=radio]')).filter((r) => /** @type {any} */ (r).name === any.name && /** @type {any} */ (r).form === any.form);
  }

  function flush() {
    // (nothing is queued once stopped: the disposer empties the queue)
    const list = [...queued].filter((el) => el.isConnected).flatMap(affected);
    queued.clear();
    for (const record of env.registry.all()) {
      const layer = record.layer;
      if (record.state !== 'active' || !layer) continue;
      const batch = createDamageBatch();
      for (const el of list) {
        // a control in a shadow tree inside a drawable: the clone flattens the tree, the whole drawable is repainted (as mutation-observer.js does)
        /** @type {Element|null} */
        let cur = el;
        let drawable = null;
        while (cur && !(drawable = layer.nearestDrawable(cur))) cur = /** @type {ShadowRoot} */ (cur.getRootNode()).host ?? null;
        if (drawable) batch.add(drawable, cur === el ? memory.reach(layer, el) : null);
      }
      batch.flush((drawable, rect) => env.scheduler.damage(record, 'mutation', drawable, rect));
    }
  }

  return () => { stopped = true; queued.clear(); };
}
