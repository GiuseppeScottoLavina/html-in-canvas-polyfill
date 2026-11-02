// runPump across canvases: the canvas whose damage is oldest starts first, so a canvas whose build uses up the round's main-thread time cannot defer the others
// for ever (review of 0.1.0-preview.18: two always-dirty canvases at 4.1 ms per build built 120 / 0 times in 120 rounds, by registration order).
// The real runPump and DamageTracker, a controlled clock and capture cost. Not a timing benchmark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPump, createPumpState } from '../../../src/snapshot/store/pump.js';
import { DamageTracker } from '../../../src/snapshot/store/damage.js';

const options = { maxDpr: 2.5, maxSnapshotFps: 60, maxSurfacePixels: 33554432, maxTotalSurfaceBytes: 536870912, inkMargin: 24, interactionFloorFps: 0, nodeBudget: { soft: 350, hard: 3000, absolute: 20000 } };
const BUDGET = { mainThreadMs: 4, mainThreadShare: 0.35, maxInFlight: 2, interaction: false };
let ids = 0;

/** a warm canvas (one measured build) with `n` drawables */
function canvas(name, n = 1, frameCap = 0) {
  const record = {
    id: ++ids, name, frameCap, state: 'active',
    contentBox: { width: 100, height: 100, gridScaleX: 1, gridScaleY: 1 },
    layer: { element: {}, isLaidOut: () => true, borderBoxSize: () => ({ width: 100, height: 100 }) },
  };
  const entries = [];
  for (let i = 0; i < n; i++) {
    const el = { name: `${name}${i}`, localName: 'div', parentElement: null, matches: () => false };
    entries.push({ el, record, incarnation: 0, surface: {}, geo: null, decoding: 0, costEma: 4.1, landRate: null, landDev: 0, lastNodes: 1, lastTakeAt: 0, firstTakeAt: 0, notBefore: 0, refused: false, lost: false, ovSeq: 0 });
  }
  return { record, entries };
}

/**
 * `rounds` pumps at `hz`; every drawable is damaged before every pump (an animation; `mark` decides how). Returns the rounds in which each canvas started a build, and the batch of every build.
 * @param {Array<{record: any, entries: any[]}>} canvases @param {{rounds?: number, hz?: number, cost?: number}} [o]
 */
async function drive(canvases, { rounds = 120, hz = 60, cost = 4.1, budget = BUDGET, mark = (e, damage, t) => damage.mark(e.el, { x: 0, y: 0, width: 10, height: 10 }, 'mutation', t) } = {}) {
  let clock = 0;
  const damage = new DamageTracker();
  const built = new Map(canvases.map((c) => [c.record.name, /** @type {number[]} */ ([])]));
  /** @type {Array<{el: string, batch: number, round: number}>} */
  const batches = [];
  let round = 0;
  const all = canvases.flatMap((c) => c.entries);
  for (const e of all) e.costEma = cost;
  const deps = {
    damage, state: createPumpState(), inFlight: new Map(), jobs: new Set(), landed: [],
    host: {
      entries: () => all, usedBytes: () => 0, translationOf: () => null, notLaidOut() {}, empty() {}, refuse() {}, reduced() {},
      landed: (l) => { damage.committed(l.entry.el, l.generation); batches.push({ el: l.entry.el.name, batch: l.batch, round: l.round }); },
      fail: (_job, error) => { throw error; },
    },
    capture: (request) => {
      const list = built.get(request.record.name);
      if (list.at(-1) !== round) list.push(round);
      clock += cost;
      return { url: 'data:image/svg+xml,test' };
    },
    decode: async () => ({}), resources: {}, interaction: () => ({}), maxPerDrawable: 1,
  };
  for (round = 0; round < rounds; round++) {
    clock = round * 1000 / hz;
    for (const e of all) mark(e, damage, clock, round);
    runPump({ options, window: { devicePixelRatio: 1 }, now: () => clock }, deps, clock, budget);
    for (const j of deps.jobs) j.round ??= round;
    await new Promise((r) => setImmediate(r));
  }
  return { built, batches };
}

