// O-dom-identity with a GENERATED prototype list: the descriptor table covers `window`, `document`, `navigator`, `CSS`, `Reflect`, `Object`, `Function.prototype` and the
// prototype of EVERY constructor on window, taken before install, while installed and after uninstall. What install patched is the diff of the first two tables (not a
// hand-written list); after uninstall the whole table must equal the first one again (function identity included).
export const IDENTITY_EXPR = `(() => {
  const ids = window.__ids ??= new Map(); let n = ids.size + 1;
  const idOf = (f) => (typeof f === 'function' || (f && typeof f === 'object') ? (ids.get(f) ?? (ids.set(f, n++), ids.get(f))) : f === undefined ? 'u' : String(f));
  const table = {};
  const objs = [['window', window], ['document', document], ['navigator', navigator], ['CSS', CSS], ['Reflect', Reflect], ['Object', Object], ['Object.prototype', Object.prototype], ['Function.prototype', Function.prototype]];
  for (const k of Object.getOwnPropertyNames(window)) { let v; try { v = window[k]; } catch { continue; } if (typeof v === 'function') { objs.push([k, v]); if (v.prototype) objs.push([k + '.prototype', v.prototype]); } }
  for (const [name, p] of objs) { const t = table[name] = {}; for (const k of Reflect.ownKeys(p)) { let d; try { d = Object.getOwnPropertyDescriptor(p, k); } catch { continue; } t[String(k)] = [idOf(d.value), idOf(d.get), idOf(d.set), d.writable, d.enumerable, d.configurable].join('|'); } }
  return { html: document.documentElement.outerHTML, table };
})()`;

/** Differences between two identity snapshots. */
export function diffIdentity(a, b) {
  const out = [];
  if (a.html !== b.html) {
    let i = 0; while (i < a.html.length && a.html[i] === b.html[i]) i++;
    out.push({ where: 'outerHTML', at: i, before: a.html.slice(Math.max(0, i - 40), i + 80), after: b.html.slice(Math.max(0, i - 40), i + 80) });
  }
  for (const name of new Set([...Object.keys(a.table), ...Object.keys(b.table)])) {
    const ta = a.table[name] ?? {}, tb = b.table[name] ?? {};
    for (const k of new Set([...Object.keys(ta), ...Object.keys(tb)])) if (ta[k] !== tb[k]) out.push({ where: `${name}.${k}`, before: ta[k] ?? 'absent', after: tb[k] ?? 'absent' });
  }
  return out;
}
