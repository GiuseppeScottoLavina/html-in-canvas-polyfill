// Shared by the four framework apps (React, Vue, Svelte, Lit): data, styles and constants, so the four apps draw the same picture
// and test/frameworks/run.mjs can check them with one script. Nothing in here touches the polyfill.

/** Canvas CSS size and where the conditional badge is DRAWN (css px; multiplied by the bitmap scale at draw time). */
export const SURFACE = { width: 480, height: 360 };
export const BADGE_AT = { x: 340, y: 300 };

export const PALETTE = ['#f2b5b5', '#b5d8f2', '#c6efb5', '#f2e2b5', '#d9c2f0', '#b5f0e6', '#f0c2dc'];

export const initialItems = () => [
  { id: 'a', label: 'Apple', color: PALETTE[0] },
  { id: 'b', label: 'Banana', color: PALETTE[1] },
  { id: 'c', label: 'Cherry', color: PALETTE[2] },
];

let seq = 0;
export const newItem = (n) => { seq += 1; const i = (n + seq) % PALETTE.length; return { id: 'n' + seq, label: 'Item ' + seq, color: PALETTE[i] }; };

/** URL switches: ?mode=ref renders the plain-DOM twin (a div instead of the canvas); ?tick=0 stops the timer component. */
const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search); // no location during server rendering
export const MODE = params.get('mode') === 'ref' ? 'ref' : 'canvas';
export const TICKING = params.get('tick') !== '0';
export const STRICT_HYDRATION = params.get('strict-hydration') === '1'; // React test probe only

/** One stylesheet for all four apps. Fixed sizes and a fixed font stack, so the plain-DOM twin is pixel-comparable. */
export const CSS = `
.surface { display: block; width: ${SURFACE.width}px; height: ${SURFACE.height}px; background: #ffffff; position: relative; }
.panel { box-sizing: border-box; width: ${SURFACE.width}px; height: ${SURFACE.height}px; padding: 10px 14px; overflow: hidden;
  background: #f4f1e8; color: #1d2330; font: 14px/18px Arial, Helvetica, sans-serif; }
.panel h2 { margin: 0 0 6px; font-size: 16px; line-height: 20px; }
.panel form { display: flex; gap: 8px; align-items: center; height: 28px; margin: 0 0 6px; }
.panel input { box-sizing: border-box; width: 180px; height: 26px; padding: 2px 6px; font: inherit; border: 1px solid #8a8f99; border-radius: 4px; background: #fff; color: #1d2330; }
.panel .echo { font-weight: bold; }
.panel ul { list-style: none; margin: 0 0 6px; padding: 0; height: 156px; }
.panel li { box-sizing: border-box; width: 300px; height: 24px; margin: 0 0 2px; padding: 3px 8px; border-radius: 3px; cursor: pointer; }
.panel li.sel { font-weight: bold; text-decoration: underline; }
.panel .buttons { display: flex; gap: 6px; height: 28px; margin: 0 0 6px; }
.panel button { height: 26px; padding: 0 10px; font: inherit; border: 1px solid #555; border-radius: 4px; background: #e2e6ee; color: #1d2330; }
.panel .tick, .panel .status { height: 18px; margin: 0 0 2px; }
.badge { box-sizing: border-box; width: 120px; height: 40px; padding: 10px 0; text-align: center; background: #c0283a; color: #fff;
  font: bold 14px/20px Arial, Helvetica, sans-serif; border-radius: 6px; cursor: pointer; }
.note { margin: 8px 0 0; font: 14px/18px Arial, Helvetica, sans-serif; }
.surface.ref > .badge { position: absolute; left: ${BADGE_AT.x}px; top: ${BADGE_AT.y}px; }
`;

/** Test surface used by test/frameworks/run.mjs (not needed by a real app). `getRoot` returns the node to query (document or a shadow root). */
export function testApi(getRoot) {
  if (typeof window === 'undefined') return { state: {}, actions: {} };
  const api = (window.__app ??= { ready: false, renders: 0, state: {}, actions: {} });
  api.q = (sel) => getRoot().querySelector(sel);
  api.rect = (sel) => { const e = api.q(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  api.text = (sel) => api.q(sel)?.textContent ?? null;
  return api;
}
