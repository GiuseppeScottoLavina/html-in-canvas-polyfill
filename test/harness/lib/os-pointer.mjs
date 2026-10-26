// The operating system's pointer and the test window (macOS).
//
// A headed Chrome on macOS delivers the REAL pointer to the page whenever its view geometry changes while the pointer rests over the page: a
// Page.captureScreenshot with a `clip` (it runs through a device-emulation pass) and a tab activation each send the page a trusted mousemove (and
// pointerover / mouseover) at the OS pointer's location, measured 2026-10-22 with Chrome 155: a scroll-cadence twin lost the :hover row it had been
// given by the harness at every element screenshot, and a range slider under the resting pointer was drawn in its hover look. A pointer outside the
// window delivers nothing. `launchChrome` therefore moves the OS pointer out of the test window (parkOsPointer), and the gates detect any pointer input
// the harness did not send (Page.installPointerGuard): such a run is reported as an environment problem, never as a product result.
import { execFileSync } from 'node:child_process';

const PY = `import sys, Quartz
p = Quartz.CGEventGetLocation(Quartz.CGEventCreate(None))
if sys.argv[1] == 'warp':
    Quartz.CGWarpMouseCursorPosition((float(sys.argv[2]), float(sys.argv[3]))); Quartz.CGAssociateMouseAndMouseCursorPosition(True)
    p = Quartz.CGEventGetLocation(Quartz.CGEventCreate(None))
print('%f %f' % (p.x, p.y))
err, ids, n = Quartz.CGGetActiveDisplayList(16, None, None)
for i in ids[:n]:
    b = Quartz.CGDisplayBounds(i); print('D %f %f %f %f' % (b.origin.x, b.origin.y, b.size.width, b.size.height))
if sys.argv[1] == 'get':
    pids = [int(x) for x in sys.argv[2].split(',') if x]
    for w in Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID) or []:
        if w.get('kCGWindowOwnerPID') in pids and w.get('kCGWindowLayer') == 0:
            b = w.get('kCGWindowBounds'); print('W %f %f %f %f' % (b['X'], b['Y'], b['Width'], b['Height']))
`;

/** @typedef {{x:number, y:number}} Pt @typedef {{left:number, top:number, width:number, height:number}} Rect */

/** Run the Quartz helper; null where it is unavailable (not macOS, no python3 / PyObjC). @returns {{at: Pt, displays: Rect[], windows: Rect[]} | null} */
function quartz(...args) {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('python3', ['-c', PY, ...args.map(String)], { encoding: 'utf8', timeout: 5000 }).trim().split('\n');
    const [x, y] = out[0].split(' ').map(Number);
    const rects = (/** @type {string} */ k) => out.slice(1).filter((l) => l.startsWith(k + ' ')).map((l) => { const [left, top, width, height] = l.slice(2).split(' ').map(Number); return { left, top, width, height }; });
    return Number.isFinite(x) && Number.isFinite(y) ? { at: { x, y }, displays: rects('D'), windows: rects('W') } : null;
  } catch { return null; }
}

/** The OS pointer location in global screen points, the active displays and the on-screen windows of process `pid` (or of any of several); null where it cannot be read. @param {number | number[]} [pid] */
export const osPointer = (pid = -1) => quartz('get', [pid].flat().join(','));

/** @param {Rect[]} rs @returns {Rect} */
const union = (rs) => { const l = Math.min(...rs.map((r) => r.left)), t = Math.min(...rs.map((r) => r.top)); return { left: l, top: t, width: Math.max(...rs.map((r) => r.left + r.width)) - l, height: Math.max(...rs.map((r) => r.top + r.height)) - t }; };
const inside = (/** @type {Pt} */ p, /** @type {Rect} */ r, m = 0) => p.x >= r.left - m && p.x < r.left + r.width + m && p.y >= r.top - m && p.y < r.top + r.height + m;

/**
 * Where to put the pointer so that it is over none of the windows `wins` (pure, unit-tested): in the middle of the widest free band of a display, away from screen
 * edges and corners (the Dock, hot corners and an auto-hidden menu bar react to an edge). null when the windows cover every display.
 * @param {Rect[]} wins @param {Rect[]} displays @returns {Pt | null}
 */
export function parkingSpot(wins, displays) {
  const win = union(wins);
  const M = 24;
  const bands = [];
  for (const d of displays) {
    const right = d.left + d.width, bottom = d.top + d.height;
    const wr = win.left + win.width, wb = win.top + win.height;
    bands.push(
      { w: right - Math.max(d.left, wr), h: d.height, x: (Math.max(d.left, wr) + right) / 2, y: d.top + d.height / 2 },
      { w: Math.min(right, win.left) - d.left, h: d.height, x: (d.left + Math.min(right, win.left)) / 2, y: d.top + d.height / 2 },
      { w: d.width, h: bottom - Math.max(d.top, wb), x: d.left + d.width / 2, y: (Math.max(d.top, wb) + bottom) / 2 },
    );
  }
  const ok = bands.filter((b) => b.w >= 2 * M && b.h >= 2 * M && !inside({ x: b.x, y: b.y }, win, M / 2));
  ok.sort((a, b) => Math.min(b.w, b.h) - Math.min(a.w, a.h));
  return ok.length ? { x: Math.round(ok[0].x), y: Math.round(ok[0].y) } : null;
}

/**
 * Move the OS pointer out of the on-screen windows of process `pid` (the browser this harness started; or of any of several processes) when it rests over one
 * of them. Returns what happened, for the run's record: `{ parked: false, reason }` (not macOS, unreadable, no window, already outside, no free spot) or `{ parked: true, from, to }`.
 * @param {number | number[]} pid
 */
export function parkOsPointer(pid) {
  const now = osPointer(pid);
  if (!now) return { parked: false, reason: 'the OS pointer cannot be read here (not macOS, or no python3 with Quartz)' };
  if (!now.windows.length) return { parked: false, reason: 'the browser has no window on screen', at: now.at };
  if (!now.windows.some((w) => inside(now.at, w))) return { parked: false, reason: 'outside the browser windows', at: now.at };
  const to = parkingSpot(now.windows, now.displays);
  if (!to) return { parked: false, reason: 'the browser windows cover every display: no place for the pointer', at: now.at };
  const after = quartz('warp', to.x, to.y);
  return { parked: !!after && !now.windows.some((w) => inside(after.at, w)), from: now.at, to: after?.at ?? null };
}
