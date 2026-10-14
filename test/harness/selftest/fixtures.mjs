// Fixture loader: F1..F5 as plain-DOM references and canvas[content=drawable] variants; optional bundle that fails loudly.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openFixture, fixtureUrl, checkBundle, FIXTURES } from '../lib/fixtures.mjs';
import { screenshotElement } from '../lib/oracle-pixel.mjs';
import { pixelStats } from '../lib/pixels.mjs';
import { PROJECT_ROOT } from '../lib/util.mjs';

const thrown = async fn => { try { await fn(); return null; } catch (e) { return e.message; } };

export async function run({ check, info, page, srv }) {
  await page.requireForeground('fixtures section');
  // static markup: every fixture has the drawable canvas variant
  for (const [id, f] of Object.entries(FIXTURES)) {
    if (id === 'f4') continue;
    const html = readFileSync(resolve(PROJECT_ROOT, f.path.slice(1)), 'utf8');
    check(`${id}: markup has <canvas content="drawable"> with a [drawable] child and the shared boot`, /<canvas[^>]*\bcontent="drawable"/.test(html) && /\sdrawable[\s>]/.test(html) && /shared\/boot\.js/.test(html), { bytes: html.length });
  }

  // the bundle is optional but must fail loudly
  check('checkBundle: a missing bundle THROWS before navigation', /BUNDLE MISSING/.test(await thrown(() => checkBundle(srv, '/dist/does-not-exist.js')) ?? ''));
  check('checkBundle: bundle "none" and undefined are fine', (await thrown(() => checkBundle(srv, 'none'))) === null && (await thrown(() => checkBundle(srv, undefined))) === null);
  check('openFixture(mode=poly) with no bundle fails loudly (fatal)', /needs \?bundle/.test(await thrown(() => openFixture(page, srv, 'f1', { mode: 'poly', timeout: 4000 })) ?? ''));
  check('openFixture(mode=poly, bundle=missing) fails loudly before loading', /BUNDLE MISSING/.test(await thrown(() => openFixture(page, srv, 'f1', { mode: 'poly', bundle: '/dist/nope.js' })) ?? ''));
  await page.navigate(fixtureUrl(srv, 'f1', { mode: 'poly', bundle: '/dist/nope.js' })); // bypass the node-side check: the page must complain itself
  await page.waitForFunction('window.__HIC_FIXTURE?.fatal', { timeout: 5000 }).catch(() => {});
  const inPage = await page.evaluate('({ fatal: __HIC_FIXTURE.fatal, banner: !!document.body.textContent.match(/FIXTURE ERROR/) })');
  check('in-page: a 404 bundle sets __HIC_FIXTURE.fatal and shows the red banner', /bundle failed to load/.test(inPage.fatal ?? '') && inPage.banner, inPage);
  await page.navigate(fixtureUrl(srv, 'f1', { mode: 'poly', bundle: '/test/harness/selftest-fixture/stub-bundle.js', params: { painter: 'none' } }));
  const stub = await page.evaluate('({ loaded: __HIC_FIXTURE.bundleLoaded, at: window.__STUB_BUNDLE_LOADED_AT, bootAt: __HIC_FIXTURE.bootAt })');
  check('a served bundle is loaded synchronously right after the markup (before any painter)', stub.loaded === true && stub.at > 0, stub);

  // references: plain DOM, non-blank, no console errors; and each poly variant without bundle must refuse
  for (const id of ['f1', 'f2', 'f3', 'f5']) {
    page.clearLogs();
    const r = await openFixture(page, srv, id, { mode: 'ref' });
    const { img, geo } = await screenshotElement(page, FIXTURES[id].surface);
    const st = pixelStats(img);
    check(`${id} ref: plain-DOM reference renders non-blank (${geo.width}x${geo.height} css)`, st.nonBlank && r.state.ready, { distinctColors: st.distinctColors, nonBackgroundFraction: st.nonBackgroundFraction ?? st.fraction });
    check(`${id} ref: no console errors`, page.errors().length === 0, page.errors());
    check(`${id} poly without bundle refuses loudly`, /bundle/.test(await thrown(() => openFixture(page, srv, id, { mode: 'poly', timeout: 3000 })) ?? ''));
  }

  // F4 node-count contract
  for (const n of [200, 500, 1000, 2000]) {
    page.clearLogs();
    await openFixture(page, srv, 'f4', { mode: 'ref', nodes: n });
    const count = await page.evaluate('document.querySelectorAll("#root, #root *").length');
    check(`f4 nodes=${n}: #root subtree has exactly ${n} elements`, count === n, { count });
    if (n === 200 || n === 2000) { const { img } = await screenshotElement(page, '#hic-surface'); check(`f4 nodes=${n}: renders non-blank`, pixelStats(img).nonBlank); }
    check(`f4 nodes=${n}: no console errors`, page.errors().length === 0, page.errors());
  }
  // F5 classic scrollbars regardless of the OS setting
  await openFixture(page, srv, 'f5', { mode: 'ref' });
  const env = await page.evaluate('(() => { const d = document.createElement("div"); d.style.cssText = "position:fixed;left:-9999px;width:100px;height:100px;overflow:scroll"; d.innerHTML = "<div style=\\"width:300px;height:300px\\"></div>"; document.body.appendChild(d); const g = d.offsetWidth - d.clientWidth; d.remove(); const sc = [...document.querySelectorAll("*")].filter(e => e.scrollHeight > e.clientHeight + 1 && getComputedStyle(e).overflowY !== "visible"); return { probeGutter: g, gutters: sc.map(e => e.offsetWidth - e.clientWidth) }; })()');
  check('f5: ::-webkit-scrollbar gives non-overlay bars (gutter > 0) on its scrollers', env.gutters.length > 0 && env.gutters.every(g => g > 0), env);
  info('scrollbar probe on a plain page (control; 0 = OS overlay bars)', env.probeGutter);
}
