// In-page frame sampler for the comparison bench (installed with page.evaluate; no polyfill internals are used, so the same probe runs
// unchanged on our polyfill, the competitor and the native implementation).
//
// Every rendering update k: rAF(k) records its timestamp and posts a MessageChannel message; the handler runs AFTER update k finished
// (rAF -> style/layout -> ResizeObserver -> paint event -> commit), so the sample is what update k committed (the next refresh shows it).
// The sample reads ONE region of the canvas backing store (drawImage into a same-size willReadFrequently scratch + getImageData) and
// reduces it to a small FEATURE; the node side matches input events to the first frame whose feature shows the expected state.
//
//   feature 'extent'  rightmost column (region px) that holds ink (pixel far from the background colour) inside a row band: grows with
//                     every character typed while the text fits the field.
//   feature 'profile' per-column ink count inside a row band: shifts left by the scroll delta while the text scrolls inside the field.
//   feature 'accent'  rightmost column holding >= 3 accent-coloured pixels: the filled track / thumb edge of a range input.
//   feature 'hash'    32-bit hash of the quantised region + fraction of pixels changed vs the previous frame (update counting).
//   'diff' events     per-event baseline: the last sampled frame when the event arrived; the first later frame whose pixels differ from it by
//                     more than `delta` on >= `minFraction` of the region resolves that event (click/focus, wheel, author mutation).
//
// Observer cost: one region readback per frame, recorded per sample (`cost`). The same probe runs on every subject, and probe runs are never
// used for RunTask numbers (those come from a separate traced pass without the probe).

