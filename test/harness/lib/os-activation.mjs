// Which application is in front (macOS), and every change of it while a test runs.
//
// A browser driven through WebDriver that is not the active application cannot make its windows key: measured 2026-10-22 with an own window that activated itself
// every second, Safari 27 dropped the trusted click into the drawn email field of the clickEffect scenario (no focus, no caret: AppKit swallows the first click of a
// window that is not key) and Firefox 157 could not give the activation to the popup of the inactive scenario (document.hasFocus() stayed true), 2 of 2 runs each,
// against 2 of 2 passes without it. The same signatures had appeared once each in full runs on the shared machine. `watchActivations()` records every application
// activation, so a runner can tell such a run from a product result: an activation of an application that is not the browser under test is an environment problem.
import { spawn, execFileSync } from 'node:child_process';

const PY = `import sys, time, AppKit
from PyObjCTools import AppHelper
ws = AppKit.NSWorkspace.sharedWorkspace()
def say(app):
    sys.stdout.write('%d %.3f %s\\n' % (app.processIdentifier(), time.time() * 1000, app.localizedName() or '')); sys.stdout.flush()
class O(AppKit.NSObject):
    def act_(self, n): say(n.userInfo()['NSWorkspaceApplicationKey'])
o = O.alloc().init()
ws.notificationCenter().addObserver_selector_name_object_(o, 'act:', AppKit.NSWorkspaceDidActivateApplicationNotification, None)
say(ws.frontmostApplication())
AppHelper.runConsoleEventLoop()
`;

/** @typedef {{pid: number, at: number, name: string}} Activation */

/** The frontmost application now, or null where it cannot be read (not macOS, no python3 with AppKit). @returns {Activation | null} */
export function frontmostApp() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('python3', ['-c', 'import AppKit, time; a = AppKit.NSWorkspace.sharedWorkspace().frontmostApplication(); print(a.processIdentifier(), time.time() * 1000, a.localizedName() or "")'], { encoding: 'utf8', timeout: 5000 }).trim();
    const [pid, at, ...name] = out.split(' ');
    return { pid: +pid, at: +at, name: name.join(' ') };
  } catch { return null; }
}

/**
 * Start recording application activations (one python3 process with an AppKit observer; stop() ends it). `since(mark)` lists the activations recorded after
 * `mark()`; the first entry is the application that was in front at the start. On a platform without the observer `available` is false and nothing is recorded.
 * @returns {{available: boolean, mark: () => number, since: (m: number) => Activation[], front: () => Activation | null, stop: () => void}}
 */
export function watchActivations() {
  /** @type {Activation[]} */ const log = [];
  if (process.platform !== 'darwin') return { available: false, mark: () => 0, since: () => [], front: () => null, stop: () => {} };
  const child = spawn('python3', ['-c', PY], { stdio: ['ignore', 'pipe', 'ignore'] });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const [pid, at, ...name] = line.split(' ');
      if (+pid > 0) log.push({ pid: +pid, at: +at, name: name.join(' ') });
    }
  });
  child.on('error', () => { /* no python3: nothing is recorded */ });
  const stop = () => { try { child.kill(); } catch { /* gone */ } };
  process.once('exit', stop);
  return {
    get available() { return log.length > 0; },
    mark: () => log.length,
    since: (m) => log.slice(m),
    front: () => log[log.length - 1] ?? null,
    stop,
  };
}

/**
 * The activations of applications other than the browser under test (pure, unit-tested): `pids` are the browser's processes; an activation of one of them
 * (the browser coming back to the front) is not foreign. @param {Activation[]} acts @param {number[]} pids
 */
export const foreignActivations = (acts, pids) => acts.filter((a) => !pids.includes(a.pid));

/**
 * Bring the browser under test to the front (macOS, best effort): the application among `pids` is asked to activate itself, through System Events (as
 * Page.activateProcess does for Chrome) and, where that is not permitted, NSRunningApplication. Returns the application's pid, or null when none of `pids` is one.
 * @param {number[]} pids
 */
export function activateApp(pids) {
  if (process.platform !== 'darwin' || !pids.length) return null;
  try {
    const out = execFileSync('python3', ['-c', `import AppKit
for p in [${pids.map((p) => Number(p)).join(',')}]:
    a = AppKit.NSRunningApplication.runningApplicationWithProcessIdentifier_(p)
    if a is not None and a.activationPolicy() == AppKit.NSApplicationActivationPolicyRegular:
        a.activateWithOptions_(AppKit.NSApplicationActivateAllWindows); print(p); break`], { encoding: 'utf8', timeout: 5000 }).trim();
    const pid = +out || null;
    if (pid) { try { execFileSync('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`], { timeout: 5000, stdio: 'ignore' }); } catch { /* not permitted */ } }
    return pid;
  } catch { return null; }
}
