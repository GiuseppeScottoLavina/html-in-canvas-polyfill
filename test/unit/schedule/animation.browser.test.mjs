import { test, assert, frames, microtasks } from '/test/unit/lib/t.js';
import { createRig } from './_dom.js';
import { installAnimationHooks, observeAnimations } from '/src/schedule/observers/animation-observer.js';
import { createPatchLedger } from '/src/api/patch.js';

const PAGE = '<div drawable id="d" style="width:200px"><div id="a" style="width:40px;height:20px;background:#0af">x</div><div id="still">y</div></div>';
const runHooks = (rig, info = { frameCap: 0, due: true }) => { let keep = false; for (const hook of [...rig.sink.hooks]) if (hook(performance.now(), info) === true) keep = true; return keep; };

test('a running Web Animation installs a frame hook, damages its target now and on every due tick, and removes the hook after a final damage', async t => {
  const rig = createRig({ html: PAGE });
  const el = rig.layerEl.querySelector('#a');
  const anim = el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(60px)' }], { duration: 100000 });
  t.cleanup(() => anim.cancel());
  t.cleanup(observeAnimations(rig.env, rig.record));
  assert.equal(rig.sink.hooks.size, 1);
  assert.deepEqual(rig.sink.causes(), ['animation']);
  assert.equal(rig.sink.damage[0].drawable.id, 'd');
  rig.sink.clear();
  assert.equal(runHooks(rig), true, 'keeps ticking while running');
  assert.equal(rig.sink.damage.length, 1);
  rig.sink.clear();
  assert.equal(runHooks(rig, { frameCap: 30, due: false }), true, 'a skipped frame costs nothing and keeps the loop');
  assert.equal(rig.sink.damage.length, 0);
  anim.finish();
  await frames(1);
  rig.sink.clear();
  assert.equal(runHooks(rig), false, 'nothing runs any more');
  assert.equal(rig.sink.damage.length, 1, 'the final state is damaged once');
  assert.equal(rig.sink.hooks.size, 0);
  assert.equal(runHooks(rig), false);
  assert.equal(rig.sink.damage.length, 1);
});

test('CSS animation and transition events start the loop', async t => {
  const style = document.createElement('style');
  style.textContent = '@keyframes hic-move{to{margin-left:30px}} .go{animation:hic-move 2s linear infinite} #still{transition:margin-left 2s linear}';
  document.head.append(style);
  t.cleanup(() => style.remove());
  const rig = createRig({ html: PAGE });
  t.cleanup(observeAnimations(rig.env, rig.record));
  assert.equal(rig.sink.hooks.size, 0, 'idle page: no hook');
  rig.layerEl.querySelector('#a').classList.add('go');
  await frames(3);
  assert.equal(rig.sink.hooks.size, 1);
  rig.layerEl.querySelector('#a').classList.remove('go');
  await frames(2);
  runHooks(rig);
  assert.equal(runHooks(rig), false);
  rig.layerEl.querySelector('#still').style.marginLeft = '40px';
  await frames(3);
  assert.equal(rig.sink.hooks.size, 1, 'transitionrun');
});

test('a Web Animation started by script fires no event: the script hook reports it at once (element.animate, animation.play); no poll', async t => {
  const rig = createRig({ html: PAGE });
  const ledger = createPatchLedger(window);
  const stopHooks = installAnimationHooks(rig.env, ledger);
  t.cleanup(() => { stopHooks(); ledger.restoreAll(); });
  t.cleanup(observeAnimations(rig.env, rig.record));
  assert.equal(rig.sink.hooks.size, 0);
  const el = rig.layerEl.querySelector('#a');
  const anim = el.animate([{ opacity: 1 }, { opacity: 0.5 }], { duration: 100000 });
  t.cleanup(() => anim.cancel());
  assert.equal(rig.sink.hooks.size, 1, 'element.animate: reported synchronously');
  anim.cancel();
  for (const h of [...rig.sink.hooks]) h(0, { due: true });
  assert.equal(rig.sink.hooks.size, 0, 'cancelled: the hook went away');
  const later = new Animation(new KeyframeEffect(el, [{ opacity: 1 }, { opacity: 0.2 }], { duration: 100000 }));
  t.cleanup(() => later.cancel());
  later.play();
  assert.equal(rig.sink.hooks.size, 1, 'animation.play: reported');
  ledger.restoreAll();
  assert.equal(Element.prototype.animate.toString().includes('[native code]'), true, 'the ledger restores the native method');
});

