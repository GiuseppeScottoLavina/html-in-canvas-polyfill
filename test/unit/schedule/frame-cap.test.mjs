import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampFrameCap, createCapGate, effectiveFps, parseFrameCap } from '../../../src/schedule/frame-cap.js';

const HZ120 = 1000 / 120;

/** frames allowed by a gate over `seconds` of a display with period `dt`; `jitter` perturbs each timestamp deterministically */
function countAllowed(fps, { seconds = 3, dt = HZ120, jitter = 0, gate = createCapGate() } = {}) {
  let n = 0;
  for (let i = 0; i < Math.round((seconds * 1000) / dt); i++) {
    const wobble = jitter ? Math.sin(i * 12.9898) * jitter : 0;
    if (gate.allow(1, i * dt + wobble, fps)) n++;
  }
  return n;
}

test('G-fps-cap arithmetic: N in 10, 15, 30, 60, 120 stays within 0.9N..1.1N per second on a 120 Hz display', () => {
  for (const n of [10, 15, 30, 60, 120]) {
    const perSecond = countAllowed(n, { seconds: 3 }) / 3;
    assert.ok(perSecond >= 0.9 * n && perSecond <= 1.1 * n, `cap ${n}: ${perSecond} frames/s`);
  }
});

test('the cap holds under +-0.8 ms vsync jitter and on a 60 Hz display', () => {
  for (const n of [10, 15, 30, 60]) {
    const jittered = countAllowed(n, { seconds: 3, jitter: 0.8 }) / 3;
    assert.ok(jittered >= 0.9 * n && jittered <= 1.1 * n, `jitter cap ${n}: ${jittered}`);
  }
  assert.equal(Math.round(countAllowed(30, { seconds: 2, dt: 1000 / 60 }) / 2), 30);
});

test('a 60 fps cap on a 120 Hz display renders every SECOND rAF, not every 2.5th (the phase accumulator)', () => {
  const gate = createCapGate();
  const allowed = [];
  for (let i = 0; i < 12; i++) if (gate.allow(1, i * HZ120, 60)) allowed.push(i);
  assert.deepEqual(allowed, [0, 2, 4, 6, 8, 10]);
});

test('positive control: "now - last >= interval" gives 48 fps for a 60 fps cap on 144 Hz, which the accumulator must not', () => {
  const dt = 1000 / 144;
  let last = -Infinity;
  let naive = 0;
  for (let i = 0; i < 144; i++) {
    const now = i * dt;
    if (now - last >= 1000 / 60 - 1e-9) { last = now; naive++; }
  }
  assert.equal(naive, 48);
  const accumulated = countAllowed(60, { seconds: 1, dt });
  assert.ok(accumulated >= 54 && accumulated <= 66, `accumulator: ${accumulated}`);
});

test('uncapped (fps 0) allows every frame and forgets the phase', () => {
  const gate = createCapGate();
  assert.equal(countAllowed(0, { seconds: 1, gate }), 120);
  assert.equal(gate.nextDueAt(1), null);
});

test('a changed fps starts a new phase and allows at once (cap change effective within one frame)', () => {
  const gate = createCapGate();
  gate.allow(1, 0, 10);
  assert.equal(gate.allow(1, HZ120, 10), false);
  assert.equal(gate.allow(1, 2 * HZ120, 120), true);
  assert.equal(gate.allow(1, 3 * HZ120, 120), true);
});

test('lateness beyond two intervals resynchronises instead of bursting to catch up', () => {
  const gate = createCapGate();
  assert.equal(gate.allow(1, 0, 30), true);
  assert.equal(gate.allow(1, 500, 30), true);
  assert.equal(gate.allow(1, 500 + HZ120, 30), false);
  assert.equal(gate.nextDueAt(1) > 500 + HZ120, true);
});

test('canvases have independent phases; reset forgets one', () => {
  const gate = createCapGate();
  gate.allow(1, 0, 10);
  assert.equal(gate.allow(2, 1, 10), true);
  assert.equal(gate.allow(1, 1, 10), false);
  gate.reset(1);
  assert.equal(gate.allow(1, 2, 10), true);
});

test('effectiveFps: build rate is min(frameCap, maxSnapshotFps); the interaction floor only raises a finite cap', () => {
  const o = { interactionFloorFps: 0, maxSnapshotFps: 60 };
  assert.equal(effectiveFps(120, o, 'paint', false), 120);
  assert.equal(effectiveFps(120, o, 'build', false), 60);
  assert.equal(effectiveFps(0, o, 'build', false), 60);
  assert.equal(effectiveFps(0, o, 'paint', true), 0);
  assert.equal(effectiveFps(10, o, 'paint', true), 10, 'floor 0 = strict');
  const floor = { interactionFloorFps: 30, maxSnapshotFps: 0 };
  assert.equal(effectiveFps(10, floor, 'paint', true), 30);
  assert.equal(effectiveFps(10, floor, 'paint', false), 10);
  assert.equal(effectiveFps(0, floor, 'paint', true), 0, 'never turns an uncapped canvas into a capped one');
  assert.equal(effectiveFps(40, floor, 'paint', true), 40, 'never lowers a higher cap');
  assert.equal(effectiveFps(10, { interactionFloorFps: 30, maxSnapshotFps: 20 }, 'build', true), 20, 'maxSnapshotFps is a load guard the floor cannot lift');
});

test('parseFrameCap follows the HTML non-negative integer rules', () => {
  const d = 7;
  assert.equal(parseFrameCap(null, d), 7);
  assert.equal(parseFrameCap(undefined, d), 7);
  assert.equal(parseFrameCap('', d), 7);
  assert.equal(parseFrameCap('abc', d), 7);
  assert.equal(parseFrameCap('-5', d), 7);
  assert.equal(parseFrameCap('0', d), 0);
  assert.equal(parseFrameCap('30', d), 30);
  assert.equal(parseFrameCap(' 30', d), 30);
  assert.equal(parseFrameCap('+30', d), 30);
  assert.equal(parseFrameCap('30fps', d), 30);
  assert.equal(parseFrameCap('3.9', d), 3);
  assert.equal(parseFrameCap('9999', d), 240);
});

test('clampFrameCap: NaN/negative/0 uncapped, otherwise rounded into 1..240', () => {
  assert.equal(clampFrameCap(NaN), 0);
  assert.equal(clampFrameCap(-3), 0);
  assert.equal(clampFrameCap(0), 0);
  assert.equal(clampFrameCap(0.4), 0);
  assert.equal(clampFrameCap(0.6), 1);
  assert.equal(clampFrameCap(29.6), 30);
  assert.equal(clampFrameCap(1000), 240);
});
