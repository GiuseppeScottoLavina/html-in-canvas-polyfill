// Pure pieces of G-a11y's accessibility-tree oracle (test/gates/lib/ax.mjs) on a hand-built CDP node list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axSubtree, axLines, axStructure, axFocused, firstDifference } from '../../gates/lib/ax.mjs';

const v = (value) => ({ type: 'string', value });
const prop = (name, value) => ({ name, value: { type: typeof value === 'boolean' ? 'boolean' : 'token', value } });
/** body > canvas(list) > [ignored generic > listitem > text, listitem(focused) > text > inline box], body > status (outside the canvas) */
function tree({ owned = true } = {}) {
  const nodes = [
    { nodeId: '1', role: v('RootWebArea'), name: v('page'), childIds: ['2'], backendDOMNodeId: 1, properties: [prop('focused', true)] },
    { nodeId: '2', role: v('generic'), ignored: true, parentId: '1', childIds: owned ? ['3', '9'] : ['3', '4', '9'], backendDOMNodeId: 2 },
    { nodeId: '3', role: v('list'), name: v('Fruit'), parentId: '2', childIds: owned ? ['4'] : [], backendDOMNodeId: 3 },
    { nodeId: '4', role: v('generic'), ignored: true, parentId: owned ? '3' : '2', childIds: ['5', '7'], backendDOMNodeId: 4 },
    { nodeId: '5', role: v('listitem'), name: v(''), parentId: '4', childIds: ['6'], backendDOMNodeId: 5, properties: [prop('focusable', true)] },
    { nodeId: '6', role: v('StaticText'), name: v('Apples'), parentId: '5', childIds: [], backendDOMNodeId: 6 },
    { nodeId: '7', role: v('listitem'), name: v(''), parentId: '4', childIds: ['8'], backendDOMNodeId: 7, properties: [prop('focusable', true), prop('focused', true)] },
    { nodeId: '8', role: v('StaticText'), name: v('Pears'), parentId: '7', childIds: ['10'], backendDOMNodeId: 8 },
    { nodeId: '10', role: v('InlineTextBox'), name: v('Pears'), parentId: '8', childIds: [], backendDOMNodeId: 8 },
    { nodeId: '9', role: v('status'), name: v(''), parentId: '2', childIds: [], backendDOMNodeId: 9, properties: [prop('live', 'polite')] },
  ];
  return nodes;
}

test('axSubtree flattens ignored nodes and inline text boxes and collects the text of every node', () => {
  const sub = axSubtree(tree(), 3);
  assert.deepEqual(sub.map((e) => [e.depth, e.role, e.text]), [[0, 'list', 'ApplesPears'], [1, 'listitem', 'Apples'], [2, 'StaticText', 'Apples'], [1, 'listitem', 'Pears'], [2, 'StaticText', 'Pears']]);
  assert.equal(axSubtree(tree(), 99), null, 'an element without an AX node is null');
});

test('axLines and axStructure: the comparable whole subtree and the announced structure', () => {
  const sub = axSubtree(tree(), 3);
  assert.deepEqual(axLines(sub, { rootRole: false }), ['root "Fruit"', '  listitem "" focusable=true', '    StaticText "Apples"', '  listitem "" focusable=true', '    StaticText "Pears"']);
  assert.equal(axLines(sub)[0], 'list "Fruit"');
  assert.deepEqual(axStructure(sub), ['root "Fruit"', '  listitem "" text="Apples"', '  listitem "" text="Pears"']);
  assert.deepEqual(axStructure(null), ['(not in the accessibility tree)']);
});

test('positive control: without the link the canvas node has no children and the structure differs', () => {
  const broken = axStructure(axSubtree(tree({ owned: false }), 3));
  const good = axStructure(axSubtree(tree(), 3));
  assert.deepEqual(broken, ['root "Fruit"']);
  assert.deepEqual(firstDifference(broken, good), { line: 1, got: '(missing)', want: '  listitem "" text="Apples"' });
  assert.equal(firstDifference(good, good), null);
});

test('axFocused finds the focused node (never the root web area) and whether it is under the canvas node', () => {
  assert.deepEqual(axFocused(tree(), 3), { role: 'listitem', name: '', underRoot: true });
  assert.deepEqual(axFocused(tree({ owned: false }), 3), { role: 'listitem', name: '', underRoot: false });
  assert.equal(axFocused(tree().map((n) => n.nodeId === '7' ? { ...n, properties: [] } : n), 3), null);
});
