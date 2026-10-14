#!/usr/bin/env node
// F4 "large app" generator: cards, a data table, nested lists and form rows with a parameterised element count.
//
//   node test/fixtures/f4-large-app/generate.mjs 1000 > f4-1000.html
//   import { generateF4Html } from './generate.mjs';
//   (the harness server serves /test/fixtures/f4-large-app/index.html?nodes=N through this function)
//
// NODE COUNT CONTRACT: `nodes` = number of ELEMENTS in the drawable subtree, i.e. `#root` plus all its descendants
// (document.querySelectorAll('#root, #root *').length === nodes). Output is deterministic for a given `nodes`.
// The whole app lives in one scroller (#scroller) inside a fixed-size canvas, so a big DOM scrolls INSIDE the canvas.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const WORDS = 'amber fjord kelp prairie umber zephyr ember juniper onyx tundra yarrow dune indigo nectar summit xenon cobalt harbor meadow reef willow basalt glacier lagoon quartz velvet'.split(' ');
let seed = 1;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const words = k => Array.from({ length: k }, () => WORDS[(rnd() * WORDS.length) | 0]).join(' ');

/** Tiny element builder that counts the elements it emits. */
function h(tag, attrs, ...kids) {
  const a = Object.entries(attrs ?? {}).map(([k, v]) => v === true ? ` ${k}` : ` ${k}="${String(v).replace(/"/g, '&quot;')}"`).join('');
  const void_ = tag === 'input' || tag === 'br';
  let n = 1, inner = '';
  for (const k of kids) { if (typeof k === 'string') inner += k; else { n += k.n; inner += k.html; } }
  return { n, html: void_ ? `<${tag}${a}>` : `<${tag}${a}>${inner}</${tag}>` };
}
const sum = list => list.reduce((s, x) => s + x.n, 0);
const join = list => list.map(x => x.html).join('');

const card = i => h('section', { class: `card c${i % 3}` }, h('h3', {}, `Card ${i}`), h('p', {}, words(9)), h('div', { class: 'meta' }, h('span', {}, `#${i}`), h('span', {}, words(1))), h('button', { type: 'button' }, 'Open'));
const tableRow = i => h('tr', {}, h('td', {}, String(i)), h('td', {}, words(2)), h('td', {}, words(1)), h('td', {}, h('input', { class: 'cell', id: `f4-cell-${i}`, value: `v${i}`, 'aria-label': `cell ${i}` })), h('td', {}, `${(i * 37) % 1000}.${i % 100}`));
const leaf = () => h('li', {}, h('span', {}, words(2)));
const group = () => h('li', { class: 'g' }, h('span', {}, words(3)), h('ul', {}, leaf(), leaf(), leaf()));
const formRow = i => h('div', { class: 'row' }, h('label', {}, h('span', {}, `Field ${i}`), h('input', { id: `f4-in-${i}`, value: words(2), 'aria-label': `field ${i}` })));
const pad = () => h('li', { class: 'pad' }, words(1));

