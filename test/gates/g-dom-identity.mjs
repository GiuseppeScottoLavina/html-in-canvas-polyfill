// G-dom-identity (O-dom-identity): install -> uninstall (twice, with a reinstall in between) leaves the DOM serialisation and the descriptor of EVERY property of window, document,
// navigator, CSS, Reflect, Object, Function.prototype and of every constructor on window and its prototype exactly as before (function identity included). The patched set is
// GENERATED from the install diff, not hand-written (lib/identity.mjs). Uninstall also leaves no listener, active observer or interval attributed to the bundle (lib/listeners.mjs).
// Positive control: one descriptor stays replaced after uninstall (class 'descriptor') and a document listener of a bundle-named script stays after uninstall (class 'leftover').
import { runGate, H } from './lib/gate.mjs';
import { IDENTITY_EXPR, diffIdentity } from './lib/identity.mjs';
import { openAuditPage, checkClean } from './lib/listeners.mjs';

runGate('G-dom-identity', async (ctx) => {
  const numbers = {};
  const { page, urls } = await openAuditPage(ctx);
  await page.navigate(new URL('/test/fixtures/identity/index.html?bundle=' + ctx.bundle, ctx.srv.url).href);
  await ctx.focus(page);
  await page.waitForFunction('typeof HicLivePolyfill === "object" && !!window.__id', { timeout: 10000 });
  const before = await page.evaluate(IDENTITY_EXPR);
  numbers.objectsCovered = Object.keys(before.table).length;
  ctx.check('the descriptor table covers every constructor of window (generated list)', numbers.objectsCovered > 300, { objects: numbers.objectsCovered }, 'surface');
  for (let round = 1; round <= 2; round++) {
    const mode = await page.evaluate('window.__id.install()');
    ctx.check(`round ${round}: installed in polyfill mode`, mode === 'polyfill', { mode }, 'surface');
    await H.sleep(500);
    const live = await page.evaluate(`({ requestPaint: typeof HTMLCanvasElement.prototype.requestPaint, draw: typeof CanvasRenderingContext2D.prototype.drawElementImage, ei: typeof ElementImage, layer: !!document.querySelector('hic-layer'), effects: typeof HTMLInCanvasEffects,
      canvasKids: document.getElementById('c').children.length })`);
    ctx.check(`round ${round}: the API is present and the layer mounted while installed (the core alone defines no HTMLInCanvasEffects: that is the optional effects bundle)`, live.requestPaint === 'function' && live.draw === 'function' && live.ei === 'function' && live.layer && live.effects === 'undefined' && live.canvasKids === 3, live, 'surface');
    const installed = await page.evaluate(IDENTITY_EXPR);
    const patched = diffIdentity(before, installed);
    const patchedObjects = [...new Set(patched.filter((d) => d.where !== 'outerHTML').map((d) => d.where.slice(0, d.where.lastIndexOf('.'))))];
    if (round === 1) { numbers.patchedProperties = patched.length; numbers.patchedObjects = patchedObjects; }
    await page.evaluate('window.__id.uninstall()');
    await H.sleep(300);
    if (ctx.control && round === 2) await page.evaluate('HTMLCanvasElement.prototype.requestPaint = function () {}'); // a patched member that uninstall left behind
    const after = await page.evaluate(IDENTITY_EXPR);
    const d = diffIdentity(before, after);
    ctx.check(`round ${round}: DOM and every descriptor of every window constructor equal the pre-install state after uninstall`, d.length === 0, d.slice(0, 6), 'descriptor');
    numbers[`round${round}Differences`] = d.length;
  }
  ctx.check('install changed many properties (the comparison has teeth)', numbers.patchedProperties >= 30, { patchedProperties: numbers.patchedProperties, objects: numbers.patchedObjects }, 'surface');
  if (ctx.control) await page.evaluate(`document.addEventListener('pointerdown', function leftBehind() {}, true);\n//# sourceURL=http://127.0.0.1/dist/hic-live-polyfill.control.js`);
  await checkClean(ctx, { page, urls, label: 'after the last uninstall', numbers });
  const errs = page.errors({ includeWarnings: false });
  ctx.check('no page error or console error', errs.length === 0, errs.slice(0, 3), 'surface');
  return { numbers };
}, { controlClasses: ['descriptor', 'leftover'] });
