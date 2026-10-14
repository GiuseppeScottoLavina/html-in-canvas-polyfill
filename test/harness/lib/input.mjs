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

/**
 * Compositor-driven scroll gesture (Input.synthesizeScrollGesture). `yDistance > 0` scrolls DOWN (sign already flipped vs raw
 * CDP). Resolves when the gesture finished; positions are viewport CSS px. `gestureSourceType: 'touch'` = touch fling-like.
 */
export async function scrollGesture(page, { x, y, yDistance = 0, xDistance = 0, speed = 800, gestureSourceType = 'mouse', repeatCount = 0, repeatDelayMs = 250, preventFling = true } = {}) {
  const t0 = performance.now();
  await page.send('Input.synthesizeScrollGesture', { x, y, yDistance: -yDistance, xDistance: -xDistance, speed, gestureSourceType, repeatCount, repeatDelayMs, preventFling });
  return { kind: 'scroll-gesture:' + gestureSourceType, speedPxPerS: speed, distance: { x: xDistance, y: yDistance }, totalMs: performance.now() - t0 };
}

/**
 * Raw touch drag (touchStart, paced touchMove, touchEnd) via Input.dispatchTouchEvent with touch emulation temporarily
 * enabled. Moving the finger up (to.y < from.y) scrolls the content down.
 */
export async function touchDrag(page, from, to, { steps = 30, intervalMs = 8, probe = false } = {}) {
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  try {
    const pt = (x, y) => [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }];
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(from.x, from.y) });
    const r = await run(page, 'touch-drag', ['touchmove', 'pointermove'], probe, steps, intervalMs, i => {
      const f = (i + 1) / steps; return page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f) });
    });
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return r;
  } finally {
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
  }
}
