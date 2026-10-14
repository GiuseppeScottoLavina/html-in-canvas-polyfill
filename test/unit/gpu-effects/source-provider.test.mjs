import test from 'node:test';
import assert from 'node:assert/strict';
import { createBus } from '../../../src/util/bus.js';
import { BUS } from '../../../src/contracts/events.js';
import { createStoreSourceProvider } from '../../../src/effects/source-provider.js';

/** Surface px = css px * scale; the version covers the whole drawable (no ink). */
function rig({ width = 200, height = 100, scale = 2 } = {}) {
  const bus = createBus();
  const source = { name: 'src' };
  const record = { id: 1 };
  let surface = { name: 'surface-1' };
  let version = null;
  const store = {
    version: () => version,
    rasterSource: (v, r) => {
      // clip to the drawable, scale to surface px
      const x0 = Math.max(0, r.sx), y0 = Math.max(0, r.sy), x1 = Math.min(v.width, r.sx + r.sw), y1 = Math.min(v.height, r.sy + r.sh);
      if (x1 <= x0 || y1 <= y0) return null;
      return { source: v.surface, sx: x0 * scale, sy: y0 * scale, sw: (x1 - x0) * scale, sh: (y1 - y0) * scale };
    },
  };
  const env = { bus, store };
  const provider = createStoreSourceProvider(env, record, source);
  const copies = [];
  const texture = { width: width * scale, height: height * scale };
  const device = { queue: { copyExternalImageToTexture: (src, dst, size) => copies.push({ origin: src.origin, dst: dst.origin, size: [...size], source: src.source }) } };
  let id = 0;
  return {
    provider, copies, texture, device, bus, record, source,
    /** commit a new version; `dirty` undefined = the store gave none */
    commit(dirty, { announce = true, newSurface = false } = {}) {
      if (newSurface) surface = { name: `surface-${id + 2}` };
      version = { id: ++id, element: new WeakRef(source), width, height, surface };
      if (dirty !== undefined) version.dirty = dirty;
      if (announce) bus.emit(BUS.SOURCE_VERSION, { record, version });
      return version;
    },
    upload(onlyDirty = true, tex = texture) { return provider.upload(device, tex, onlyDirty); },
  };
}

test('version() is null before the first commit, then the newest version id', () => {
  const r = rig();
  assert.equal(r.provider.version(), null);
  assert.equal(r.provider.size(), null);
  r.commit(null);
  assert.equal(r.provider.version(), 1);
  assert.deepEqual(r.provider.size(), { width: 400, height: 200, cssWidth: 200, cssHeight: 100 });
});

test('first upload is a full copy and returns the version', () => {
  const r = rig();
  r.commit({ x: 10, y: 10, width: 5, height: 5 });
  assert.equal(r.upload(), 1);
  assert.deepEqual(r.copies.at(-1).size, [400, 200]);
  assert.deepEqual(r.copies.at(-1).origin, { x: 0, y: 0 });
});

test('a later commit with a small dirty rect copies only that rect (+2 css px margin), at the same place in the texture', () => {
  const r = rig();
  r.commit(null); r.upload();
  r.commit({ x: 20, y: 30, width: 10, height: 6 });
  assert.equal(r.upload(), 2);
  const c = r.copies.at(-1);
  // grown by 2 css px each side -> x 18..32, y 28..38 -> surface px *2
  assert.deepEqual(c.origin, { x: 36, y: 56 });
  assert.deepEqual(c.dst, { x: 36, y: 56 });
  assert.deepEqual(c.size, [28, 20]);
});

test('dirty rects of skipped versions are unioned: nothing the host did not see is left stale', () => {
  const r = rig();
  r.commit(null); r.upload();
  r.commit({ x: 10, y: 10, width: 4, height: 4 });
  r.commit({ x: 100, y: 50, width: 4, height: 4 });
  assert.equal(r.upload(), 3);
  const c = r.copies.at(-1);
  assert.ok(c.origin.x <= 2 * 8 && c.origin.y <= 2 * 8, 'covers the first rect');
  assert.ok(c.origin.x + c.size[0] >= 2 * 106 && c.origin.y + c.size[1] >= 2 * 52, 'covers the second rect');
});

test('falls back to a FULL copy when: no dirty info, new surface, new texture, restore, unannounced version, too large, onlyDirty=false', () => {
  const r = rig();
  const full = () => assert.deepEqual(r.copies.at(-1).size, [400, 200]);
  r.commit(null); r.upload();
  r.commit(undefined); r.upload(); full(); // no `dirty` on the version
  r.commit({ x: 0, y: 0, width: 4, height: 4 }, { newSurface: true }); r.upload(); full(); // replaced backing store
  r.commit({ x: 0, y: 0, width: 4, height: 4 }); r.upload(true, { width: 400, height: 200 }); full(); // different texture
  r.commit({ x: 0, y: 0, width: 4, height: 4 }); r.upload(); full(); // back on the first texture: full once more
  r.commit({ x: 0, y: 0, width: 4, height: 4 }); r.upload(); // now partial again, to arm the next cases
  assert.ok(r.copies.at(-1).size[0] < 400);
  r.bus.emit(BUS.SURFACE_RESTORED, { record: r.record, element: r.source });
  r.commit({ x: 0, y: 0, width: 4, height: 4 }); r.upload(); full();
  r.commit({ x: 0, y: 0, width: 4, height: 4 }, { announce: false }); r.upload(); full(); // nobody announced it: dirty unknown
  r.commit({ x: 0, y: 0, width: 190, height: 90 }); r.upload(); full(); // > 60 % of the texture
  r.commit({ x: 0, y: 0, width: 4, height: 4 }); r.upload(false); full(); // caller asked for everything
});

test('a SURFACE_RESTORED for another element does not force a full copy', () => {
  const r = rig();
  r.commit(null); r.upload();
  r.bus.emit(BUS.SURFACE_RESTORED, { record: r.record, element: {} });
  r.commit({ x: 0, y: 0, width: 4, height: 4 }); r.upload();
  assert.ok(r.copies.at(-1).size[0] < 400);
});

test('a dirty rect outside the surface copies nothing but still reports the version', () => {
  const r = rig();
  r.commit(null); r.upload();
  const n = r.copies.length;
  r.commit({ x: 500, y: 500, width: 4, height: 4 });
  assert.equal(r.upload(), 2);
  assert.equal(r.copies.length, n);
});

test('events of other canvases or other elements are ignored; dispose unsubscribes', () => {
  const r = rig();
  r.commit(null); r.upload();
  r.bus.emit(BUS.SOURCE_VERSION, { record: { id: 99 }, version: { id: 50, element: new WeakRef(r.source), dirty: { x: 0, y: 0, width: 190, height: 90 } } });
  r.bus.emit(BUS.SOURCE_VERSION, { record: r.record, version: { id: 51, element: new WeakRef({}), dirty: { x: 0, y: 0, width: 190, height: 90 } } });
  r.commit({ x: 0, y: 0, width: 4, height: 4 });
  r.upload();
  assert.ok(r.copies.at(-1).size[0] < 400, 'foreign dirty rects did not widen the copy');
  r.provider.dispose();
  r.bus.emit(BUS.SOURCE_VERSION, { record: r.record, version: { id: 52, element: new WeakRef(r.source), dirty: null } });
});

test('upload returns 0 while the store has no version', () => {
  const r = rig();
  assert.equal(r.upload(), 0);
  assert.equal(r.copies.length, 0);
});
