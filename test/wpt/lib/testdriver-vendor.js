// CDP-backed test driver for the vendored testdriver.js: pointer and wheel action sequences and element clicks become
// trusted Input.dispatchMouseEvent calls made by the runner through the `__wptDrive` binding. Nothing else is supported.
(function () {
  'use strict';
  const pending = new Map(); let seq = 0;
  window.__wptDriveDone = (id, err) => { const p = pending.get(id); pending.delete(id); if (p) (err ? p.reject(new Error(err)) : p.resolve()); };
  const drive = msg => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    if (typeof window.__wptDrive !== 'function') return reject(new Error('no __wptDrive binding'));
    window.__wptDrive(JSON.stringify({ id, ...msg }));
  });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const state = { x: 0, y: 0, lastUp: 0, lastX: -1, lastY: -1, clicks: 0, down: 0 };
  const center = el => {
    const r = el.getClientRects()[0]; const l = Math.max(0, r.left), rt = Math.min(innerWidth, r.right), t = Math.max(0, r.top), b = Math.min(innerHeight, r.bottom);
    return [Math.floor((l + rt) / 2), Math.floor((t + b) / 2)];
  };
  const resolve = (a) => {
    const o = a.origin ?? 'viewport'; const dx = a.x ?? 0, dy = a.y ?? 0;
    if (o === 'viewport') return [dx, dy];
    if (o === 'pointer') return [state.x + dx, state.y + dy];
    const c = center(o); return [c[0] + dx, c[1] + dy];
  };
  const button = a => ['left', 'middle', 'right'][a.button ?? 0] ?? 'left';
  async function run(a) {
    switch (a.type) {
      case 'pause': if (a.duration) await sleep(a.duration); return;
      case 'pointerMove': { const [x, y] = resolve(a); state.x = x; state.y = y; return drive({ t: 'move', x, y, buttons: state.down }); }
      case 'pointerDown': {
        const near = Math.hypot(state.x - state.lastX, state.y - state.lastY) < 3 && performance.now() - state.lastUp < 500;
        state.clicks = near ? state.clicks + 1 : 1; state.down = 1;
        return drive({ t: 'down', x: state.x, y: state.y, button: button(a), clickCount: state.clicks });
      }
      case 'pointerUp': state.down = 0; state.lastUp = performance.now(); state.lastX = state.x; state.lastY = state.y;
        return drive({ t: 'up', x: state.x, y: state.y, button: button(a), clickCount: state.clicks });
      case 'scroll': { const [x, y] = resolve(a); state.x = x; state.y = y; return drive({ t: 'wheel', x, y, dx: a.deltaX ?? 0, dy: a.deltaY ?? 0 }); }
      default: throw new Error('unsupported action ' + a.type);
    }
  }
  window.test_driver_internal = Object.assign(window.test_driver_internal || {}, {
    async action_sequence(sources) {
      const ticks = Math.max(0, ...sources.map(s => s.actions.length));
      for (let i = 0; i < ticks; i++) await Promise.all(sources.map(s => s.actions[i] ? run(s.actions[i]) : null));
    },
    async click(element, coords) {
      await run({ type: 'pointerMove', x: coords.x, y: coords.y }); await run({ type: 'pointerDown' }); await run({ type: 'pointerUp' });
    },
  });
})();
