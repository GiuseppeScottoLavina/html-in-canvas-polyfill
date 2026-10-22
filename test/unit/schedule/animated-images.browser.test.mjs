// Animated images inside a drawable: the frame due on the polyfill's clock, a damage per frame (WPT animated-gif: one paint per frame), nothing for still images,
// nothing while the canvas cannot be seen, nothing faster than the build rate of the canvas.
import { test, assert, sleep } from '/test/unit/lib/t.js';
import { createRig } from './_dom.js';
import { createAnimatedImages, observeAnimatedImages } from '/src/schedule/observers/animated-images.js';

// rgb100.gif: three 100x100 frames (red, green 0,153,0, blue), 200 ms each, looped forever (NETSCAPE2.0 extension)
const GIF = '/test/vendor/wpt/html/canvas/element/manual/draw-element-image/resources/rgb100.gif';
const STILL = '/test/vendor/wpt/images/blue.png';
const PAGE = '<div drawable id="d" style="width:100px"><img id="i" width="100" height="100"></div>';

/** @param {string} url @param {(b: Uint8Array) => Uint8Array} [edit] @returns {Promise<string>} the bytes as a base64 data: URL, as the resource cache inlines them */
async function inline(url, edit = (b) => b) {
  const bytes = edit(new Uint8Array(await (await fetch(url)).arrayBuffer()));
  let bin = '';
  for (const c of bytes) bin += String.fromCharCode(c);
  return `data:${url.endsWith('.gif') ? 'image/gif' : 'image/png'};base64,${btoa(bin)}`;
}

/** @param {Uint8Array} b @param {number} n @returns {number} offset of the n-th graphic control extension (21 F9 04), the start of the n-th frame */
function gce(b, n) {
  for (let i = 0, k = 0; i + 2 < b.length; i++) if (b[i] === 0x21 && b[i + 1] === 0xf9 && b[i + 2] === 4 && ++k === n) return i;
  throw new Error('no such frame');
}

/** @param {string} dataUrl @returns {Promise<number[]>} the pixel at (25, 25) */
async function pixel(dataUrl) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = new OffscreenCanvas(100, 100);
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d'));
  ctx.drawImage(img, 0, 0);
  return [...ctx.getImageData(25, 25, 1, 1).data];
}

/** @param {object} [opts] */
function setup(opts) {
  const rig = createRig({ html: PAGE, ...opts });
  const player = createAnimatedImages(rig.env);
  rig.env.animatedImages = player;
  const img = /** @type {HTMLImageElement} */ (rig.layerEl.querySelector('#i'));
  return { rig, player, img };
}

const COLOURS = { '255,0,0,255': 'red', '0,153,0,255': 'green', '0,0,255,255': 'blue' };

test('an animated GIF: one damage per frame of the image (200 ms), cause animation, and the capture gets the frame due: red, green, blue, red', async (t) => {
  const { rig, player, img } = setup();
  t.cleanup(() => player.dispose());
  t.cleanup(observeAnimatedImages(rig.env, rig.record));
  const source = await inline(GIF);
  assert.equal(player.frameUrl(img, 'https://x.test/rgb100.gif', source), source, 'the first frame is the image itself');
  /** @type {string[]} */
  const seen = [];
  const t0 = performance.now();
  let last = '';
  while (performance.now() - t0 < 900) {
    const url = player.frameUrl(img, 'https://x.test/rgb100.gif', source);
    if (url !== last) { last = url; seen.push(COLOURS[/** @type {keyof COLOURS} */ ((await pixel(url)).join(','))] ?? 'other'); }
    await sleep(20);
  }
  assert.deepEqual(seen.slice(0, 4), ['red', 'green', 'blue', 'red'], `frames in order: ${seen}`);
  const n = rig.sink.damage.length;
  assert.ok(n >= 3 && n <= 5, `a damage per frame change (4 in 0.9 s): ${n}`);
  assert.ok(rig.sink.damage.every((d) => d.cause === 'animation' && d.drawable.id === 'd'), 'cause animation, in its drawable');
  assert.ok(rig.sink.damage.slice(1).every((d) => d.rect && d.rect.width <= 100 + 2 * 24 + 1), 'after the first sighting, the reach of the image (its box and the ink margin), not the whole drawable');
});

