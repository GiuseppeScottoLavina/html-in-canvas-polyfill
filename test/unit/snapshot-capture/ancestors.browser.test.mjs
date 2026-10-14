// Review fixes M1 (ancestor-dependent CSS and custom properties), M5 (:link / UA link look), m2 (indeterminate checkbox), m4 (no inline-style CSP violation).
import { test, assert } from '/test/unit/lib/t.js';
import { createCapture } from '/src/snapshot/capture/capture.js';
import { mount, rasterize, inkFraction } from './_support.mjs';

/** @param {CanvasRenderingContext2D} x @param {number} px @param {number} py @returns {number[]} rgba */
const pixel = (x, px, py) => [...x.getImageData(px, py, 1, 1).data];
const near = (got, want, tol = 6) => got.slice(0, 3).every((v, i) => Math.abs(v - want[i]) <= tol);
const tile = async (m, el = m.layerEl.firstElementChild, over = {}) => rasterize(m.capture(m.request(el, over)));

test('M1: a rule that names ancestors of the canvas (class chain, child combinator) styles the clone', async (t) => {
  const css = '.card{width:80px;height:40px}.app.theme-dark > .holder .card{background:rgb(0,0,255)}';
  const m = mount('<div class="card" drawable></div>', { css });
  m.host.className = 'app theme-dark';
  const inner = document.createElement('div');
  inner.className = 'holder';
  m.host.replaceChildren(...m.host.childNodes);
  inner.append(m.canvas);
  m.host.prepend(inner);
  const got = await tile(m);
  assert.ok(near(pixel(got, 40, 20), [0, 0, 255]), `ancestor rule not applied: ${pixel(got, 40, 20)}`);
  t.cleanup(() => inner.remove());
});

test('M1 control: without the matching ancestor classes the same rule does not apply', async () => {
  const css = '.card{width:80px;height:40px;background:rgb(255,255,255)}.app.theme-dark > .holder .card{background:rgb(0,0,255)}';
  const m = mount('<div class="card" drawable></div>', { css });
  const got = await tile(m);
  assert.ok(near(pixel(got, 40, 20), [255, 255, 255]));
});

test('M1: custom properties set above the canvas (inline on a wrapper, or by a rule that cannot match inside the clone) reach the clone', async () => {
  const css = '.card{width:80px;height:40px}.a{background:var(--wrap-bg)}.b{background:var(--has-bg)}.w:has(> .sibling) { --has-bg: rgb(0,200,0) }';
  const m = mount('<div class="a card" drawable></div><div class="b card" drawable style="margin-top:50px"></div>', { css });
  m.host.className = 'w';
  m.host.style.setProperty('--wrap-bg', 'rgb(255,0,0)');
  m.host.insertAdjacentHTML('beforeend', '<i class="sibling"></i>');
  const [a, b] = m.layerEl.children;
  assert.ok(near(pixel(await tile(m, a), 40, 20), [255, 0, 0]), 'inline custom property of a wrapper');
  assert.ok(near(pixel(await tile(m, b), 40, 20), [0, 200, 0]), 'custom property of a :has() rule (sibling stub absent in the clone)');
});

test('M1: ancestors become attribute-only display:contents shells above the canvas shell; html and body stay collapsed', () => {
  const m = mount('<div class="card" drawable>x</div>', { css: '.card{width:80px;height:40px}' });
  m.host.className = 'outer';
  m.host.setAttribute('data-mode', 'dark');
  m.host.setAttribute('onclick', 'alert(1)');
  const svg = decodeURIComponent(m.capture(m.request(m.layerEl.firstElementChild)).url.split(',').slice(1).join(','));
  assert.ok(/<div[^>]*class="outer"[^>]*data-hic-shell/.test(svg) && /data-mode="dark"/.test(svg), 'the wrapper shell carries class and attributes');
  assert.ok(!svg.includes('onclick'));
  assert.ok(svg.indexOf('class="outer"') < svg.indexOf('data-hic-root'), 'the chain wraps the canvas shell');
  assert.equal((svg.match(/<body/g) ?? []).length, 0);
});

test('M5: :link and :any-link rules match anchors with href in the clone, anchors without href do not', async () => {
  const css = 'a{display:block;width:60px;height:20px}a:link{background:rgb(0,255,0)}a.any:any-link{background:rgb(255,0,255)}';
  const m = mount('<div class="s" drawable><a href="#x">l</a><a class="any" href="#y">a</a><a>n</a></div>', { css });
  const got = await tile(m);
  assert.ok(near(pixel(got, 55, 10), [0, 255, 0]), 'a:link applied to the first link');
  assert.ok(near(pixel(got, 55, 30), [255, 0, 255]), 'a.any:any-link (more specific) wins on the second link');
  assert.ok(!near(pixel(got, 55, 50), [0, 255, 0]) && !near(pixel(got, 55, 50), [255, 0, 255]), 'an anchor without href is not a link');
});

