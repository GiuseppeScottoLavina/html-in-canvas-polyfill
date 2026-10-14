// Minimal raw Chrome DevTools Protocol client over Node's global WebSocket. Zero dependencies (Node >= 22).

/** A CDP command that got no answer in time: the target (usually a renderer main thread) is stuck. */
export class CdpTimeoutError extends Error {
  constructor(method, ms) { super(`CDP ${method} did not answer in ${ms} ms (the renderer is stuck)`); this.name = 'CdpTimeoutError'; this.method = method; }
}

export class CDPConnection {
  /** @param {string} wsUrl */
  constructor(wsUrl) { this.wsUrl = wsUrl; this.sendTimeoutMs = 0; this.id = 0; this.pending = new Map(); this.handlers = new Map(); this.closed = false; }

  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((ok, bad) => {
      this.ws.addEventListener('open', ok, { once: true });
      this.ws.addEventListener('error', () => bad(new Error('CDP websocket error')), { once: true });
    });
    this.ws.addEventListener('message', ev => this.#onMessage(ev.data));
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
    return this;
  }

  #onMessage(data) {
    const msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id); if (!p) return; this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(`${p.method}: ${msg.error.message}`), { cdp: msg.error }));
      else p.resolve(msg.result);
    } else if (msg.method) {
      const sid = msg.sessionId ?? '';
      for (const h of this.handlers.get(`${sid}|${msg.method}`) ?? []) { try { h(msg.params); } catch (e) { console.error('CDP handler error', e); } }
    }
  }

  /**
   * A runner that must never hang sets `sendTimeoutMs` (0 = unbounded, the default: some gates await long page promises): a renderer that spins at 100 % never answers, and an unbounded wait turns that into a hung test run.
   * The rejection is a CdpTimeoutError so a runner can tell "the page is stuck" from an ordinary protocol error and kill the browser at once.
   * @returns {Promise<any>}
   */
  send(method, params = {}, sessionId, timeoutMs = this.sendTimeoutMs) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = ++this.id;
    const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => { this.pending.delete(id); reject(new CdpTimeoutError(method, timeoutMs)); }, timeoutMs) : null;
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); }, method });
      this.ws.send(JSON.stringify(msg));
    });
  }

  /** Subscribe to an event; returns an unsubscribe function. */
  on(method, handler, sessionId) {
    const key = `${sessionId ?? ''}|${method}`;
    if (!this.handlers.has(key)) this.handlers.set(key, new Set());
    this.handlers.get(key).add(handler);
    return () => this.handlers.get(key)?.delete(handler);
  }

  waitFor(method, { sessionId, timeout = 30000, predicate = () => true } = {}) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, params => { if (predicate(params)) { clearTimeout(t); off(); resolve(params); } }, sessionId);
      const t = setTimeout(() => { off(); reject(new Error(`timeout waiting for ${method}`)); }, timeout);
    });
  }

  close() { try { this.ws?.close(); } catch { /* already closed */ } }
}
