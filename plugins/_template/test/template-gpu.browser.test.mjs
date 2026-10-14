// The template's input mapper against the pixels the GPU produced (plugins/_shared/gpu-check.mjs). Every spatial plugin needs this test.
import { assert } from '/test/unit/lib/t.js';
import { checkMapperAgainstGpu, gpuTest } from '/plugins/_shared/gpu-check.mjs';
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
