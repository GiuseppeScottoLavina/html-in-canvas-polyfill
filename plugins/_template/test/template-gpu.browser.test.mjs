// The template's input mapper against the pixels the GPU produced (plugins/_shared/gpu-check.mjs). Every spatial plugin needs this test.
import { assert } from '/test/unit/lib/t.js';
import { changedPixels, checkMapperAgainstGpu, gpuTest, runActionOnGpu } from '/plugins/_shared/gpu-check.mjs';
import { plugin } from '/plugins/_template/index.js';

gpuTest('the mapper predicts every presented pixel; the identity mapper does not (positive control)', async (t) => {
  const v = await checkMapperAgainstGpu(t, plugin, { offset: 30 });
  assert.ok(v.ok, v.why);
});

gpuTest('offset 0 is the identity on the GPU too', async (t) => {
  const v = await checkMapperAgainstGpu(t, plugin, { offset: 0 }, { minIdentityWrong: 0 });
  assert.ok(v.ok, v.why);
  assert.ok(v.identity.wrong <= 5, `identity wrong on ${v.identity.wrong} px`);
});

gpuTest('the action shift through the effect handle: the frame that resolves it shows the new offset and agrees with its mapper', async (t) => {
  const r = await runActionOnGpu(t, plugin, { offset: 0 }, 'shift', { offset: 30 }, { checkEvery: 1 });
  assert.equal(r.state, 'still');
  assert.ok(r.frames <= 2, `one frame shows it: ${r.frames}`);
  assert.ok(changedPixels(r.last, r.first) > 200, 'the picture moved');
  assert.ok(r.worst !== null && r.worst.wrong <= 5, `the mapper of that frame is wrong on ${r.worst?.wrong} px`);
});
