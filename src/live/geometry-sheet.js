/**
 * Rule-based geometry writes: one CSSStyleRule per drawn element in a polyfill-owned adopted sheet (docs/ARCHITECTURE.md ADR-F).
 * Module: live (src/live/*).
 */

/** @typedef {import('../contracts/types.js').GeometryRules} GeometryRules */

/** Every sheet the polyfill creates (layer, geometry, selector mirror): observers and the CSS collector skip them. */
const ownedSheets = new WeakSet();

/** @param {CSSStyleSheet} sheet @returns {CSSStyleSheet} the same sheet, registered as polyfill-owned */
export function markOwnedSheet(sheet) {
  ownedSheets.add(sheet);
  return sheet;
}

/** @param {CSSStyleSheet} sheet @returns {boolean} */
export function isOwnedSheet(sheet) {
  return ownedSheets.has(sheet);
}

const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * set() inserts the rule on first use and later only calls rule.style.setProperty(name, value, 'important') for the declarations that changed (no sheet re-parse, no style attribute, no cssText pollution, no CSP style-src issue).
 * remove() deletes the rule. owns(sheet) is how the stylesheet observer and the CSS collector skip the polyfill's own sheets.
 * @param {CSSStyleSheet} sheet  constructed sheet already adopted into the root
 * @returns {GeometryRules}
 */
export function createGeometryRules(sheet) {
  markOwnedSheet(sheet);
  /** @type {Map<string, {rule: CSSStyleRule, written: Map<string, string>}>} */
  const rules = new Map();

  /** @param {string} key */
  function insert(key) {
    if (!KEY_PATTERN.test(key)) throw new TypeError(`invalid geometry key "${key}"`);
    const index = sheet.insertRule(`[data-hic-hit="${key}"]{}`, sheet.cssRules.length);
    const entry = { rule: /** @type {CSSStyleRule} */ (sheet.cssRules[index]), written: new Map() };
    rules.set(key, entry);
    return entry;
  }

  return {
    set(key, declarations) {
      const entry = rules.get(key) ?? insert(key);
      const style = entry.rule.style;
      for (const [name, value] of Object.entries(declarations)) {
        if (entry.written.get(name) === value) continue;
        style.setProperty(name, value, 'important');
        entry.written.set(name, value);
      }
      for (const name of [...entry.written.keys()]) {
        if (name in declarations) continue;
        style.removeProperty(name);
        entry.written.delete(name);
      }
    },
    remove(key) {
      const entry = rules.get(key);
      if (!entry) return;
      rules.delete(key);
      const list = sheet.cssRules;
      for (let i = 0; i < list.length; i++) {
        if (list[i] === entry.rule) { sheet.deleteRule(i); return; }
      }
    },
    owns: (candidate) => ownedSheets.has(candidate),
  };
}
