import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitList, syncDeclarations, transitionGuard } from '../../../src/live/scroll-sync.js';

const SHADOW = 'inset 0 0 0 0 transparent';
const IMAGE = 'linear-gradient(transparent, transparent)';

test('splitList: top-level commas only', () => {
  assert.deepEqual(splitList('linear-gradient(rgb(0, 0, 0), red), url("a,b.png")'), ['linear-gradient(rgb(0, 0, 0), red)', 'url("a,b.png")']);
  assert.deepEqual(splitList('scroll'), ['scroll']);
});

test('syncDeclarations: a plain scroller gets the transparent inset shadow and a transparent local image', () => {
  assert.deepEqual(syncDeclarations({ boxShadow: 'none', backgroundImage: 'none', backgroundAttachment: 'scroll' }), {
    'box-shadow': SHADOW, 'background-image': IMAGE, 'background-attachment': 'local', 'background-clip': 'border-box',
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

test('syncDeclarations: the added bottom layer keeps the clip the background colour had', () => {
  assert.equal(syncDeclarations({ boxShadow: 'none', backgroundImage: 'none', backgroundAttachment: 'scroll', backgroundClip: 'padding-box' })['background-clip'], 'padding-box');
  const two = syncDeclarations({ boxShadow: 'none', backgroundImage: 'url("a.png"), url("b.png")', backgroundAttachment: 'scroll', backgroundClip: 'content-box, border-box, padding-box' });
  assert.equal(two['background-clip'], 'content-box, border-box, border-box', 'the colour was clipped by the second (bottom) layer, not by the cycled third value');
});

test('transitionGuard: a transition that covers box-shadow is held for box-shadow alone (appended at 0s, delays aligned); none otherwise', () => {
  assert.deepEqual(transitionGuard({ transitionProperty: 'all', transitionDuration: '0.3s', transitionDelay: '0s' }), {
    'transition-property': 'all, box-shadow', 'transition-duration': '0.3s, 0s', 'transition-delay': '0s, 0s',
  });
  assert.deepEqual(transitionGuard({ transitionProperty: 'opacity, box-shadow, color', transitionDuration: '1s, 200ms', transitionDelay: '0.1s' }), {
    'transition-property': 'opacity, box-shadow, color, box-shadow', 'transition-duration': '1s, 200ms, 1s, 0s', 'transition-delay': '0.1s, 0.1s, 0.1s, 0s',
  });
  assert.ok(transitionGuard({ transitionProperty: 'box-shadow', transitionDuration: '0s', transitionDelay: '50ms' }), 'a delay alone makes a transition');
  assert.equal(transitionGuard({ transitionProperty: 'all', transitionDuration: '0s', transitionDelay: '0s' }), null, 'the initial value: no transition');
  assert.equal(transitionGuard({ transitionProperty: 'opacity, color', transitionDuration: '1s', transitionDelay: '0s' }), null);
  assert.equal(transitionGuard({ transitionProperty: 'none', transitionDuration: '1s', transitionDelay: '0s' }), null);
});
