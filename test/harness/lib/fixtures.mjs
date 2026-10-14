// Node-side helpers for loading the fixtures served by server.mjs.
//
//   F1 water form (static markup)   F2 scroll   F3 resize   F4 large app (nodes=200|500|1000|2000)   F5 classic scrollbars
//   each as  mode=ref (plain DOM) | mode=poly (canvas + polyfill bundle) | mode=native (canvas + browser implementation)
//
// The new polyfill is not built yet: `bundle` is optional everywhere and a given-but-missing bundle fails LOUDLY (before
// navigation here, and again inside the page via boot.js).
import { sleep } from './util.mjs';

export const FIXTURES = {
  f1: { path: '/test/fixtures/f1-water-form/index.html', surface: '#hic-surface', title: 'F1 water form: ~60 elements, fields, textarea, range slider, checkbox' },
  f2: { path: '/test/fixtures/f2-scroll/index.html', surface: '#hic-surface', title: 'F2 scroll: page scroll moves the canvas; #list (sticky head, 300 rows), #side + nested #inner scrollers' },
  f3: { path: '/test/fixtures/f3-resize/index.html', surface: '#hic-surface', title: 'F3 resize: canvas width 100 %, flex-wrap cards, media queries at 800/520 px, wrapping text' },
  f4: { path: '/test/fixtures/f4-large-app/index.html', surface: '#hic-surface', title: 'F4 large app: cards, table, nested lists, form rows; ?nodes=N element budget' },
  f5: { path: '/test/fixtures/f5-classic-scrollbars/index.html', surface: '#hic-surface', title: 'F5 classic scrollbars: ::-webkit-scrollbar forces non-overlay bars (vertical, horizontal, corner, textarea)' },
};

/**
 * @param {{url:string}} server
 * @param {keyof typeof FIXTURES|string} id fixture id (f1..f5) or a path starting with '/'
 * @param {{mode?:'poly'|'ref'|'native', bundle?:string, nodes?:number, params?:Record<string,string|number>}} [o]
 */
export function fixtureUrl(server, id, { mode = 'poly', bundle, nodes, params = {} } = {}) {
  const path = FIXTURES[id]?.path ?? id;
  const u = new URL(path, server.url);
  u.searchParams.set('mode', mode);
  if (bundle && bundle !== 'none') u.searchParams.set('bundle', bundle);
  if (nodes !== undefined) u.searchParams.set('nodes', String(nodes));
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.href;
}

/** Throws unless every same-origin bundle path (a comma-separated list is allowed) is served with HTTP 200 (absolute http(s) URLs are not checked). */
export async function checkBundle(server, bundle) {
  if (!bundle || bundle === 'none') return;
  for (const one of bundle.split(',')) {
    if (/^https?:/.test(one)) continue;
    const r = await fetch(new URL(one, server.url));
    if (r.status !== 200) throw new Error(`BUNDLE MISSING: ${one} -> HTTP ${r.status}. The polyfill build is optional, but a bundle that is asked for must exist.`);
    const body = await r.text();
    if (body.length < 50) throw new Error(`BUNDLE SUSPICIOUSLY SMALL: ${one} (${body.length} bytes)`);
  }
}

/**
 * Navigate `page` to a fixture and wait until it is ready (first non-empty paint for poly/native, swap done for ref).
 * THROWS on a fixture/bundle failure, on page errors that appear before ready, or on timeout.
 * @param {import('./page.mjs').Page} page
 * @returns {Promise<{url:string, state:object}>}
 */
export async function openFixture(page, server, id, { mode = 'poly', bundle, nodes, params, timeout = 20000 } = {}) {
  await checkBundle(server, bundle);
  const url = fixtureUrl(server, id, { mode, bundle, nodes, params });
  page.clearLogs();
  await page.navigate(url);
  const t0 = Date.now();
  for (;;) {
    const s = await page.evaluate('({ fatal: window.__HIC_FIXTURE?.fatal ?? null, ready: !!window.__HIC_FIXTURE?.ready, state: window.__HIC_FIXTURE ? { mode: __HIC_FIXTURE.mode, bundle: __HIC_FIXTURE.bundle, bundleLoaded: __HIC_FIXTURE.bundleLoaded, nativeSupported: __HIC_FIXTURE.nativeSupported, legacyAttr: __HIC_FIXTURE.legacyAttr } : null, draw: window.__HIC_DRAW ? { paints: __HIC_DRAW.paints, errors: __HIC_DRAW.errors, backing: __HIC_DRAW.lastBacking } : null })');
    if (s.fatal) throw new Error(`fixture ${id} (${mode}) FAILED: ${s.fatal}`);
    if (s.ready) return { url, state: s };
    if (Date.now() - t0 > timeout) throw new Error(`fixture ${id} (${mode}) not ready after ${timeout} ms: ${JSON.stringify(s)}; page errors: ${JSON.stringify(page.errors())}`);
    await sleep(60);
  }
}

/** Open the canvas variant and its plain-DOM reference in two tabs of the same window. */
export async function openPair(browser, server, id, { mode = 'poly', bundle, nodes, params } = {}) {
  const surfacePage = await browser.newPage(); const refPage = await browser.newPage({ reuseFirst: false });
  await refPage.bringToFront(); await openFixture(refPage, server, id, { mode: 'ref', nodes, params });
  await surfacePage.bringToFront(); const surface = await openFixture(surfacePage, server, id, { mode, bundle, nodes, params });
  return { surfacePage, refPage, surface };
}
