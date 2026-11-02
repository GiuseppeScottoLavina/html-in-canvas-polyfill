// PumpResult.quietUntil: set only when the pump started nothing, every drawable with damage waits for a known time and nothing else is in progress, so the
// scheduler may stop its frame loop until then (scheduler.test.mjs, "quiet wait"). The real runPump and DamageTracker with a fake host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPump, createPumpState } from '../../../src/snapshot/store/pump.js';
import { DamageTracker } from '../../../src/snapshot/store/damage.js';

const options = { maxDpr: 2.5, maxSnapshotFps: 60, maxSurfacePixels: 33554432, maxTotalSurfaceBytes: 536870912, inkMargin: 24, interactionFloorFps: 0, nodeBudget: { soft: 350, hard: 3000, absolute: 20000 } };
const BUDGET = { mainThreadMs: 4, mainThreadShare: 0.35, maxInFlight: 2, interaction: false };

/** a canvas with drawables over the hard node budget (built at most every 250 ms), the last build at t=1000, damaged again at t=1010 */
function setup({ busy = () => false, drawables = 1 } = {}) {
  const record = { id: 1, frameCap: 0, state: 'active', contentBox: { width: 100, height: 100, gridScaleX: 1, gridScaleY: 1 }, layer: { element: {}, isLaidOut: () => true, borderBoxSize: () => ({ width: 100, height: 100 }) } };
  const damage = new DamageTracker();
  const entries = Array.from({ length: drawables }, (_, i) => ({
    el: { i, localName: 'div', parentElement: null, matches: () => false }, record, incarnation: 0, surface: {}, geo: null, decoding: 0, costEma: 2, landRate: null, landDev: 0,
    lastNodes: 5000, lastTakeAt: 1000, firstTakeAt: 0, notBefore: 0, refused: false, lost: false, ovSeq: 0,
  }));
  let clock = 1010;
  for (const e of entries) damage.mark(e.el, { x: 0, y: 0, width: 10, height: 10 }, 'mutation', clock);
  let captures = 0;
  const deps = {
    damage, state: createPumpState(), inFlight: new Map(), jobs: new Set(), landed: [],
    host: { entries: () => entries, usedBytes: () => 0, translationOf: () => null, notLaidOut() {}, empty() {}, refuse() {}, reduced() {}, landed() {}, fail: (_j, e) => { throw e; }, ...(busy ? { busy } : {}) },
    capture: () => { captures++; return { url: 'data:image/svg+xml,test' }; },
    decode: () => new Promise(() => {}), resources: {}, interaction: () => ({}), maxPerDrawable: 1,
  };
  const pump = (at = clock) => { clock = at; return runPump({ options, window: { devicePixelRatio: 1 }, now: () => clock }, deps, at, BUDGET); };
  return { entries, deps, pump, captures: () => captures };
}

test('quietUntil: a drawable held by the node budget (next build at t=1250) and nothing else in progress', () => {
  const t = setup();
  const out = t.pump(1010);
  assert.equal(out.started, 0);
  assert.equal(out.moreWork, true);
  assert.equal(out.nextDueAt, 1250);
  assert.equal(out.quietUntil, 1250);
});

test('quietUntil (control): null while the host is busy or does not say, a build decodes, a result waits to be committed, or a drawable is skipped without a due time', () => {
  /** @type {Array<[string, (t: ReturnType<typeof setup>) => void, object?]>} */
  const cases = [
    ['host busy', () => {}, { busy: () => true }],
    ['host without busy()', () => {}, { busy: null }],
    ['a decode in flight', (t) => { t.deps.jobs.add({}); }],
    ['a split decode not started yet', (t) => { t.entries[1].decoding = 1; }, { drawables: 2 }],
    ['a landed result', (t) => { t.deps.landed.push({}); }],
    ['a refused drawable', (t) => { t.entries[1].refused = true; }, { drawables: 2 }],
    ['a drawable that is not laid out', (t) => { const el = t.entries[1].el; const laid = t.entries[0].record.layer.isLaidOut; t.entries[0].record.layer.isLaidOut = (e) => e !== el && laid(e); }, { drawables: 2 }],
  ];
  for (const [name, arrange, o] of cases) {
    const t = setup(o);
    arrange(t);
    const out = t.pump(1010);
    assert.equal(out.moreWork, true, name);
    assert.equal(out.quietUntil, null, name);
  }
});

test('quietUntil (control): null when a build started, and when nothing is pending', () => {
  const t = setup();
  const out = t.pump(1300);
  assert.equal(out.started, 1);
  assert.equal(out.quietUntil, null);
  assert.equal(t.captures(), 1);
  const idle = t.pump(1400);
  assert.equal(idle.moreWork, false);
  assert.equal(idle.quietUntil, null);
});
