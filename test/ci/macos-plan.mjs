// Which browser suites the hosted macOS runner judges (.github/workflows/ci-macos.yml) and which stay on a local Mac, with the measured reason.
//
// The hosted runner (GitHub macos-15, Apple M1 virtual machine, 3 vCPU) has a logged-in desktop, a 60 Hz virtual display (1024 x 768 at start, switched to
// 1600 x 1200 by test/ci/macos-display.mjs; no HiDPI mode, so gates without a DPR of their own run at --force-device-scale-factor=2 through HIC_GATE_DPR) and an
// "Apple Paravirtual device" GPU (ANGLE Metal; WebGPU offers an adapter). Everything not listed in LOCAL_ONLY runs there, so a new gate or mutant runs in CI
// by default instead of being left out silently.
//
//   node test/ci/macos-plan.mjs --gates                   the gates the runner runs, comma-separated (for run-all.mjs --only)
//   node test/ci/macos-plan.mjs --mutants=all|pr          the mutants the runner runs (every gate of the mutant runs there); `pr` is one per gate
//   node test/ci/macos-plan.mjs --report                  what is NOT run on the runner and why: GitHub warnings and a step-summary table
//   node test/ci/macos-plan.mjs --local-gates | --local-mutants   the complement, for a local run (test/ci/local.mjs, `npm run test:local`)
import { readdirSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTANTS } from '../gates/mutants/mutants.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Suites and gates that stay on a local Mac: id -> the reason, measured on the hosted runner (2026-10-26, Chrome 156.0.8078.48, Canary 158.0.8125.0). */
export const LOCAL_ONLY = {
  'g-scroll-cadence': 'its cadence thresholds come from a 120 Hz display; on the runner\'s 60 Hz virtual display the live list moved in 61-74 % of the frames of the wheel stream (thresholds 70 % per case, 82 % on average)',
  'g-f1-form-effect': 'continuous WebGPU effects present no frames on the runner\'s virtual GPU (0 effect frames per second at every frame cap; the gate waits for frames and its watchdog ends it after 10 min)',
  'g-interposer-strong': 'the same: the CRT and water effects present no continuous frames on the runner\'s virtual GPU, the gate never finishes',
  'test:plugins': 'six of the nine plugin gallery tests need continuous effect frames (water, CRT, glitch, page-curl, shatter: 0 frames per second on the runner\'s virtual GPU)',
  'test:examples effect-plugin': 'its frame-cap check counts continuous effect frames (0 on the runner\'s virtual GPU); every other example and the documentation smoke pages run in CI',
  'test:native-effects': 'G-native-effects and G-native-interposer measure continuous effect frames over Canary\'s own implementation (0 per second on the runner\'s virtual GPU)',
  'test:wpt': 'on the runner 3 of the 237 files were unstable between repetitions (onpaint-css-animation, onpaint-post-tree-order, privacy/picture-images-ignored), which fails the gate (measured before 0.1.0-preview.7). It also takes 18 min and its native oracle, Chrome Canary, changes every day',
  'test:xbrowser stp': 'Safari Technology Preview is not installed on the runner image',
  'test:mobile': 'the iOS Simulator and the Android Emulator (the Android Emulator needs hardware virtualization, which the hosted macOS virtual machine does not offer)',
  'bench:compare': 'performance numbers are taken on the 120 Hz development machine (docs/PERFORMANCE-COMPARISON.md); a shared 3 vCPU virtual machine at 60 Hz would measure something else',
};

/** every gate file stem under test/gates (g-*.mjs) */
export const ALL_GATES = readdirSync(resolve(root, 'test/gates')).filter((f) => /^g-.*\.mjs$/.test(f)).map((f) => f.replace(/\.mjs$/, '')).sort();
/** @type {Record<string, string>} */
const local = LOCAL_ONLY;
export const CI_GATES = ALL_GATES.filter((g) => !local[g]);
/** mutants every gate of which runs on the runner */
export const CI_MUTANTS = MUTANTS.filter((m) => m.gates.every((g) => CI_GATES.includes(g)));
export const LOCAL_GATES = ALL_GATES.filter((g) => local[g]);
export const LOCAL_MUTANTS = MUTANTS.filter((m) => !CI_MUTANTS.includes(m));
/** the PR subset: per CI gate, the first mutant of the suite that targets it (every gate shown able to catch a seeded bug on every pull request) */
export const PR_MUTANTS = CI_GATES.map((g) => CI_MUTANTS.find((m) => m.gates.includes(g))).filter((m, i, a) => m && a.indexOf(m) === i);

const arg = (/** @type {string} */ k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.includes('--gates')) console.log(CI_GATES.join(','));
  else if (process.argv.includes('--local-gates')) console.log(LOCAL_GATES.join(','));
  else if (process.argv.includes('--local-mutants')) console.log(LOCAL_MUTANTS.map((m) => m.name).join(','));
  else if (arg('mutants')) console.log((arg('mutants') === 'pr' ? PR_MUTANTS : CI_MUTANTS).map((m) => /** @type {any} */ (m).name).join(','));
  else if (process.argv.includes('--report')) {
    const rows = [...Object.entries(LOCAL_ONLY), ...LOCAL_MUTANTS.map((m) => [`mutant ${m.name}`, `targets ${m.gates.filter((g) => !CI_GATES.includes(g)).join(', ')}, which runs locally only`])];
    for (const [id, why] of rows) console.log(`::warning title=Not run on the hosted macOS runner::${id}: ${why}`);
    const md = ['### Not run on the hosted macOS runner (run them locally: CONTRIBUTING.md, "Browser gates")', '', '| suite | why |', '| --- | --- |', ...rows.map(([id, why]) => `| ${id} | ${why} |`), ''].join('\n');
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
    console.log(`${rows.length} suites, gates and mutants are not run here; CI gates: ${CI_GATES.length} of ${ALL_GATES.length}; CI mutants: ${CI_MUTANTS.length} of ${MUTANTS.length}`);
  } else { console.error('usage: macos-plan.mjs --gates | --mutants=all|pr | --report | --local-gates | --local-mutants'); process.exit(2); }
}
