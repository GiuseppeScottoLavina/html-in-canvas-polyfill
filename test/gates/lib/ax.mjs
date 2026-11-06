// O-ax helpers of G-a11y: Chrome's real accessibility tree (CDP Accessibility.getFullAXTree), cut at one DOM element and flattened the way a screen reader
// walks it (ignored nodes and inline text boxes are skipped, their children move up). The pure functions take the CDP node list and are unit-tested in Node
// (test/unit/gate-tooling/gate-ax.test.mjs).

/** Roles that carry the structure a screen reader announces: the projection compared with a fixture's expectations. */
export const STRUCTURE_ROLES = new Set(['Canvas', 'list', 'listitem', 'heading', 'textbox', 'checkbox', 'radio', 'slider', 'spinbutton', 'combobox', 'button', 'link',
  'status', 'alert', 'log', 'form', 'group', 'region', 'img', 'figure']);
/** AX properties kept in the compact form. */
const PROPS = ['focusable', 'focused', 'checked', 'level', 'live', 'atomic', 'relevant', 'editable', 'disabled', 'hidden', 'valuetext'];

/** The whole tree of the page. @returns {Promise<any[]>} */
export async function axNodes(page) {
  const { nodes } = await page.send('Accessibility.getFullAXTree', {});
  return nodes;
}

/** The DOM backend node id of the first element that matches `selector` (null when there is none). */
export async function backendIdOf(page, selector) {
  const r = await page.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` });
  if (!r.result?.objectId) return null;
  const d = await page.send('DOM.describeNode', { objectId: r.result.objectId });
  await page.send('Runtime.releaseObject', { objectId: r.result.objectId }).catch(() => {});
  return d.node.backendNodeId;
}

const val = (/** @type {any} */ v) => v?.value;

/**
 * The exposed subtree of the AX node of DOM node `rootBackend`, pre-order: [{depth, role, name, value, props, text, id}] (pure). Ignored nodes and InlineTextBox
 * nodes are not listed and their children take their depth. `text` is the concatenated StaticText of the node's exposed descendants. Null when the element
 * has no AX node (it is not in the tree).
 * @param {any[]} nodes @param {number|null} rootBackend
 */
export function axSubtree(nodes, rootBackend) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => n.backendDOMNodeId === rootBackend && rootBackend != null);
  if (!root) return null;
  /** @type {any[]} */ const out = [];
  /** @returns {string} the StaticText under n */
  const walk = (/** @type {any} */ n, /** @type {number} */ depth) => {
    if (!n) return '';
    const role = val(n.role) ?? '';
    const shown = n === root || (!n.ignored && role !== 'InlineTextBox');
    let entry = null;
    if (shown) {
      const props = Object.fromEntries((n.properties ?? []).filter((/** @type {any} */ p) => PROPS.includes(p.name)).map((/** @type {any} */ p) => [p.name, val(p.value)]));
      entry = { depth, role, name: val(n.name) ?? '', value: n.value ? val(n.value) : undefined, props, text: '', id: n.nodeId, ignored: !!n.ignored };
      out.push(entry);
    }
    let text = shown && role === 'StaticText' ? String(val(n.name) ?? '') : '';
    for (const c of n.childIds ?? []) text += walk(byId.get(c), shown ? depth + 1 : depth);
    if (entry) entry.text = text;
    return text;
  };
  walk(root, 0);
  return out;
}

/** One line per exposed node of `sub` (pure): the whole subtree in a comparable form. The root line leaves its role out when `rootRole` is false. */
export function axLines(sub, { rootRole = true } = {}) {
  if (!sub) return ['(not in the accessibility tree)'];
  return sub.map((e, i) => {
    const props = Object.entries(e.props).filter(([k]) => k !== 'focused').map(([k, v]) => `${k}=${v}`).join(' ');
    return `${'  '.repeat(e.depth)}${i === 0 && !rootRole ? 'root' : e.role} "${e.name}"${e.value !== undefined ? ` value=${JSON.stringify(e.value)}` : ''}${props ? ' ' + props : ''}`;
  });
}

/**
 * The structure a screen reader announces (pure): only the nodes of STRUCTURE_ROLES (and the root, written `root`), with their depth among such nodes,
 * the name, the value, checked / level / live, and the text of list items, headings and live regions.
 */
export function axStructure(sub) {
  if (!sub) return ['(not in the accessibility tree)'];
  /** @type {string[]} */ const out = [];
  /** @type {number[]} */ const stack = [];   // depths of the structure ancestors
  sub.forEach((e, i) => {
    if (i > 0 && !STRUCTURE_ROLES.has(e.role)) return;
    while (stack.length && stack[stack.length - 1] >= e.depth) stack.pop();
    const d = stack.length;
    stack.push(e.depth);
    const bits = [`${i === 0 ? 'root' : e.role} "${e.name}"`];
    if (e.value !== undefined && e.value !== '') bits.push(`value=${JSON.stringify(String(e.value))}`);
    if (e.props.checked !== undefined) bits.push(`checked=${e.props.checked}`);
    if (e.role === 'heading' && e.props.level !== undefined) bits.push(`level=${e.props.level}`);
    if (e.props.live) bits.push(`live=${e.props.live}`);
    if (['listitem', 'heading', 'status', 'alert', 'log'].includes(e.role)) bits.push(`text=${JSON.stringify(e.text.trim())}`);
    out.push('  '.repeat(d) + bits.join(' '));
  });
  return out;
}

/** The focused node of the tree (pure): {role, name, underRoot} or null; `underRoot` says whether it is in the AX subtree of `rootBackend`. */
export function axFocused(nodes, rootBackend) {
  const f = nodes.find((n) => (n.properties ?? []).some((/** @type {any} */ p) => p.name === 'focused' && val(p.value) === true) && val(n.role) !== 'RootWebArea');
  if (!f) return null;
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  let underRoot = false;
  for (let n = f; n; n = byId.get(n.parentId)) if (n.backendDOMNodeId === rootBackend) { underRoot = true; break; }
  return { role: val(f.role) ?? '', name: val(f.name) ?? '', underRoot };
}

/** The first line where two line lists differ (pure), for a failure detail. */
export function firstDifference(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return { line: i, got: a[i] ?? '(missing)', want: b[i] ?? '(missing)' };
  return null;
}
