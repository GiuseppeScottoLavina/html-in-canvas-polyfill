/**
 * Hover/active/focus/caret tracking (InteractionTracker).
 * Module: schedule (src/schedule/observers/*).
 */

import { createDamageBatch, getRectMemory } from './damage-rect.js';
import { noteCaretEvent, selectionApiMissing } from '../../util/caret-index.js';
import { currentEngine } from '../../util/engine.js';
import { WINDOW_STATE_SELECTOR, notePress, themedStateChange } from '../../util/native-states.js';

/** @typedef {import('../../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../../contracts/types.js').CssBundle} CssBundle */
/** @typedef {import('../../contracts/types.js').DamageCause} DamageCause */
/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../../contracts/types.js').InteractionSnapshot} InteractionSnapshot */
/** @typedef {import('../../contracts/types.js').InteractionTracker} InteractionTracker */
/** @typedef {import('../../contracts/types.js').TrackerControl} TrackerControl */

const BLINK_MS = 530;
/** A mapped target set this soon after a native pointerdown re-targets that press (the interposer runs after the tracker's own listener). */
const PRESS_REBIND_MS = 50;
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);
const PRESSABLE = 'button,summary,[role="button"],input[type="button"],input[type="submit"],input[type="reset"],input[type="checkbox"],input[type="radio"]';
/** Every interaction pseudo-class counts as used: there is no capture to ask, or asking failed. */
const ALL_PSEUDO = Object.freeze({ hover: true, active: true, focus: true, focusVisible: true, focusWithin: true });
/** @type {ReadonlySet<Element>} */
const NONE = new Set();

/**
 * A text control or editing host that shows a caret.
 * @param {Element} el
 * @returns {boolean}
 */
export function isTextEditing(el) {
  const control = /** @type {HTMLInputElement} */ (el);
  if (el.nodeName === 'TEXTAREA') return !control.readOnly && !control.disabled;
  if (el.nodeName === 'INPUT') return TEXT_INPUT_TYPES.has(control.type) && !control.readOnly && !control.disabled;
  return /** @type {HTMLElement} */ (el).isContentEditable === true;
}

/** True when the selection is collapsed, i.e. there is a caret to blink. @param {HicEnv} env @param {Element} el */
function hasCaret(env, el) {
  if (el.nodeName === 'INPUT' || el.nodeName === 'TEXTAREA') {
    const control = /** @type {HTMLInputElement} */ (el);
    try {
      return control.selectionStart === control.selectionEnd;
    } catch {
      return true;
    }
  }
  return env.document.getSelection()?.isCollapsed !== false;
}

/**
 * pointerover/out (hover chain), pointerdown/up + keyboard activation (active chain), focusin/out + modality (focus-visible), caret blink timer (530 ms, only while a text control is focused; a blink publishes 'caret' damage that the store
 * serves from the caret patch, never from a tile build). onChange listeners receive the changed elements; damage is published only when a rule depends on the pseudo-class (hover, active; focus always, the ring is a pixel change).
 * setMappedTarget(record, el): while an effect displaces the pixels, hover/active chains follow the element under the MAPPED pointer, not the native hit (cursor is set by the interposer from the same element).
 * Damage rects come from the rect memory (damage-rect.js): hover/active may reach outside the box (menus, tooltips), so they use the reach union; focus and caret stay in the control.
 * The tracker has no wheel/touch listener and no pointermove listener.
 * Which pseudo-classes the author CSS uses comes from capture's cached CssBundle (it builds one now when it has none; the next capture reuses it); without a capture every one counts.
 * @param {HicEnv} env
 * @param {import('../../contracts/types.js').Capture} [capture]
 * @returns {TrackerControl}
 */
