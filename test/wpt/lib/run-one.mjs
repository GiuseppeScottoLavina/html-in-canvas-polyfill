// Run ONE vendored WPT test file in a Session tab and reduce it to a plain result record:
//   {status, message, subtests:[{name,status,message}], ms, detail?}
// testharness: the per-subtest results come from test/wpt/lib/report.js (window.__WPT); reftest: two screenshots and the
// harness pixel comparison with the test's own `<meta name=fuzzy>`; crashtest: loads and settles without a renderer crash.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sleep } from '../../harness/lib/util.mjs';
import { decodePng, encodePng } from '../../harness/lib/png.mjs';
import { compareImages, pixelStats } from '../../harness/lib/pixels.mjs';
import { VIEWPORT } from './session.mjs';

const SUB = ['PASS', 'FAIL', 'TIMEOUT', 'NOTRUN', 'PRECONDITION_FAILED'];
const HARNESS = ['OK', 'ERROR', 'TIMEOUT', 'PRECONDITION_FAILED'];

const result = (status, message, subtests = [], extra = {}) => ({ status, message: message ? String(message).slice(0, 400) : '', subtests, ...extra });

async function load(session, url, { waitLoad = true, timeout = 20000 } = {}) {
  await session.blank();
  const { page } = session;
  const loaded = waitLoad ? page.conn.waitFor('Page.loadEventFired', { sessionId: page.sessionId, timeout }) : null;
  loaded?.catch(() => {});
  const r = await page.send('Page.navigate', { url });
  if (r.errorText) throw new Error('navigate failed: ' + r.errorText);
  if (loaded) await loaded;
}

export async function runTestharness(session, origin, test) {
  const { page } = session; const t0 = Date.now(); const limit = (test.long ? 60000 : 10000) + 6000;
  await load(session, origin + test.path, { waitLoad: false });
  let snap = null;
  while (Date.now() - t0 < limit) {
    if (session.crashed) return result('CRASH', 'renderer crashed', [], { ms: Date.now() - t0 });
    snap = await page.evaluate(`(location.pathname === ${JSON.stringify(test.path.split("?")[0])} && window.__WPT) ? JSON.stringify(window.__WPT) : ''`, { timeout: 8000 }).catch(e => (/stuck|did not answer/.test(e.message) ? 'STUCK' : ''));
    if (snap === 'STUCK') return result('CRASH', 'renderer stuck (CDP unanswered)', [], { ms: Date.now() - t0, stuck: true });
    if (snap && JSON.parse(snap).done) break;
    await sleep(60);
  }
  const R = snap ? JSON.parse(snap) : null;
  const subtests = (R?.tests ?? []).map(s => ({ name: s.name, status: SUB[s.status] ?? String(s.status), message: s.message }));
  const ms = Date.now() - t0;
  if (!R) return result('NOHARNESS', page.errors().map(e => e.text).slice(0, 2).join(' | ') || 'testharness did not start', subtests, { ms });
  if (!R.done) return result('RUNNER_TIMEOUT', 'no completion callback in ' + limit + ' ms', subtests, { ms });
  return result(HARNESS[R.harnessStatus] ?? String(R.harnessStatus), R.harnessMessage, subtests, { ms });
}

async function settle(session, timeout = 5000) {
  const { page } = session; const t0 = Date.now();
  for (;;) {
    if (session.crashed) throw Object.assign(new Error('renderer crashed'), { crash: true });
    const st = await page.evaluate(`document.readyState === 'complete' && !document.documentElement.classList.contains('reftest-wait')`, { timeout: 8000 }).catch(() => false);
    if (st) break;
    if (Date.now() - t0 > timeout) throw Object.assign(new Error('reftest-wait never cleared'), { timeout: true });
    await sleep(40);
  }
  await page.evaluate(`document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))`, { timeout: 8000 }).catch(() => {});
}

async function shoot(session, url) {
  await load(session, url);
  await settle(session);
  const png = await session.page.screenshot({ clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height } });
  return { png, img: decodePng(png) };
}

function fuzzyFor(test, refHref) {
  const f = test.fuzzy.find(x => x.ref && refHref.endsWith(x.ref)) ?? test.fuzzy.find(x => !x.ref);
  return f ?? { maxDifference: [0, 0], totalPixels: [0, 0] };
}

