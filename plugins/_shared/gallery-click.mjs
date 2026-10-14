// Click-through check in the plugin gallery (examples/plugins/), headless Chrome, TRUSTED input (CDP Input.dispatchMouseEvent).
//
// The plugin's own pure mapper (the formula that the GPU tests compare with the presented pixels) tells where a control of the live form
// is DRAWN. The check clicks at a drawn position of the control that is NOT its position in the DOM (the element natively under the
// pointer there is another one), and requires that the control is activated (checkbox toggled, field focused, form submitted).
// Control: a click at the control's DOM position, where the effect draws something else, must NOT activate it.
// Also recorded: console errors (must be none), the effect frame rate with the frame cap at 120, and the frames rendered in one idle
// second with prefers-reduced-motion: reduce.
//
// Used by plugins/<name>/test/gallery.e2e.mjs of crt, holo-card and liquid-glass, each with its own plan (where the plugin draws a control).
// Needs the built bundles: `npm run build` (`npm run test:plugins` runs every gallery e2e).
import * as H from '../../test/harness/index.mjs';
import { startServer } from '../../examples/serve.mjs';
import { builtBundle } from './gallery-e2e.mjs';

const VIEW = { width: 1180, height: 1000 };
const CONTROLS = 'a[href],button,input:not([type=hidden]),select,textarea,summary,label,[tabindex]';
/** the form controls of the gallery page, in order of preference, and how their activation shows */
export const TARGETS = [
  { sel: '#consent', kind: 'checkbox' }, { sel: '#submit', kind: 'submit' }, { sel: '#email', kind: 'focus' },
  { sel: '#name', kind: 'focus' }, { sel: '#message', kind: 'focus' },
];

/**
 * @typedef {Object} Ctx
 * @property {any} page
 * @property {{x: number, y: number, w: number, h: number}} canvas  content box in viewport css px
 * @property {(x: number, y: number) => Promise<void>} moveTo  trusted pointer move to a canvas point
 * @property {(x: number, y: number) => Promise<void>} clickAt  trusted click at a canvas point (no move before)
 * @property {any[]} boxes  every control and label of the live form, canvas css px
 * @property {(b: any, p: {x: number, y: number}, m?: number) => boolean} inside
 * @property {(p: {x: number, y: number}) => any[]} nativeAt
 * @property {(mapFor: Plan['mapFor'], targets: typeof TARGETS) => any} findDrawn
 */

/**
 * @typedef {Object} Plan
 * @property {string} name
 * @property {(p: {x: number, y: number}) => ((p: {x: number, y: number, width: number, height: number}) => {x: number, y: number})} mapFor
 *   the mapper of the frame that is presented when the pointer rests at canvas point p (after setup)
 * @property {(ctx: Ctx) => Promise<void>} [setup]  may replace plan.mapFor
 * @property {number} [settleBeforeClick]  ms to wait between the pointer move and the click
 * @property {typeof TARGETS} [targets]
 * @property {(ctx: Ctx) => Promise<void>} [idle]  after the reduced-motion reload
 * @property {(ctx: Ctx) => Promise<void>} [animate]  makes the effect animate while frames are counted
 */

