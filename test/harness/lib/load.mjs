// System-load snapshot. Store it with EVERY measured result; a run with machine load above the threshold must be labelled as such.
import { execFileSync } from 'node:child_process';
import { sleep } from './util.mjs';

/**
 * @param {{ownPids?:number[], thresholdPct?:number}} o  ownPids: process ids (and their children are matched by ppid) we spawned.
 * @returns {{at:string, loadAvg:number[], top:{pid:number,cpu:number,cmd:string}[], busyProcesses:object[], highLoad:boolean, thresholdPct:number}}
 */
export function loadSnapshot({ ownPids = [], thresholdPct = 15 } = {}) {
  const out = execFileSync('ps', ['-Ao', 'pid=,ppid=,pcpu=,args=', '-r'], { encoding: 'utf8', maxBuffer: 16e6 });
  const rows = out.split('\n').filter(Boolean).map(l => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/); return m && { pid: +m[1], ppid: +m[2], cpu: +m[3], cmd: m[4] }; }).filter(Boolean);
  const own = new Set(ownPids); // expand to descendants
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (!own.has(r.pid) && own.has(r.ppid)) { own.add(r.pid); grew = true; } }
  const top = rows.slice(0, 6).map(r => ({ pid: r.pid, cpu: r.cpu, own: own.has(r.pid), cmd: r.cmd.replace(/^.*\/(Contents|Helpers)\//, '').slice(0, 90) }));
  // WindowServer and ps itself are OS overhead of our own rendering, not other load
  const busy = rows.filter(r => !own.has(r.pid) && r.cpu > thresholdPct && !/WindowServer|\bps\b|SkyLight/.test(r.cmd))
    .map(r => ({ pid: r.pid, cpu: r.cpu, cmd: r.cmd.slice(0, 120) }));
  return { at: new Date().toISOString(), loadAvg: execFileSync('sysctl', ['-n', 'vm.loadavg'], { encoding: 'utf8' }).trim(), top, busyProcesses: busy, highLoad: busy.length > 0, thresholdPct };
}

/** Wait (up to maxWaitMs) until no other process exceeds the threshold; returns the last snapshot (highLoad=true if still busy). */
export async function waitForQuiet({ ownPids = [], thresholdPct = 15, maxWaitMs = 180000, pollMs = 10000 } = {}) {
  const t0 = Date.now(); let s = loadSnapshot({ ownPids, thresholdPct }); let waited = 0;
  while (s.highLoad && Date.now() - t0 < maxWaitMs) { await sleep(pollMs); s = loadSnapshot({ ownPids, thresholdPct }); }
  waited = Date.now() - t0; return { ...s, waitedMs: waited };
}
