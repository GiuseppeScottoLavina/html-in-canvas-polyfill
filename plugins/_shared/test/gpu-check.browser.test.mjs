// The browser test kit itself (gpu-check.mjs): spyMappers keeps the instance live.
import { test, assert } from '/test/unit/lib/t.js';
import { spyMappers } from '/plugins/_shared/gpu-check.mjs';

test('spyMappers records every mapper and does not freeze getters: a `continuous` that changes at runtime stays live', async () => {
  let animating = false;
  const plugin = {
    type: 'spy-probe', apiVersion: 2, version: 1,
    async create() {
      return {
        spatial: true,
        get continuous() { return animating; },
        frames: 0,
        render() { this.frames += 1; },
        captureInputMapper() { return (/** @type {any} */ p) => ({ x: p.x, y: p.y }); },
      };
    },
  };
  const { def, mappers } = spyMappers(plugin);
  const inst = await def.create(/** @type {any} */ ({}), {});
  assert.equal(inst.continuous, false);
  animating = true;
  assert.equal(inst.continuous, true, 'the getter is read through, not copied at create()');
  inst.render();
  assert.equal(inst.frames, 1, 'methods run with the instance as `this`');
  const m = inst.captureInputMapper({});
  assert.equal(mappers.length, 1);
  assert.equal(mappers[0], m);
});
