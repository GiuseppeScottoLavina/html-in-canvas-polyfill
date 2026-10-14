/**
 * WGSL loading of a plugin served as source (unit tests, native ES modules): each plugin's `wgsl.js` is
 * `export const wgsl = wgslLoader(import.meta.url);`, which fetches a .wgsl file next to that module, once per file. The build
 * (scripts/build.mjs) replaces the plugin's `wgsl.js` with a module that returns the .wgsl files of its folder as inlined strings, so a
 * built plugin never touches the network and never includes this module.
 */

/**
 * @param {string} base  import.meta.url of the plugin's wgsl.js
 * @returns {(file: string) => Promise<string>}  `file` is a .wgsl file of the plugin folder, e.g. 'water.wgsl'
 */
export function wgslLoader(base) {
  /** @type {Map<string, Promise<string>>} */
  const loads = new Map();
  return async function wgsl(file) {
    let load = loads.get(file);
    if (!load) {
      load = fetch(new URL(`./${file}`, base).href, { cache: 'no-store' }).then(async (response) => {
        if (!response.ok) throw new Error(`${file} fetch ${response.status}`);
        return response.text();
      });
      loads.set(file, load);
    }
    try {
      return await load;
    } catch (error) {
      loads.delete(file);
      throw error;
    }
  };
}
