import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleFontMarkup, simpleFontSheet } from '../../../src/snapshot/capture/font-subsets.js';

const face = (range, url) => `@font-face{font-family:Demo;src:url("${url}");${range ? 'unicode-range:'+range+';' : ''}}`;
const latin = face('U+0-FF', 'latin'), thai = face('U+E01-E5B', 'thai');
const css = latin + thai;
test('CSSOM and source Unicode ranges, multiple intervals, metrics and unrecognized descriptors', () => {
  const keep = latin + face('U+0000-00FF', 'padded') + face('U+1F300-1F6FF,U+2012', 'punctuation')
    + face('U+6C34', 'ic') + face('U+012?', 'wildcard') + face(null, 'all')
    + face('U+1234567', 'invalid') + face('U+BB-AA', 'reversed') + face('U+FF', 'src;unicode-range: U+0E00-0E5B');
  assert.equal(simpleFontSheet(keep + thai), keep);
  assert.equal(simpleFontSheet(`@layer skin{${css}}`), `@layer skin{${latin}}`);
  assert.equal(simpleFontSheet(latin), null);
});

test('literal generated text and simple case transforms are covered; unknown generators retain the full stylesheet', () => {
  const basic = 'p::before{content:"Hello!"}a{text-transform:uppercase}';
  assert.equal(simpleFontSheet(css + basic), latin + basic);
  for (const rule of ['p::before{content:"ไทย"}', 'p::before{content:"\\e01"}', 'p::after{content:attr(title)}',
    'p::before{content:var(--label)}', 'p::before{content:counter(chapter)}', 'p{text-transform:uppercase full-width}',
    'p{text-transform:math-auto}', 'p{text-transform:var(--case)}', 'p{display:list-item}', 'p{hyphens:auto}', 'p{text-emphasis-style:sesame}']) {
    assert.equal(simpleFontSheet(css + rule), null, rule);
  }
});

test('each serialized tile is rechecked after editable state, flattened shadow text and language changes', () => {
  assert.ok(simpleFontMarkup('<div lang="en-US"><input value="Nightjar"/></div>', ''));
  assert.ok(simpleFontMarkup('<div lang="it-IT">È già pronto, sì. Perché? Più tardi però.</div>', ''));
  assert.ok(simpleFontMarkup('<p lang="it" style="text-transform:uppercase">à è é ì ò ù</p>', ''));
  assert.equal(simpleFontMarkup('<p style="-webkit-locale:&quot;tr&quot;">i</p>', ''), false);
  for (const mark of ['<div>ไทย</div>', '<input value="ไทย" />', '<div>e\u0301</div>', '<div>🪶</div>', '<div lang="tr">i</div>',
    '<input type="date"/>', '<ul><li>a</li></ul>', '<q>text</q>', '<style>p:after{content:"x"}</style>',
    '<p style="text-transform: uppercase full-width;">A</p>', '<p style="content: &quot;\\e01&quot;;"></p>', '<p>&#3585;</p>']) {
    assert.equal(simpleFontMarkup(mark, ''), false, mark);
  }
  assert.ok(simpleFontMarkup('<div>ASCII again</div>', '.pseudo:before{content:"Hi"}'));
  assert.equal(simpleFontMarkup('<div>ASCII</div>', '.pseudo:before{content:counter(c)}'), false);
});

test('a different weight, family, metric override or rule scope cannot replace a face in the font matcher', () => {
  for (const other of [latin.replace('Demo;', 'Other;'), latin.replace('src:', 'font-weight:700;src:'),
    latin.replace('src:', 'ascent-override:85%;src:'), '@layer other{'+latin+'}']) {
    assert.equal(simpleFontSheet(thai + other), null);
  }
});