export function createInteractionTracker(env, capture) {
  const win = env.window;
  const memory = getRectMemory(env);
  /** @param {CanvasRecord} record @returns {CssBundle['pseudo']} */
  function pseudoUsage(record) {
    if (!capture) return ALL_PSEUDO;
    try {
      return capture.cssBundle(record, capture.resources).pseudo;
    } catch (err) {
      env.reporter.caught(err, 'tracker.pseudo');
      return ALL_PSEUDO;
    }
  }
  /** @type {Map<CanvasRecord, () => void>} */
  const attached = new Map();
  /** @type {Map<CanvasRecord, ReadonlySet<Element>>} */
  const hover = new Map();
  /** @type {Map<CanvasRecord, ReadonlySet<Element>>} */
  const active = new Map();
  /** @type {Map<CanvasRecord, Element|null>} */
  const nativeTarget = new Map();
  /** @type {Map<CanvasRecord, Element>} */
  const mapped = new Map();
  /** @type {Map<CanvasRecord, {native: boolean, at: number}>} */
  const pressed = new Map();
  /** @type {Set<(change: {record: CanvasRecord, kind: 'hover'|'active'|'focus'|'caret', elements: Element[]}) => void>} */
  const listeners = new Set();
  /** @type {Element|null} */
  let focus = null;
  /** @type {CanvasRecord|null} */
  let focusRecord = null;
  let focusVisible = false;
  let caretVisible = true;
  let blinkTimer = 0;
  /** @type {{x: number, y: number}|null} where the last mouse or pen pointerover happened (client px) */
  let pointer = null;
  /** @type {InteractionSnapshot|null} */
  let snap = null;
  let documentListeners = 0;

  /** @param {CanvasRecord} record @param {Element|null|undefined} el @returns {Set<Element>} el and its ancestors inside the layer */
  function chainOf(record, el) {
    /** @type {Set<Element>} */
    const chain = new Set();
    const root = record.layer?.element;
    if (!root || !el || !root.contains(el)) return chain;
    for (let node = /** @type {Element|null} */ (el); node && node !== root; node = node.parentElement) chain.add(node);
    return chain;
  }

  /**
   * @param {CanvasRecord} record
   * @param {DamageCause} cause
   * @param {Element[]} own  controls whose pixels change inside their box
   * @param {Element[]} reach  elements whose rules may restyle descendants or overflow
   * @param {Element[]} [paint]  elements whose rules only paint (memory.paintReach)
   */
  function publish(record, cause, own, reach, paint = []) {
    const layer = record.layer;
    if (!layer) return;
    const batch = createDamageBatch();
    for (const [list, measure] of /** @type {const} */ ([[own, memory.own], [reach, memory.reach], [paint, memory.paintReach]])) {
      for (const el of list) {
        const drawable = layer.nearestDrawable(el);
        if (drawable) batch.add(drawable, measure(layer, el));
      }
    }
    batch.flush((drawable, rect) => env.scheduler.damage(record, cause, drawable, rect));
  }

  /**
   * @param {CanvasRecord} record
   * @param {'hover'|'active'|'focus'|'caret'} kind
   * @param {Element[]} elements
   */
  function changed(record, kind, elements) {
    if (!elements.length) return;
    snap = null;
    for (const cb of [...listeners]) {
      try {
        cb({ record, kind, elements });
      } catch (err) {
        env.reporter.caught(err, 'tracker.onChange');
      }
    }
  }

  /** @param {Map<CanvasRecord, ReadonlySet<Element>>} chains @param {'hover'|'active'} kind @param {CanvasRecord} record @param {ReadonlySet<Element>} next */
  function setChain(chains, kind, record, next) {
    const prev = chains.get(record) ?? NONE;
    const diff = [...prev].filter((el) => !next.has(el)).concat([...next].filter((el) => !prev.has(el)));
    if (!diff.length) return;
    if (next.size) chains.set(record, next);
    else chains.delete(record);
    changed(record, kind, diff);
    const usage = pseudoUsage(record);
    // :hover rules that only paint cannot move a sibling: the hovered elements' own reach is the damage, also the first time one is hovered (rows that pass under a still pointer while a list scrolls)
    if (usage[kind]) publish(record, kind, [], kind === 'hover' && usage.hoverLayout === false ? [] : diff, kind === 'hover' && usage.hoverLayout === false ? diff : []);
    else {
      // the widget theme's own hover / pressed look (Gecko, WebKit pressed buttons) needs no author rule to change the pixels
      const engine = currentEngine().engine;
      const own = diff.filter((el) => themedStateChange(el, kind, engine));
      if (own.length) publish(record, kind, own, []);
    }
  }

  /** @param {CanvasRecord} record @param {Element|null|undefined} target */
  function setHover(record, target) {
    setChain(hover, 'hover', record, chainOf(record, target));
  }

  /** @param {CanvasRecord} record @param {Element|null|undefined} target */
  function setActive(record, target) {
    setChain(active, 'active', record, chainOf(record, target));
  }

  function stopBlink() {
    if (blinkTimer) win.clearInterval(blinkTimer);
    blinkTimer = 0;
  }

  function blink() {
    if (!focus || !focusRecord || env.document.hidden || !env.document.hasFocus() || !hasCaret(env, focus)) return;
    caretVisible = !caretVisible;
    changed(focusRecord, 'caret', [focus]);
    publish(focusRecord, 'caret', [focus], []);
  }

  /** The blink restarts solid on every edit, like the native caret. */
  function restartBlink() {
    if (!blinkTimer) return;
    stopBlink();
    caretVisible = true;
    snap = null;
    blinkTimer = win.setInterval(blink, BLINK_MS);
  }

  function syncBlink() {
    stopBlink();
    caretVisible = true;
    snap = null;
    if (focus && isTextEditing(focus)) blinkTimer = win.setInterval(blink, BLINK_MS);
  }

  /** @param {Element} el */
  function ringVisible(el) {
    try {
      return el.matches(':focus-visible') || isTextEditing(el);
    } catch {
      return isTextEditing(el);
    }
  }

  /** @param {CanvasRecord} record @param {Element|null} next */
  function setFocus(record, next) {
    const prev = focus;
    if (prev === next) return;
    focus = next;
    focusRecord = next ? record : null;
    focusVisible = next ? ringVisible(next) : false;
    const controls = /** @type {Element[]} */ ([prev, next].filter((el) => !!el));
    const ancestors = pseudoUsage(record).focusWithin ? [...chainOf(record, prev), ...chainOf(record, next)].filter((el) => !controls.includes(el)) : [];
    syncBlink();
    // the caret shows (or goes) with the focus, before the tile with the focus styles lands (store.caretNow)
    const layer = record.layer;
    if (prev && layer) { const d = layer.nearestDrawable(prev); if (d) env.store.caretNow?.(d, null); }
    if (next && layer && isTextEditing(next)) { const d = layer.nearestDrawable(next); if (d) env.store.caretNow?.(d, next); }
    changed(record, 'focus', controls.concat(ancestors));
    publish(record, 'focus', controls, ancestors);
  }

  /** @param {CanvasRecord} record */
  function pointerHandlers(record) {
    const root = /** @type {HTMLElement} */ (record.layer?.element);
    /** @type {Array<[string, (ev: any) => void]>} */
    const table = [
      // A finger hovers only by a TAP: Chrome and Mobile Safari match no :hover while a finger rests or pans (measured in Chrome with a CDP touch: the touched row was
      // never :hover until a tap), and after a tap the tapped element stays :hover until the next tap elsewhere (a CSS :hover menu opens on a tap). Its pointerover /
      // pointerout at each contact and at the start of each pan put the whole chain of the touched row in and out of the hover set: two rebuilds of the drawable per
      // gesture, whose damage covered every scroller on the chain and dropped its cached scroll pages (iOS Simulator: every gesture over a list with a :hover rule
      // began with 5 to 9 plain builds). The tap is its pointerup (a pan ends in pointercancel), handled with the other releases (onRelease).
      ['pointerover', (ev) => {
        if (ev.pointerType === 'touch') return;
        pointer = { x: ev.clientX, y: ev.clientY };
        snap = null;
        nativeTarget.set(record, ev.target);
        if (!mapped.has(record)) setHover(record, ev.target);
      }],
      ['pointerout', (ev) => {
        if (ev.pointerType === 'touch' || (ev.relatedTarget && root.contains(ev.relatedTarget))) return;
        pointer = null;
        snap = null;
        nativeTarget.set(record, null);
        if (!mapped.has(record)) setHover(record, null);
      }],
      ['pointerdown', (ev) => {
        noteCaretEvent(ev);
        // no selectionchange reports a caret moved by a press in an email/number field that already has focus: re-measure it
        if (ev.target === env.document.activeElement && selectionApiMissing(ev.target)) publish(record, 'selection', [ev.target], []);
        pressed.set(record, { native: !mapped.has(record), at: env.now() });
        const pe = /** @type {PointerEvent} */ (ev);
        const hit = mapped.get(record) ?? ev.target;
        // the press point is known in live coordinates only when the native hit is the pressed element (an effect may displace the mapped one)
        if (hit instanceof Element) notePress(hit, hit === ev.target ? { x: pe.clientX, y: pe.clientY } : null);
        setActive(record, mapped.get(record) ?? ev.target);
        restartBlink();
      }],
      ['keydown', (ev) => {
        noteCaretEvent(ev);
        restartBlink();
        if (ev.key === ' ' && !ev.repeat && ev.target.matches?.(PRESSABLE)) setActive(record, ev.target);
      }],
      ['input', (ev) => { noteCaretEvent(ev); restartBlink(); }],
      ['focusin', (ev) => { noteCaretEvent(ev); setFocus(record, ev.target); }],
      ['focusout', (ev) => {
        if (!ev.relatedTarget || !root.contains(ev.relatedTarget)) setFocus(record, null);
      }],
    ];
    return table;
  }

  function releaseAll() {
    pressed.clear();
    for (const record of [...active.keys()]) setActive(record, null);
  }

  /** @param {Event} ev */
  const onRelease = (ev) => {
    if (ev.type === 'keyup' && /** @type {KeyboardEvent} */ (ev).key !== ' ') return;
    releaseAll();
    // a tap: the tapped element of a canvas becomes the hovered one, and a tap elsewhere ends the hover a tap left in another canvas (see pointerover above)
    if (ev.type === 'pointerup' && /** @type {PointerEvent} */ (ev).pointerType === 'touch') {
      const t = /** @type {Element|null} */ (ev.target);
      pointer = null;
      snap = null;
      for (const record of attached.keys()) {
        const inside = !!t && t.nodeType === 1 && !!record.layer?.element.contains(t);
        if (!inside && !hover.get(record)?.size) continue;
        nativeTarget.set(record, inside ? t : null);
        if (!mapped.has(record)) setHover(record, inside ? t : null);
      }
    }
  };

  let windowActive = true;
  /**
   * WebKit (macOS) draws the accent-tinted parts of its controls in grey while the window is not key: a window focus change repaints the controls of every attached canvas
   * (two event listeners, no polling, nothing runs while the window state is unchanged).
   */
  const onWindowFocus = () => {
    if (currentEngine().engine !== 'webkit') return;
    const now = env.document.hasFocus();
    if (now === windowActive) return;
    windowActive = now;
    for (const record of attached.keys()) {
      const root = record.layer?.element;
      const controls = root ? Array.from(root.querySelectorAll(WINDOW_STATE_SELECTOR)) : [];
      if (controls.length) publish(record, 'focus', controls, []);
    }
  };
  const onBlur = () => { releaseAll(); onWindowFocus(); };

  function listenDocument() {
    if (documentListeners++) return;
    for (const type of ['pointerup', 'pointercancel', 'keyup']) env.document.addEventListener(type, onRelease, { capture: true, passive: true });
    windowActive = env.document.hasFocus();
    win.addEventListener('blur', onBlur);
    win.addEventListener('focus', onWindowFocus);
  }

  function unlistenDocument() {
    if (--documentListeners) return;
    for (const type of ['pointerup', 'pointercancel', 'keyup']) env.document.removeEventListener(type, onRelease, { capture: true });
    win.removeEventListener('blur', onBlur);
    win.removeEventListener('focus', onWindowFocus);
  }

  /** @param {CanvasRecord} record */
  function forget(record) {
    for (const chains of [hover, active]) chains.delete(record);
    nativeTarget.delete(record);
    mapped.delete(record);
    pressed.delete(record);
    if (focusRecord === record) {
      focus = null;
      focusRecord = null;
      focusVisible = false;
      stopBlink();
    }
    snap = null;
  }

  /** @param {CanvasRecord} record */
  function detach(record) {
    attached.get(record)?.();
    attached.delete(record);
    forget(record);
  }

  return {
    attach(record) {
      const layer = record.layer;
      if (attached.has(record) || !layer) return;
      const root = layer.element;
      const table = pointerHandlers(record);
      for (const [type, fn] of table) root.addEventListener(type, fn, { capture: true, passive: true });
      listenDocument();
      attached.set(record, () => {
        for (const [type, fn] of table) root.removeEventListener(type, fn, { capture: true });
        unlistenDocument();
      });
    },

    detach,

    dispose() {
      for (const record of [...attached.keys()]) detach(record);
      stopBlink();
      listeners.clear();
    },

    snapshot() {
      if (!snap) {
        snap = Object.freeze({
          hover: new Set([...hover.values()].flatMap((chain) => [...chain])),
          active: new Set([...active.values()].flatMap((chain) => [...chain])),
          focus, focusVisible, caretVisible, pointer: mapped.size ? null : pointer,
        });
      }
      return snap;
    },

    setMappedTarget(record, target) {
      snap = null;
      if (!target) {
        mapped.delete(record);
        setHover(record, nativeTarget.get(record));
        return;
      }
      mapped.set(record, target);
      setHover(record, target);
      const press = pressed.get(record);
      if (press?.native && env.now() - press.at < PRESS_REBIND_MS) {
        press.native = false;
        setActive(record, target);
      }
    },

    onChange(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  };
}
