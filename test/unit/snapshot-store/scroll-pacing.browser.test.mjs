// Pacing of scroll damage (pump.js pumpRecord): a scroller's own scroll damage (with at most hover inside the scrolled box riding along) is held by the framecap and
// the cost bucket only; maxSnapshotFps and the node-budget interval still hold every other change. Controls: the same steps with a DOM change are held.
import { test, assert } from '/test/unit/lib/t.js';
import { makeRig, until } from './helpers.mjs';

const LIST = { x: 10, y: 10, width: 60, height: 40 };

/** Damage, pump, land, commit; returns whether a build started. */
async function step(rig, a, rect, cause) {
  const calls = rig.calls.length;
  rig.store.markDamage(a, rect, cause);
  rig.pump();
  const started = rig.calls.length > calls;
  if (started) { await until(() => rig.store.hasLanded(), 3000, 'the tile'); rig.store.commitLanded(); }
  return started;
}

for (const [what, options] of [['maxSnapshotFps 10', { maxSnapshotFps: 10 }], ['the node-budget interval', { maxSnapshotFps: 0, nodeBudget: { soft: 2, hard: 5, absolute: 1000 } }]]) {
  test(`scroll damage is built at once, back to back, under ${what}; a DOM change is held`, async (t) => {
    const rig = await makeRig(t, { options });
    const a = rig.add('a', 100, 60);
    await rig.build(a);
    assert.equal(await step(rig, a, LIST, 'scroll'), true, 'scroll right behind the first build');
    assert.equal(await step(rig, a, LIST, 'scroll'), true, 'and again');
    rig.store.markDamage(a, { x: 10, y: 20, width: 60, height: 8 }, 'hover');
    assert.equal(await step(rig, a, LIST, 'scroll'), true, 'with a hovered row inside the list riding along');
    assert.equal(await step(rig, a, LIST, 'mutation'), false, 'control: a DOM change right behind is held by the limit');
    assert.equal(await step(rig, a, LIST, 'scroll'), false, 'and scroll damage pending with it is held too');
  });
}

test('hover outside the scrolled box takes the limit back', async (t) => {
  const rig = await makeRig(t, { options: { maxSnapshotFps: 10 } });
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  assert.equal(await step(rig, a, LIST, 'mutation'), true);
  rig.store.markDamage(a, { x: 80, y: 20, width: 15, height: 8 }, 'hover');
  assert.equal(await step(rig, a, LIST, 'scroll'), false);
});

test('the framecap still holds scroll damage', async (t) => {
  const rig = await makeRig(t, { options: { maxSnapshotFps: 10 } });
  rig.record.frameCap = 10;
  const a = rig.add('a', 100, 60);
  await rig.build(a);
  assert.equal(await step(rig, a, LIST, 'mutation'), true);
  assert.equal(await step(rig, a, LIST, 'scroll'), false);
});
