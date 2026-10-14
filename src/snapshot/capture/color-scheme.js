/**
 * The colour scheme the page's form controls are drawn in (shared by the core capture and the engines bundle).
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

/**
 * The scheme the page's form controls are drawn in. `<meta name="color-scheme">` makes the document dark while the computed `color-scheme` stays `normal`; the image document
 * knows no such meta, so its controls would come out light.
 * @param {Document} doc @param {string} computed @returns {string}
 */
export function usedColorScheme(doc, computed) {
  if (computed && computed !== 'normal') return computed;
  return doc.querySelector('meta[name="color-scheme" i]')?.getAttribute('content')?.trim() || computed;
}
