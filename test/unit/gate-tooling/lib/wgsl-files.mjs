// Every .wgsl file of plugins/, as the build inlines it (scripts/wgsl-strip.mjs minifyWgsl). The browser test compiles each one, from source and
// minified; test/unit/gate-tooling/wgsl-strip.test.mjs fails when this list and the files on disk differ.
export const WGSL_FILES = [
  'plugins/_template/offset.wgsl',
  'plugins/cloth/cloth.wgsl',
  'plugins/crt/crt.wgsl',
  'plugins/disintegrate/disintegrate.wgsl',
  'plugins/glitch/glitch.wgsl',
  'plugins/holo-card/holo-card.wgsl',
  'plugins/ink/advect.wgsl',
  'plugins/ink/ink.wgsl',
  'plugins/liquid-glass/liquid-glass.wgsl',
  'plugins/page-curl/blur.wgsl',
  'plugins/page-curl/page-curl.wgsl',
  'plugins/shatter/shatter.wgsl',
  'plugins/water/water.wgsl',
];
