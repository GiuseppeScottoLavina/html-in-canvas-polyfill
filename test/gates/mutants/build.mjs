// Pure: apply a mutant's string edits to a bundle text. Every anchor must occur exactly once (a rebuilt bundle makes it drift, which must fail loudly, never skip).
/** @param {string} baseText @param {{edits:Array<[string,string]>|'EMPTY'}} m @returns {{text:string}|{drift:string}} */
export function buildMutant(baseText, m) {
  if (m.edits === 'EMPTY') return { text: '/* polyfill not installed: this bundle is intentionally a no-op, padded to pass the harness size check */\n' + ' '.repeat(100) + '\n' };
  let text = baseText;
  for (const [a, b] of m.edits) {
    const n = text.split(a).length - 1;
    if (n !== 1) return { drift: `anchor found ${n} times: ${a.slice(0, 90)}` };
    text = text.replace(a, () => b);
  }
  return { text };
}
