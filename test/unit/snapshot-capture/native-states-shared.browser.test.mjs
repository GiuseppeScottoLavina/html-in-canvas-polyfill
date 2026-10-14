// Regression (final verification, Safari L-rg:press): the core's interaction tracker records a press with notePress, the engines bundle's skin painter reads it with
// pressOnThumb; each bundle carries its OWN copy of util/native-states.js, so the press state must live on a page-wide symbol, not in module scope.
import { test, assert } from '/test/unit/lib/t.js';

test('two copies of native-states.js share the press record (core writes, engines bundle reads)', async () => {
  const core = await import('/src/util/native-states.js?copy=core');
  const engines = await import('/src/util/native-states.js?copy=engines');
  assert.notEqual(core, engines, 'two module instances');
  const el = document.createElement('input');
  el.type = 'range'; el.min = '0'; el.max = '100'; el.value = '0';
  el.style.cssText = 'position:fixed;left:0;top:0;width:200px';
  document.body.append(el);
  try {
    const r = el.getBoundingClientRect();
    core.notePress(el, { x: r.left + 190, y: r.top + 5 });
    assert.equal(engines.pressOnThumb(el, 0, 16, false), false, 'a press far from the thumb (value 0 at the left) is seen by the other copy');
    core.notePress(el, { x: r.left + 4, y: r.top + 5 });
    assert.equal(engines.pressOnThumb(el, 0, 16, false), true, 'and a press on the thumb');
  } finally { el.remove(); }
});