test('M5: an unstyled link looks like the browser draws it (blue, underlined) and author colour still wins', async () => {
  const m = mount('<div class="s" drawable style="font:20px sans-serif"><a href="#x">link link link</a><br><a href="#y" style="color:rgb(200,0,0)">red red red</a></div>', { css: '.s{width:200px;height:60px}' });
  const got = await tile(m);
  const { data } = got.getImageData(0, 0, 200, 30);
  let blue = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] < 60 && data[i + 1] < 60 && data[i + 2] > 180) blue++;
  assert.ok(blue > 80, `blue link pixels: ${blue}`);
  const red = got.getImageData(0, 30, 200, 30).data;
  let r = 0;
  let b = 0;
  for (let i = 0; i < red.length; i += 4) { if (red[i] > 150 && red[i + 1] < 60) r++; if (red[i] < 60 && red[i + 1] < 60 && red[i + 2] > 180) b++; }
  assert.ok(r > 80 && b === 0, `author colour wins: red ${r} blue ${b}`);
});

test('m2: an indeterminate checkbox is drawn filled with a white dash; a plain one is not', async () => {
  const html = '<div class="s" drawable><input type="checkbox" id="i"> <input type="checkbox" id="p"></div>';
  const m = mount(html, { css: '.s{width:80px;height:30px;font:14px sans-serif}input{margin:4px}' });
  const live = m.layerEl.querySelector('#i');
  const first = live.getBoundingClientRect();
  const base = m.layerEl.getBoundingClientRect();
  const cx = Math.round(first.left - base.left + 6);
  const cy = Math.round(first.top - base.top + 6);
  const plain = await tile(m);
  assert.ok(!near(pixel(plain, cx - 4, cy), [0, 117, 255], 30), 'control: no fill before the state is set');
  live.indeterminate = true;
  const got = await tile(m);
  assert.ok(near(pixel(got, cx - 4, cy), [0, 117, 255], 30), `accent fill at the box: ${pixel(got, cx - 4, cy)}`);
  assert.ok(near(pixel(got, cx, cy), [255, 255, 255], 30), `white dash in the middle: ${pixel(got, cx, cy)}`);
  assert.ok(inkFraction(got) > 0.01);
});

test('m4: under style-src without unsafe-inline a capture raises no CSP violation (inline styles go through the CSSOM) and still paints', async (t) => {
  const html = '<div class="s" drawable style="background:#eee"><span hidden>h</span><textarea rows="2" style="overflow:auto">a\nb\nc\nd\ne</textarea><input type="checkbox" id="i"><a href="#">l</a>'
    + '<div class="sc" style="height:30px;overflow:auto"><p>1</p><p>2</p><p>3</p><p>4</p></div><iframe></iframe></div>';
  const m = mount(html, { css: '.s{width:200px;height:200px}.sc{height:30px;overflow:auto}' });
  m.layerEl.querySelector('#i').indeterminate = true;
  m.layerEl.querySelector('.sc').scrollTop = 20;
  const meta = document.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = "style-src 'self'";
  document.head.append(meta);
  t.cleanup(() => meta.remove());
  const violations = [];
  const on = (e) => { if (e.sourceFile.includes('/src/snapshot/')) violations.push(`${e.violatedDirective} ${e.sourceFile}:${e.lineNumber}`); };
  document.addEventListener('securitypolicyviolation', on);
  t.cleanup(() => document.removeEventListener('securitypolicyviolation', on));
  const strict = createCapture(m.env); // the inert document is created under the policy
  const r = strict(m.request(m.layerEl.firstElementChild));
  await new Promise((ok) => setTimeout(ok, 50));
  assert.deepEqual(violations, [], `CSP violations: ${violations.join(' | ')}`);
  assert.ok(inkFraction(await rasterize(r)) > 0.05);
  // control: the old way of writing the attribute is reported by this very setup
  const control = [];
  const seen = (e) => control.push(e.violatedDirective);
  document.addEventListener('securitypolicyviolation', seen);
  t.cleanup(() => document.removeEventListener('securitypolicyviolation', seen));
  document.implementation.createHTMLDocument('').body.setAttribute('style', 'color:red');
  await new Promise((ok) => setTimeout(ok, 50));
  assert.ok(control.includes('style-src-attr'), 'positive control: setAttribute("style") is a violation under this policy');
});

test('m1: <video controls> is reported as video-controls (limited) once per element; a video without controls is not', () => {
  const m = mount('<div class="s" drawable><video id="v" controls width="80" height="40"></video><video id="n" width="80" height="40"></video></div>', { css: '.s{width:200px;height:100px}' });
  const r = m.capture(m.request(m.layerEl.firstElementChild));
  const hits = r.unsupported.filter((u) => u.feature === 'video-controls');
  assert.equal(hits.length, 1);
  assert.ok(hits[0].path.includes('video#v'), hits[0].path);
  assert.equal(m.reported.filter((e) => e.feature === 'video-controls').length, 1, 'the reporter got it');
});
