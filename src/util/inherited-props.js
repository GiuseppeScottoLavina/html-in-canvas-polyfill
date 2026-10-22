/**
 * The CSS inherited properties as longhands (pointer-events left out: the layer owns it), plus container-type / container-name.
 * Module: util.
 */

/**
 * INHERITED properties that the children of a canvas no longer inherit from it once they live in its layer (they are siblings now): the CSS inherited-property list
 * as longhands, minus pointer-events (the layer owns it). container-type/name are not inherited but must sit on the layer for @container rules of the canvas to reach
 * the children (live/presentation.js copies them all; schedule/observers/mutation-observer.js compares them).
 */
export const INHERITED_PROPS = Object.freeze([
  'font-family', 'font-size', 'font-size-adjust', 'font-weight', 'font-style', 'font-stretch', 'font-kerning', 'font-optical-sizing', 'font-palette', 'font-language-override',
  'font-synthesis-weight', 'font-synthesis-style', 'font-synthesis-small-caps', 'font-feature-settings', 'font-variation-settings',
  'font-variant-caps', 'font-variant-east-asian', 'font-variant-emoji', 'font-variant-ligatures', 'font-variant-numeric', 'font-variant-position',
  'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-align-last', 'text-indent', 'text-justify', 'text-orientation', 'text-rendering', 'text-size-adjust',
  'text-transform', 'text-shadow', 'text-wrap-mode', 'text-wrap-style', 'text-underline-offset', 'text-underline-position', 'text-decoration-skip-ink',
  'text-emphasis-style', 'text-emphasis-color', 'text-emphasis-position', 'white-space-collapse', 'word-break', 'overflow-wrap', 'line-break', 'hyphens', 'hyphenate-character',
  'tab-size', 'quotes', 'orphans', 'widows', 'hanging-punctuation', 'ruby-position',
  'color', '-webkit-text-fill-color', '-webkit-text-stroke-color', '-webkit-text-stroke-width', 'accent-color', 'color-scheme', 'caret-color', 'print-color-adjust',
  'cursor', 'image-rendering', 'image-orientation', 'forced-color-adjust', 'scrollbar-color', 'paint-order', 'empty-cells', 'caption-side', 'border-collapse', 'border-spacing',
  'list-style-type', 'list-style-position', 'list-style-image', 'visibility', 'direction', 'writing-mode', 'fill', 'stroke', 'color-interpolation', 'shape-rendering',
  'container-type', 'container-name',
]);

