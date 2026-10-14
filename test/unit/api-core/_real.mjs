// Helpers for tests that run the REAL install (default services) in the unit-test page; each test uninstalls with its cleanup.
import { sleep, frames } from '/test/unit/lib/t.js';
import { install } from '/src/index.js';

export { sleep, frames };

/** @param {any} t @param {any} [options] */
export function inst(t, options) {
  const i = install(options);
  t.cleanup(() => i.uninstall());
  return i;
}

/**
 * A managed canvas with one red drawable child #a (100x50) and a non-drawable grandchild #g; waits for the first paint.
 * @param {any} t
 * @param {any} i  the HicInstalled
 * @param {{w?: number, h?: number, inner?: string, wait?: boolean}} [o]
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function mk(t, i, { w = 200, h = 100, inner = '<div id="a" drawable style="width:100px;height:50px;background:rgb(255,0,0)"><span id="g">hi</span></div>', wait = true } = {}) {
  const host = document.createElement('div');
  host.innerHTML = `<canvas content="drawable" width="${w}" height="${h}">${inner}</canvas>`;
  document.body.append(host);
  t.cleanup(() => host.remove());
  const c = /** @type {HTMLCanvasElement} */ (host.firstElementChild);
  if (wait) { c.requestPaint(); await i.whenPainted(c); }
  return c;
}

/** @param {() => unknown} fn @returns {any} the thrown value or null */
export function thrown(fn) {
  try { fn(); } catch (e) { return e; }
  return null;
}

/** @param {string} id @param {string} color @returns {HTMLElement} */
export function drawableDiv(id, color) {
  const d = document.createElement('div');
  d.id = id;
  d.setAttribute('drawable', '');
  d.style.cssText = `width:30px;height:20px;background:${color}`;
  d.textContent = id;
  return d;
}
