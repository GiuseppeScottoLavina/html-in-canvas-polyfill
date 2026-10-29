// Page-side sabotage of the renderer for CONTROL runs. A control is a deliberately broken variant of the polyfill: the gate must turn red for it.
//
// Sabotage code is APPENDED to a copy of the bundle (`controlBundleText`), so it runs right after the polyfill installed and BEFORE the first paint: the
// broken behaviour is present from the first frame (a sabotage applied after the first paint would let geometry/first-draw state already be good).
//   blank   drawElementImage draws, then overwrites the canvas with black (every draw is a black frame)
//   stale   only the first drawElementImage of the page draws; later paints leave the old bitmap
//   nogeom  hit-test geometry is never applied (updateElementGeometry is a no-op and every draw preserves the layout position)
//   nowheel every wheel event is cancelled (native scrolling of the live list never happens)
//   freezelayer the live layer keeps a stale width (the live layout never converges to the new window size)
//   nohit   same as nogeom, kept as a name for gates that only care about the hit test
//   originshift every draw lands one device pixel to the right when the canvas starts on a fractional device pixel (an output that depends on the page position)
//   nopagescroll the polyfill's window scroll listener (the page-scroll watch of sticky / fixed drawables) is never added: the build before that watch existed
//   nosync  the scroll synchronisation attribute (data-hic-scroll) is never set on a live scroller: the compositor draws a precise scroll without waiting for the main frame
//   nocompose an empty position:fixed element is put into every scroller the pointer reaches (nothing visible): the scroll compositor has no plan for it, every step is built
//   halfpaint every second paint event of a canvas is dropped (no handler runs, nothing is drawn): a renderer that paints in every other frame, the old scroll cadence
export const SABOTAGE_JS = {
  blank: `(() => { const p = CanvasRenderingContext2D.prototype; const o = p.drawElementImage; p.drawElementImage = function (...a) { try { o.apply(this, a); } finally { this.save(); this.setTransform(1,0,0,1,0,0); this.globalCompositeOperation='copy'; this.fillStyle='#000'; this.fillRect(0,0,this.canvas.width,this.canvas.height); this.restore(); } }; return 'blank'; })()`,
  stale: `(() => { const p = CanvasRenderingContext2D.prototype; const o = p.drawElementImage; let n = 0; p.drawElementImage = function (...a) { if (n++ === 0) return o.apply(this, a); }; window.__sabotageStale = () => n; return 'stale'; })()`,
  nogeom: `(() => { const p = HTMLCanvasElement.prototype; p.updateElementGeometry = function () {}; const c = CanvasRenderingContext2D.prototype; const o = c.drawElementImage; c.drawElementImage = function (el, ...a) { const last = a[a.length - 1]; if (last && typeof last === 'object') return o.call(this, el, ...a.slice(0, -1), { ...last, preserveElementGeometry: true }); return o.call(this, el, ...a, { preserveElementGeometry: true }); }; return 'nogeom'; })()`,
};
SABOTAGE_JS.nowheel = `(() => { addEventListener('wheel', (e) => e.preventDefault(), { capture: true, passive: false }); return 'nowheel'; })()`;
SABOTAGE_JS.freezelayer = `(() => { setInterval(() => { const l = document.querySelector('hic-layer'); if (l) l.style.setProperty('width', '1400px', 'important'); }, 16); return 'freezelayer'; })()`;
SABOTAGE_JS.nohit = SABOTAGE_JS.nogeom;
SABOTAGE_JS.originshift = `(() => { const p = CanvasRenderingContext2D.prototype; const o = p.drawElementImage; p.drawElementImage = function (el, ...a) { const f = (this.canvas.getBoundingClientRect().left * devicePixelRatio) % 1; if (f > 1e-3 && typeof a[0] === 'number') a[0] += 1; return o.call(this, el, ...a); }; return 'originshift'; })()`;
SABOTAGE_JS.nopagescroll = `(() => { const add = EventTarget.prototype.addEventListener; EventTarget.prototype.addEventListener = function (type, fn, o) { if (this === window && type === 'scroll' && o && o.capture && /hic-live-polyfill/.test(new Error().stack || '')) return; return add.call(this, type, fn, o); }; return 'nopagescroll'; })()`;

SABOTAGE_JS.nosync = `(() => { const set = Element.prototype.setAttribute; Element.prototype.setAttribute = function (n, v) { if (n === 'data-hic-scroll') return; return set.call(this, n, v); }; return 'nosync'; })()`;
SABOTAGE_JS.nocompose = `(() => { addEventListener('pointerover', (e) => { for (let el = e.target; el && el.nodeType === 1; el = el.parentElement) { if (el.scrollHeight > el.clientHeight + 1 && !el.__gateFixed) { el.__gateFixed = true; const d = document.createElement('div'); d.style.cssText = 'position:fixed;width:0;height:0'; el.prepend(d); } } }, { capture: true, passive: true }); return 'nocompose'; })()`;
SABOTAGE_JS.halfpaint = `(() => { const d = EventTarget.prototype.dispatchEvent; const n = new WeakMap(); EventTarget.prototype.dispatchEvent = function (e) { if (e.type === 'paint' && this instanceof HTMLCanvasElement) { const k = (n.get(this) ?? 0) + 1; n.set(this, k); if (k % 2 === 0) return true; } return d.call(this, e); }; return 'halfpaint'; })()`;

/** The bundle text with the sabotage of every kind in `kinds` appended (each wrapped so a failure is visible, not silent). */
export function controlBundleText(bundleText, kinds) {
  const tail = kinds.map((k) => {
    if (!SABOTAGE_JS[k]) throw new Error('unknown sabotage ' + k);
    return `;try { ${SABOTAGE_JS[k]}; } catch (e) { console.error('[gate control] sabotage ${k} failed: ' + e); }`;
  });
  return bundleText + '\n' + tail.join('\n') + '\n';
}

/** Apply a sabotage after load (for gates whose control is about LATER behaviour, e.g. a renderer that dies after the first frame). */
export async function sabotage(page, kind) {
  const js = SABOTAGE_JS[kind];
  if (!js) throw new Error('unknown sabotage ' + kind);
  return page.evaluate(js);
}
