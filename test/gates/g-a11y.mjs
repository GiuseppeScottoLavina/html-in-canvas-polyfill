// G-a11y (O-ax): Chrome's real accessibility tree (CDP Accessibility.getFullAXTree, lib/ax.mjs) keeps the structure of a canvas's children when the polyfill
// moves them into its live layer. Two fixtures, each with the polyfill (mode=poly) and as the plain page (mode=ref, no canvas, no polyfill: what Chrome itself
// exposes for the same HTML):
//   test/fixtures/a11y   a list canvas (role=list, three focusable listitems) and a group canvas with a form (heading, text field, checkbox, slider, button, polite status)
//   F1 (test/fixtures/f1-water-form)   the water-form page: two headings, four text fields, a checkbox, a slider with an output, a button, a polite status
// For every fixture and mode the gate asserts, under the canvas node (the twin's node on the plain page):
//   tree       roles, names, values and order equal the fixture's written expectations, and with the polyfill the whole subtree equals the plain page's line by line
//   focus      Tab from a fixed start reaches every control in DOM order, and the focused AX node is that control, under the canvas
//   edit       trusted typing changes the field's value, an arrow key the slider's, and a script text change the item's and the heading's text, in the tree
//   live       a status update is in the tree with its text and politeness (live=polite) under the canvas
//   lifecycle  (polyfill) after uninstall and install again the subtree equals the one before, line by line, and the expectations still hold
// The plain page passes the same expectations: they are what Chrome defines for this HTML, not what the polyfill happens to produce.
// Positive control: the control bundle drops every aria-owns write on a canvas (the link of ADR-M) and makes the live layer inert, so the children leave the
// canvas node and the tab order: every class goes red. The permanent mutant `a11y-owns-dropped` removes the aria-owns write alone (test/gates/mutants).
import { runGate, H } from './lib/gate.mjs';
import { axNodes, backendIdOf, axSubtree, axLines, axStructure, axFocused, firstDifference } from './lib/ax.mjs';