const TWO = '<div drawable id="d" style="width:200px"><div id="a" style="width:40px;height:20px;background:#0af">x</div></div>'
  + '<div drawable id="e" style="width:200px"><div id="b" style="width:40px;height:20px;background:#fa0">y</div></div>';
/**
 * A rig with the script hooks and the observer; `paused(el)` is a Web Animation of `el` paused at 200 ms, once the loop its start began has ended;
 * `dispose()` restores the hooks (one ledger at a time patches the prototypes).
 */
function hooked(t, html = TWO) {
  const rig = createRig({ html });
  const ledger = createPatchLedger(window);
  const stopHooks = installAnimationHooks(rig.env, ledger);
  const stop = observeAnimations(rig.env, rig.record);
  const dispose = () => { stop(); stopHooks(); ledger.restoreAll(); };
  t.cleanup(dispose);
  /** @param {Element} el */
  const paused = async (el) => {
    const a = el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(60px)' }], { duration: 1000 });
    t.cleanup(() => a.cancel());
    a.pause();
    a.currentTime = 200;
    await frames(2);
    runHooks(rig);
    assert.equal(rig.sink.hooks.size, 0, 'paused: the loop ended');
    rig.sink.clear();
    return a;
  };
  return { rig, stop, dispose, paused, a: rig.layerEl.querySelector('#a'), b: rig.layerEl.querySelector('#b') };
}

/** @type {Array<[string, (a: Animation, h: ReturnType<typeof hooked>) => void, string[]]>} change of a paused animation of #a, the drawables it damages */
const RETIMES = [
  ['currentTime setter', (a) => { a.currentTime = 700; }, ['d']],
  ['startTime setter (it runs: the loop takes it)', (a) => { a.startTime = /** @type {number} */ (document.timeline.currentTime) - 300; }, ['d']],
  ['playbackRate setter', (a) => { a.playbackRate = 2; }, ['d']],
  ['updatePlaybackRate()', (a) => { a.updatePlaybackRate(0.5); }, ['d']],
  ['pause() of an idle animation (it shows its first frame)', (a) => { a.cancel(); a.pause(); }, ['d']],
  ['finish()', (a) => { a.finish(); }, ['d']],
  ['cancel()', (a) => { a.cancel(); }, ['d']],
  ['reverse() (it runs: the loop takes it)', (a) => { a.reverse(); }, ['d']],
  ['effect.updateTiming()', (a) => { a.effect?.updateTiming({ delay: -100 }); }, ['d']],
  ['effect.setKeyframes()', (a) => { /** @type {KeyframeEffect} */ (a.effect).setKeyframes([{ opacity: 1 }, { opacity: 0 }]); }, ['d']],
  ['effect.target setter (the old and the new target)', (a, h) => { /** @type {KeyframeEffect} */ (a.effect).target = h.b; }, ['d', 'e']],
  ['animation.effect setter (the old and the new target)', (a, h) => { a.effect = new KeyframeEffect(h.b, [{ opacity: 1 }, { opacity: 0 }], { duration: 1000 }); }, ['d', 'e']],
];

