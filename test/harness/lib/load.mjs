// System-load snapshot. Store it with EVERY measured result; a run with machine load above the threshold must be labelled as such.
import { execFileSync } from 'node:child_process';
import { loadavg } from 'node:os';
import { sleep } from './util.mjs';

/**
 * @param {{ownPids?:number[], thresholdPct?:number}} o  ownPids: process ids (and their children are matched by ppid) we spawned.
 * @returns {{at:string, loadAvg:number[], top:{pid:number,cpu:number,cmd:string}[], busyProcesses:object[], highLoad:boolean, thresholdPct:number}}
 */
/** The ps arguments that list every process with its parent and CPU share, busiest first: BSD ps (macOS) sorts with -r, procps (Linux) with --sort. */
export function psArgs(platform = process.platform) {
  return ['-Ao', 'pid=,ppid=,pcpu=,args=', platform === 'darwin' ? '-r' : '--sort=-pcpu'];
}

/** The load average in the format of macOS's `sysctl -n vm.loadavg` ("{ 1.20 1.31 1.40 }"), from sysctl on macOS and from the OS elsewhere. */
export function loadAverage(platform = process.platform) {
  if (platform === 'darwin') return execFileSync('sysctl', ['-n', 'vm.loadavg'], { encoding: 'utf8' }).trim();
  return `{ ${loadavg().map((n) => n.toFixed(2)).join(' ')} }`;
}

export function loadSnapshot({ ownPids = [], thresholdPct = 15 } = {}) {
  const out = execFileSync('ps', psArgs(), { encoding: 'utf8', maxBuffer: 16e6 });
  const rows = out.split('\n').filter(Boolean).map(l => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/); return m && { pid: +m[1], ppid: +m[2], cpu: +m[3], cmd: m[4] }; }).filter(Boolean);
  const own = new Set(ownPids); // expand to descendants
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (!own.has(r.pid) && own.has(r.ppid)) { own.add(r.pid); grew = true; } }
  const top = rows.slice(0, 6).map(r => ({ pid: r.pid, cpu: r.cpu, own: own.has(r.pid), cmd: r.cmd.replace(/^.*\/(Contents|Helpers)\//, '').slice(0, 90) }));
  // WindowServer and ps itself are OS overhead of our own rendering, not other load
  const busy = rows.filter(r => !own.has(r.pid) && r.cpu > thresholdPct && !/WindowServer|\bps\b|SkyLight/.test(r.cmd))
    .map(r => ({ pid: r.pid, cpu: r.cpu, cmd: r.cmd.slice(0, 120) }));
  return { at: new Date().toISOString(), loadAvg: loadAverage(), top, busyProcesses: busy, highLoad: busy.length > 0, thresholdPct };
}

/** Wait (up to maxWaitMs) until no other process exceeds the threshold; returns the last snapshot (highLoad=true if still busy). */
export async function waitForQuiet({ ownPids = [], thresholdPct = 15, maxWaitMs = 180000, pollMs = 10000 } = {}) {
  const t0 = Date.now(); let s = loadSnapshot({ ownPids, thresholdPct }); let waited = 0;
  while (s.highLoad && Date.now() - t0 < maxWaitMs) { await sleep(pollMs); s = loadSnapshot({ ownPids, thresholdPct }); }
  waited = Date.now() - t0; return { ...s, waitedMs: waited };
}
