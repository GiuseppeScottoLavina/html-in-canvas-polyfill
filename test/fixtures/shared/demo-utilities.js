/**
 * Utilities used only by repository demos/tests.
 *
 * Nothing in this module is required by the HTML-in-Canvas polyfill. Keeping
 * diagnostics and presentation helpers here makes that boundary obvious to
 * readers copying the basic integration pattern.
 */


/**
 * Guard virtual CSSOM diagnostics so they only run against a generation for
 * which the canvas has already emitted an authoritative `paint`.
 *
 * ResizeObserver has a mandatory initial delivery for every observed target;
 * that delivery is bookkeeping rather than evidence that a newer dirty HIC
 * generation exists, so observe() suppresses it once per target. Subsequent
 * resize/scroll invalidations advance a monotonic token; commit() records the
 * token covered by the newest canvas paint.
 */
export function createPostPaintCSSOMReadGate(readVisualSignature = null) {
  let revision = 0;
  let committedRevision = -1;
  let committedVisualSignature;
  let visualSignatureCommitted = false;
  const observed = new WeakSet();
  const visualSignatureStable = () => {
    if (typeof readVisualSignature !== 'function') return true;
    if (!visualSignatureCommitted) return false;
    try { return Object.is(readVisualSignature(), committedVisualSignature); }
    catch { return false; }
  };
  return Object.freeze({
    invalidate() { revision += 1; return revision; },
    observe(entries) {
      let changed = false;
      for (const entry of entries ?? []) {
        const target = entry?.target;
        if (!target || (typeof target !== 'object' && typeof target !== 'function')) continue;
        if (observed.has(target)) changed = true;
        else observed.add(target);
      }
      if (changed) revision += 1;
      return changed;
    },
    commit() {
      committedRevision = revision;
      if (typeof readVisualSignature === 'function') {
        try {
          committedVisualSignature = readVisualSignature();
          visualSignatureCommitted = true;
        } catch { visualSignatureCommitted = false; }
      }
      return committedRevision;
    },
    get stable() { return revision === committedRevision && visualSignatureStable(); },
    snapshot() { return Object.freeze({
      revision,
      committedRevision,
      revisionStable: revision === committedRevision,
      visualSignatureStable: visualSignatureStable(),
      stable: revision === committedRevision && visualSignatureStable()
    }); }
  });
}

export function bindFrameCapControl(canvas, input, output, onChange = () => {}) {
  if (!input || !output) return () => {};
  const readValue = () => Math.min(120, Math.max(15, Number(input.value) || 60));
  const applyLive = () => {
    const value = readValue();
    try { canvas.frameCap = value; }
    catch { canvas.setAttribute('framecap', String(value)); }
    const label = `${Math.round(value)} fps`;
    if (output.textContent !== label) output.textContent = label;
    onChange(value);
    return value;
  };
  // Both the control-plane value and authored UI are live. The polyfill core is
  // responsible for keeping ordinary DOM mutations fast; demos must not defer
  // visible state merely to avoid exercising a real application workload.
  input.addEventListener('input', applyLive);
  input.addEventListener('change', applyLive);
  applyLive();
  return () => {
    input.removeEventListener('input', applyLive);
    input.removeEventListener('change', applyLive);
  };
}

function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * ratio)))] ?? 0;
}

/**
 * Measure interaction→DOM→paint→effect-presentation latency without driving
 * any rendering itself. The probe is deliberately observational: removing it
 * must not change demo behavior.
 */
export function createInteractionLatencyProbe(canvas, target) {
  const samples = [];
  let active = null;
  let lastPaintAt = 0;

  const now = () => performance.now();
  const belongs = event => event.target === target || (event.target instanceof Node && target.contains?.(event.target));

  const begin = event => {
    if (!belongs(event)) return;
    active = {
      kind: event.type,
      pointerAt: now(),
      clickAt: 0,
      inputAt: 0,
      changeAt: 0,
      paintAt: 0,
      presentAt: 0,
      checked: 'checked' in target ? Boolean(target.checked) : null
    };
  };
  const mark = key => event => {
    if (!belongs(event)) return;
    if (!active) begin(event);
    if (active && !active[key]) active[key] = now();
  };
  const onPaint = () => {
    lastPaintAt = now();
    if (!active || active.paintAt) return;
    active.paintAt = lastPaintAt;
    // Without an effect host, paint is the visible terminal stage.
    queueMicrotask(() => {
      if (active && active.paintAt && !active.presentAt && !globalThis.__HIC_DEMO_EFFECT_HOST__) commit(active.paintAt);
    });
  };
  const onEffectFrame = () => {
    if (!active?.paintAt || active.presentAt) return;
    active.presentAt = now();
    commit(active.presentAt);
  };
  function commit(terminalAt) {
    if (!active) return;
    const origin = active.inputAt || active.changeAt || active.clickAt || active.pointerAt;
    samples.push(Object.freeze({
      ...active,
      domLatency: Math.max(0, (active.inputAt || active.changeAt || active.clickAt || origin) - active.pointerAt),
      paintLatency: active.paintAt ? Math.max(0, active.paintAt - origin) : null,
      presentLatency: Math.max(0, terminalAt - origin)
    }));
    if (samples.length > 64) samples.splice(0, samples.length - 64);
    active = null;
  }

  const onClick = mark('clickAt');
  const onInput = mark('inputAt');
  const onChange = mark('changeAt');
  target.addEventListener('pointerdown', begin);
  target.addEventListener('click', onClick);
  target.addEventListener('input', onInput);
  target.addEventListener('change', onChange);
  canvas.addEventListener('paint', onPaint);
  canvas.addEventListener('effectframe', onEffectFrame);

  return {
    snapshot() {
      const complete = samples.filter(sample => Number.isFinite(sample.presentLatency));
      const values = complete.map(sample => sample.presentLatency).sort((a, b) => a - b);
      const paintValues = complete.map(sample => sample.paintLatency).filter(Number.isFinite).sort((a, b) => a - b);
      return {
        count: complete.length,
        last: complete.at(-1) ?? null,
        medianMs: percentile(values, .5),
        p95Ms: percentile(values, .95),
        paintMedianMs: percentile(paintValues, .5),
        paintP95Ms: percentile(paintValues, .95),
        lastPaintAt
      };
    },
    destroy() {
      target.removeEventListener('pointerdown', begin);
      target.removeEventListener('click', onClick);
      target.removeEventListener('input', onInput);
      target.removeEventListener('change', onChange);
      canvas.removeEventListener('paint', onPaint);
      canvas.removeEventListener('effectframe', onEffectFrame);
    }
  };
}

export function createFPSMeter(canvas, onSample = () => {}) {
  let start = performance.now();
  let frames = 0;
  let measuredFPS = 0;
  const onFrame = () => {
    frames += 1;
    const current = performance.now();
    const elapsed = current - start;
    if (elapsed < 500) return;
    measuredFPS = Math.round((frames * 1000 / elapsed) * 10) / 10;
    frames = 0;
    start = current;
    onSample(measuredFPS);
  };
  canvas.addEventListener('effectframe', onFrame);
  return {
    get value() { return measuredFPS; },
    destroy() { canvas.removeEventListener('effectframe', onFrame); }
  };
}
