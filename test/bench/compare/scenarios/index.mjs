// Scenario registry (order = run order). Each entry: async (session, {quick}) => JSON-serialisable result.
import { runTyping } from './typing.mjs';
import { runSlider, runClick, runScroll } from './interact.mjs';

export const SCENARIOS = {
  typing: async (s, o) => ({ explainer: await runTyping(s, 'explainer', o), f1: await runTyping(s, 'f1', { ...o, configs: [['fits', 120], ['fits', 30]], control: false }) }),
  slider: (s, o) => runSlider(s, o),
  click: (s, o) => runClick(s, o),
  scroll: (s, o) => runScroll(s, o),
};
import { runResize, runIdle, runFirstPaint, runMemory, runLargeDom, runBundle } from './system.mjs';
Object.assign(SCENARIOS, {
  resize: (s, o) => runResize(s, o),
  idle: (s, o) => runIdle(s, o),
  firstpaint: (s, o) => runFirstPaint(s, o),
  memory: (s, o) => runMemory(s, o),
  largedom: (s, o) => runLargeDom(s, o),
  bundle: (s, o) => runBundle(s, o),
});
