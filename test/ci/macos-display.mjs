// The main display of a macOS machine: its current mode, the modes it offers, and (with --min=WxH) a switch to the smallest mode at least that large, so
// that the 1400 x 900 windows of the gates fit on screen (a hosted macOS runner starts at 1024 x 768). Prints one JSON object; exits 1 when --min cannot be met.
//   node test/ci/macos-display.mjs [--min=1600x1000]
import { execFileSync } from 'node:child_process';

const PY = `import sys, json, Quartz
d = Quartz.CGMainDisplayID()
def desc(m):
    return {'w': Quartz.CGDisplayModeGetWidth(m), 'h': Quartz.CGDisplayModeGetHeight(m), 'pw': Quartz.CGDisplayModeGetPixelWidth(m), 'ph': Quartz.CGDisplayModeGetPixelHeight(m), 'hz': Quartz.CGDisplayModeGetRefreshRate(m)}
opts = {Quartz.kCGDisplayShowDuplicateLowResolutionModes: True}
modes = list(Quartz.CGDisplayCopyAllDisplayModes(d, opts) or [])
out = {'current': desc(Quartz.CGDisplayCopyDisplayMode(d)), 'modes': [desc(m) for m in modes]}
if len(sys.argv) > 2:
    w, h = int(sys.argv[1]), int(sys.argv[2])
    fit = sorted([m for m in modes if Quartz.CGDisplayModeGetWidth(m) >= w and Quartz.CGDisplayModeGetHeight(m) >= h], key=lambda m: (Quartz.CGDisplayModeGetWidth(m) * Quartz.CGDisplayModeGetHeight(m), -Quartz.CGDisplayModeGetPixelWidth(m)))
    if fit:
        err, cfg = Quartz.CGBeginDisplayConfiguration(None)
        Quartz.CGConfigureDisplayWithDisplayMode(cfg, d, fit[0], None)
        out['setError'] = Quartz.CGCompleteDisplayConfiguration(cfg, Quartz.kCGConfigurePermanently)
        out['after'] = desc(Quartz.CGDisplayCopyDisplayMode(d))
    out['fits'] = bool(fit) and out['after']['w'] >= w and out['after']['h'] >= h
print(json.dumps(out))
`;

const min = process.argv.find((a) => a.startsWith('--min='))?.slice(6).split('x').map(Number);
const out = JSON.parse(execFileSync('python3', ['-c', PY, ...(min ?? []).map(String)], { encoding: 'utf8', timeout: 20000 }));
console.log(JSON.stringify(out, null, 1));
if (min && !out.fits) { console.error(`the main display offers no mode of at least ${min.join(' x ')} points`); process.exit(1); }