const A11Y = '/test/fixtures/a11y/index.html';
const FIXTURES = {
  a11y: {
    path: A11Y, ready: 'window.__A11Y && window.__A11Y.ready',
    roots: {
      '#chart': { role: { poly: 'list', ref: 'list' }, structure: ['root "Fruit sales"', '  listitem "" text="Apples: 40%"', '  listitem "" text="Pears: 35%"', '  listitem "" text="Plums: 25%"'] },
      '#form': {
        role: { poly: 'group', ref: 'group' },
        structure: ['root "Contact form"', '  form ""', '    heading "Contact" level=2 text="Contact"', '    textbox "Name" value="Ada"', '    checkbox "Send me news" checked=true',
          '    slider "Volume" value="5"', '    button "Send"', '    status "" live=polite text="Nothing sent yet."'],
      },
    },
    focusStart: '#step-reinstall',
    focus: [['item-apples', '#chart', 'listitem'], ['item-pears', '#chart', 'listitem'], ['item-plums', '#chart', 'listitem'], ['name', '#form', 'textbox'], ['news', '#form', 'checkbox'],
      ['volume', '#form', 'slider'], ['send', '#form', 'button']],
    field: { id: 'name', root: '#form', name: 'Name', type: ' Lovelace', value: 'Ada Lovelace' },
    slider: { id: 'volume', root: '#form', name: 'Volume', value: '6' },
    script: { run: "document.getElementById('step-text').click()", root: '#form', expect: ['heading "Contact us" level=2 text="Contact us"'], root2: '#chart', expect2: ['listitem "" text="Apples: 45%"'] },
    live: { run: "document.getElementById('step-live').click()", root: '#form', expect: 'status "" live=polite text="Update 1: the list changed."' },
    lifecycle: { uninstall: "document.getElementById('step-uninstall').click()", reinstall: "document.getElementById('step-reinstall').click()" },
  },
  f1: {
    path: '/test/fixtures/f1-water-form/index.html', ready: 'window.__HIC_FIXTURE && window.__HIC_FIXTURE.ready && (window.__HIC_FIXTURE.mode === "ref" || (window.__HIC_DRAW?.paints ?? 0) >= 1)',
    roots: {
      '#hic-surface': {
        role: { poly: 'Canvas', ref: 'generic' },
        structure: ['root "Interactive HTML-in-Canvas WebGPU plugin form"', '  form ""', '    heading "Touch the interface." level=1 text="Touch the interface."', '    heading "Fluid contact" level=2 text="Fluid contact"',
          '    textbox "Name" value="Giuseppe"', '    textbox "Email" value="hello@example.com"', '    textbox "Project" value="WebGPU interface"',
          '    textbox "Message" value="The water is refracting this actual form after the polyfill renders it."', '    checkbox "Keep the HTML snapshot reactive while I edit the controls." checked=true',
          '    slider "Frame cap · main + plugins" value="60"', '    status "" live=polite text="60 fps"', '    button "Submit form"',
          '    status "" live=polite text="●Ready · validation and submit run through the real form."'],
      },
    },
    focusStart: null,
    focus: [['name', '#hic-surface', 'textbox'], ['email', '#hic-surface', 'textbox'], ['project', '#hic-surface', 'textbox'], ['message', '#hic-surface', 'textbox'], ['consent', '#hic-surface', 'checkbox'],
      ['fps-cap', '#hic-surface', 'slider'], ['submit-button', '#hic-surface', 'button']],
    field: { id: 'project', root: '#hic-surface', name: 'Project', type: ' now', value: 'WebGPU interface now' },
    slider: { id: 'fps-cap', root: '#hic-surface', name: 'Frame cap · main + plugins', value: '65' },
    script: null,
    live: { run: "(() => { const f = document.getElementById('form-feedback'); f.dataset.state = 'error'; f.textContent = 'Check the email field.'; })()", root: '#hic-surface', expect: 'status "" live=polite text="●Check the email field."' },
    lifecycle: null,
  },
};

/** The AX subtree of every root of a fixture, read from one tree. */
async function snapshot(page, roots) {
  const nodes = await axNodes(page);
  const out = {};
  for (const sel of roots) {
    const be = await backendIdOf(page, sel);
    const sub = axSubtree(nodes, be);
    out[sel] = { be, sub, role: sub?.[0]?.role ?? null, lines: axLines(sub, { rootRole: false }), structure: axStructure(sub) };
  }
  return { nodes, roots: out };
}

/** Poll the tree until `ok(snapshot)` holds (the AX tree is updated after layout, asynchronously) or `ms` passed; returns the last snapshot. */
async function settle(page, roots, ok, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    const s = await snapshot(page, roots);
    if (ok(s) || Date.now() - t0 > ms) return s;
    await H.sleep(100);
  }
}

const has = (lines, line) => lines.some((l) => l.trim() === line);

async function open(ctx, page, id, mode) {
  const F = FIXTURES[id];
  const u = new URL(F.path, ctx.srv.url);
  u.searchParams.set('mode', mode);
  if (mode === 'poly') u.searchParams.set('bundle', ctx.bundle);
  await page.navigate(u.href);
  await ctx.focus(page);
  await page.waitForFunction(F.ready, { timeout: 15000 });
  // the link is written after `load` and one task (a11y-link.js); wait for it with the polyfill, a fixed short settle on the plain page
  if (mode === 'poly') await page.waitForFunction(`[...document.querySelectorAll('canvas')].every((c) => !c.children.length || c.hasAttribute('aria-owns'))`, { timeout: 5000 }).catch(() => {});
  await H.sleep(400);
}