const css = `
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #111418; color: #e6e9ef; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
  #hic-surface { display: block; width: 1280px; max-width: 100%; height: 800px; margin: 0 auto; background: #181c22; }
  #root { width: 100%; height: 100%; background: #181c22; }
  #scroller { width: 100%; height: 100%; overflow: auto; padding: 16px; display: flex; flex-direction: column; gap: 18px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  header h1 { margin: 0; font-size: 22px; } header nav { display: flex; gap: 8px; } header nav a { padding: 4px 10px; border-radius: 999px; background: #2c3a52; font-size: 12px; }
  h2 { margin: 0 0 8px; font-size: 16px; color: #9fb4d6; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
  .card { padding: 10px 12px; border-radius: 10px; background: #232a35; border: 1px solid #3a4658; }
  .card.c1 { background: #26302a; border-color: #4d6b52; } .card.c2 { background: #2d2735; border-color: #6a5287; }
  .card h3 { margin: 0 0 4px; font-size: 15px; } .card p { margin: 0 0 8px; color: #b9c2d3; }
  .card .meta { display: flex; gap: 8px; margin-bottom: 8px; font-size: 12px; color: #8fa0bb; }
  .card button { padding: 5px 10px; border: 0; border-radius: 6px; background: #e0a458; color: #1a120b; font: inherit; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; } th, td { padding: 4px 8px; text-align: left; border-bottom: 1px solid #2b3442; white-space: nowrap; }
  th { background: #232a35; position: sticky; top: 0; } tbody tr:nth-child(even) { background: #1c222b; }
  input.cell { width: 110px; padding: 2px 6px; border: 1px solid #4a5a75; border-radius: 5px; background: #10151c; color: inherit; font: inherit; }
  ul { margin: 0; padding-left: 18px; } li.g > span { font-weight: 600; } li.pad { color: #7d8aa3; }
  .forms { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 8px 14px; }
  .row label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: #9fb4d6; }
  .row input { padding: 6px 8px; border: 1px solid #4a5a75; border-radius: 6px; background: #10151c; color: #e6e9ef; font: inherit; }
`;

/**
 * @param {{nodes?:number}} [o] element count of the drawable subtree (#root included); minimum 60.
 * @returns {string} a complete HTML document
 */
export function generateF4Html({ nodes = 500 } = {}) {
  if (!Number.isInteger(nodes) || nodes < 60 || nodes > 20000) throw new Error('f4: nodes must be an integer in [60, 20000], got ' + nodes);
  seed = 1;
  const nav = h('nav', {}, ...['Home', 'Reports', 'Billing', 'Team', 'Settings', 'Help'].map(t => h('a', {}, t)));
  const header = h('header', {}, h('h1', {}, `F4 large app (${nodes} nodes)`), nav);
  const thead = h('thead', {}, h('tr', {}, ...['#', 'Name', 'Tag', 'Value', 'Score'].map(t => h('th', {}, t))));
  // Fixed overhead = #root, #scroller, header, 4 sections with their h2/containers, table skeleton. Units are then added round-robin
  // (2 cards, 3 table rows, 1 nested group, 2 form rows) until the next round would overshoot, and 1-element <li> pads fill the gap.
  const cards = [], rows = [], groups = [], fields = [], pads = [];
  const build = () => {
    const sections = [
      h('section', {}, h('h2', {}, 'Cards'), h('div', { class: 'cards' }, ...cards)),
      h('section', {}, h('h2', {}, 'Table'), h('table', {}, thead, h('tbody', {}, ...rows))),
      h('section', {}, h('h2', {}, 'Nested lists'), h('ul', { class: 'tree' }, ...groups), h('ul', { class: 'padlist' }, ...pads)),
      h('section', {}, h('h2', {}, 'Form rows'), h('div', { class: 'forms' }, ...fields)),
    ];
    return h('div', { id: 'root', drawable: true }, h('div', { id: 'scroller' }, header, h('main', {}, ...sections)));
  };
  let i = 0;
  for (;;) {
    const next = [card(i), card(i + 1), tableRow(i), tableRow(i + 1), tableRow(i + 2), group(), formRow(i), formRow(i + 1)];
    if (build().n + sum(next) > nodes) break;
    cards.push(next[0], next[1]); rows.push(next[2], next[3], next[4]); groups.push(next[5]); fields.push(next[6], next[7]); i += 3;
  }
  while (build().n < nodes) pads.push(pad());
  const root = build();
  if (root.n !== nodes) throw new Error(`f4 generator bug: built ${root.n} elements, wanted ${nodes}`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>F4 large app ${nodes}</title>
<style>${css}</style></head>
<body>
<canvas id="hic-surface" width="1280" height="800" content="drawable" aria-label="F4 large app surface">
${root.html}
</canvas>
<script src="/test/fixtures/shared/boot.js"></script>
</body></html>
`;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.stdout.write(generateF4Html({ nodes: Number(process.argv[2] ?? 500) }));
}
