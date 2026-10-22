// Module worker of worker.browser.test.mjs WITHOUT the worker bundle: it sees the raw wire record and writes on its geometry channel directly, as a faulty or
// hostile worker could. {forge: [...ops]} posts those operations as they are; {own: values} posts one well-formed update of the element it was sent.
let record = null;
self.onmessage = (e) => {
  const d = e.data;
  if (d && d.__hicElementImage === 1) { record = d; self.postMessage({ ok: true, canvas: d.canvas, element: d.element }); return; }
  if (d.forge) { record.port.postMessage(d.forge); self.postMessage({ ok: true }); return; }
  if (d.own) { record.port.postMessage([{ kind: 'update', canvas: record.canvas, element: record.element, values: d.own, is2D: true, clip: null }]); self.postMessage({ ok: true }); }
};