test('positive control: a still image (PNG) or a one-image GIF is never played: the capture gets its bytes, nothing is damaged, no decoder runs', async (t) => {
  const { rig, player, img } = setup();
  t.cleanup(() => player.dispose());
  t.cleanup(observeAnimatedImages(rig.env, rig.record));
  const still = await inline(STILL);
  // rgb100.gif cut after its first image (header, extensions, one image, trailer)
  const one = await inline(GIF, (b) => Uint8Array.from([...b.subarray(0, gce(b, 2)), 0x3b]));
  assert.equal(player.frameUrl(img, 'https://x.test/blue.png', still), still);
  await sleep(500);
  assert.equal(player.frameUrl(img, 'https://x.test/one.gif', one), one);
  await sleep(500);
  assert.equal(player.frameUrl(img, 'https://x.test/one.gif', one), one);
  assert.equal(rig.sink.damage.length, 0);
});

test('a GIF without a loop count plays once: three frames, then the last one stays and nothing is damaged', async (t) => {
  const { rig, player, img } = setup();
  t.cleanup(() => player.dispose());
  t.cleanup(observeAnimatedImages(rig.env, rig.record));
  // remove the NETSCAPE2.0 application extension (19 bytes: 21 FF 0B 'NETSCAPE2.0' 03 01 lo hi 00)
  const once = await inline(GIF, (b) => { const at = gce(b, 1) - 19; assert.equal(b[at + 1], 0xff, 'the NETSCAPE2.0 extension comes before the first frame'); return Uint8Array.from([...b.subarray(0, at), ...b.subarray(at + 19)]); });
  player.frameUrl(img, 'https://x.test/once.gif', once);
  await sleep(1000);
  assert.equal(rig.sink.damage.length, 2, 'green, then blue');
  assert.equal(COLOURS[/** @type {keyof COLOURS} */ ((await pixel(player.frameUrl(img, 'https://x.test/once.gif', once))).join(','))], 'blue');
});

test('the frame cap of the canvas bounds the frame rate: at 2 fps a 5 fps image changes at most every 500 ms (frames are skipped, the clock is kept)', async (t) => {
  const { rig, player, img } = setup();
  rig.record.frameCap = 2;
  t.cleanup(() => player.dispose());
  t.cleanup(observeAnimatedImages(rig.env, rig.record));
  player.frameUrl(img, 'https://x.test/rgb100.gif', await inline(GIF));
  const times = [];
  const t0 = performance.now();
  while (performance.now() - t0 < 1700) {
    const n = rig.sink.damage.length;
    await sleep(10);
    if (rig.sink.damage.length > n) times.push(performance.now());
  }
  assert.ok(times.length >= 2 && times.length <= 4, `about 3 frames in 1.7 s: ${times.length}`);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 480, `gap ${times[i] - times[i - 1]} ms`);
});

test('a canvas out of view pauses the image (no decode, no damage) and plays it again when it comes back', async (t) => {
  const { rig, player, img } = setup({ canvasStyle: 'width:200px;height:100px;position:fixed;left:0;top:30000px' });
  t.cleanup(() => player.dispose());
  t.cleanup(observeAnimatedImages(rig.env, rig.record));
  player.frameUrl(img, 'https://x.test/rgb100.gif', await inline(GIF));
  await sleep(800);
  assert.equal(rig.sink.damage.length, 0, 'out of view: paused');
  rig.canvas.style.top = '0px';
  await sleep(800);
  assert.ok(rig.sink.damage.length >= 2, `in view: played (${rig.sink.damage.length})`);
});

test('an image that left the layer stops its clock', async (t) => {
  const { rig, player, img } = setup();
  t.cleanup(() => player.dispose());
  t.cleanup(observeAnimatedImages(rig.env, rig.record));
  player.frameUrl(img, 'https://x.test/rgb100.gif', await inline(GIF));
  await sleep(500);
  assert.ok(rig.sink.damage.length >= 1);
  img.remove();
  await sleep(250);
  rig.sink.clear();
  await sleep(600);
  assert.equal(rig.sink.damage.length, 0, 'no image shows it: stopped');
});
