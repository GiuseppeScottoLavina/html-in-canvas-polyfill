/**
 * The damped spring of the pointer-following example plugins (plugins/_lib/: bundled into each plugin that imports it).
 */

const SUBSTEP = 1 / 240;

/**
 * Advance `s` (position x, y towards the target tx, ty with velocity vx, vy) by dt seconds, in substeps of at most 1/240 s, so the spring
 * stays stable at a low frame cap. @param {{x: number, y: number, vx: number, vy: number, tx: number, ty: number}} s
 * @param {number} dt @param {number} stiffness  1/s^2 @param {number} damping  1/s
 */
export function springSubsteps(s, dt, stiffness, damping) {
  let left = dt;
  while (left > 1e-6) {
    const h = Math.min(SUBSTEP, left);
    s.vx += ((s.tx - s.x) * stiffness - s.vx * damping) * h;
    s.vy += ((s.ty - s.y) * stiffness - s.vy * damping) * h;
    s.x += s.vx * h;
    s.y += s.vy * h;
    left -= h;
  }
}
