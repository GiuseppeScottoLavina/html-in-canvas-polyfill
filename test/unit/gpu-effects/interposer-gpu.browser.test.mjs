// The input interposer validated against the pixels the GPU really produced: every click lands on a pixel that the GPU screenshot shows
// as part of the intended control. Events are synthetic (page-side); the trusted-input variant is gate G-interposer-gpu.
import { test, assert } from '/test/unit/lib/t.js';
import { gpuAvailable, makeRig } from './lib/rig.mjs';
import { createEffectHost } from '/src/effects/effect-host.js';
import { WaterEffectPlugin } from '/src/effects/water/water-plugin.js';

const GPU = await gpuAvailable();
console.error(`interposer-gpu tests: WebGPU ${GPU ? 'available' : 'NOT available'}`);
const gtest = (name, fn, opts) => (GPU ? test(name, fn, opts) : test.skip(`SKIPPED: no WebGPU - ${name}`, fn));

const W = 480, H = 320;
const CONTROLS = [
  { id: 'a', x: 60, y: 50, w: 70, h: 20, drop: [0, -12], html: (r) => `<button data-id="a" style="${r};cursor:pointer;margin:0;padding:0">A</button>` },
  { id: 'chk', x: 200, y: 52, w: 16, h: 16, drop: [0, -12], html: (r) => `<input data-id="chk" type="checkbox" style="${r};margin:0">` },
  { id: 'txt', x: 60, y: 140, w: 120, h: 20, drop: [0, -12], html: (r) => `<input data-id="txt" type="text" value="hello world, a long line of text" style="${r};margin:0;box-sizing:border-box;font:14px monospace;padding:2px">` },
  { id: 'rng', x: 250, y: 142, w: 120, h: 16, drop: [0, -12], html: (r) => `<input data-id="rng" type="range" min="0" max="100" value="50" style="${r};margin:0;padding:0">` },
  { id: 'b', x: 60, y: 230, w: 70, h: 20, drop: null, html: (r) => `<button data-id="b" style="${r};margin:0;padding:0">B</button>` },
];
/** the water ring (radius = age * 0.18 of the canvas height) crosses the top and bottom edge of the controls that carry a drop */
const RING_AGE_MS = 156;
const PER_CONTROL = 8; // 5 controls x 8 = 40 presses

/** What the browser does on mousedown when pointerdown was not cancelled (synthetic events have no default actions): focus + caret. */
function nativeMouseDown(target, cx, cy) {
  const ctl = target.closest('button,input,textarea,select,[tabindex]');
  if (!ctl) { document.activeElement?.blur?.(); return; }
  ctl.focus();
  if (ctl.localName === 'input' && ctl.type === 'text') {
    const hit = document.caretPositionFromPoint(cx, cy);
    if (hit?.offsetNode === ctl) ctl.setSelectionRange(hit.offset, hit.offset);
  }
}

const rectStyle = (c) => `position:absolute;left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px`;
const paintOnly = (list) => (ctx) => { ctx.fillStyle = '#fff'; for (const c of list) ctx.fillRect(c.x, c.y, c.w, c.h); };

