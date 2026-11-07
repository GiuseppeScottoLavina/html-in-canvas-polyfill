// HicInstalled.whenPainted over a native implementation (docs/API-CONTRACT.md section 2): it resolves at once when the canvas has already fired `paint`,
// else at its first `paint`, and rejects with a TimeoutError after timeoutMs. In modes native and native-bridged `paint` is the browser's own event, so the
// polyfill's canvas registry knows nothing of it; this in-page probe makes canvases of its own on the page the core is installed on and measures each case:
//   already   a canvas that fired its first paint and then stays static: whenPainted resolves in well under a frame, with no paint in between
//   first     whenPainted called before the canvas is in the document: it resolves at the canvas's first paint, not before
//   timeout   a canvas that never paints: TimeoutError after timeoutMs
//   adopted   a canvas in an open shadow root passed to adoptRoot (paint is not composed: it never reaches the window), painted, then static: at once
// Used by G-bridged-translation (Chrome for Testing 154 / 155: mode native-bridged, and mode native without the bridge) and G-native-loader (Chrome 157 or later).

/** at most this long for a "resolves at once" (one frame at 120 Hz) */
export const AT_ONCE_MS = 8.33;

/**
 * The probe's source; it evaluates to a promise of its measurements.
 * @param {string} attribute  what makes a canvas drawable in that build: 'content' (content="drawable") or 'layoutsubtree' (the earlier draft, mode native)
 */
export function whenPaintedProbe(attribute = 'content') {
  return `(async () => {
  const installed = window[Symbol.for('hic.installed')];
  // a frame, or 100 ms where the page gets no frames (a hidden page): the probe never hangs, and visibility is recorded
  const frame = () => new Promise((done) => { const t = setTimeout(done, 100); requestAnimationFrame(() => { clearTimeout(t); done(); }); });
  const frames = async (n) => { while (n-- > 0) await frame(); };
  const make = () => {
    const c = document.createElement('canvas');
    c.width = 60; c.height = 40;
    ${attribute === 'layoutsubtree' ? "c.setAttribute('layoutsubtree', '');" : "c.setAttribute('content', 'drawable');"}
    // drawable: in the current API only a child that carries it is drawn and fires paint (Chrome 157 fires none for a canvas whose children lack it); the earlier draft ignores it
    c.innerHTML = '<div drawable style="width: 20px; height: 20px; background: rgb(0, 128, 0)"></div>';
    c.getContext('2d');
    c.__paints = 0;
    c.addEventListener('paint', () => { c.__paints++; });
    return c;
  };
  const settle = async (p, c) => { const t0 = performance.now(); const out = await p.then(() => 'resolved', (e) => e && e.name); return { out, ms: +(performance.now() - t0).toFixed(2), paintsAtSettle: c ? c.__paints : null }; };
  const insert = async (c, parent) => { parent.append(c); await frames(2); };
  const painted = async (c) => { const t0 = performance.now(); while (!c.__paints && performance.now() - t0 < 3000) await frame(); await frames(4); return c.__paints; };
  const atOnce = async (c) => { const before = await painted(c); const r = await settle(installed.whenPainted(c, 1000), c); return { ...r, paintedBefore: before, paintsDuring: r.paintsAtSettle - before }; };
  const r = { mode: installed.mode, kind: installed.native && installed.native.kind, visibility: document.visibilityState };
  const a = make(); await insert(a, document.body);
  r.already = await atOnce(a);
  const b = make(); const pending = installed.whenPainted(b, 3000); await insert(b, document.body);
  r.first = await settle(pending, b);
  r.timeout = await settle(installed.whenPainted(document.createElement('canvas'), 200), null);
  const host = document.createElement('div'); document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  installed.adoptRoot(root);
  const s = make(); await insert(s, root);
  r.adopted = await atOnce(s);
  for (const c of [a, b, host]) c.remove();
  return r;
})()`;
}

/**
 * The checks over the probe's result: [name, ok, detail].
 * @param {any} r  the probe's result
 * @param {string} where  which install it measured, for the check names
 * @returns {Array<[string, boolean, unknown]>}
 */
export function whenPaintedChecks(r, where) {
  const at = `whenPainted, ${where} (mode ${r?.mode}, kind ${r?.kind})`;
  const once = (/** @type {any} */ x) => !!x && x.out === 'resolved' && x.paintedBefore >= 1 && x.paintsDuring === 0 && x.ms < AT_ONCE_MS;
  return [
    [`${at}: a canvas that already fired paint and stays static resolves at once (under ${AT_ONCE_MS} ms, no paint in between)`, once(r?.already), r?.already],
    [`${at}: called before the canvas is in the document, it resolves at the canvas's first paint`, r?.first?.out === 'resolved' && r.first.paintsAtSettle >= 1, r?.first],
    [`${at}: a canvas that never paints rejects with TimeoutError after timeoutMs (200 ms)`, r?.timeout?.out === 'TimeoutError' && r.timeout.ms >= 190 && r.timeout.ms < 1000, r?.timeout],
    [`${at}: a canvas in an open shadow root passed to adoptRoot that already fired paint resolves at once`, once(r?.adopted), r?.adopted],
  ];
}
