import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAnimatedImages, sniffAnimated } from '../../../src/schedule/observers/animated-images.js';

const vendor = (p) => new Uint8Array(readFileSync(new URL(`../../vendor/wpt/${p}`, import.meta.url)));
const bytes = (...parts) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

// a 1x1 GIF: header, logical screen with a 2-colour table, one graphic control extension and one image
const GIF_HEAD = bytes('GIF89a', [1, 0, 1, 0, 0x80, 0, 0], [255, 0, 0, 0, 0, 0]);
const GIF_FRAME = bytes([0x21, 0xf9, 4, 0, 10, 0, 0, 0], [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0], [2, 2, 0x44, 0x01, 0]);
const gif = (frames) => bytes([...GIF_HEAD], ...Array.from({ length: frames }, () => [...GIF_FRAME]), [0x3b]);
const chunk = (type, data = []) => [...u32(data.length), ...bytes(type), ...data, 0, 0, 0, 0];
const png = (...chunks) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], ...chunks);
const IHDR = chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const webp = (flags) => bytes('RIFF', [30, 0, 0, 0], 'WEBPVP8X', [10, 0, 0, 0, flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const ftyp = (major, ...compatible) => bytes(u32(16 + 4 * compatible.length), 'ftyp', major, [0, 0, 0, 0], ...compatible);

test('GIF: two images or more are an animation, one is not (the WPT image rgb100.gif has three)', () => {
  assert.equal(sniffAnimated(vendor('html/canvas/element/manual/draw-element-image/resources/rgb100.gif')), true);
  assert.equal(sniffAnimated(gif(1)), false);
  assert.equal(sniffAnimated(gif(2)), true);
  // a global colour table and a local one are skipped, extension sub-blocks are walked
  const local = bytes([...GIF_HEAD], [0x21, 0xfe, 3, 0x61, 0x62, 0x63, 0], [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x80], [0, 0, 0, 255, 255, 255], [2, 2, 0x44, 0x01, 0], [...GIF_FRAME], [0x3b]);
  assert.equal(sniffAnimated(local), true);
});

test('GIF: bytes that end inside the first image answer null (more bytes are needed), never a guess', () => {
  const two = gif(2);
  assert.equal(sniffAnimated(two.subarray(0, GIF_HEAD.length + 12)), null);
  assert.equal(sniffAnimated(two.subarray(0, 8)), null);
});

test('APNG: an acTL chunk with more than one frame before IDAT; a plain PNG, a one-frame acTL or acTL after IDAT are not animated', () => {
  assert.equal(sniffAnimated(vendor('images/blue.png')), false);
  assert.equal(sniffAnimated(png(IHDR, chunk('acTL', [...u32(3), ...u32(0)]), chunk('IDAT', [1]))), true);
  assert.equal(sniffAnimated(png(IHDR, chunk('acTL', [...u32(1), ...u32(0)]), chunk('IDAT', [1]))), false);
  assert.equal(sniffAnimated(png(IHDR, chunk('IDAT', [1]), chunk('acTL', [...u32(3), ...u32(0)]))), false);
  assert.equal(sniffAnimated(png(IHDR)), null, 'no IDAT yet: unknown');
});

test('WebP: the animation flag of VP8X; AVIF: the image-sequence brand avis', () => {
  assert.equal(sniffAnimated(webp(0x02)), true);
  assert.equal(sniffAnimated(webp(0x10)), false, 'alpha only');
  assert.equal(sniffAnimated(bytes('RIFF', [30, 0, 0, 0], 'WEBPVP8 ', [0, 0, 0, 0, 0, 0, 0, 0, 0])), false, 'a simple lossy WebP');
  assert.equal(sniffAnimated(ftyp('avif', 'mif1', 'avis')), true);
  assert.equal(sniffAnimated(ftyp('avif', 'mif1', 'miaf')), false);
  assert.equal(sniffAnimated(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>')), false);
});

// The frame cache under budget pressure: the real player with stand-in ImageDecoder, OffscreenCanvas and FileReader, a virtual clock, and encoded frames of 4 Mi
// characters (the budget, 24 Mi characters, holds five of them). Every image has three frames of 200 ms and loops.
const BUDGET_CHARS = 24 * 1024 * 1024;
const FRAME_CHARS = 4 * 1024 * 1024;
const SOURCE = `data:image/gif;base64,${Buffer.from(gif(3)).toString('base64')}`;

function rig() {
  let now = 0;
  let timerIds = 0;
  const timers = new Map();
  const stats = { encodes: 0 };
  class Decoder {
    static async isTypeSupported() { return true; }
    constructor() {
      this.tracks = { ready: Promise.resolve(), selectedTrack: { animated: true, frameCount: 3, repetitionCount: Infinity } };
      this.completed = Promise.resolve();
    }
    async decode({ frameIndex }) { return { image: { displayWidth: 64, displayHeight: 64, duration: 200_000, frameIndex, close() {} } }; }
    close() {}
  }
  class Canvas {
    getContext() { return { drawImage: (image) => { this.image = image; } }; }
    async convertToBlob() { stats.encodes++; return { frameIndex: this.image.frameIndex }; }
  }
  class Reader {
    readAsDataURL(blob) {
      const head = `data:image/png;base64,F${blob.frameIndex}#${stats.encodes}:`;
      this.result = head + 'A'.repeat(FRAME_CHARS - head.length);
      this.onload();
    }
  }
  const env = {
    now: () => now,
    window: {
      ImageDecoder: Decoder, OffscreenCanvas: Canvas, FileReader: Reader,
      setTimeout(fn, ms) { const id = ++timerIds; timers.set(id, { fn, at: now + ms }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    reporter: { deviation() {} },
  };
  const player = createAnimatedImages(env);
  player.addViewer({ contains: (img) => img.isConnected, visible: () => true, intervalMs: () => 0, damage() {} });
  const settle = () => new Promise((r) => setImmediate(r));
  return {
    player, stats,
    settle,
    /** moves the clock by ms, firing every timer due on the way, in order */
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

/** @param {string} url @returns {string} the frame index an encoded frame was made from, 'source' for the image itself */
const shown = (url) => (url === SOURCE ? 'source' : url.slice(url.indexOf(',') + 2, url.indexOf('#')));

test('frame cache churn: images used and removed in turn never fall back to the source, and released frames make room (3 encodes each)', async () => {
  const r = rig();
  for (let i = 0; i < 10; i++) {
    const img = { isConnected: true };
    const abs = `https://x.test/a${i}.gif`;
    assert.equal(r.player.frameUrl(img, abs, SOURCE), SOURCE, 'the first frame is the image itself');
    await r.settle();
    const before = r.stats.encodes;
    await r.advance(200);
    assert.equal(shown(r.player.frameUrl(img, abs, SOURCE)), '1', `image ${i}: the frame due at 200 ms`);
    await r.advance(200);
    assert.equal(shown(r.player.frameUrl(img, abs, SOURCE)), '2', `image ${i}: the frame due at 400 ms`);
    assert.equal(r.stats.encodes - before, 3, `image ${i}: frames 1 and 2, and frame 0 ready for the next boundary`);
    img.isConnected = false;
    r.player.wake();
    await r.settle();
  }
  // the released images keep frames only as the budget allows, the most recent first: the first image's frame 0 is gone, the last one's is cached
  const first = r.player.frameUrl({ isConnected: true }, 'https://x.test/a0.gif', SOURCE);
  const last = r.player.frameUrl({ isConnected: true }, 'https://x.test/a9.gif', SOURCE);
  assert.equal(shown(first), 'source', 'the oldest released frames were evicted');
  assert.equal(shown(last), '0', 'the newest released frame is still cached');
  r.player.dispose();
});

test('frame cache: a frame shown by a live image is never evicted, even over budget; the frame becoming current is not evicted on arrival', async () => {
  const r = rig();
  // seven live images, each showing an encoded frame: 7 x 4 Mi > 24 Mi, every shown frame stays (positive control of the protection)
  const live = Array.from({ length: 7 }, (_, i) => ({ img: { isConnected: true }, abs: `https://x.test/l${i}.gif` }));
  for (const { img, abs } of live) r.player.frameUrl(img, abs, SOURCE);
  await r.settle();
  await r.advance(200);
  for (const [i, { img, abs }] of live.entries()) assert.equal(shown(r.player.frameUrl(img, abs, SOURCE)), '1', `live image ${i} shows frame 1 at 200 ms`);
  assert.ok(live.length * FRAME_CHARS > BUDGET_CHARS, 'the shown frames alone exceed the budget');
  // the next boundary: every image's new frame arrives while the cache is full of shown frames, and must be the one the capture gets
  await r.advance(200);
  for (const [i, { img, abs }] of live.entries()) assert.equal(shown(r.player.frameUrl(img, abs, SOURCE)), '2', `live image ${i} shows frame 2 at 400 ms`);
  await r.advance(200);
  for (const [i, { img, abs }] of live.entries()) assert.equal(shown(r.player.frameUrl(img, abs, SOURCE)), '0', `live image ${i} loops to frame 0 at 600 ms`);
  r.player.dispose();
});
