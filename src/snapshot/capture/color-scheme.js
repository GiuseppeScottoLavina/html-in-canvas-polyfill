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

/**
 * Is the used colour scheme of `el` dark? Its computed `color-scheme` (or the document's `<meta name="color-scheme">`) offers dark, and light only when the user prefers dark.
 * Engines draw the dark look of their native parts (classic scrollbars) from it; a dark page background alone keeps the light look (measured Safari 27, Chrome 155).
 * @param {Window} win @param {Element} el @returns {boolean}
 */
export function darkSchemeOf(win, el) {
  const scheme = usedColorScheme(el.ownerDocument, win.getComputedStyle(el).colorScheme);
  return /\bdark\b/.test(scheme) && (!/\blight\b/.test(scheme) || win.matchMedia('(prefers-color-scheme: dark)').matches);
}
