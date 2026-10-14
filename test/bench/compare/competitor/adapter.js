// Adapter v2 (ours, NOT part of the competitor), appended AFTER the competitor bundle. The competitor recognises only the
// pre-2026-09 attribute `layoutsubtree`; the pinned WPT tests and the current explainer use `<canvas content=drawable>`.
// This mirrors content=drawable onto layoutsubtree at the moments an author who wrote `layoutsubtree` in markup would have had it:
// when page script first touches the canvas (getContext, onpaint, requestPaint, paint listener, captureElementImage), at
// DOMContentLoaded, and for canvases inserted/changed later. Setting it while the canvas is still being parsed would make the
// competitor adopt the children too early (v1 did that and lost the children), so nothing is mirrored before that.
(function () {
  const isDrawable = (c) => (c.getAttribute('content') || '').toLowerCase() === 'drawable';
  const sync = (c) => { if (!(c instanceof HTMLCanvasElement)) return; if (isDrawable(c)) { if (!c.hasAttribute('layoutsubtree')) c.setAttribute('layoutsubtree', ''); } else if (c.hasAttribute('layoutsubtree')) c.removeAttribute('layoutsubtree'); };
  const P = HTMLCanvasElement.prototype;
  const wrapMethod = (name) => { const d = Object.getOwnPropertyDescriptor(P, name); if (!d || typeof d.value !== 'function') return; const f = d.value; Object.defineProperty(P, name, { ...d, value: function (...a) { if (name !== 'addEventListener' || a[0] === 'paint') sync(this); return f.apply(this, a); } }); };
  ['getContext', 'requestPaint', 'captureElementImage', 'getElementTransform', 'addEventListener'].forEach(wrapMethod);
  const od = Object.getOwnPropertyDescriptor(P, 'onpaint');
  if (od && od.set) Object.defineProperty(P, 'onpaint', { ...od, set(v) { sync(this); od.set.call(this, v); } });
  const scanAll = () => document.querySelectorAll('canvas').forEach(sync);
  const scan = (n) => { if (n instanceof HTMLCanvasElement) sync(n); else if (n && n.querySelectorAll) n.querySelectorAll('canvas').forEach(sync); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scanAll, { once: true }); else scanAll();
  new MutationObserver((ms) => { if (document.readyState === 'loading') return; for (const m of ms) { if (m.type === 'attributes') sync(m.target); else m.addedNodes.forEach(scan); } })
    .observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['content'] });
})();
