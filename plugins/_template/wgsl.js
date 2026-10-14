/**
 * WGSL loader of this plugin. Served as source (unit tests, native ES modules) it fetches a .wgsl file next to this module, once per file.
 * The build (scripts/build.mjs) replaces this module with one that returns the .wgsl files of this folder as inlined strings, so a built
 * plugin never touches the network. Every plugin folder that ships .wgsl files carries a copy of this file (plugins/README.md).
 */

/** @type {Map<string, Promise<string>>} */
const loads = new Map();

/**
 * @param {string} file  a .wgsl file of this folder, e.g. 'water.wgsl'
 * @returns {Promise<string>}
 */
export async function wgsl(file) {
  let load = loads.get(file);
  if (!load) {
    load = fetch(new URL(`./${file}`, import.meta.url).href, { cache: 'no-store' }).then(async (response) => {
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
}
