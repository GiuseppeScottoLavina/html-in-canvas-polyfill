import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sniffAnimated } from '../../../src/schedule/observers/animated-images.js';

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
