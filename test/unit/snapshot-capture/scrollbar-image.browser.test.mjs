// WPT privacy/scrollbar-thumb-images-ignored: an author-styled scrollbar thumb with a background IMAGE (and a min-height) was drawn as a transparent box of the proportional
// length, so the same-origin green thumb was missing from the picture. The thumb overlay now carries the inlined image and the thumb's min-height.
// The unit runner hides scrollbars (no live gutter, so no overlay is painted at all): the two parts are tested here, the whole path by the WPT file
// (run with the platform scrollbars shown, test/wpt/lib/inventory.mjs `scrollbars`).
import { test, assert } from '/test/unit/lib/t.js';
import { barImage, verticalBar } from '/src/snapshot/capture/scroll-emulation.js';
import { makeEnv } from './_support.mjs';
import { createResourceCache } from '/src/snapshot/capture/inline-resources.js';

const RED = new URL('/test/unit/snapshot-capture/assets/red.svg', location.href).href;
const part = (image) => ({ backgroundImage: image, backgroundSize: 'auto', backgroundPosition: '0% 0%', backgroundRepeat: 'repeat', backgroundOrigin: 'padding-box', backgroundClip: 'border-box' });

test('the background image of a styled bar part is carried with its url inlined (pending while it loads)', async () => {
  const resources = createResourceCache(makeEnv().env);
  const res = { pending: false, failed: [] };
  const first = barImage(part(`url("${RED}")`), location.href, resources, res);
  assert.equal(res.pending, true, 'first use: still loading, the capture is incomplete');
  assert.ok(first.includes('url("data:,")'), 'never the network URL inside the SVG image');
  await resources.load(RED, 'svg');
  const done = { pending: false, failed: [] };
  const decl = barImage(part(`url("${RED}")`), location.href, resources, done);
  assert.equal(done.pending, false);
  assert.ok(/^background-image:url\("data:image\/svg\+xml/.test(decl), decl.slice(0, 80));
  assert.ok(decl.includes('background-repeat:repeat;') && decl.includes('background-position:0% 0%;'), decl);
  assert.equal(barImage(part('none'), location.href, resources, done), '', 'no image: nothing added');
});

test('a cross-origin bar image without CORS is refused: an empty image, listed as failed', async () => {
  const resources = createResourceCache(makeEnv().env);
  const url = 'https://not-a-real-host.invalid/red.png';
  barImage(part(`url("${url}")`), location.href, resources, { pending: false, failed: [] });
  await resources.load(url, 'image').catch(() => {});
  const res = { pending: false, failed: [] };
  const decl = barImage(part(`url("${url}")`), location.href, resources, res);
  assert.ok(decl.includes('url("data:,")'), decl);
  assert.equal(res.failed.length, 1);
});

test('a styled thumb is never shorter than its min-height, nor longer than the track', () => {
  // the WPT geometry: a 100 px scrollport over 200 px of content, thumb min-height 100 px
  assert.equal(verticalBar(100, 100, 200, true, false).thumbH, 50, 'proportional length without a min-height');
  assert.equal(verticalBar(100, 100, 200, true, false, 100).thumbH, 100);
  assert.equal(verticalBar(100, 100, 200, true, false, 400).thumbH, 100, 'clamped to the track');
  assert.equal(verticalBar(15, 100, 2000, true, false).thumbH, 20, 'engine default minimum kept');
});
