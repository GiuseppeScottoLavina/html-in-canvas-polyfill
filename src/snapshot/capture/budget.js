/**
 * Node budget ladder (docs/ARCHITECTURE.md ADR-D.7).
 * Module: snapshot-capture (src/snapshot/capture/*). Pure.
 */

/** @typedef {import('../../contracts/types.js').NodeBudget} NodeBudget */

/**
 * ok -> prune (> soft) -> degrade (> hard: <= 4 fps) -> refuse (> absolute).
 * @param {number} nodes
 * @param {NodeBudget} budget
 * @returns {'ok'|'prune'|'degrade'|'refuse'}
 */
export function evaluateBudget(nodes, budget) {
  if (nodes > budget.absolute) return 'refuse';
  if (nodes > budget.hard) return 'degrade';
  if (nodes > budget.soft) return 'prune';
  return 'ok';
}
