// Node tests of the plugin folder contract (contract.mjs): what a plugin and plugins/_lib/ may import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPluginFolder, checkSharedLib } from '../contract.mjs';

/** a throwaway repository layout: plugins/demo, plugins/other, plugins/_lib, src/effects */
function layout(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'hic-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test('a plugin imports its own files, plugins/_lib/ and src/effects/no-target.js; anything else is a problem', async (t) => {
  const root = layout(t, {
    'plugins/demo/index.js': [
      "import { a } from './a.js';",
      "import { NO_TARGET } from '../../src/effects/no-target.js';",
      "import { lib } from '../_lib/lib.js';",
      "import { host } from '../../src/effects/index.js';",
      "import { other } from '../other/index.js';",
      "import x from 'some-package';",
    ].join('\n'),
    'plugins/demo/a.js': 'export const a = 1;',
    'plugins/_lib/lib.js': "import { NO_TARGET } from '../../src/effects/no-target.js';\nexport const lib = NO_TARGET;",
    'plugins/other/index.js': 'export const other = 1;',
    'src/effects/no-target.js': 'export const NO_TARGET = {};',
    'src/effects/index.js': 'export const host = 1;',
  });
  const imports = (await checkPluginFolder(join(root, 'plugins/demo'))).filter((p) => p.includes(' imports '));
  assert.deepEqual(imports.map((p) => /imports "([^"]+)"/.exec(p)?.[1]), ['../../src/effects/index.js', '../other/index.js', 'some-package']);
  assert.deepEqual(checkSharedLib(join(root, 'plugins/_lib')), []);
});

test('plugins/_lib/ is held to the same rules: it may not import a plugin or other modules of src/', (t) => {
  const root = layout(t, {
    'plugins/_lib/lib.js': "import { x } from '../demo/index.js';\nimport { y } from '../../src/effects/effect-host.js';\nexport const z = URL.createObjectURL;",
    'plugins/demo/index.js': 'export const x = 1;',
    'src/effects/effect-host.js': 'export const y = 1;',
  });
  const problems = checkSharedLib(join(root, 'plugins/_lib'));
  assert.equal(problems.length, 3, problems.join('\n'));
  assert.ok(problems.some((p) => /blob: URLs/.test(p)));
});
