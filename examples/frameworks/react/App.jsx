// React 19 app whose UI lives inside <canvas content="drawable"> and is painted with drawElementImage from the `paint` event.
// The polyfill script (dist/hic-live-polyfill.iife.js) is loaded by index.html BEFORE this bundle.
import { useCallback, useEffect, useRef, useState } from 'react';
import { BADGE_AT, MODE, STRICT_HYDRATION, TICKING, initialItems, newItem, testApi } from '../shared/app-spec.js';

const api = testApi(() => document);

/**
 * Wire a drawable canvas for as long as THAT canvas element exists: a React 19 callback ref with a cleanup function.
 * (A useEffect(..., []) in the parent would keep listening to a canvas that a conditional render already replaced.)
 * The drawables are read from refs at paint time, because a conditional child may have been unmounted or re-created since.
 */
function useCanvasPainter(panelRef, badgeRef) {
  return useCallback((canvas) => {
    if (!canvas || MODE === 'ref') return undefined;            // plain-DOM twin: nothing to paint
    const ctx = canvas.getContext('2d');
    const onPaint = () => {
      ctx.reset();
      const s = canvas.width / canvas.clientWidth;              // bitmap px per css px
      if (panelRef.current) ctx.drawElementImage(panelRef.current, 0, 0);
      if (badgeRef.current) ctx.drawElementImage(badgeRef.current, BADGE_AT.x * s, BADGE_AT.y * s);
    };
    // addEventListener (not canvas.onpaint): a listener survives an uninstall()/install() of the polyfill, an onpaint property does not
    canvas.addEventListener('paint', onPaint);
    const ro = new ResizeObserver(([entry]) => {
      const box = entry.devicePixelContentBoxSize[0];
      canvas.width = box.inlineSize; canvas.height = box.blockSize;
    });
    ro.observe(canvas, { box: 'device-pixel-content-box' });
    return () => { ro.disconnect(); canvas.removeEventListener('paint', onPaint); };
  }, []);
}

function Ticker() {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!TICKING) return undefined;
    const t = setInterval(() => setN((x) => x + 1), 500);
    return () => clearInterval(t);
  }, []);
  return <div className="tick">tick: {n}</div>;
}

export function App() {
  const panelRef = useRef(null), badgeRef = useRef(null);
  const [name, setName] = useState('');
  const [items, setItems] = useState(initialItems);
  const [selected, setSelected] = useState(null);
  const [badge, setBadge] = useState(true);
  const [badgeClicks, setBadgeClicks] = useState(0);
  const [surface, setSurface] = useState(true);   // the whole canvas mounts / unmounts (think: a route change)
  const [note, setNote] = useState(false);         // a sibling rendered AFTER the canvas, in the canvas's parent
  const canvasRef = useCanvasPainter(panelRef, badgeRef);

  const actions = {
    add: () => setItems((xs) => (xs.length >= 6 ? xs : [...xs, newItem(xs.length)])),
    remove: () => setItems((xs) => xs.slice(1)),
    reverse: () => setItems((xs) => [...xs].reverse()),
    toggle: () => setBadge((b) => !b),
    toggleSurface: () => setSurface((v) => !v),
    toggleNote: () => setNote((v) => !v),
  };
  useEffect(() => {
    api.renders += 1;
    api.state = { name, order: items.map((i) => i.id), selected, badge, badgeClicks, surface, note };
    api.actions = actions;
    api.ready = true;
  });

  const Surface = MODE === 'ref' ? 'div' : 'canvas';
  // suppressHydrationWarning: the polyfill adds data-hic-canvas and aria-owns to the canvas before hydrateRoot runs, which React's dev
  // build reports as an attribute mismatch (docs/guides/FRAMEWORKS.md, section 4). It silences only this element's own attributes. ?strict-hydration=1 drops it (test probe).
  const surfaceProps = MODE === 'ref' ? { className: 'surface ref' }
    : { className: 'surface', content: 'drawable', suppressHydrationWarning: !STRICT_HYDRATION };
  return (<div className="app">{surface && (
    <Surface id="surface" ref={canvasRef} {...surfaceProps}>
      <div id="panel" className="panel" drawable="" ref={panelRef}>
        <h2>React {'19'} in a canvas</h2>
        <form onSubmit={(e) => e.preventDefault()}>
          <input id="name" value={name} placeholder="your name" onChange={(e) => setName(e.target.value)} />
          <span id="echo" className="echo">Hello, {name || 'nobody'}!</span>
        </form>
        <ul id="list">
          {items.map((it) => (
            <li key={it.id} data-id={it.id} className={selected === it.id ? 'sel' : ''} style={{ background: it.color }}
                onClick={() => setSelected(it.id)}>{it.label}</li>
          ))}
        </ul>
        <div className="buttons">
          <button id="btn-add" type="button" onClick={actions.add}>Add</button>
          <button id="btn-remove" type="button" onClick={actions.remove}>Remove first</button>
          <button id="btn-reverse" type="button" onClick={actions.reverse}>Reverse</button>
          <button id="btn-toggle" type="button" onClick={actions.toggle}>Badge</button>
        </div>
        <Ticker />
        <div className="status">selected: {selected ?? '-'} / badge clicks: {badgeClicks}</div>
      </div>
      {badge && (
        <div id="badge" className="badge" drawable="" ref={badgeRef} onClick={() => setBadgeClicks((n) => n + 1)}>BADGE</div>
      )}
    </Surface>)}
    {note && <p id="note" className="note">A note rendered after the canvas.</p>}
  </div>);
}
