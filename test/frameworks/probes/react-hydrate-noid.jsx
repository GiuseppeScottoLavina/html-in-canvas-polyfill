// Probe (docs/guides/FRAMEWORKS.md, section 4): React hydrateRoot over a drawable canvas whose top-level drawable has NO id. The polyfill gives such a
// child a generated id (for the canvas aria-owns, ADR-M) before React hydrates; suppressHydrationWarning on the canvas does not cover
// attributes of its children. Built and run by test/frameworks/run.mjs; the result is recorded as KNOWN, never as a pass.
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';

export function Probe() {
  return (
    <canvas className="probe" content="drawable" suppressHydrationWarning style={{ width: 200, height: 60, display: 'block' }}>
      <div drawable="" style={{ width: 200, height: 60, background: '#cde' }}>no id here</div>
    </canvas>
  );
}
export const ssr = () => renderToString(<Probe />);
export const hydrate = (el) => hydrateRoot(el, <Probe />);
