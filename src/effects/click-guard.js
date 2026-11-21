/**
 * The clicks of a re-targeted gesture (interposer.js, native-interposer.js): the native ones are swallowed, the element the user sees gets its own.
 * Module: gpu-effects (src/effects/**).
 *
 * A re-targeted press cancels its pointerdown, which stops mousedown, mouseup, focus and caret placement on the element the browser hit, but
 * Chrome still fires `click` there after pointerup, and `dblclick` after a second one (verified with trusted input on Chrome 157). Both are
 * swallowed in the capture phase of the WINDOW, so that no listener of the page sees them: not the hit element, not its ancestors, not a
 * capture listener on the document or the body. Only a window capture listener the page added before the host was created runs first.
 * The element drawn under the release gets the click instead (a MouseEvent at the mapped point; it bubbles, so the control around it runs its
 * activation: a button, a link, a checkbox, a label that forwards to its control, a summary that toggles its details), and a `dblclick` when
 * the two clicks of a double click went to the same element. A disabled control gets none, as natively. These events are not trusted:
 * a script cannot make a trusted one.
 */

import { controlOf } from './interposer-controls.js';

/**
 * The element a pointer click at `el` belongs to: its control, or the element itself where there is none. A press and a release whose units
 * differ make no click; a press whose unit differs from the one the browser hit is re-targeted.
 * @param {Element} root  @param {Element|null} el  @returns {Element|null}
 */
export function clickUnit(root, el) {
  return controlOf(root, el) ?? el;
}

/** The nearest element that contains both (the target of a native click whose press and release hit different elements). @param {Element|null} a @param {Element|null} b */
export function commonAncestor(a, b) {
  if (!a || !b) return null;
  for (let n = /** @type {Element|null} */ (a); n; n = n.parentElement) if (n.contains(b)) return n;
  return null;
}

/**
 * @param {Window & typeof globalThis} win
 * @param {Element} root  the element whose clicks are guarded (the live layer, or the canvas over a native implementation)
 */
export function createClickGuard(win, root) {
  /** the events this guard dispatched itself, which pass */
  const ours = new WeakSet();
  /** the next pointer click inside `root` comes from a re-targeted gesture */
  let swallow = false;
  /** @typedef {{el: Element|null, init: MouseEventInit}} Fired */
  /** the last two gestures, when they were re-targeted: the element each one clicked (null: none) */
  /** @type {Fired|null} */
  let last = null;
  /** @type {Fired|null} */
  let prev = null;

  /** @param {Event} e */
  const inRoot = (e) => e.composedPath().includes(root);

  /** @param {Element} el @param {string} type @param {number} detail @param {MouseEventInit} init */
  function dispatch(el, type, detail, init) {
    const ev = new win.MouseEvent(type, { ...init, detail });
    ours.add(ev);
    el.dispatchEvent(ev);
  }

  /** A pointer click (detail > 0) inside `root` after a re-targeted gesture went to the natively hit element. Keyboard and script clicks (detail 0) pass. @param {MouseEvent} e */
  function onClick(e) {
    if (ours.has(e) || !swallow || e.detail === 0 || !inRoot(e)) return;
    swallow = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  /** @param {MouseEvent} e */
  function onDblClick(e) {
    if (ours.has(e) || !last || !inRoot(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const pair = last.el && prev?.el === last.el && last.el.isConnected ? last : null;
    last = prev = null;
    if (pair?.el) dispatch(pair.el, 'dblclick', 2, pair.init);
  }

  win.addEventListener('click', onClick, { capture: true });
  win.addEventListener('dblclick', onDblClick, { capture: true });

  return {
    /** A primary press starts a gesture; `retargeted` false: the browser hits what the user sees, and its clicks are its own. @param {boolean} retargeted */
    press(retargeted) {
      swallow = false;
      if (!retargeted) last = prev = null;
    },
    /**
     * A re-targeted gesture ended: its native click will be swallowed, and `el` (the element drawn under the release, or null for none) gets the click.
     * @param {Element|null} el  @param {{x: number, y: number}|null} [point]  the mapped release, viewport css px  @param {PointerEvent} [from]  the pointerup
     */
    release(el, point = null, from) {
      swallow = true;
      const control = el ? controlOf(root, el) : null;
      const target = el && !control?.matches(':disabled') ? el : null;
      const x = point?.x ?? from?.clientX ?? 0, y = point?.y ?? from?.clientY ?? 0;
      /** @type {MouseEventInit} */
      const init = {
        bubbles: true, cancelable: true, composed: true, view: win, button: 0, buttons: 0, clientX: x, clientY: y,
        screenX: (from?.screenX ?? 0) + x - (from?.clientX ?? 0), screenY: (from?.screenY ?? 0) + y - (from?.clientY ?? 0),
        ctrlKey: !!from?.ctrlKey, shiftKey: !!from?.shiftKey, altKey: !!from?.altKey, metaKey: !!from?.metaKey,
      };
      prev = last;
      last = { el: target, init };
      if (target) dispatch(target, 'click', 1, init);
    },
    /** pointercancel: no click follows */
    cancel() { swallow = false; },
    dispose() {
      win.removeEventListener('click', onClick, { capture: true });
      win.removeEventListener('dblclick', onDblClick, { capture: true });
      swallow = false;
      last = prev = null;
    },
  };
}