test('a script change of a paused animation\'s timing damages its target once, one microtask later; the frame-hook loop takes only an animation the change starts', async t => {
  for (const [name, change, want] of RETIMES) {
    const h = hooked(t);
    const a = await h.paused(h.a);
    change(a, h);
    assert.equal(h.rig.sink.damage.length, 0, `${name}: nothing synchronously (the script may change more in this task)`);
    await Promise.resolve();
    assert.deepEqual(h.rig.sink.damage.map((d) => `${d.cause}:${d.drawable.id}`).sort(), want.map((id) => `animation:${id}`), name);
    const runs = a.playState === 'running' || a.pending;
    assert.equal(h.rig.sink.hooks.size, runs ? 1 : 0, `${name}: a frame hook only while it runs`);
    a.cancel();
    h.dispose();
  }
});

test('a seek to the current time, a pause() of a paused animation and a change outside the layer damage nothing; several changes in one task damage once', async t => {
  const h = hooked(t);
  const a = await h.paused(h.a);
  const outside = document.createElement('div');
  document.body.append(outside);
  t.cleanup(() => outside.remove());
  const far = outside.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1000 });
  t.cleanup(() => far.cancel());
  far.pause();
  await microtasks();
  h.rig.sink.clear();
  a.currentTime = a.currentTime;
  a.playbackRate = a.playbackRate;
  a.pause();
  a.updatePlaybackRate(1);
  far.currentTime = 500;
  far.effect?.updateTiming({ delay: 10 });
  await microtasks();
  assert.equal(h.rig.sink.damage.length, 0, 'nothing changed inside the layer');
  a.currentTime = 300;
  a.currentTime = 400;
  a.effect?.updateTiming({ delay: 20 });
  a.playbackRate = 3;
  await microtasks();
  assert.deepEqual(h.rig.sink.causes(), ['animation'], 'positive control: the changes of one task are one damage of #d');
  assert.equal(h.rig.sink.damage[0].drawable.id, 'd');
  h.rig.sink.clear();
  a.currentTime = 500;
  h.stop();
  await microtasks();
  assert.equal(h.rig.sink.damage.length, 0, 'a change queued before the disposer damages nothing after it');
});

test('the timing hooks are restored by the ledger: every patched member of Animation, AnimationEffect and KeyframeEffect comes back by identity', async t => {
  const members = [[Animation.prototype, ['play', 'pause', 'finish', 'cancel', 'reverse', 'updatePlaybackRate', 'currentTime', 'startTime', 'playbackRate', 'effect']],
    [AnimationEffect.prototype, ['updateTiming']], [KeyframeEffect.prototype, ['setKeyframes', 'target']], [Element.prototype, ['animate']]];
  const read = () => members.flatMap(([proto, keys]) => keys.map((key) => [`${proto.constructor.name}.${key}`, Object.getOwnPropertyDescriptor(proto, key)]));
  const before = read();
  const ledger = createPatchLedger(window);
  const rig = createRig({ html: PAGE });
  const stopHooks = installAnimationHooks(rig.env, ledger);
  t.cleanup(() => { stopHooks(); ledger.restoreAll(); });
  const same = (/** @type {any} */ x, /** @type {any} */ y) => x?.value === y?.value && x?.get === y?.get && x?.set === y?.set;
  const during = read();
  const unpatched = before.filter(([key, d], i) => same(d, during[i][1])).map(([key]) => key);
  assert.deepEqual(unpatched, [], 'positive control: each member is patched while installed');
  assert.deepEqual(ledger.restoreAll(), []);
  stopHooks();
  const left = before.filter(([key, d], i) => !same(d, read()[i][1])).map(([key]) => key);
  assert.deepEqual(left, [], 'every member restored');
});

test('disposer removes the hook and the listeners', async t => {
  const rig = createRig({ html: PAGE });
  const anim = rig.layerEl.querySelector('#a').animate([{ opacity: 1 }, { opacity: 0.5 }], { duration: 100000 });
  t.cleanup(() => anim.cancel());
  const stop = observeAnimations(rig.env, rig.record);
  assert.equal(rig.sink.hooks.size, 1);
  stop();
  assert.equal(rig.sink.hooks.size, 0);
});