async function scene(t, { interposer, touch = false }) {
  const rig = makeRig({ w: W, h: H, html: CONTROLS.map((c) => c.html(rectStyle(c))).join(''), paint: paintOnly(CONTROLS) });
  rig.commit();
  const host = await createEffectHost(rig.env, rig.deps, rig.canvas, rig.source, { interposer });
  t.cleanup(() => host.destroy());
  await host.addPlugin(WaterEffectPlugin, { intensity: 1 });
  const rect = rig.canvas.getBoundingClientRect();
  for (const c of CONTROLS.filter((k) => k.drop)) rig.layerEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.left + c.x + c.w / 2 + c.drop[0], clientY: rect.top + c.y + c.h / 2 + c.drop[1] }));
  const T = performance.now() + RING_AGE_MS;
  // one GPU screenshot per control with ONLY that control's pixels in the source: where its drawn pixels really are
  const masks = new Map();
  for (const c of CONTROLS) {
    rig.commit(null, paintOnly([c]));
    rig.tick(T);
    const img = rig.snap();
    const bright = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i += 1) bright[i] = img.data[i * 4] > 110 ? 1 : 0;
    masks.set(c.id, bright);
  }
  rig.commit(null, paintOnly(CONTROLS));
  rig.tick(T);
  const el = (id) => rig.layerEl.querySelector(`[data-id="${id}"]`);
  const state = { clicks: [], pointerType: touch ? 'touch' : 'mouse' };
  rig.layerEl.addEventListener('click', (e) => state.clicks.push(e.target.closest('[data-id]')?.dataset.id ?? 'none'));
  const api = {
    rig, host, masks, el, state,
    /** drawn pixels of control `id`, one pixel inside the mask edge, scanning order */
    pixelsOf(id) {
      const m = masks.get(id);
      const out = [];
      for (let y = 2; y < H - 2; y += 1) for (let x = 2; x < W - 2; x += 1) {
        const k = y * W + x;
        if (m[k] && m[k - 1] && m[k + 1] && m[k - W] && m[k + W]) out.push([x, y]);
      }
      return out;
    },
    fire(type, x, y, init = {}) {
      const r = rig.canvas.getBoundingClientRect();
      const cx = r.left + x, cy = r.top + y;
      const target = document.elementFromPoint(cx, cy) ?? rig.layerEl;
      const base = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy };
      if (type === 'click') target.dispatchEvent(new MouseEvent('click', { ...base, detail: 1 }));
      else {
        const ev = new PointerEvent(type, { ...base, pointerId: 1, pointerType: state.pointerType, isPrimary: true, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, ...init });
        target.dispatchEvent(ev);
        if (type === 'pointerdown' && !ev.defaultPrevented) nativeMouseDown(target, cx, cy);
      }
      return target;
    },
    /** a full press: move, down, up, and the click the browser still sends to the natively hit element */
    press(x, y) {
      api.reset();
      api.fire('pointermove', x, y);
      const native = api.fire('pointerdown', x, y);
      api.fire('pointerup', x, y);
      api.fire('click', x, y);
      return native;
    },
    /** which control the press operated: the control that received an unswallowed click, else the focused one */
    activated() {
      if (state.clicks.length) return state.clicks.join('+');
      const a = document.activeElement;
      return a?.dataset?.id ?? 'none';
    },
    reset() {
      state.clicks.length = 0;
      document.activeElement?.blur?.();
      /** @type {HTMLInputElement} */ (el('chk')).checked = false;
      /** @type {HTMLInputElement} */ (el('rng')).value = '50';
    },
  };
  return api;
}

/** no bright pixel of `mask` within `r` px (square window) */
function farFromBright(mask, x, y, r) {
  for (let j = Math.max(0, y - r); j <= Math.min(H - 1, y + r); j += 1) for (let i = Math.max(0, x - r); i <= Math.min(W - 1, x + r); i += 1) if (mask[j * W + i]) return false;
  return true;
}

/**
 * Drawn pixels of control `id` split by what the NATIVE hit test says about them: `moved` = the pixel lies outside the control's own
 * source rect (the browser would hit something else there), `stayed` = inside it. Both come from the GPU masks plus the known layout.
 */
function strata(s, id) {
  const c = CONTROLS.find((k) => k.id === id);
  const moved = [], stayed = [];
  for (const p of s.pixelsOf(id)) {
    const inside = p[0] >= c.x && p[0] < c.x + c.w && p[1] >= c.y && p[1] < c.y + c.h;
    (inside ? stayed : moved).push(p);
  }
  return { moved, stayed };
}

