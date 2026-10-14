import { test, assert, frames, microtasks, sleep } from '/test/unit/lib/t.js';
import { createRig } from './_dom.js';
import { createInteractionTracker } from '/src/schedule/observers/interaction-tracker.js';
import { createCapture } from '/src/snapshot/capture/capture.js';

const PAGE = '<div drawable id="d" style="width:200px"><div id="card" class="card"><button id="b1" class="btn">one</button><button id="b2" class="btn">two</button></div><input id="in" style="width:100px"><textarea id="ta"></textarea></div>';

function setup(t, css = '.btn:hover{color:red}.btn:active{color:blue}') {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  const rig = createRig({ html: PAGE });
  const tracker = createInteractionTracker(rig.env, createCapture(rig.env));
  tracker.attach(rig.record);
  const changes = [];
  tracker.onChange(c => changes.push({ kind: c.kind, n: c.elements.length }));
  t.cleanup(() => { tracker.dispose(); style.remove(); });
  const $ = id => rig.layerEl.querySelector('#' + id);
  const fire = (el, type, init = {}) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, ...init }));
  return { ...rig, tracker, changes, $, fire };
}

test('hover chain: pointerover builds target + ancestors inside the layer; pointerout to outside clears it; snapshot is immutable per state', async t => {
  const s = setup(t);
  s.fire(s.$('b1'), 'pointerover');
  const snap = s.tracker.snapshot();
  assert.deepEqual([...snap.hover].map(e => e.id).sort(), ['b1', 'card', 'd']);
  assert.equal(s.tracker.snapshot(), snap, 'cached while nothing changed');
  s.fire(s.$('b1'), 'pointerout', { relatedTarget: s.$('b2') });
  assert.equal(s.tracker.snapshot(), snap, 'moving inside the layer does not clear');
  s.fire(s.$('b2'), 'pointerover');
  const moved = s.tracker.snapshot();
  assert.notEqual(moved, snap);
  assert.deepEqual([...moved.hover].map(e => e.id).sort(), ['b2', 'card', 'd']);
  assert.deepEqual([...snap.hover].map(e => e.id).sort(), ['b1', 'card', 'd'], 'an old snapshot never changes');
  s.fire(s.$('b2'), 'pointerout', { relatedTarget: document.body });
  assert.equal(s.tracker.snapshot().hover.size, 0);
});

test('hover damage is published only when a rule uses :hover, as a reach rect of the changed elements', async t => {
  const s = setup(t);
  s.fire(s.$('b1'), 'pointerover');
  assert.deepEqual(s.sink.causes(), ['hover']);
  assert.equal(s.sink.damage[0].drawable.id, 'd');
});

test('without a :hover rule hover damage is skipped, but onChange listeners and the snapshot still follow the pointer', async t => {
  const noRule = setup(t, '.btn{color:red}');
  noRule.fire(noRule.$('b1'), 'pointerover');
  assert.equal(noRule.sink.damage.length, 0, 'no :hover rule, no damage');
  assert.equal(noRule.changes.length, 1, 'but onChange listeners are told');
  assert.equal(noRule.tracker.snapshot().hover.has(noRule.$('b1')), true);
});

test('the :hover usage comes from capture\'s CssBundle and follows its stylesheet epoch (a rule added later turns damage on)', async t => {
  const style = document.createElement('style');
  document.head.append(style);
  t.cleanup(() => style.remove());
  const rig = createRig({ html: PAGE });
  const capture = createCapture(rig.env);
  const tracker = createInteractionTracker(rig.env, capture);
  tracker.attach(rig.record);
  t.cleanup(() => tracker.dispose());
  const b = rig.layerEl.querySelector('#b1');
  b.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  assert.equal(rig.sink.damage.length, 0);
  b.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
  style.textContent = '.btn:hover{color:red}';
  capture.invalidateStyles();
  rig.sink.clear();
  b.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  assert.equal(rig.sink.causes().includes('hover'), true);
});

test('without a capture every pseudo-class counts as used, and a throwing capture is reported and treated the same', async t => {
  const rig = createRig({ html: PAGE });
  const b = rig.layerEl.querySelector('#b1');
  const plain = createInteractionTracker(rig.env);
  plain.attach(rig.record);
  t.cleanup(() => plain.dispose());
  b.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  assert.deepEqual(rig.sink.causes(), ['hover']);
  plain.dispose();
  rig.sink.clear();
  const broken = createInteractionTracker(rig.env, /** @type {any} */ ({ resources: {}, cssBundle() { throw new Error('css exploded'); } }));
  broken.attach(rig.record);
  t.cleanup(() => broken.dispose());
  b.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  assert.deepEqual(rig.sink.causes(), ['hover']);
  assert.ok(rig.reporter.errors.some(([err, where]) => where === 'tracker.pseudo' && /css exploded/.test(err.message)));
});

