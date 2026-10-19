import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitList, syncDeclarations } from '../../../src/live/scroll-sync.js';

const SHADOW = 'inset 0 0 0 0 transparent';
const IMAGE = 'linear-gradient(transparent, transparent)';

test('splitList: top-level commas only', () => {
  assert.deepEqual(splitList('linear-gradient(rgb(0, 0, 0), red), url("a,b.png")'), ['linear-gradient(rgb(0, 0, 0), red)', 'url("a,b.png")']);
  assert.deepEqual(splitList('scroll'), ['scroll']);
});

test('syncDeclarations: a plain scroller gets the transparent inset shadow and a transparent local image', () => {
  assert.deepEqual(syncDeclarations({ boxShadow: 'none', backgroundImage: 'none', backgroundAttachment: 'scroll' }), {
    'box-shadow': SHADOW, 'background-image': IMAGE, 'background-attachment': 'local',
  });
});

test('syncDeclarations: the author values are kept in front of the added layers', () => {
  const d = syncDeclarations({ boxShadow: 'rgba(0, 0, 0, 0.3) 0px 2px 6px 0px', backgroundImage: 'url("a.png"), linear-gradient(red, blue)', backgroundAttachment: 'fixed' });
  assert.equal(d['box-shadow'], `rgba(0, 0, 0, 0.3) 0px 2px 6px 0px, ${SHADOW}`);
  assert.equal(d['background-image'], `url("a.png"), linear-gradient(red, blue), ${IMAGE}`);
  assert.equal(d['background-attachment'], 'fixed, fixed, local', 'the author attachments repeat over their layers, the added layer is local');
});

test('syncDeclarations: an author inset shadow or local image is enough on its own; both = nothing to add', () => {
  const inset = syncDeclarations({ boxShadow: 'rgb(0, 0, 0) 0px 0px 3px 0px inset', backgroundImage: 'none', backgroundAttachment: 'scroll' });
  assert.equal(inset['box-shadow'], undefined);
  assert.equal(inset['background-image'], IMAGE);
  const local = syncDeclarations({ boxShadow: 'none', backgroundImage: 'url("x.png")', backgroundAttachment: 'local' });
  assert.equal(local['background-image'], undefined);
  assert.equal(local['box-shadow'], SHADOW);
  assert.equal(syncDeclarations({ boxShadow: 'rgb(0, 0, 0) 0px 0px 3px 0px inset', backgroundImage: 'url("x.png")', backgroundAttachment: 'local' }), null);
});
