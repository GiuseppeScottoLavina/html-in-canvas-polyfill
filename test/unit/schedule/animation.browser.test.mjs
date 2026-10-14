import { test, assert, frames, sleep } from '/test/unit/lib/t.js';
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

test('disposer removes the hook and the listeners', async t => {
  const rig = createRig({ html: PAGE });
  const anim = rig.layerEl.querySelector('#a').animate([{ opacity: 1 }, { opacity: 0.5 }], { duration: 100000 });
  t.cleanup(() => anim.cancel());
  const stop = observeAnimations(rig.env, rig.record);
  assert.equal(rig.sink.hooks.size, 1);
  stop();
  assert.equal(rig.sink.hooks.size, 0);
});