test('active chain follows pointerdown until pointerup anywhere in the document; Space activates a focused button', async t => {
  const s = setup(t);
  s.fire(s.$('b1'), 'pointerdown');
  assert.deepEqual([...s.tracker.snapshot().active].map(e => e.id).sort(), ['b1', 'card', 'd']);
  assert.ok(s.sink.causes().includes('active'));
  s.fire(document.body, 'pointerup');
  assert.equal(s.tracker.snapshot().active.size, 0);
  s.$('b2').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ' }));
  assert.equal(s.tracker.snapshot().active.has(s.$('b2')), true);
  document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
  assert.equal(s.tracker.snapshot().active.size, 0);
  s.$('in').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ' }));
  assert.equal(s.tracker.snapshot().active.size, 0, 'a text input is not pressable');
});

test('setMappedTarget: hover and active follow the mapped element, native events are ignored while mapped, null restores the native target', async t => {
  const s = setup(t);
  s.fire(s.$('b1'), 'pointerover');
  s.tracker.setMappedTarget(s.record, s.$('b2'));
  assert.deepEqual([...s.tracker.snapshot().hover].map(e => e.id).sort(), ['b2', 'card', 'd']);
  s.fire(s.$('b1'), 'pointerover');
  assert.equal(s.tracker.snapshot().hover.has(s.$('b1')), false, 'native hit ignored');
  s.fire(s.$('b1'), 'pointerdown');
  assert.equal(s.tracker.snapshot().active.has(s.$('b2')), true, 'the press lands on the mapped element');
  assert.equal(s.tracker.snapshot().active.has(s.$('b1')), false);
  s.fire(document.body, 'pointerup');
  s.tracker.setMappedTarget(s.record, null);
  assert.equal(s.tracker.snapshot().hover.has(s.$('b1')), true, 'back to the native target');
  assert.equal(s.tracker.snapshot().hover.has(s.$('b2')), false);
});

test('a mapped target set right after a native pointerdown re-targets that press (the interposer runs second)', async t => {
  const s = setup(t);
  s.fire(s.$('b1'), 'pointerdown');
  s.tracker.setMappedTarget(s.record, s.$('b2'));
  assert.equal(s.tracker.snapshot().active.has(s.$('b2')), true);
  assert.equal(s.tracker.snapshot().active.has(s.$('b1')), false);
});

test('focus: focusin sets snapshot.focus/focusVisible and publishes focus damage in the control; focusout clears; damage is not pseudo-gated', async t => {
  const s = setup(t, '.x{}');
  s.$('in').focus();
  await frames(1);
  const snap = s.tracker.snapshot();
  assert.equal(snap.focus, s.$('in'));
  assert.equal(snap.focusVisible, true, 'text input always shows the ring');
  assert.ok(s.sink.causes().includes('focus'));
  s.$('in').blur();
  assert.equal(s.tracker.snapshot().focus, null);
  s.$('b1').focus();
  assert.equal(s.tracker.snapshot().focus, s.$('b1'));
  s.$('in').focus();
  assert.equal(s.tracker.snapshot().focus, s.$('in'), 'moving focus inside the layer ends with the new control');
});

test('caret blink: runs only while a text control is focused, toggles caretVisible every 530 ms and publishes caret damage; a key restarts it solid', async t => {
  if (!document.hasFocus()) { console.warn('document has no focus in this runner: blink is skipped by design'); }
  const s = setup(t, '.x{}');
  s.$('b1').focus();
  await sleep(700);
  assert.equal(s.sink.causes().includes('caret'), false, 'no blink on a button');
  s.$('in').focus();
  if (!document.hasFocus()) return;
  s.sink.clear();
  await sleep(1200);
  const carets = s.sink.damage.filter(d => d.cause === 'caret');
  assert.ok(carets.length >= 1 && carets.length <= 3, `caret damages in 1.2 s: ${carets.length}`);
  assert.equal(s.sink.damage.every(d => d.drawable.id === 'd' && d.rect), true);
  const before = s.changes.filter(c => c.kind === 'caret').length;
  assert.equal(before, carets.length);
  s.$('in').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
  assert.equal(s.tracker.snapshot().caretVisible, true);
  s.$('in').blur();
  s.sink.clear();
  await sleep(700);
  assert.equal(s.sink.causes().includes('caret'), false, 'the timer stops with the focus');
}, { timeout: 6000 });

test('no wheel, mousewheel or touch listener and no pointermove listener is ever added by the tracker', async t => {
  const seen = [];
  const original = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, ...rest) { seen.push(type); return original.call(this, type, ...rest); };
  t.cleanup(() => { EventTarget.prototype.addEventListener = original; });
  setup(t);
  assert.ok(seen.includes('pointerover') && seen.includes('focusin'), 'positive control: the spy sees the tracker');
  const bad = seen.filter(type => /^(wheel|mousewheel|touch.*|pointermove)$/.test(type));
  assert.deepEqual(bad, []);
});

test('detach forgets the record: no more events, chains cleared, timers stopped', async t => {
  const s = setup(t);
  s.fire(s.$('b1'), 'pointerover');
  s.tracker.detach(s.record);
  assert.equal(s.tracker.snapshot().hover.size, 0);
  s.sink.clear();
  s.fire(s.$('b2'), 'pointerover');
  assert.equal(s.tracker.snapshot().hover.size, 0);
  assert.equal(s.sink.damage.length, 0);
});