async function campaign(s) {
  let total = 0, right = 0, nativeWrong = 0;
  const misses = [];
  for (const c of CONTROLS) {
    const { moved, stayed } = strata(s, c.id);
    console.error(`${c.id}: drawn ${moved.length + stayed.length} (moved ${moved.length})`);
    assert.ok(moved.length + stayed.length > 100, `the GPU shows control ${c.id}`);
    if (c.drop) assert.ok(moved.length >= 8, `control ${c.id} is displaced on the GPU (${moved.length} drawn pixels outside its own rect)`);
    for (let k = 0; k < PER_CONTROL; k += 1) {
      // half the presses on pixels the browser would hit something else at, half on the rest of the control
      const list = k % 2 === 0 && moved.length ? moved : stayed.length ? stayed : moved;
      const [x, y] = list[Math.floor(((Math.floor(k / 2) + 0.5) * list.length) / (PER_CONTROL / 2))];
      const native = s.press(x, y);
      total += 1;
      if (s.activated() === c.id) right += 1; else misses.push(`${c.id}@${x},${y}->${s.activated()}`);
      if (native.closest('[data-id]')?.dataset.id !== c.id) nativeWrong += 1;
    }
  }
  return { total, right, nativeWrong, misses };
}

gtest('clicks on pixels the GPU drew for a control activate THAT control (>= 95 %); mouse', async (t) => {
  const s = await scene(t, { interposer: true });
  const r = await campaign(s);
  console.error(`interposer ON : ${r.right}/${r.total} intended; native hit was a different element for ${r.nativeWrong}/${r.total}; misses: ${r.misses.join(' ') || 'none'}`);
  assert.ok(r.nativeWrong / r.total >= 0.1, `the scene really displaces controls from under their drawn pixels (${r.nativeWrong}/${r.total})`);
  assert.ok(r.right / r.total >= 0.95, `${r.right}/${r.total}`);
  assert.ok(s.host.stats().remapped > 0);
});

gtest('positive control: with the interposer OFF at least 10 % of the same clicks activate a different control', async (t) => {
  const s = await scene(t, { interposer: false });
  const r = await campaign(s);
  console.error(`interposer OFF: ${r.right}/${r.total} intended (${r.total - r.right} wrong)`);
  assert.ok((r.total - r.right) / r.total >= 0.1, `${r.total - r.right} wrong of ${r.total}`);
  assert.equal(s.host.stats().remapped, 0);
});

gtest('touch gestures (implicit capture on the natively hit element) are re-targeted the same way', async (t) => {
  const s = await scene(t, { interposer: true, touch: true });
  const r = await campaign(s);
  console.error(`touch ON      : ${r.right}/${r.total} intended; misses: ${r.misses.join(' ') || 'none'}`);
  assert.ok(r.right / r.total >= 0.95, `${r.right}/${r.total}`);
});

gtest('the checkbox toggles exactly once, on the drawn control, and the natively hit control is not clicked', async (t) => {
  const s = await scene(t, { interposer: true });
  const px = s.pixelsOf('chk');
  let wrongNative = 0;
  for (let k = 0; k < 8; k += 1) {
    const [x, y] = px[Math.floor(((k + 0.5) * px.length) / 8)];
    const native = s.press(x, y);
    assert.equal(s.el('chk').checked, true, `toggled at ${x},${y}`);
    assert.deepEqual(s.state.clicks, ['chk'], 'one click, on the checkbox');
    if (native.dataset?.id !== 'chk') wrongNative += 1;
  }
  assert.ok(wrongNative >= 1, 'at least one of these presses had a different native target (so the swallow was exercised)');
});

