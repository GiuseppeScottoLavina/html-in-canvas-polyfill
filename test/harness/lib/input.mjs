// Paced, cadence-reporting input injectors. Every function returns a report that includes the cadence that was REALLY
// achieved (`actual` gap stats, `effectiveHz`, `cadenceOk`) and, with `probe: true`, what the PAGE saw (Chrome coalesces
// pointermove/wheel and delivers bursts when the main thread is busy, so sent != received).
//
// All events are trusted CDP Input.* events. `intervalMs: 0` sends back-to-back (pipelined).
import { paced } from './util.mjs';

/** @typedef {import('./util.mjs').PacedReport & {kind:string, pageSaw?:object}} InputReport */

async function run(page, kind, probeTypes, probe, count, intervalMs, fn) {
  if (probe) await page.installEventProbe(probeTypes);
  const r = await paced(count, intervalMs, fn);
  const out = { kind, ...r };
  if (probe) out.pageSaw = await page.readEventProbe();
  return out;
}

/** Type `text` one key at a time every `intervalMs` (default 8 ms ~ 120 Hz). @returns {Promise<InputReport>} */
export async function typeKeys(page, text, { intervalMs = 8, probe = false } = {}) {
  const chars = [...text];
  return run(page, 'keys', ['keydown'], probe, chars.length, intervalMs, i => page.key(chars[i]));
}

/** Press a list of named keys ('Backspace', 'ArrowDown', ...). */
export async function pressKeys(page, keys, { intervalMs = 8, probe = false } = {}) {
  return run(page, 'keys', ['keydown'], probe, keys.length, intervalMs, i => page.key(keys[i]));
}

/**
 * A finger flick at (x, y) through the browser's touch pipeline (Input.dispatchTouchEvent; the page needs Emulation.setTouchEmulationEnabled to see a touch-first
 * device): the contact, `restMs` of rest, `count` moves of `step` css px every `intervalMs` (dir 1 moves the finger up: the content scrolls down), the release
 * (the browser flings). No OS input.
 */
export async function touchDrag(page, { x, y, dir = 1, step = 12, count = 12, intervalMs = 16, restMs = 50 } = {}) {
  const at = (/** @type {number} */ py) => [{ x, y: py, radiusX: 4, radiusY: 4, force: 1, id: 1 }];
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(y) });
  await new Promise((ok) => setTimeout(ok, restMs));
  const r = await paced(count, intervalMs, (/** @type {number} */ i) => page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(y - step * dir * (i + 1)) }));
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  return { kind: 'touch', ...r };
}

/** `count` wheel events of (deltaX, deltaY) at (x,y). deltaY > 0 scrolls down. */
export async function wheelStream(page, { x, y, deltaX = 0, deltaY = 40, count = 30, intervalMs = 8, probe = false } = {}) {
  return run(page, 'wheel', ['wheel'], probe, count, intervalMs, () => page.wheel(x, y, deltaX, deltaY));
}

/** Pointer moves from `from` to `to` in `steps` events (no button pressed unless buttons=1). */
export async function mouseStream(page, from, to, { steps = 30, intervalMs = 8, buttons = 0, probe = false } = {}) {
  return run(page, 'mouse-move', ['pointermove'], probe, steps, intervalMs, i => {
    const f = (i + 1) / steps; return page.mouseMove(from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f, { buttons });
  });
}

/** Press at `from`, paced move to `to`, release. The report covers the move phase. */
export async function mouseDrag(page, from, to, { steps = 30, intervalMs = 8, probe = false } = {}) {
  await page.mouseMove(from.x, from.y); await page.mouseDown(from.x, from.y);
  const r = await mouseStream(page, from, to, { steps, intervalMs, buttons: 1, probe });
  await page.mouseUp(to.x, to.y);
  return { ...r, kind: 'mouse-drag' };
}
