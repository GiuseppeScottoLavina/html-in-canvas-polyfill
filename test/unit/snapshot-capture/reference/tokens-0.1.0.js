// FROZEN REFERENCE (test only): the token collector of src/snapshot/capture/css-shake.js as released in 0.1.0-preview.1 (see clone-0.1.0.js). Never edit its logic.
import { collectVarNames } from '/src/snapshot/capture/custom-props.js';

/** @param {string} text @returns {string} 53-bit hash as hex */
function hash(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * Accumulates the tokens of the elements that end up in the serialised clone (the clone builder feeds it while it builds).
 * @returns {TokenCollector}
 */
export function createTokenCollector() {
  const classes = new Set();
  const ids = new Set();
  const tags = new Set();
  const fonts = new Set();
  const vars = new Set();
  let attrNeed = false;
  return {
    add(el) {
      tags.add(el.localName.toLowerCase());
      const attrs = el.attributes;
      let plain = 0;
      for (let i = 0; i < attrs.length; i++) {
        const a = attrs[i];
        const name = a.name;
        if (name === 'class') {
          plain++;
          for (const c of a.value.split(/\s+/)) if (c) classes.add(c);
        } else if (name === 'id') { plain++; ids.add(a.value); } else if (name === 'style') {
          plain++;
          const v = a.value;
          collectVarNames(v, vars);
          if (v.includes('font')) for (const m of v.matchAll(/(?:^|;)\s*font(?:-family)?\s*:([^;]*)/gi)) fonts.add(m[1].trim().toLowerCase());
        }
      }
      if (attrs.length > plain) attrNeed = true;
    },
    finish() {
      const sig = hash([[...classes].sort().join(' '), [...ids].sort().join(' '), [...tags].sort().join(' '), [...fonts].sort().join('|'), attrNeed ? 1 : 0].join('\n'));
      return { classes, ids, tags, fonts, vars, hasAttributeSelectorNeed: attrNeed, signature: sig };
    },
  };
}

