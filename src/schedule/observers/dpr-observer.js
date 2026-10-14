/**
 * devicePixelRatio changes -> BUS.DPR.
 * Module: schedule (src/schedule/observers/*).
 */

import { BUS } from '../../contracts/events.js';

/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */

/**
 * matchMedia resolution listener re-armed on every change + window resize (page zoom changes the ratio and fires `resize`; a monitor move fires the media query).
 * On a change: record.dpr of every canvas (owner: schedule), BUS.DPR, and whole-drawable 'dpr' damage so the surfaces are re-rastered at the new scale (old ones stay shown until then).
 * @param {HicEnv} env
 * @returns {() => void}
 */
export function observeDpr(env) {
  const win = env.window;
  let current = win.devicePixelRatio;
  /** @type {(() => void)|null} */
  let unlisten = null;

  function listen() {
    unlisten?.();
    unlisten = null;
    const query = win.matchMedia(`(resolution: ${current}dppx)`);
    query.addEventListener('change', check);
    unlisten = () => query.removeEventListener('change', check);
  }

  function check() {
    const next = win.devicePixelRatio;
    if (next === current) return;
    current = next;
    for (const record of env.registry.all()) record.dpr = next;
    env.bus.emit(BUS.DPR, { dpr: next });
    for (const record of env.registry.all()) env.scheduler.damage(record, 'dpr', null, null);
    listen();
  }

  win.addEventListener('resize', check);
  listen();
  return () => {
    win.removeEventListener('resize', check);
    unlisten?.();
    unlisten = null;
  };
}