/* eslint-disable no-undef */
function pageProbe() {
  if (window.__cmp) return true;
  const C = window.__cmp = {};
  let S = null;
  const lum = (d, i) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  C.start = (o) => {
    const canvas = document.querySelector(o.selector);
    if (!canvas) throw new Error('probe: canvas not found ' + o.selector);
    const r = o.region;
    const sc = document.createElement('canvas'); sc.width = r.w; sc.height = r.h;
    const sctx = sc.getContext('2d', { willReadFrequently: true });
    const read = () => { sctx.clearRect(0, 0, r.w, r.h); sctx.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h); return sctx.getImageData(0, 0, r.w, r.h).data; };
    const band = o.band ?? [0, r.h];
    const bg = o.bg ?? null; const inkDelta = o.inkDelta ?? 70;
    const isInk = (d, i) => Math.max(Math.abs(d[i] - bg[0]), Math.abs(d[i + 1] - bg[1]), Math.abs(d[i + 2] - bg[2])) > inkDelta && d[i + 3] > 100;
    const features = {
      extent(d) { let best = -1; for (let x = r.w - 1; x >= 0 && best < 0; x--) for (let y = band[0]; y < band[1]; y++) if (isInk(d, (y * r.w + x) * 4)) { best = x; break; } return best; },
      profile(d) { const p = new Array(r.w).fill(0); for (let y = band[0]; y < band[1]; y++) for (let x = 0; x < r.w; x++) if (isInk(d, (y * r.w + x) * 4)) p[x]++; return p; },
      accent(d) {
        for (let x = r.w - 1; x >= 0; x--) { let n = 0; for (let y = band[0]; y < band[1]; y++) { const i = (y * r.w + x) * 4; if (d[i + 2] > 170 && d[i + 1] > 150 && d[i + 2] - d[i] > 60 && d[i + 3] > 100) n++; } if (n >= 3) return x; }
        return -1;
      },
      hash(d) { let h = 2166136261; for (let i = 0; i < d.length; i += 4) { h ^= (d[i] >> 3) | ((d[i + 1] >> 3) << 5) | ((d[i + 2] >> 3) << 10); h = Math.imul(h, 16777619); } return h >>> 0; },
      none() { return 0; },
    };
    const feat = features[o.feature ?? 'hash'];
    S = { o, frames: [], events: [], pending: [], prev: null, last: null, running: true, rafTs: 0, read, canvas, contentScore: [] };
    const diffFrac = (a, b, delta) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3])) > delta) n++; return n / (a.length / 4); };
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      if (!S || !S.running) return;
      const a = performance.now();
      const d = read();
      const f = feat(d);
      const changed = S.prev ? diffFrac(d, S.prev, 8) : 0;
      // content score: share of pixels far from the region's first pixel colour (cheap non-blank signal, every 4th pixel)
      let off = 0, cnt = 0; for (let i = 0; i < d.length; i += 16) { cnt++; if (Math.abs(lum(d, i) - lum(d, 0)) > 10 || d[i + 3] < 10) off++; }
      let alpha = 0; for (let i = 3; i < d.length; i += 64) alpha += d[i]; alpha /= (d.length / 64) * 255;
      const fr = { t: S.rafTs, f, changed, alpha, content: off / cnt, w: canvas.width, h: canvas.height };
      for (const p of S.pending) {
        if (p.hitT !== undefined) continue;
        if (diffFrac(d, p.base, o.delta ?? 24) >= (o.minFraction ?? 0.002)) { p.hitT = S.rafTs; p.hitFrame = S.frames.length; }
      }
      fr.cost = performance.now() - a;
      S.frames.push(fr); S.prev = d; S.last = d;
    };
    const loop = (ts) => { if (!S || !S.running) return; S.rafTs = ts; ch.port2.postMessage(0); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    const target = o.stateTarget ? document.querySelector(o.stateTarget) : null;
    const readState = () => target ? { value: target.value ?? null, scrollLeft: target.scrollLeft, scrollTop: target.scrollTop } : null;
    S.listeners = [];
    for (const type of o.events ?? []) {
      const h = (e) => {
        if (!e.isTrusted && !o.untrusted) return;
        const ev = { type, t: e.timeStamp, i: S.events.length, key: e.key ?? null, state: readState(), stateRaf: null };
        S.events.push(ev);
        requestAnimationFrame(() => { ev.stateRaf = readState(); });
        if (o.diffOn && o.diffOn.includes(type)) {
          if (S.last) S.pending.push({ ev: ev.i, base: S.last, t: e.timeStamp });
        }
      };
      addEventListener(type, h, { capture: true, passive: true });
      S.listeners.push([type, h]);
    }
    return { region: r, dpr: devicePixelRatio, canvas: [canvas.width, canvas.height] };
  };
  /** Mark an author-side change (JS mutation) as an "event" with a diff baseline, same clock as event.timeStamp. */
  C.mark = (label) => {
    if (!S) return null;
    const ev = { type: 'mark', t: performance.now(), i: S.events.length, key: label, state: null, stateRaf: null };
    S.events.push(ev);
    if (S.last) S.pending.push({ ev: ev.i, base: S.last, t: ev.t });
    return ev.i;
  };
  C.frameCount = () => (S ? S.frames.length : 0);
  C.stop = () => {
    if (!S) return null;
    S.running = false;
    for (const [t, h] of S.listeners) removeEventListener(t, h, true);
    const out = { frames: S.frames, events: S.events, diffs: S.pending.map((p) => ({ ev: p.ev, t: p.t, hitT: p.hitT ?? null, hitFrame: p.hitFrame ?? null })) };
    S = null;
    return out;
  };
  /** Paint-event counter (cheap, no readback): used in the traced passes and for the native no-readback cross-check. */
  C.countPaints = (selector) => {
    const c = document.querySelector(selector);
    const P = C.paints = { n: 0, t: [], raf: [] };
    c.addEventListener('paint', () => { P.n++; P.t.push(performance.now()); });
    const loop = (ts) => { P.raf.push(ts); if (P.raf.length > 20000) P.raf.splice(0, 10000); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    return true;
  };
  return true;
}

export const PROBE_SRC = `(${pageProbe.toString()})()`;

export async function installProbe(page) { await page.evaluate(PROBE_SRC); }
export async function startProbe(page, o) { await installProbe(page); return page.evaluate(`window.__cmp.start(${JSON.stringify(o)})`); }
export async function stopProbe(page) { return page.evaluate('window.__cmp.stop()'); }
export async function waitFrames(page, n, timeoutMs = 5000) {
  const t0 = Date.now(); const start = await page.evaluate('window.__cmp.frameCount()');
  while ((await page.evaluate('window.__cmp.frameCount()')) < start + n) { if (Date.now() - t0 > timeoutMs) throw new Error('probe: frames stalled (tab hidden?)'); await new Promise((r) => setTimeout(r, 20)); }
}
