import { test, assert, sleep } from '/test/unit/lib/t.js';
import { install } from '/src/index.js';

/** What a re-install does to a managed canvas (docs/API-CONTRACT.md section 3, GETTING-STARTED "Uninstall and reinstall") */
test('after uninstall() + install() the canvas gets its first paint on its own; addEventListener listeners survive, onpaint is forgotten', async t => {
  const first = install();
  t.cleanup(() => { first.uninstall(); });
  const host = document.createElement('div');
  host.innerHTML = '<canvas content="drawable" width="80" height="40"><div drawable style="width:80px;height:40px;background:#f00">x</div></canvas>';
  document.body.append(host);
  t.cleanup(() => host.remove());
  const canvas = /** @type {HTMLCanvasElement} */ (host.firstElementChild);
  let viaListener = 0, viaProperty = 0;
  canvas.addEventListener('paint', () => { viaListener++; });
  canvas.onpaint = () => { viaProperty++; };
  await first.whenPainted(canvas);
  assert.ok(viaListener >= 1 && viaProperty >= 1, 'first install painted');
  first.uninstall();
  const before = { l: viaListener, p: viaProperty };
  const second = install();
  t.cleanup(() => second.uninstall());
  assert.equal(second.canvases()[0], canvas, 'the canvas is managed again');
  let reassigned = 0;
  canvas.onpaint = () => { reassigned++; }; // a page re-arms its handler right after install(), as the docs say
  await second.whenPainted(canvas);
  await sleep(100);
  assert.ok(viaListener > before.l, 'the native listener survived and saw the automatic first paint of the new install');
  assert.equal(viaProperty, before.p, 'onpaint set before uninstall is dropped');
  assert.ok(reassigned >= 1, 'a handler re-assigned right after install() sees the automatic first paint');
});
