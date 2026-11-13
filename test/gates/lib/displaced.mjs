// Shared by the gates that click through a strongly displaced effect (G-interposer-strong, and G-native-interposer over a native implementation):
// marker colours on the F1 fields, their visual shape in a screenshot of the presented frame, and trusted clicks where the native hit test
// (the plain-DOM twin at the same point) would NOT reach the field the user sees.
import { H } from './gate.mjs';

export const MARKS = { '#name': [255, 0, 0], '#email': [0, 255, 0], '#project': [0, 0, 255], '#message': [255, 0, 255] };
export const MARK_CSS = Object.entries(MARKS).map(([s, c]) => `${s}{background:rgb(${c}) !important;border-color:rgb(${c}) !important;box-shadow:none !important;background-image:none !important;color:rgb(${c}) !important}`).join('');
export const MIN_TRIALS = 30;
export const MIN_SHARE = 0.95;
export const COLUMNS = [0.08, 0.2, 0.32, 0.44, 0.56, 0.68, 0.8, 0.92];

export const isMark = (img, i, c) => c.every((v, k) => (v > 0 ? img.data[i + k] > 150 : img.data[i + k] < 100));

/** visual bounding box of a marker colour in the screenshot, device px (null when absent) */
export function bbox(img, c) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) if (isMark(img, (y * img.width + x) * 4, c)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/**
 * The part of the canvas a frozen-frame trial of field `r` needs (viewport css px): the field, 40 px to each side and above, and 90 px below, where the drop
 * falls 40 px under it and its crown pushes the bottom edge down. Clamped to the canvas `c`.
 * @param {{x: number, y: number, width: number, height: number}} c @param {{x: number, y: number, width: number, height: number}} r
 */
export function fieldClip(c, r) {
  const x0 = Math.max(c.x, Math.floor(r.x - 40)), y0 = Math.max(c.y, Math.floor(r.y - 40));
  const x1 = Math.min(c.x + c.width, Math.ceil(r.x + r.width + 40)), y1 = Math.min(c.y + c.height, Math.ceil(r.y + r.height + 90));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** true when the marker colour `c` reaches the border of `img`: the field may go on beyond a clipped shot, so its edges there are not measured */
export function touchesBorder(img, c) {
  const b = bbox(img, c);
  return !!b && (b.x0 <= 1 || b.y0 <= 1 || b.x1 >= img.width - 2 || b.y1 >= img.height - 2);
}

/** visual top / bottom of the marker at device column `col` (the longest run), device px */
export function column(img, c, col) {
  let best = null, start = -1;
  for (let y = 0; y <= img.height; y++) {
    const on = y < img.height && isMark(img, (y * img.width + col) * 4, c);
    if (on && start < 0) start = y;
    if (!on && start >= 0) { if (!best || y - start > best.bottom - best.top) best = { top: start, bottom: y }; start = -1; }
  }
  return best && best.bottom - best.top >= 6 ? best : null;
}

/** The ids of the controls the native hit test reaches at each point on the twin (a label resolves to its control), in one evaluation. */
export const nativeAt = (ref, pts) => ref.evaluate(`${JSON.stringify(pts.map((p) => [p.x, p.y]))}.map(([x, y]) => { const r = document.elementFromPoint(x, y); let c = r && r.closest('input,select,textarea,button'); if (!c) { const l = r && r.closest('label'); c = l && l.control; } return c ? c.id : ''; })`);

/** Candidate clicks at the visual places of the marked fields in `shot`: 3 css px inside the visual top, bottom, left and right edges and at the middle, along several columns / rows. */
export function candidates(shot, fields, origin, dpr, missing) {
  const out = [];
  for (const sel of fields) {
    const c = MARKS[sel];
    const box = bbox(shot, c);
    if (!box) { missing.push(sel); continue; }
    for (const f of COLUMNS) {
      const col = Math.round(box.x0 + f * (box.x1 - box.x0));
      const e = column(shot, c, col);
      if (!e) continue;
      for (const [kind, yDev] of [['top', e.top + 3 * dpr], ['top+6', e.top + 6 * dpr], ['middle', (e.top + e.bottom) / 2], ['bottom-6', e.bottom - 6 * dpr], ['bottom', e.bottom - 3 * dpr]]) {
        if (yDev > e.top && yDev < e.bottom) out.push({ sel, kind, x: origin.x + col / dpr, y: origin.y + yDev / dpr });
      }
    }
    const midRow = Math.round((box.y0 + box.y1) / 2);
    let left = -1, right = -1;
    for (let x = 0; x < shot.width; x++) if (isMark(shot, (midRow * shot.width + x) * 4, c)) { if (left < 0) left = x; right = x; }
    if (left >= 0 && right - left > 12 * dpr) {
      out.push({ sel, kind: 'left', x: origin.x + left / dpr + 3, y: origin.y + midRow / dpr });
      out.push({ sel, kind: 'right', x: origin.x + (right + 1) / dpr - 3, y: origin.y + midRow / dpr });
    }
  }
  return out;
}

/** the frames the effect host of the page (window.__host) has presented so far */
const FRAMES = 'window.__host.stats().frames';

/**
 * A screenshot of the frame frozen with framecap=1, as the oracle of clicks: `{ img, frame }`, or null when the host presented a frame while it was taken (the
 * picture is then of either frame). The changed cap allows one frame at once (the cap gate starts a new phase), so the shot waits for it first.
 * Until 2026-11-12 the shot was taken at once and its frame not checked: on a loaded Mac the screenshot took ~800 ms of the ~1 s the frame stays, the second click
 * of a spot landed after the next frame, and was judged against a picture no longer shown (every wrong click of G-interposer-strong's water was one of those).
 * @param {any} page @param {() => Promise<any>} shoot  the screenshot (its image)
 */
export async function frozenShot(page, shoot) {
  await H.sleep(40);
  const before = await page.evaluate(FRAMES);
  const img = await shoot();
  const after = await page.evaluate(FRAMES);
  return before === after ? { img, frame: before } : null;
}

/**
 * Trusted clicks at the candidates where the native hit test would NOT reach the field the user sees there; at most `max` (a frozen frame is presented for ~1 s).
 * With `frame` (frozenShot), a click counts only when that frame is still the one presented at its pointerdown, where the interposer maps it: otherwise it is
 * `stale` (not a trial) and the spot's other clicks are not made. A wrong click on the frame of the shot counts as wrong.
 * @param {number|null} [frame]
 * @returns {Promise<void>} counts into `out`
 */
export async function clickTrials(ctx, page, ref, cands, out, max = Infinity, frame = null) {
  // read from the twin without bringing it to the front: a tab switch makes the effect page visible again and re-render, which would change the frozen frame
  const native = await nativeAt(ref, cands);
  const subs = cands.map((c, i) => ({ ...c, native: native[i] })).filter((c) => { const d = c.native !== c.sel.slice(1); if (!d) out.notDiscriminating++; return d; }).slice(0, max);
  if (frame !== null) await page.evaluate(`window.__framesAtDown === undefined && document.addEventListener('pointerdown', () => { window.__framesAtDown = ${FRAMES}; }, true)`);
  for (const c of subs) {
    await page.evaluate('document.activeElement && document.activeElement.blur(); window.__framesAtDown = null');
    await page.click(c.x, c.y);
    if (frame !== null) {
      const at = await page.evaluate('window.__framesAtDown');
      if (at !== frame) { out.stale = (out.stale ?? 0) + 1; break; }
    }
    await H.sleep(60);
    const active = await page.evaluate('document.activeElement && document.activeElement.id');
    const ok = active === c.sel.slice(1);
    out.discriminating++;
    if (ok) out.correct++;
    if (!ok || out.trials.length < 6) out.trials.push({ sel: c.sel, kind: c.kind, x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10, native: c.native, active, ok });
  }
}
