// Environment, profile guard, foreground checks (loud failure).
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchChrome } from '../lib/chrome.mjs';
import { PROFILES_DIR } from '../lib/util.mjs';

export async function run({ check, info, page, browser, srv, R }) {
  const env = R.environment.main;
  check('page is foreground and focused with REAL focus (not emulated)', env.focus.hasFocus && env.focus.visibilityState === 'visible' && !env.focusEmulated, env.focus);
  check('rAF cadence measured (p50 between 3 and 40 ms)', env.rafMeasured.p50Ms > 3 && env.rafMeasured.p50Ms < 40, env.rafMeasured);
  info('refresh', `${env.rafMeasured.impliedHz.toFixed(1)} Hz (rAF p50 ${env.rafMeasured.p50Ms.toFixed(2)} ms, p95 ${env.rafMeasured.p95Ms.toFixed(2)} ms)`);
  info('dpr / viewport / chrome', { dpr: env.viewport.dpr, inner: [env.viewport.innerWidth, env.viewport.innerHeight], outer: [env.viewport.outerWidth, env.viewport.outerHeight], chrome: env.chrome });

  // profile guard: positive control, must refuse
  for (const bad of ['/tmp/hic-selftest-evil-profile', `${PROFILES_DIR}/../escape-profile`, PROFILES_DIR, join(homedir(), 'Library/Application Support/Google/Chrome')]) {
    const err = await launchChrome({ userDataDir: bad }).then(b => { b.close(); return null; }, e => e.message);
    check(`launchChrome refuses profile outside .profiles/: ${bad}`, !!err && /refusing|resolves outside/.test(err), err);
  }

  // foreground loud failure: a second tab hides the first; assertForeground MUST throw, ensureForeground must recover it
  const other = await browser.newPage({ reuseFirst: false });
  await other.bringToFront();
  await new Promise(r => setTimeout(r, 400));
  const thrown = await page.assertForeground('(control: tab deliberately hidden)').then(() => null, e => e.message);
  check('assertForeground THROWS when the tab is hidden (positive control for the loud failure)', !!thrown && /NOT FOREGROUND/.test(thrown), thrown);
  const rec = await page.ensureForeground();
  check('ensureForeground recovers real focus after the control', rec.ok && rec.mode === 'real', rec);
  await other.close();
  await page.requireForeground('after closing the control tab');

  // server: bundle identity endpoint + traversal + dot paths refused
  const hash = await (await fetch(`${srv.url}/__hic/hash?path=/test/harness/selftest-fixture/stub-bundle.js`)).json();
  check('/__hic/hash reports sha256 + bytes of a served file', /^[0-9a-f]{64}$/.test(hash.sha256) && hash.bytes > 20, hash);
  // fetch() normalises '/../package.json' to '/package.json' before it is sent, so a traversal probe must go out RAW: http.request keeps the path exactly as written.
  const rawGet = (/** @type {string} */ path) => new Promise((resolve, reject) => {
    const u = new URL(srv.url);
    const req = httpRequest({ host: u.hostname, port: u.port, path, method: 'GET' }, (res) => {
      /** @type {Buffer[]} */ const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
  const escapes = ['/../../../../../../etc/hosts', '/..%2f..%2f..%2f..%2f..%2f..%2fetc/hosts', '/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/hosts', '/.git/config', '/.profiles/x'];
  const codes = (await Promise.all(escapes.map(rawGet))).map((r) => r.status);
  check('server refuses traversal out of the root and dot-directories sent as RAW requests (403/404, never 200)', codes.every(c => c === 403 || c === 404), codes);
  // '/../package.json' is normalised BY THE SERVER to '/package.json' inside the root: allowed to answer 200 only with the root's own file, never with a file from outside
  const dotdot = await rawGet('/../package.json');
  const own = (await import('node:fs')).readFileSync(new URL('../../../package.json', import.meta.url));
  check('a raw /../package.json is refused or answered with the ROOT\'s own package.json (never a file outside the root)', dotdot.status === 403 || dotdot.status === 404 || (dotdot.status === 200 && dotdot.body.equals(own)), { status: dotdot.status });
  check('control: the same file under its normal path IS served (the refusal above is not a dead server)', (await rawGet('/package.json')).status === 200);
}