function judge(cmp, fuzzy, rel) {
  if (!cmp.sizeMatch) return { same: false, why: 'size ' + JSON.stringify(cmp.sizes) };
  const okMax = cmp.maxDiff >= fuzzy.maxDifference[0] && cmp.maxDiff <= fuzzy.maxDifference[1];
  const okTot = cmp.diffPixels >= fuzzy.totalPixels[0] && cmp.diffPixels <= fuzzy.totalPixels[1];
  const same = cmp.diffPixels === 0 || (okMax && okTot);
  return { same, why: `diffPixels=${cmp.diffPixels} maxDiff=${cmp.maxDiff} allowed max ${fuzzy.maxDifference} pixels ${fuzzy.totalPixels}` };
}

/** The first uncaught exceptions / console errors of the page, appended to a failure message so a triage has something to read. */
function pageErrors(session) {
  const errs = session.page.errors({ includeWarnings: false }).map(e => e.text).filter(Boolean).slice(0, 2);
  return errs.length ? ` [page: ${errs.join(' | ').slice(0, 300)}]` : '';
}

export async function runReftest(session, origin, test, { shotDir } = {}) {
  const t0 = Date.now(); const verdicts = [];
  try {
    const subject = await shoot(session, origin + test.path);
    for (const ref of test.refs) {
      const r = await shoot(session, origin + ref.href);
      const cmp = compareImages(subject.img, r.img, { diffImage: !!shotDir });
      const j = judge(cmp, fuzzyFor(test, ref.href), ref.rel);
      const ok = ref.rel === 'match' ? j.same : !j.same;
      verdicts.push({ ref: ref.href, rel: ref.rel, ok, why: j.why, refBlank: !pixelStats(r.img).nonBlank });
      if (!ok && shotDir) {
        mkdirSync(shotDir, { recursive: true });
        writeFileSync(`${shotDir}/test.png`, subject.png); writeFileSync(`${shotDir}/ref.png`, r.png);
        if (cmp.diffImage) writeFileSync(`${shotDir}/diff.png`, encodePng(cmp.diffImage));
      }
    }
  } catch (e) {
    const status = e.crash ? 'CRASH' : e.timeout ? 'TIMEOUT' : /stuck|did not answer/.test(e.message) ? 'CRASH' : 'ERROR';
    const why = `${e.message}${pageErrors(session)}`;
    return result(status, why, [{ name: 'reftest', status: 'FAIL', message: why }], { ms: Date.now() - t0 });
  }
  const ok = verdicts.length > 0 && verdicts.every(v => v.ok);
  const why = verdicts.map(v => `${v.rel} ${v.ok ? 'ok' : 'FAIL'}: ${v.why}`).join('; ');
  return result(ok ? 'OK' : 'FAIL', why, [{ name: 'reftest', status: ok ? 'PASS' : 'FAIL', message: why }], { ms: Date.now() - t0, verdicts, blank: verdicts.some(v => v.refBlank) });
}

export async function runCrashtest(session, origin, test) {
  const t0 = Date.now();
  try { await load(session, origin + test.path); await settle(session); await sleep(300); await session.page.evaluate('1', { timeout: 8000 }); }
  catch (e) {
    const crash = e.crash || /stuck|did not answer/.test(e.message);
    return result(crash ? 'CRASH' : 'TIMEOUT', e.message, [{ name: 'crashtest', status: 'FAIL', message: e.message }], { ms: Date.now() - t0 });
  }
  if (session.crashed) return result('CRASH', 'renderer crashed', [{ name: 'crashtest', status: 'FAIL', message: 'crash' }], { ms: Date.now() - t0 });
  return result('OK', '', [{ name: 'crashtest', status: 'PASS', message: '' }], { ms: Date.now() - t0 });
}

export function runOne(session, origin, test, opts) {
  if (test.type === 'testharness') return runTestharness(session, origin, test);
  if (test.type === 'reftest') return runReftest(session, origin, test, opts);
  return runCrashtest(session, origin, test);
}

/** Pass = harness OK and every subtest PASS (and at least one subtest). */
export const filePasses = r => r.status === 'OK' && r.subtests.length > 0 && r.subtests.every(s => s.status === 'PASS');
export { dirname };
