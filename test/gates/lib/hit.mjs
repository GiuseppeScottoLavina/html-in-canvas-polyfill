// O-hit with teeth (TEST-PLAN oracle O-hit): trusted clicks at the INNER EDGE of each control (2 css px inside) and just OUTSIDE it (3 css px), on the
// polyfill page and on the plain-DOM twin at the same coordinates. A click at the centre of a big control survives a hit-test that is off by 10-20 px;
// a click 2 px inside the edge does not, and the outside click proves the neighbour (or the canvas) gets it when the pointer is off the control.
//   - every inside point must hit the control itself (its id, or a descendant/label of it)
//   - every point must hit the SAME element as on the twin (so a shifted hit-test, in any direction, shows up as a different neighbour)
// The probe records the first pointerdown target and cancels mousedown/click, so probing changes no control state (no focus, no toggle, no range drag).
import { H } from './gate.mjs';

const PROBE = `(() => {
  if (window.__hitProbe) return window.__hitProbe.log.length = 0;
  const P = window.__hitProbe = { log: [] };
  // author ids only: generated ids (hic-*) and twin wrappers (twin*) are not comparable between the polyfill page and the twin
  const name = (t) => { if (!(t instanceof Element)) return 'none'; if (t.localName === 'canvas' || t.id === 'hic-surface' || t.id === 'twin') return 'surface'; return t.id && !/^(hic-|twin)/.test(t.id) ? t.id : t.localName; };
  const rec = (e) => P.log.push({ id: name(e.composedPath()[0]), tag: e.composedPath()[0]?.localName ?? null, x: e.clientX, y: e.clientY });
  const stop = (e) => e.preventDefault();
  addEventListener('pointerdown', rec, true); addEventListener('mousedown', stop, true); addEventListener('click', stop, true);
  P.off = () => { removeEventListener('pointerdown', rec, true); removeEventListener('mousedown', stop, true); removeEventListener('click', stop, true); delete window.__hitProbe; };
  return 0;
})()`;

/** Install the probe (idempotent) and clear its log. */
export function installHitProbe(page) { return page.evaluate(PROBE); }

/** Trusted click at (x, y); resolves to the element id the page saw the pointerdown on ('none' when nothing was recorded). */
export async function hitAt(page, x, y) {
  await page.evaluate('window.__hitProbe.log.length = 0');
  await page.click(x, y);
  await H.sleep(25);
  const log = await page.evaluate('window.__hitProbe.log.slice()');
  return log[0]?.id ?? 'none';
}

/** Inside (2 px) and outside (3 px) probe points at the middle of each side of `rect`; `inset` shrinks the inside offset for thin controls. */
export function edgePoints(rect, { inside = 2, outside = 3 } = {}) {
  const mx = rect.x + rect.width / 2, my = rect.y + rect.height / 2;
  const x2 = rect.x + rect.width, y2 = rect.y + rect.height;
  const inn = Math.min(inside, rect.width / 2 - 0.5, rect.height / 2 - 0.5);
  return [
    { side: 'left', kind: 'inside', x: rect.x + inn, y: my }, { side: 'right', kind: 'inside', x: x2 - inn, y: my },
    { side: 'top', kind: 'inside', x: mx, y: rect.y + inn }, { side: 'bottom', kind: 'inside', x: mx, y: y2 - inn },
    { side: 'left', kind: 'outside', x: rect.x - outside, y: my }, { side: 'right', kind: 'outside', x: x2 + outside, y: my },
    { side: 'top', kind: 'outside', x: mx, y: rect.y - outside }, { side: 'bottom', kind: 'outside', x: mx, y: y2 + outside },
  ];
}

/**
 * Probe the edges of every control on the polyfill page and the twin and report the verdicts as checks (class 'hit').
 * `controls`: [{name, id, rect}] with css rects in viewport coordinates read from the twin. `accept[id]` lists extra ids that count as "the control itself"
 * (a label wrapping the control).
 */
export async function checkEdgeHits(ctx, { page, ref, controls: all, accept = {}, group = 'edge hits', numbers = {} }) {
  await ctx.focus(ref);
  const vp = await ref.evaluate('({ w: innerWidth, h: innerHeight })');
  // controls scrolled or wrapped out of the viewport cannot be clicked: skipped (listed in the numbers)
  const controls = all.filter((c) => c.rect && c.rect.x >= 4 && c.rect.y >= 4 && c.rect.x + c.rect.width <= vp.w - 4 && c.rect.y + c.rect.height <= vp.h - 4);
  numbers[`${group} skipped`] = all.filter((c) => !controls.includes(c)).map((c) => c.name);
  await ctx.focus(ref); await installHitProbe(ref);
  await ctx.focus(page); await installHitProbe(page);
  const rows = [];
  for (const c of controls) {
    for (const p of edgePoints(c.rect, c.points)) {
      await ctx.focus(ref);
      const twinHit = await hitAt(ref, p.x, p.y);
      await ctx.focus(page);
      const polyHit = await hitAt(page, p.x, p.y);
      rows.push({ control: c.name, ...p, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, twinHit, polyHit });
    }
  }
  for (const p of [ref, page]) { await ctx.focus(p); await p.evaluate('window.__hitProbe && window.__hitProbe.off()'); }
  const insideBad = rows.filter((r) => r.kind === 'inside' && r.polyHit !== controls.find((c) => c.name === r.control).id && !(accept[controls.find((c) => c.name === r.control).id] ?? []).includes(r.polyHit));
  const differs = rows.filter((r) => r.polyHit !== r.twinHit);
  numbers[group] = { points: rows.length, insideBad: insideBad.length, differsFromTwin: differs.length };
  ctx.check(`${group}: a click 2 px inside every control edge hits that control (none of its neighbours)`, rows.length > 0 && insideBad.length === 0, insideBad.slice(0, 4), 'hit');
  ctx.check(`${group}: every probe point (inside and 3 px outside) hits the same element as on the plain-DOM twin`, differs.length === 0, differs.slice(0, 4), 'hit');
  return rows;
}
