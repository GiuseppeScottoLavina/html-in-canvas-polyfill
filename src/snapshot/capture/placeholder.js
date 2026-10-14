/**
 * Hatched placeholder box for unsupported content.
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

import { MARK } from '../../contracts/events.js';
import { setInlineStyle } from './inline-style.js';

/** @typedef {import('../../contracts/types.js').Size} Size */
/** @typedef {import('../../contracts/types.js').UnsupportedEntry} UnsupportedEntry */

const HATCH = 'repeating-linear-gradient(45deg,#d8433c 0,#d8433c 3px,#fbe9e7 3px,#fbe9e7 9px)';
const MIN_SIDE = 12;

/**
 * A sized div (data-hic-node) with a hatched background and a title attribute naming the feature.
 * @param {Document} doc
 * @param {Omit<UnsupportedEntry, "t"|"count">} entry
 * @param {Size} size
 * @returns {Element}
 */
export function placeholderElement(doc, entry, size) {
  const box = doc.createElement('div');
  const w = Math.max(MIN_SIDE, Math.round(size.width * 100) / 100);
  const h = Math.max(MIN_SIDE, Math.round(size.height * 100) / 100);
  box.setAttribute(MARK.NODE_ATTR, '');
  box.setAttribute('title', `${entry.feature}: ${entry.message}`);
  setInlineStyle(box, `display:block;box-sizing:border-box;flex:none;width:${w}px;height:${h}px;border:1px solid #d8433c;background:${HATCH}`);
  return box;
}
