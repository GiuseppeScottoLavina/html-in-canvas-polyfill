import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foregroundOn, luminance, over, rangeSkin, tintWithContrast, toggleSkin, withLuminance, popupGlyph, spinGlyph } from '../../../src/snapshot/capture/webkit-skins.js';
import { accentPalette, adjustLuminance, geckoProgressSkin, geckoRangeSkin, geckoToggleSkin } from '../../../src/snapshot/capture/gecko-skins.js';
import { webkitBarColors, webkitBarGeometry } from '../../../src/snapshot/capture/webkit-bars.js';
import { meterRegion, popupPadding } from '../../../src/snapshot/capture/native-controls.js';

const near = (a, b, tol = 1.5) => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= tol);

test('WebKit tint: an authored accent moves to luminance 0.5 (measured Playwright WebKit 26.5: #79efff light -> 101,202,216; #888 dark -> 188; black dark -> 204,183,180; gamut clips)', () => {
  assert.ok(near(tintWithContrast([121, 239, 255, 1], false, true), [101, 202, 216]));
  assert.ok(near(tintWithContrast([255, 255, 0, 1], false, true), [194, 194, 0]));
  assert.ok(near(tintWithContrast([136, 136, 136, 1], true, true), [188, 188, 188]));
  assert.ok(near(tintWithContrast([0, 0, 0, 1], true, true), [204, 183, 180], 2));
  assert.ok(near(tintWithContrast([255, 136, 0, 1], true, true), [255, 153, 0], 2));
  assert.deepEqual(tintWithContrast([0, 0, 255, 1], true, true).slice(0, 3).map(Math.round), [0, 0, 255]);
  assert.deepEqual(tintWithContrast([255, 255, 0, 1], false, false), [255, 255, 0, 1], 'the system accent is used as it is');
  assert.ok(Math.abs(luminance(withLuminance([121, 239, 255, 1], 0.5)) - 0.5) < 0.005);
});

test('WebKit indicator: white on a background at the 0.5 threshold (regression: the accent radio dot came out black)', () => {
  assert.deepEqual(foregroundOn(tintWithContrast([121, 239, 255, 1], false, true)), [255, 255, 255, 1]);
  assert.deepEqual(foregroundOn([255, 255, 255, 1]), [0, 0, 0, 1]);
  assert.deepEqual(over([0, 0, 0, 0.5], [255, 255, 255, 1]).map(Math.round), [128, 128, 128, 1]);
});

