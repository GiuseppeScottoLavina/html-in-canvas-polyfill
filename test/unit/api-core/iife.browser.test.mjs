import { test, assert, sleep } from '/test/unit/lib/t.js';

/** load src/iife.js as a module script in a fresh iframe, after an optional inline setup script; resolves with the frame window once __HIC__ exists */
async function loadEntry(/** @type {any} */ t, setup = '') {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  t.cleanup(() => frame.remove());
  const base = location.origin;
  frame.srcdoc = `<!doctype html><body><script>window.__warnings=[];window.__errors=[];const w=console.warn,e=console.error;console.warn=(...a)=>{__warnings.push(a.map(String).join(' '));};console.error=(...a)=>{__errors.push(a.map(String).join(' '));};addEventListener('error',ev=>__errors.push('uncaught '+ev.message));${setup}</script><base href="${base}/"><script type="module" src="${base}/src/iife.js"></script></body>`;
  const w = /** @type {any} */ (frame.contentWindow);
  for (let i = 0; i < 100 && !(w.__HIC__ || w.__errors?.length); i++) await sleep(20);
  return w;
}

test('auto-install on a supported browser: HicLivePolyfill exposed, installed synchronously, __HIC__.report() available', async t => {
  const w = await loadEntry(t);
  assert.equal(typeof w.HicLivePolyfill.install, 'function');
  assert.equal(typeof w.HicLivePolyfill.getInstalled, 'function');
  assert.equal(typeof w.HicLivePolyfill.version, 'string');
  assert.ok(Array.isArray(w.HicLivePolyfill.FEATURES));
  const real = w.__errors.filter((/** @type {string} */ e) => !/not implemented/.test(e)); // a module nobody wrote yet is reported by compose, by design
  assert.equal(real.length, 0, `no console.error / uncaught: ${real.join(' | ')}`);
  assert.ok(w.__HIC__.installed, 'installed');
  assert.equal(w.__HIC__.installed.mode, 'polyfill');
  assert.equal(w.HicLivePolyfill.getInstalled(w), w.__HIC__.installed);
  assert.equal(w.__HIC__.report().mode, 'polyfill');
  w.__HIC__.installed.uninstall();
});

test('auto-install on a refused browser: one console.warn, __HIC__.error set, nothing thrown', async t => {
  const ua = "Object.defineProperty(navigator,'userAgent',{get:()=>'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'});Object.defineProperty(navigator,'userAgentData',{get:()=>undefined});";
  const w = await loadEntry(t, ua);
  assert.equal(w.__errors.length, 0, `no error, no throw: ${w.__errors.join(' | ')}`);
  assert.equal(w.__warnings.length, 1, 'exactly one warning');
  assert.ok(/not installed \(browser\)/.test(w.__warnings[0]));
  assert.equal(w.__HIC__.error.feature, 'browser');
  assert.equal(w.__HIC__.installed, undefined);
  assert.equal(w.HicLivePolyfill.getInstalled(w), null);
  let thrown;
  try { w.HicLivePolyfill.install(); } catch (e) { thrown = e; }
  assert.equal(thrown?.feature, 'browser', 'an explicit install() keeps the loud throw');
});

test('N-04: after uninstall() + install(), __HIC__.installed and report() follow the live instance', async t => {
  const w = await loadEntry(t, '');
  const doc = w.document;
  doc.body.insertAdjacentHTML('beforeend', '<canvas id="c" content="drawable" width="50" height="30"><div drawable id="d">x</div></canvas>');
  const first = w.__HIC__.installed;
  first.uninstall();
  const second = w.HicLivePolyfill.install();
  assert.notEqual(second, first);
  assert.equal(w.HicLivePolyfill.getInstalled(w), second);
  assert.equal(w.__HIC__.installed, second, '__HIC__.installed is the live instance');
  assert.equal(w.__HIC__.report().canvases.length, 1, 'report() lists the canvas');
  assert.equal(w.__HIC__.report().canvases[0].drawables, 1);
  assert.equal(second.canvases()[0], doc.getElementById('c'));
  second.uninstall();
});

test('N-06: a layoutsubtree attribute that is in the markup at install time warns once too', async t => {
  const w = await loadEntry(t, `document.body.insertAdjacentHTML('beforeend','<canvas layoutsubtree width="40" height="20"><div id="x">a</div></canvas><canvas layoutsubtree width="40" height="20"></canvas>');`);
  const legacy = w.__warnings.filter((/** @type {string} */ m) => /layoutsubtree/.test(m));
  assert.equal(legacy.length, 1, `exactly one deprecation warning: ${w.__warnings.join(' | ')}`);
  assert.ok(JSON.stringify(w.__HIC__.report()).includes('layoutsubtree-legacy'), 'the report has the deviation');
  w.__HIC__.installed.uninstall();
});
