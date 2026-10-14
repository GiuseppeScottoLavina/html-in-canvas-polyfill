/**
 * UI helpers shared by the example plugins (plugins/README.md: plugins/_lib/ is bundled into each plugin that imports it).
 */

/**
 * Adds a plugin's UI stylesheet to `doc` once: a `<style data-hic-effect-style="<name>">` in the head.
 * @param {Document} doc @param {string} name @param {string} css
 */
export function injectStyle(doc, name, css) {
  if (doc.querySelector(`style[data-hic-effect-style="${name}"]`)) return;
  const style = doc.createElement('style');
  style.dataset.hicEffectStyle = name;
  style.textContent = css;
  (doc.head || doc.documentElement).append(style);
}
