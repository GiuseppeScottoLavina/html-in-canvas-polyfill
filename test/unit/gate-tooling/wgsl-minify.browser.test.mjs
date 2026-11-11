// The WGSL a built plugin inlines compiles on a real WebGPU device as its source does: every shipped shader, from source and minified
// (scripts/wgsl-strip.mjs minifyWgsl), gives no compilation error and the same entry points. Skipped LOUDLY (test names start with
// "SKIPPED: no WebGPU") when the machine has none.
import { test, assert } from '/test/unit/lib/t.js';
import { gpuAvailable } from '/test/unit/gpu-effects/lib/rig.mjs';
import { minifyWgsl } from '/scripts/wgsl-strip.mjs';
import { WGSL_FILES } from './lib/wgsl-files.mjs';

const GPU = await gpuAvailable();
console.error(`wgsl minify tests: WebGPU ${GPU ? 'available' : 'NOT available'}`);
const gtest = (name, fn, opts) => (GPU ? test(name, fn, opts) : test.skip(`SKIPPED: no WebGPU - ${name}`, fn));

/** @param {GPUDevice} device @param {string} code @returns {Promise<string[]>} the error messages */
async function errorsOf(device, code) {
  const info = await device.createShaderModule({ code }).getCompilationInfo();
  return info.messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
}

/** the entry points, read from the attributes (`@vertex fn name`, ...) */
const entryPoints = (/** @type {string} */ code) => [...code.matchAll(/@(vertex|fragment|compute)\b[^{]*?\bfn\s*([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => `${m[1]} ${m[2]}`).sort();

gtest('every shipped shader compiles from source and minified, with the same entry points (control: a join that WGSL reads otherwise fails)', async () => {
  const device = await (await navigator.gpu.requestAdapter()).requestDevice();
  try {
    // control: the check sees the error a careless join makes (`let x` written `letx`, `a / *p` written `a/*p`)
    const ok = 'fn f(p: ptr<function, f32>) -> f32 { let x = 1.0; return x / *p; }';
    assert.deepEqual(await errorsOf(device, ok), []);
    assert.ok((await errorsOf(device, 'fn f(p:ptr<function,f32>)->f32{letx=1.0;return x/ *p;}')).length > 0, 'two words joined is an error');
    assert.ok((await errorsOf(device, 'fn f(p:ptr<function,f32>)->f32{let x=1.0;return x/*p;}')).length > 0, 'a joined comment start is an error');
    assert.equal(minifyWgsl(ok), 'fn f(p:ptr<function,f32>)->f32{let x=1.0;return x/ *p;}\n');
    assert.deepEqual(await errorsOf(device, minifyWgsl(ok)), []);
    let saved = 0;
    for (const file of WGSL_FILES) {
      const src = await (await fetch('/' + file)).text();
      const min = minifyWgsl(src);
      assert.deepEqual(await errorsOf(device, src), [], `${file} from source`);
      assert.deepEqual(await errorsOf(device, min), [], `${file} minified`);
      const entries = entryPoints(src);
      assert.ok(entries.length > 0, `${file}: has entry points`);
      assert.deepEqual(entryPoints(min), entries, `${file}: same entry points`);
      saved += src.length - min.length;
    }
    assert.ok(saved > 0, 'the minified shaders are smaller');
  } finally { device.destroy(); }
}, { timeout: 60000 });