gtest('hover and the layer cursor follow the MAPPED control, not the native pointer', async (t) => {
  const s = await scene(t, { interposer: true });
  let checked = 0;
  for (const id of ['a', 'txt', 'rng']) {
    const px = s.pixelsOf(id);
    for (const k of [0, Math.floor(px.length / 2), px.length - 1]) {
      s.fire('pointermove', ...px[k]);
      const mapped = s.rig.tracker.mapped.at(-1);
      assert.equal(mapped?.closest('[data-id]')?.dataset.id, id, `mapped target at ${px[k]}`);
      assert.equal(s.rig.layerEl.style.cursor, getComputedStyle(mapped).cursor);
      checked += 1;
    }
  }
  assert.equal(getComputedStyle(s.el('a')).cursor, 'pointer');
  assert.equal(checked, 9);
  s.rig.layerEl.dispatchEvent(new PointerEvent('pointerleave'));
  assert.equal(s.rig.tracker.mapped.at(-1), null, 'leaving the layer hands hover back to the native pointer');
  assert.equal(s.rig.layerEl.style.cursor, '');
});

gtest('range drag: the value follows the drawn track on every pointermove, input per change, one change at the end', async (t) => {
  const s = await scene(t, { interposer: true });
  const range = s.el('rng');
  const px = s.pixelsOf('rng');
  const midRow = px.map((p) => p[1]).sort((a, b) => a - b)[Math.floor(px.length / 2)];
  const row = px.filter((p) => p[1] === midRow).sort((a, b) => a[0] - b[0]);
  assert.ok(row.length > 100);
  const events = [];
  range.addEventListener('input', () => events.push(['input', range.value]));
  range.addEventListener('change', () => events.push(['change', range.value]));
  s.reset();
  s.fire('pointermove', ...row[0]);
  s.fire('pointerdown', ...row[0]);
  const values = [Number(range.value)];
  const STEPS = 8;
  for (let k = 1; k <= STEPS; k += 1) {
    s.fire('pointermove', ...row[Math.floor((k / STEPS) * (row.length - 1))]);
    values.push(Number(range.value));
  }
  s.fire('pointerup', ...row[row.length - 1]);
  s.fire('click', ...row[row.length - 1]);
  console.error(`range drag values: ${values.join(' ')}`);
  assert.ok(values[0] <= 12, `the left end of the drawn track is near the minimum, got ${values[0]}`);
  assert.ok(values.at(-1) >= 88, `the right end is near the maximum, got ${values.at(-1)}`);
  for (let i = 1; i < values.length; i += 1) assert.ok(values[i] > values[i - 1], `strictly increasing on every move: ${values}`);
  assert.equal(events.filter((e) => e[0] === 'input').length >= STEPS, true, 'an input event per move');
  assert.equal(events.filter((e) => e[0] === 'change').length, 1, 'exactly one change, at the end');
  assert.equal(s.state.clicks.length, 0, 'the native click was swallowed');
  assert.equal(document.activeElement, range);
});

gtest('text input: focus lands on the drawn field and the caret follows the drawn x', async (t) => {
  const s = await scene(t, { interposer: true });
  const input = s.el('txt');
  const px = s.pixelsOf('txt');
  const midRow = px.map((p) => p[1]).sort((a, b) => a - b)[Math.floor(px.length / 2)];
  const row = px.filter((p) => p[1] === midRow).sort((a, b) => a[0] - b[0]);
  const offsets = [];
  for (const f of [0.02, 0.5, 0.98]) {
    s.press(...row[Math.floor(f * (row.length - 1))]);
    assert.equal(document.activeElement, input);
    assert.equal(input.selectionStart, input.selectionEnd, 'collapsed caret');
    offsets.push(input.selectionStart);
  }
  console.error(`caret offsets across the drawn field: ${offsets.join(' ')} (value length ${input.value.length})`);
  assert.ok(offsets[0] <= 2 && offsets[1] > offsets[0] && offsets[2] > offsets[1], `monotonic with x: ${offsets}`);
});

gtest('destroying the host removes the interposer: pointer events pass through again', async (t) => {
  const s = await scene(t, { interposer: true });
  s.host.destroy();
  const px = s.pixelsOf('a');
  const before = s.rig.tracker.mapped.length;
  s.fire('pointermove', ...px[0]);
  assert.equal(s.rig.tracker.mapped.length, before, 'no longer following');
  assert.equal(s.rig.layerEl.style.cursor, '');
});
