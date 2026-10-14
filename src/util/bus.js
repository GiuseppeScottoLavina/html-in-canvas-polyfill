/** Synchronous topic bus. A throwing listener never stops the others. */

/** @typedef {import('../contracts/types.js').Bus} Bus */

/** @param {(err: unknown, topic: string) => void} [onError] @returns {Bus} */
export function createBus(onError) {
  /** @type {Map<string, Set<(payload: any) => void>>} */
  const topics = new Map();
  return {
    on(topic, listener) {
      let set = topics.get(topic);
      if (!set) topics.set(topic, (set = new Set()));
      set.add(listener);
      return () => { set.delete(listener); };
    },
    emit(topic, payload) {
      const set = topics.get(topic);
      if (!set) return;
      for (const l of [...set]) {
        try { l(payload); } catch (err) { if (onError) onError(err, topic); else queueMicrotask(() => { throw err; }); }
      }
    },
    clear() { topics.clear(); },
  };
}
