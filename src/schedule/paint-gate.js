/**
 * Paint gate: a paint fires only when a draw inside the handler cannot throw for lack of a snapshot, and (coherentPaint) when all drawables show one DOM state (docs/ARCHITECTURE.md ADR-C).
 * Module: schedule (src/schedule/*).
 */

/** @typedef {import('../contracts/types.js').CanvasRecord} CanvasRecord */
/** @typedef {import('../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../contracts/types.js').SnapshotStore} SnapshotStore */

/**
 * @typedef {Object} GateVerdict
 * @property {boolean} open
 * @property {'ready'|'no-drawables'|'first-commit'|'coherence'|'timeout'} reason  'timeout': the wait cap (paintGateMaxWaitMs for first-commit, coherenceMaxWaitMs for coherence) elapsed, the paint fires anyway and a report entry is made
 */

/**
 * @typedef {Object} PaintGate
 * @property {(record: CanvasRecord, now: number) => GateVerdict} evaluate  never clears record.paint.force (so it stays set while closed); sets/clears record.paint.waitingSince and gateReason
 */

/**
 * Uses store.isPaintReady(record). A canvas with no eligible drawable-with-a-box is open (paint with [] so authors can draw other content).
 * The wait clock starts when the gate first closes for a reason and restarts when the reason changes (each reason has its own cap); it is cleared whenever the gate opens.
 * @param {HicEnv} env
 * @param {SnapshotStore} store
 * @returns {PaintGate}
 */
export function createPaintGate(env, store) {
  return {
    evaluate(record, now) {
      const paint = record.paint;
      const readiness = store.isPaintReady(record);
      const reason = readiness.reason;
      if (readiness.ready || (reason === 'coherence' && !env.options.coherentPaint)) {
        open(paint);
        return { open: true, reason: readiness.ready ? reason : 'ready' };
      }
      const closedReason = reason === 'coherence' ? 'coherence' : 'first-commit';
      if (paint.waitingSince === null || paint.gateReason !== closedReason) {
        paint.waitingSince = now;
        paint.gateReason = closedReason;
      }
      const cap = closedReason === 'coherence' ? env.options.coherenceMaxWaitMs : env.options.paintGateMaxWaitMs;
      if (now - paint.waitingSince >= cap) {
        open(paint);
        return { open: true, reason: 'timeout' };
      }
      return { open: false, reason: closedReason };
    },
  };
}

/** @param {CanvasRecord['paint']} paint */
function open(paint) {
  paint.waitingSince = null;
  paint.gateReason = null;
}
