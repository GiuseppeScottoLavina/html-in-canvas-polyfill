// FROZEN REFERENCE (test only): cleanAttributes of src/snapshot/capture/state-sync.js as released in 0.1.0-preview.1 (see clone-0.1.0.js). Never edit its logic.
const KEEP_HIC_ATTRS = new Set(['data-hic-root', 'data-hic-shell', 'data-hic-s', 'data-hic-sp']);
const XML_ATTR_NAME = /^[A-Za-z_][\w.-]*$/;
/**
 * Drop what must not reach the image document: event handlers, polyfill markers, attribute names XML cannot carry (frameworks use `@click`, `:class`), autofocus.
 * @param {Element} el
 */
export function cleanAttributes(el) {
  const attrs = el.attributes;
  for (let i = attrs.length - 1; i >= 0; i--) {
    const a = attrs[i];
    const name = a.name;
    if (a.namespaceURI) continue;
    if ((name.charCodeAt(0) === 111 && name.charCodeAt(1) === 110) || name === 'autofocus' || !XML_ATTR_NAME.test(name) || (name.startsWith('data-hic-') && !KEEP_HIC_ATTRS.has(name))) el.removeAttribute(name);
  }
}
