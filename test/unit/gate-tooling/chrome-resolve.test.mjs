// Where the harness finds Chrome on each platform (test/harness/lib/chrome.mjs), checked without a browser: the platform and the file system are parameters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHROME_APPS, chromeCandidates, resolveChrome } from '../../harness/lib/chrome.mjs';

const WIN_ENV = { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
const only = (/** @type {string[]} */ ...present) => (/** @type {string} */ p) => present.includes(p);

test('macOS: the application bundles, as before', () => {
  assert.deepEqual(chromeCandidates('darwin', {}), { stable: [CHROME_APPS.stable], canary: [CHROME_APPS.canary] });
  assert.equal(resolveChrome('stable', { platform: 'darwin', env: {}, exists: only(CHROME_APPS.stable) }), CHROME_APPS.stable);
});

test('Windows: Program Files, Program Files (x86), then the per-user install; Canary is per-user only', () => {
  const c = chromeCandidates('win32', WIN_ENV);
  assert.deepEqual(c.stable, ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe']);
  assert.deepEqual(c.canary, ['C:\\Users\\me\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe']);
  assert.equal(resolveChrome('stable', { platform: 'win32', env: WIN_ENV, exists: only(c.stable[2]) }), c.stable[2]);
  assert.deepEqual(chromeCandidates('win32', {}), { stable: [], canary: [] }, 'no environment, no guess');
});

test('Linux: the package locations first, the macOS path (where the CI image links the browser) last', () => {
  const c = chromeCandidates('linux', {});
  assert.equal(c.stable[0], '/opt/google/chrome/chrome');
  assert.equal(c.stable.at(-1), CHROME_APPS.stable);
  assert.equal(resolveChrome('stable', { platform: 'linux', env: {}, exists: only('/usr/bin/google-chrome', CHROME_APPS.stable) }), '/usr/bin/google-chrome');
});

test('HIC_CHROME_PATH overrides the stable channel only; an explicit path is used as given', () => {
  const env = { ...WIN_ENV, HIC_CHROME_PATH: 'D:\\tools\\chrome\\chrome.exe' };
  const all = () => true;
  assert.equal(resolveChrome('stable', { platform: 'win32', env, exists: all }), 'D:\\tools\\chrome\\chrome.exe');
  assert.equal(resolveChrome('canary', { platform: 'win32', env, exists: all }), chromeCandidates('win32', env).canary[0]);
  assert.equal(resolveChrome('/x/chrome', { platform: 'linux', env, exists: only('/x/chrome') }), '/x/chrome');
});

test('nothing installed: a loud error that names every place it looked and the two ways out', () => {
  assert.throws(() => resolveChrome('stable', { platform: 'win32', env: WIN_ENV, exists: () => false }),
    (e) => e instanceof Error && e.message.includes('Program Files (x86)') && e.message.includes('--chrome=<path>') && e.message.includes('HIC_CHROME_PATH'));
  assert.throws(() => resolveChrome('/nope/chrome', { platform: 'linux', env: {}, exists: () => false }), /Chrome executable not found: \/nope\/chrome/);
});
