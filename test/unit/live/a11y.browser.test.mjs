import { test, assert, microtasks } from '/test/unit/lib/t.js';
import { setup, page } from '/test/unit/live/lib.mjs';

const ITEMS = '<div role="listitem" drawable tabindex="0">One</div><div role="listitem" id="mine">Two</div>text<script>1</script><div role="listitem">Three</div>';

test('the canvas aria-owns its top-level children; ids are generated only where missing', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page(ITEMS, 'display:block');
  canvas.setAttribute('role', 'list');
  const r = managed(canvas);
  const kids = r.layer.logicalChildNodes().filter((n) => n.nodeType === 1);
  const owns = canvas.getAttribute('aria-owns').split(' ');
  assert.equal(owns.length, 3, 'script and text are not owned');
  assert.ok(owns[0].startsWith(`hic-o-${r.id}-`));
  assert.equal(owns[1], 'mine');
  assert.equal(kids[0].id, owns[0]);
  assert.equal(kids[1].id, 'mine');
  assert.equal(kids[3].id, owns[2]);
  assert.equal(kids[2].hasAttribute('id'), false, 'script gets no id');
  assert.equal(r.layer.element.getAttribute('role'), 'presentation');
});

test('author aria-owns is merged, kept when the author changes it, and restored on unmount', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page('<div id="x">x</div>', 'display:block');
  canvas.setAttribute('aria-owns', 'elsewhere');
  const r = managed(canvas);
  assert.equal(canvas.getAttribute('aria-owns'), 'elsewhere x');
  canvas.setAttribute('aria-owns', 'other');
  await microtasks();
  assert.equal(canvas.getAttribute('aria-owns'), 'other x', 'a new author value is merged, not overwritten');
  r.layer.unmount();
  assert.equal(canvas.getAttribute('aria-owns'), 'other');
  const { canvas: bare } = page('<div>y</div>');
  const r2 = managed(bare);
  assert.ok(bare.hasAttribute('aria-owns'));
  r2.layer.unmount();
  assert.equal(bare.hasAttribute('aria-owns'), false);
  assert.equal(bare.firstChild.hasAttribute('id'), false, 'generated id removed');
});

test('adding and removing children keeps aria-owns current and cleans generated ids', async (t) => {
  const { managed } = setup({ t });
  const { canvas } = page('<div id="a">a</div>');
  managed(canvas);
  const b = document.createElement('div');
  canvas.append(b);
  assert.equal(canvas.getAttribute('aria-owns').split(' ').length, 2);
  assert.ok(b.id.startsWith('hic-o-'));
  const id = b.id;
  canvas.removeChild(b);
  assert.equal(canvas.getAttribute('aria-owns'), 'a');
  assert.equal(b.hasAttribute('id'), false, 'the removed child does not keep our id');
  assert.ok(id);
});

test('positive control: without the link there is no aria-owns', async (t) => {
  const { record } = setup({ t });
  const { canvas } = page('<div>a</div>');
  const r = record(canvas);
  assert.equal(canvas.hasAttribute('aria-owns'), false, 'not mounted: untouched');
  r.layer.mount();
  assert.equal(canvas.hasAttribute('aria-owns'), true);
});