/** @param {Plan} plan */
export async function runGalleryClickThrough(plan) {
  builtBundle(plan.name);
  const server = await startServer();
  const browser = await H.launchChrome({ name: `gallery-${plan.name}`, windowSize: [VIEW.width, VIEW.height + 100], dpr: 1, extraArgs: ['--headless=new', '--hide-scrollbars'] });
  const result = { plugin: plan.name, checks: /** @type {any[]} */ ([]), numbers: /** @type {Record<string, unknown>} */ ({}) };
  const check = (/** @type {string} */ name, /** @type {boolean} */ ok, /** @type {unknown} */ detail) => { result.checks.push({ name, ok: !!ok, detail }); return ok; };
  try {
    const page = await browser.newPage();
    await page.send('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false });
    const open = async () => {
      await page.navigate(`${server.url}/examples/plugins/?effect=${plan.name}`);
      await page.waitForFunction(`window.__gallery && window.__gallery.ready && window.__gallery.active === ${JSON.stringify(plan.name)}`, { timeout: 20000 });
      await H.sleep(500);
      // the picker and the panel above grow with the manifest: bring the whole canvas into the viewport before measuring it
      await page.evaluate(`document.getElementById('stage').scrollIntoView({ block: 'start' })`);
      await H.sleep(200);
      const canvas = await page.evaluate(`(() => { const c = document.getElementById('stage'); const r = c.getBoundingClientRect(); return { x: r.left + c.clientLeft, y: r.top + c.clientTop, w: c.clientWidth, h: c.clientHeight }; })()`);
      // the live form: rects of every control and label (canvas css px; the live layer lies exactly over the canvas)
      const boxes = await page.evaluate(`(() => {
        const c = document.getElementById('stage'); const r0 = c.getBoundingClientRect(); const ox = r0.left + c.clientLeft, oy = r0.top + c.clientTop;
        return [...document.getElementById('demo-form').querySelectorAll(${JSON.stringify(CONTROLS)})].map((e, i) => {
          if (!e.id) e.id = 'hic-e2e-' + i;
          const r = e.getBoundingClientRect();
          return { id: e.id, tag: e.localName, forId: e.htmlFor || (e.localName === 'label' && e.querySelector('input,textarea,select') ? e.querySelector('input,textarea,select').id : ''), x: r.left - ox, y: r.top - oy, w: r.width, h: r.height };
        });
      })()`);
      const inside = (/** @type {any} */ b, /** @type {{x: number, y: number}} */ p, m = 0) => p.x >= b.x + m && p.x <= b.x + b.w - m && p.y >= b.y + m && p.y <= b.y + b.h - m;
      /** the controls natively under p (what a click there would reach without the effect), by their DOM boxes */
      const nativeAt = (/** @type {{x: number, y: number}} */ p) => boxes.filter((b) => inside(b, p));
      /** a drawn position of one of `targets` that is not its DOM position, by the mapper `mapFor(p)` of the frame shown with the pointer at p */
      const findDrawn = (/** @type {Plan['mapFor']} */ mapFor, /** @type {typeof TARGETS} */ targets) => {
        for (const target of targets) {
          const box = boxes.find((b) => `#${b.id}` === target.sel);
          if (!box) continue;
          const related = (/** @type {any} */ b) => b.id === box.id || b.forId === box.id;
          let best = null;
          for (let y = Math.max(2, box.y - 160); y < Math.min(canvas.h - 2, box.y + box.h + 160); y += 2) {
            for (let x = Math.max(2, box.x - 220); x < Math.min(canvas.w - 2, box.x + box.w + 220); x += 2) {
              const p = { x, y };
              if (nativeAt(p).some(related)) continue;
              const m = mapFor(p)({ x, y, width: canvas.w, height: canvas.h });
              if (!inside(box, m, Math.min(4, box.w / 4, box.h / 4))) continue;
              const d = Math.hypot(m.x - (box.x + box.w / 2), m.y - (box.y + box.h / 2));
              if (!best || d < best.d) best = { p, d, mapped: m };
            }
          }
          if (best) return { target, box, ...best };
        }
        return null;
      };
      /** @type {Ctx} */
      const ctx = {
        page, canvas, boxes, inside, nativeAt, findDrawn,
        moveTo: (x, y) => page.mouseMove(canvas.x + x, canvas.y + y),
        clickAt: async (x, y) => { await page.mouseDown(canvas.x + x, canvas.y + y); await page.mouseUp(canvas.x + x, canvas.y + y); },
      };
      return ctx;
    };
    const ctx = await open();
    check('the gallery runs the plugin over the form, through WebGPU', true, { canvas: ctx.canvas });
    await plan.setup?.(ctx);
    const { boxes, inside, nativeAt } = ctx;
    const W = ctx.canvas.w, Hh = ctx.canvas.h;
    const drawnAt = (/** @type {{x: number, y: number}} */ p) => plan.mapFor(p)({ x: p.x, y: p.y, width: W, height: Hh });
    // prefer a target whose DOM centre the effect draws as something else, so that the control click below is meaningful
    const candidates = (plan.targets ?? TARGETS).map((t) => ctx.findDrawn(plan.mapFor, [t])).filter(Boolean);
    const controllable = (/** @type {any} */ c) => {
      const dom = { x: c.box.x + c.box.w / 2, y: c.box.y + c.box.h / 2 };
      const m = drawnAt(dom);
      return !boxes.some((b) => (b.id === c.box.id || b.forId === c.box.id) && inside(b, m));
    };
    const chosen = candidates.find(controllable) ?? candidates[0] ?? null;
    if (!check('a control is drawn where a click natively reaches something else (found with the plugin mapper)', !!chosen, chosen && { target: chosen.target.sel, drawnAt: chosen.p, dom: { x: chosen.box.x, y: chosen.box.y, w: chosen.box.w, h: chosen.box.h } })) return finish();
    const { target, box, p } = /** @type {any} */ (chosen);
    const native = await page.evaluate(`(() => { const e = document.elementFromPoint(${ctx.canvas.x + p.x}, ${ctx.canvas.y + p.y}); const c = e && e.closest(${JSON.stringify(CONTROLS)}); return { el: e && (e.id || e.localName), control: c && c.id }; })()`);
    check('the browser agrees: the element natively under that point is not the control nor its label', native.control !== box.id && !(boxes.find((b) => b.id === native.control)?.forId === box.id), native);

    const read = () => page.evaluate(`({ checked: !!document.querySelector(${JSON.stringify(target.sel)}).checked, active: document.activeElement && document.activeElement.id, feedback: document.getElementById('form-feedback').dataset.state })`);
    const activated = (/** @type {any} */ before, /** @type {any} */ after) => target.kind === 'checkbox' ? after.checked !== before.checked
      : target.kind === 'focus' ? after.active === box.id : after.feedback === 'success' && before.feedback !== 'success';

    // control: a click at the control's DOM centre, if the effect draws something else there, must not activate it
    const dom = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    const domDrawn = drawnAt(dom);
    const related = boxes.filter((b) => b.id === box.id || b.forId === box.id);
    if (!related.some((b) => inside(b, domDrawn))) {
      await page.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
      await ctx.moveTo(dom.x, dom.y);
      if (plan.settleBeforeClick) await H.sleep(plan.settleBeforeClick);
      const before = await read();
      await ctx.clickAt(dom.x, dom.y);
      await H.sleep(250);
      const after = await read();
      check('control: a click at the DOM position of the control (the effect draws something else there) does not activate it', !activated(before, after), { at: dom, drawnSource: domDrawn, before, after });
    } else result.checks.push({ name: 'control skipped: the effect draws the control itself at its DOM position', ok: true, detail: { at: dom } });

    await page.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
    await ctx.moveTo(p.x, p.y);
    if (plan.settleBeforeClick) await H.sleep(plan.settleBeforeClick);
    const before = await read();
    await ctx.clickAt(p.x, p.y);
    await H.sleep(250);
    const after = await read();
    check(`a trusted click on the DRAWN position of ${target.sel} activates it (${target.kind})`, activated(before, after), { at: p, before, after });

    // effect frames per second with the cap at 120, while the effect animates
    await page.evaluate(`(() => { const r = document.getElementById('fps-cap'); r.value = '120'; r.dispatchEvent(new Event('input')); })()`);
    const countFrames = async (/** @type {number} */ ms, /** @type {() => Promise<void>} */ during) => {
      await page.evaluate(`window.__e2eFrames = 0; window.__e2eCount = window.__e2eCount || (document.getElementById('stage').addEventListener('effectframe', () => { window.__e2eFrames += 1; }), true)`);
      const t0 = Date.now();
      await during?.();
      const left = ms - (Date.now() - t0);
      if (left > 0) await H.sleep(left);
      return (await page.evaluate(`window.__e2eFrames`)) * 1000 / Math.max(ms, Date.now() - t0);
    };
    result.numbers.cap = await page.evaluate(`document.getElementById('stage').frameCap`);
    result.numbers.raf = await page.evaluate(`new Promise((ok) => { let n = 0; const t0 = performance.now(); const f = () => { n += 1; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else ok(n * 1000 / (performance.now() - t0)); }; requestAnimationFrame(f); })`);
    result.numbers.animatedFps = await countFrames(2000, () => plan.animate?.(ctx) ?? Promise.resolve());
    await page.mouseMove(5, 5);   // away from the canvas
    await H.sleep(1500);
    result.numbers.idleFps = await countFrames(1000);

    const errors = page.errors({ includeWarnings: false });
    check('no console error or page exception', errors.length === 0, errors);

    // prefers-reduced-motion: reload; after it settles, an idle second renders (almost) nothing
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const reduced = await open();
    await plan.idle?.(reduced);
    await page.mouseMove(5, 5);
    await H.sleep(1500);
    result.numbers.reducedMotionIdleFps = await countFrames(1000);
    check('prefers-reduced-motion: no animation while idle (at most 2 effect frames in one second)', /** @type {number} */ (result.numbers.reducedMotionIdleFps) <= 2, result.numbers.reducedMotionIdleFps);
    const errors2 = page.errors({ includeWarnings: false });
    check('no console error or page exception with reduced motion either', errors2.length === 0, errors2);
    return finish();
  } finally {
    await browser.close();
    await server.close();
  }

  function finish() {
    const ok = result.checks.every((c) => c.ok);
    for (const c of result.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : `\n      ${JSON.stringify(c.detail)}`}`);
    console.log(`numbers: ${JSON.stringify(result.numbers)}`);
    console.log(ok ? `${plan.name}: gallery click-through OK` : `${plan.name}: gallery click-through FAILED`);
    process.exitCode = ok ? 0 : 1;
    return result;
  }
}