test('WebKit skins: checkbox corner 5.5/16, check / dot / bar, range thumb 24 x 16 at ratio x (w - 24), track inset 1 px', () => {
  const p = { canvas: [255, 255, 255, 1], controlBg: [255, 255, 255, 1], secondaryLabel: [0, 0, 0, 0.5], opaqueFill: [230, 230, 230, 1] };
  const cb = toggleSkin(16, 16, { type: 'checkbox', checked: true, indeterminate: false, disabled: false, tint: [0, 122, 255, 1] }, /** @type {any} */ (p));
  assert.match(cb, /rx="5\.5"/);
  assert.match(cb, /<path transform="translate\(/);
  assert.match(toggleSkin(16, 16, { type: 'radio', checked: true, indeterminate: false, disabled: false, tint: [0, 122, 255, 1] }, /** @type {any} */ (p)), /<circle cx="8" cy="8" r="2\.4"/);
  assert.match(toggleSkin(16, 16, { type: 'checkbox', checked: false, indeterminate: false, disabled: false, tint: [0, 122, 255, 1] }, /** @type {any} */ (p)), /stroke-width="1\.5"/);
  const r = rangeSkin(129, 16, { ratio: 0.3, disabled: false, tint: [0, 122, 255, 1] }, /** @type {any} */ (p));
  assert.match(r, /<rect x="31\.5" y="0" width="24" height="16" rx="8"/, 'thumb at 0.3 x 105');
  assert.match(r, /<rect x="1" y="4" width="127" height="8" rx="4" fill="rgba\(230,230,230,1\)"/);
  assert.match(r, /viewBox="-3 -3 135 22"/, 'room for the thumb shadow');
});

test('WebKit menu list: internal padding by control size; glyph 0.55 em wide at the end padding', () => {
  assert.deepEqual(popupPadding(11), { top: 2, right: 23, bottom: 3, left: 8 });
  assert.equal(popupPadding(10).left, 10);
  assert.equal(popupPadding(16).right, 26);
  assert.match(popupGlyph(80, 20, 13, 8, [0, 0, 0, 1]), /translate\(64\.85 /);
  assert.match(spinGlyph({ x: 5, y: 2, w: 146, h: 17 }, false, /** @type {any} */ ({ label: [0, 0, 0, 1], quinaryLabel: [0, 0, 0, 0.05], quaternaryLabel: [0, 0, 0, 0.1] })), /rx="4\.25"/);
});

test('meter regions follow the HTML spec (optimum above high, below low, or in the middle)', () => {
  const m = (value, low, high, optimum) => meterRegion(/** @type {any} */ ({ value, low, high, optimum }));
  assert.equal(m(55, 30, 70, 90), 'suboptimal');
  assert.equal(m(15, 30, 70, 90), 'even-less-good');
  assert.equal(m(80, 30, 70, 90), 'optimum');
  assert.equal(m(0.9, 0, 1, 0.5), 'optimum');
  assert.equal(m(10, 30, 70, 50), 'suboptimal');
});

test('Gecko accent: RelativeLuminanceUtils::Adjust and the palette shades (live: #79efff checked radio ring 0,90,99)', () => {
  const a = accentPalette([121, 239, 255, 1], [255, 255, 255, 1], true);
  assert.ok(near(a.fg, [0, 90, 99], 2), JSON.stringify(a.fg));
  assert.deepEqual(accentPalette([0, 122, 255, 1], [255, 255, 255, 1], false).fg, [255, 255, 255, 1]);
  assert.ok(luminance(a.darker) < luminance(a.dark) && luminance(a.dark) < luminance(a.accent));
  const half = adjustLuminance([200, 100, 50, 1], 0.1);
  assert.ok(Math.abs(luminance(half) - 0.1) < 0.01);
});

test('Gecko skins: checkbox radius 4 with a 1 px border, check polyline x side/14, range thumb 20 px at ratio x (w - 20), meter 12 px radius 6', () => {
  const p = /** @type {any} */ ({ dark: false, border: [143, 143, 157, 1], field: [255, 255, 255, 1], disabledField: [255, 255, 255, 0.5], disabledBorder: [199, 199, 206, 1], hoverBorder: [103, 103, 116, 1], activeBorder: [72, 72, 81, 1] });
  const acc = accentPalette([0, 122, 255, 1], [255, 255, 255, 1], false);
  assert.match(geckoToggleSkin(14, 14, { type: 'checkbox', checked: false, indeterminate: false, disabled: false, accent: acc }, p), /rx="3\.5" fill="rgba\(255,255,255,1\)" stroke="rgba\(143,143,157,1\)" stroke-width="1"/);
  assert.match(geckoToggleSkin(14, 14, { type: 'checkbox', checked: true, indeterminate: false, disabled: false, accent: acc }, p), /d="M10\.5 3\.9L5\.7 9\.6L3\.1 7"/);
  assert.match(geckoToggleSkin(14, 14, { type: 'checkbox', checked: false, indeterminate: false, disabled: false, hover: true, accent: acc }, p), /stroke="rgba\(103,103,116,1\)"/);
  assert.match(geckoRangeSkin(130, 20, { ratio: 0.5, disabled: false, accent: acc }), /<rect x="56" y="1" width="18" height="18" rx="9"/);
  assert.match(geckoProgressSkin(80, 16, { meter: true, position: 0.5, region: 'optimum', accent: acc }), /y="2\.5" width="79" height="11" rx="5\.5" fill="rgba\(0,171,96,1\)"/);
});

test('WebKit classic bars (measured Safari 27): 11 px lane 3 px into a 17 px gutter, inset 3 px at both ends, knob >= 18 px; light black 52 % / dark white 57 % knob', () => {
  const g = webkitBarGeometry(17, 592, 592, 10500, 300);
  assert.deepEqual([g.laneStart, g.laneLength, g.across, g.thickness], [3, 586, 3, 11]);
  assert.ok(Math.abs(g.knobLength - 586 * (592 / 10500)) < 0.01);
  assert.ok(Math.abs(g.knobStart - (3 + (300 / (10500 - 592)) * (586 - g.knobLength))) < 0.01);
  assert.equal(webkitBarGeometry(17, 100, 100, 100000, 0).knobLength, 18);
  assert.equal(webkitBarColors(false).knob, 'rgba(0,0,0,0.522)');
  assert.equal(webkitBarColors(true).knob, 'rgba(255,255,255,0.573)');
});

test('checkbox/radio baseline: appearance:none moves the baseline to the margin edge; the clone drops by the engine inset + bottom margin (regression: labels grew 3 px per row)', async () => {
  const { toggleBaseline } = await import('../../../src/snapshot/capture/native-controls.js');
  assert.equal(toggleBaseline({ verticalAlign: 'baseline', marginBottom: '3px' }, 2), 'vertical-align:-5px!important;');
  assert.equal(toggleBaseline({ verticalAlign: '2px', marginBottom: '3px' }, 1), 'vertical-align:-2px!important;');
  assert.equal(toggleBaseline({ verticalAlign: 'middle', marginBottom: '3px' }, 1), '');
});

// ---- ADR X-12: Firefox listbox bar, hover / pressed / focus states, Safari inactive window and pressed looks
import { geckoBoxSkin, geckoListboxBar, geckoListboxThumb } from '../../../src/snapshot/capture/gecko-skins.js';
import { inactiveTints, pressedShade } from '../../../src/snapshot/capture/webkit-skins.js';
import { notePress, pressOnThumb, themedStateChange } from '../../../src/util/native-states.js';

test('Gecko listbox thumb (measured Firefox 157: track 82, client 82 / scroll 122 -> drawn 48 px from 1.5 to 80.5; scroll 242 -> 23 px; >= 27 px frame)', () => {
  assert.equal(geckoListboxThumb({ track: 82, client: 82, scroll: 82, offset: 0 }), null, 'nothing scrolls: track only');
  const a = /** @type {any} */ (geckoListboxThumb({ track: 82, client: 82, scroll: 122, offset: 0 }));
  assert.ok(Math.abs(a.start - 1.5) < 0.01 && Math.abs(a.length - 48) < 1.2);
  const b = /** @type {any} */ (geckoListboxThumb({ track: 82, client: 82, scroll: 122, offset: 40 }));
  assert.ok(Math.abs(b.start + b.length - 80.5) < 0.6, 'at the end it reaches 1.5 px before the track end');
  const c = /** @type {any} */ (geckoListboxThumb({ track: 82, client: 82, scroll: 242, offset: 80 }));
  assert.ok(Math.abs(c.length - 23) < 1.2 && Math.abs(c.start - 29.5) < 1);
  assert.equal(/** @type {any} */ (geckoListboxThumb({ track: 102, client: 102, scroll: 602, offset: 0 })).length, 24, 'minimum frame 27 px');
});

test('Gecko listbox gutter: inner edge / second line / track / outer edge and a 6 px rounded thumb 2 px from the outer edge (light 231/248/250/237, 194; dark 51/46/46/49, 117)', () => {
  const light = geckoListboxBar({ x: 100, y: 2, w: 11, h: 82 }, { start: 1.5, length: 48 }, false);
  for (const v of [231, 248, 250, 237, 194]) assert.match(light, new RegExp(`rgba\\(${v},${v},${v},1\\)`));
  assert.match(light, /<rect x="103" y="3.5" width="6" height="48" rx="3"/);
  const dark = geckoListboxBar({ x: 100, y: 2, w: 11, h: 82 }, null, true);
  assert.match(dark, /rgba\(51,51,51,1\)/);
  assert.doesNotMatch(dark, /rx="3"/, 'no thumb when nothing scrolls');
  assert.match(geckoListboxBar({ x: 0, y: 0, w: 11, h: 50 }, null, false, true), /<rect x="10" y="0" width="1" height="50" fill="rgba\(231/, 'rtl: the inner edge faces the content on the right');
});

test('Gecko focus ring: 2 px of the accent centred on the edge plus 1 px white outside; the skin covers the box grown by 2 px', () => {
  const p = /** @type {any} */ ({ border: [143, 143, 157, 1], field: [255, 255, 255, 1], face: [233, 233, 237, 1] });
  const svg = geckoBoxSkin(100, 20, { field: true, disabled: false }, p, '', [0, 122, 255, 1]);
  assert.match(svg, /viewBox="-2 -2 104 24"/);
  assert.match(svg, /stroke="rgba\(0,122,255,1\)" stroke-width="2"/);
  assert.match(svg, /stroke="#fff" stroke-width="1"/);
  assert.match(geckoBoxSkin(100, 20, { field: true, disabled: false }, p), /viewBox="0 0 100 20"/);
});

test('Gecko system accent: the OS shades (measured 0,122,255 -> hover 0,102,222, pressed 0,81,190); an authored accent keeps the luminance scaling', () => {
  const sys = accentPalette([0, 122, 255, 1], [255, 255, 255, 1], false);
  assert.deepEqual(sys.dark.slice(0, 3), [0, 102, 222]);
  assert.deepEqual(sys.darker.slice(0, 3), [0, 81, 190]);
  const auth = accentPalette([0, 122, 255, 1], [255, 255, 255, 1], true);
  assert.notDeepEqual(auth.dark.slice(0, 3), [0, 102, 222]);
});

test('WebKit inactive window (measured Safari 27): checked fill 243 / 40, bars 170 / 102 over Canvas; pressed blends 20 % to black / white', () => {
  const light = inactiveTints(/** @type {any} */ ({ dark: false, canvas: [255, 255, 255, 1] }));
  assert.ok(near(light.fill, [243, 243, 243], 1) && near(light.bar, [170, 170, 170], 1));
  const dark = inactiveTints(/** @type {any} */ ({ dark: true, canvas: [30, 30, 30, 1] }));
  assert.ok(near(dark.fill, [40, 40, 40], 1) && near(dark.bar, [102, 102, 102], 1));
  assert.ok(near(pressedShade([235, 235, 235, 1], false), [188, 188, 188], 1));
  assert.ok(near(pressedShade([0, 122, 255, 1], false), [0, 98, 204], 1.5));
  assert.ok(near(pressedShade([0, 122, 255, 1], true), [51, 149, 255], 1.5));
  assert.equal(+pressedShade([0, 0, 0, 0.5], false)[3].toFixed(2), 0.6, 'the 50 % border of a pressed empty box reads 60 %');
  const cb = toggleSkin(16, 16, { type: 'checkbox', checked: true, indeterminate: false, disabled: false, tint: light.fill, ink: [0, 0, 0, 0.85] }, /** @type {any} */ ({ canvas: [255, 255, 255, 1], controlBg: [255, 255, 255, 1] }));
  assert.match(cb, /fill="rgba\(0,0,0,0.85\)"/, 'inactive mark in the label colour');
});

test('native interaction states: Gecko themes hover on fields and toggles and press on buttons / range; WebKit only press; slider press counts only on the thumb (value before the press)', () => {
  const el = (/** @type {string} */ localName, type = '') => /** @type {any} */ ({ localName, type });
  assert.ok(themedStateChange(el('input', 'text'), 'hover', 'gecko'));
  assert.ok(themedStateChange(el('select'), 'hover', 'gecko'));
  assert.ok(!themedStateChange(el('input', 'text'), 'active', 'gecko'));
  assert.ok(themedStateChange(el('button'), 'active', 'gecko'));
  assert.ok(!themedStateChange(el('button'), 'hover', 'webkit'));
  assert.ok(themedStateChange(el('input', 'checkbox'), 'active', 'webkit'));
  assert.ok(!themedStateChange(el('div'), 'hover', 'gecko'));
  const range = /** @type {any} */ ({ localName: 'input', type: 'range', value: '30', min: '', max: '', offsetWidth: 129, getBoundingClientRect: () => ({ left: 239, width: 129 }) });
  notePress(range, { x: 304, y: 23 });
  range.value = '50';
  assert.equal(pressOnThumb(range, 0.5, 24, false), false, 'a press on the track (thumb then at 30 %) is not a thumb press although the thumb jumped under it');
  notePress(range, { x: 300, y: 23 }); // value 50 now: thumb 291.5-315.5
  assert.equal(pressOnThumb(range, 0.5, 24, false), true);
  assert.equal(pressOnThumb(/** @type {any} */ ({}), 0.5, 24, false), true, 'unknown press point: thumb');
});