/** the longest run of rounds without a build start, from the first round */
function longestWait(rounds, total) {
  let worst = 0, last = -1;
  for (const r of [...rounds, total]) { worst = Math.max(worst, r - last - 1); last = r; }
  return worst;
}

test('pump fairness: two always-dirty canvases whose builds each use up the round (4.1 ms of 4) take turns, in either registration order; neither waits more than one round', async () => {
  for (const reverse of [false, true]) {
    const a = canvas('A'), b = canvas('B');
    const { built } = await drive(reverse ? [b, a] : [a, b]);
    for (const name of ['A', 'B']) {
      const rounds = built.get(name);
      assert.ok(rounds.length >= 55, `${name} built in ${rounds.length} of 120 rounds (reverse=${reverse}; main: 120 / 0)`);
      assert.ok(longestWait(rounds, 120) <= 1, `${name} waited ${longestWait(rounds, 120)} rounds in a row (reverse=${reverse})`);
    }
  }
});

test('pump fairness: three such canvases each start a build at least every third round', async () => {
  const cs = [canvas('A'), canvas('B'), canvas('C')];
  const { built } = await drive(cs);
  for (const name of ['A', 'B', 'C']) assert.ok(longestWait(built.get(name), 120) <= 2, `${name} waited ${longestWait(built.get(name), 120)} rounds in a row`);
});

test('pump fairness (control): cheap builds of two canvases both start in every round, and the builds of one canvas in a round share a batch', async () => {
  const a = canvas('A', 2), b = canvas('B', 2);
  const { built, batches } = await drive([a, b], { cost: 0.5, rounds: 30 });
  assert.equal(built.get('A').length, 30);
  assert.equal(built.get('B').length, 30);
  for (const name of ['A', 'B']) {
    for (let r = 0; r < 30; r++) {
      const mine = batches.filter((x) => x.round === r && x.el.startsWith(name));
      assert.equal(mine.length, 2, `round ${r}: both drawables of ${name} built`);
      assert.equal(new Set(mine.map((x) => x.batch)).size, 1, `round ${r}: one batch per canvas`);
    }
  }
  const ab = batches.filter((x) => x.round === 3);
  assert.notEqual(ab.find((x) => x.el === 'A0').batch, ab.find((x) => x.el === 'B0').batch, 'canvases have batches of their own');
});

test('pump fairness (control): the frame cap of a canvas still paces it while it goes first', async () => {
  const a = canvas('A', 1, 20), b = canvas('B');
  const { built } = await drive([a, b], { cost: 0.5, rounds: 120 });
  assert.ok(built.get('A').length <= 42 && built.get('A').length >= 38, `A capped at 20 fps: ${built.get('A').length} builds in 2 s`);
  assert.equal(built.get('B').length, 120);
});

test('pump fairness (control): a pump inside an input task builds the canvas with the input first, even when another canvas has older damage that uses up the round', async () => {
  for (const cause of ['active', 'focus', 'input']) {
    for (const reverse of [false, true]) {
      const a = canvas('A'), b = canvas('B');
      // A animates (damaged in every round, older damage once B goes first); B gets input damage in the odd rounds only
      const mark = (e, damage, t, round) => {
        if (e.record.name === 'A') damage.mark(e.el, { x: 0, y: 0, width: 10, height: 10 }, 'animation', t - 5);
        else if (round % 2) damage.mark(e.el, { x: 0, y: 0, width: 10, height: 10 }, cause, t);
      };
      const { built } = await drive(reverse ? [b, a] : [a, b], { rounds: 40, mark, budget: { ...BUDGET, urgent: true } });
      const odd = Array.from({ length: 20 }, (_, i) => 2 * i + 1);
      assert.deepEqual(built.get('B'), odd, `${cause} (reverse=${reverse}): B built in the round of its input`);
    }
  }
});