/** Tab from the fixture's start and read, after every key, document.activeElement and the focused AX node. */
async function tabWalk(page, F) {
  if (F.focusStart) await page.evaluate(`document.querySelector(${JSON.stringify(F.focusStart)}).focus()`);
  else await page.evaluate('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
  const steps = [];
  for (const [id, root, role] of F.focus) {
    await page.key('Tab');
    await H.sleep(120);
    const active = await page.evaluate('document.activeElement ? document.activeElement.id : null');
    const nodes = await axNodes(page);
    const be = await backendIdOf(page, root);
    let focused = axFocused(nodes, be);
    for (let i = 0; i < 10 && (!focused || focused.role !== role); i++) { await H.sleep(100); focused = axFocused(await axNodes(page), be); }
    steps.push({ want: id, active, focused, ok: active === id && !!focused && focused.role === role && focused.underRoot });
  }
  return steps;
}

runGate('G-a11y', async (ctx) => {
  const numbers = {};
  const page = await ctx.page();
  await page.send('DOM.enable');
  await page.send('Accessibility.enable');
  for (const id of Object.keys(FIXTURES)) {
    const F = FIXTURES[id];
    const roots = Object.keys(F.roots);
    const ref = {};
    for (const mode of ['ref', 'poly']) {
      const tag = `${id} ${mode === 'ref' ? 'plain page' : 'polyfill'}`;
      const errors0 = page.errors({ includeWarnings: false }).length;
      await open(ctx, page, id, mode);
      // ---- tree
      const s0 = await settle(page, roots, (s) => roots.every((r) => firstDifference(s.roots[r].structure, F.roots[r].structure) === null));
      for (const r of roots) {
        const got = s0.roots[r];
        numbers[`${id}.${mode}.${r}.nodes`] = got.sub?.length ?? 0;
        ctx.check(`${tag} ${r}: roles, names, values and order equal the expectations`, firstDifference(got.structure, F.roots[r].structure) === null,
          { first: firstDifference(got.structure, F.roots[r].structure), got: got.structure.slice(0, 16) }, 'tree');
        ctx.check(`${tag} ${r}: the root node has role ${F.roots[r].role[mode]}`, got.role === F.roots[r].role[mode], { role: got.role }, 'tree');
        if (mode === 'ref') ref[r] = got.lines;
        else ctx.check(`${tag} ${r}: every node of the subtree equals the plain page's, line by line`, firstDifference(got.lines, ref[r]) === null,
          { first: firstDifference(got.lines, ref[r]), lines: got.lines.length, refLines: ref[r]?.length }, 'tree');
      }
      // ---- lifecycle (polyfill only): before any edit, so the trees compare like with like
      if (mode === 'poly' && F.lifecycle) {
        await page.evaluate(F.lifecycle.uninstall);
        await H.sleep(500);
        const gone = await page.evaluate(`({ layers: document.querySelectorAll('hic-layer').length, owns: [...document.querySelectorAll('canvas')].map((c) => c.getAttribute('aria-owns')), generated: document.querySelectorAll('[id^="hic-o-"]').length })`);
        const s1 = await snapshot(page, roots);
        numbers[`${id}.uninstalled`] = { ...gone, structure: Object.fromEntries(roots.map((r) => [r, s1.roots[r].structure])) };
        ctx.check(`${tag}: uninstall removes the layer, the generated aria-owns and ids`, gone.layers === 0 && gone.owns.every((v) => v === null) && gone.generated === 0, gone, 'lifecycle');
        await page.evaluate(F.lifecycle.reinstall);
        await page.waitForFunction(`[...document.querySelectorAll('canvas')].every((c) => c.hasAttribute('aria-owns')) && document.querySelectorAll('hic-layer').length === ${roots.length}`, { timeout: 5000 }).catch(() => {});
        const s2 = await settle(page, roots, (s) => roots.every((r) => firstDifference(s.roots[r].lines, s0.roots[r].lines) === null));
        for (const r of roots) {
          ctx.check(`${tag} ${r}: after uninstall and install again the subtree equals the one before, line by line`, firstDifference(s2.roots[r].lines, s0.roots[r].lines) === null,
            { first: firstDifference(s2.roots[r].lines, s0.roots[r].lines) }, 'lifecycle');
          ctx.check(`${tag} ${r}: ... and the expectations still hold`, firstDifference(s2.roots[r].structure, F.roots[r].structure) === null, { first: firstDifference(s2.roots[r].structure, F.roots[r].structure) }, 'lifecycle');
        }
      }
      // ---- focus
      const steps = await tabWalk(page, F);
      numbers[`${id}.${mode}.tab`] = steps.map((s) => `${s.active}:${s.focused?.role ?? '-'}${s.focused?.underRoot ? '' : '(outside)'}`);
      ctx.check(`${tag}: Tab reaches every control in DOM order, and the focused AX node is that control under its canvas`, steps.every((s) => s.ok), steps.filter((s) => !s.ok).slice(0, 3), 'focus');
      // ---- edit: trusted typing, an arrow key on the slider, a script text change
      await page.evaluate(`(() => { const f = document.getElementById(${JSON.stringify(F.field.id)}); f.focus(); f.setSelectionRange(f.value.length, f.value.length); })()`);
      let typed = null;
      try { await page.typeText(F.field.type, { intervalMs: 30 }); typed = true; } catch (e) { typed = String(e.message); }
      const fieldLine = `textbox "${F.field.name}" value=${JSON.stringify(F.field.value)}`;
      const s3 = await settle(page, [F.field.root], (s) => has(s.roots[F.field.root].structure, fieldLine));
      ctx.check(`${tag}: typed text is the field's value in the tree (${F.field.value})`, typed === true && has(s3.roots[F.field.root].structure, fieldLine),
        { typed, got: s3.roots[F.field.root].structure.filter((l) => l.includes('textbox')) }, 'edit');
      await page.evaluate(`document.getElementById(${JSON.stringify(F.slider.id)}).focus()`);
      const sliderFocused = await page.evaluate(`document.activeElement && document.activeElement.id === ${JSON.stringify(F.slider.id)}`);
      if (sliderFocused) await page.key('ArrowRight');
      const sliderLine = `slider "${F.slider.name}" value=${JSON.stringify(F.slider.value)}`;
      const s4 = await settle(page, [F.slider.root], (s) => has(s.roots[F.slider.root].structure, sliderLine));
      ctx.check(`${tag}: an arrow key moves the slider's value in the tree (${F.slider.value})`, sliderFocused && has(s4.roots[F.slider.root].structure, sliderLine),
        { sliderFocused, got: s4.roots[F.slider.root].structure.filter((l) => l.includes('slider')) }, 'edit');
      if (F.script) {
        await page.evaluate(F.script.run);
        const s5 = await settle(page, roots, (s) => F.script.expect.every((l) => has(s.roots[F.script.root].structure, l)) && F.script.expect2.every((l) => has(s.roots[F.script.root2].structure, l)));
        ctx.check(`${tag}: a script text change is in the tree (the heading and the list item)`, F.script.expect.every((l) => has(s5.roots[F.script.root].structure, l)) && F.script.expect2.every((l) => has(s5.roots[F.script.root2].structure, l)),
          { form: s5.roots[F.script.root].structure, chart: s5.roots[F.script.root2].structure }, 'edit');
      }
      // ---- live region
      await page.evaluate(F.live.run);
      const s6 = await settle(page, [F.live.root], (s) => has(s.roots[F.live.root].structure, F.live.expect));
      ctx.check(`${tag}: a live update is in the tree with its text and politeness, under the canvas`, has(s6.roots[F.live.root].structure, F.live.expect),
        { got: s6.roots[F.live.root].structure.filter((l) => l.includes('status')) }, 'live');
      const errs = page.errors({ includeWarnings: false }).slice(errors0);
      ctx.check(`${tag}: no page error or console error`, errs.length === 0, errs.slice(0, 3), 'surface');
    }
  }
  return { numbers };
}, { controlClasses: ['tree', 'focus', 'edit', 'live', 'lifecycle'], controlSabotage: ['noaxlink', 'inertlayer'] });
