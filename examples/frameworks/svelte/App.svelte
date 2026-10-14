<!-- Svelte 5 app whose UI lives inside <canvas content="drawable"> and is painted with drawElementImage from the `paint` event.
     The polyfill script (dist/hic-live-polyfill.iife.js) is loaded by index.html BEFORE this bundle. -->
<script>
  import Ticker from './Ticker.svelte';
  import { BADGE_AT, MODE, initialItems, newItem, testApi } from '../shared/app-spec.js';

  const api = testApi(() => document);
  let canvas = $state(), panel = $state(), badgeEl = $state();
  let name = $state(''), items = $state(initialItems()), selected = $state(null), badge = $state(true), badgeClicks = $state(0);
  let surface = $state(true), note = $state(false); // the whole canvas mounts/unmounts; a sibling after the canvas

  const actions = {
    add: () => { if (items.length < 6) items.push(newItem(items.length)); },
    remove: () => { items.shift(); },
    reverse: () => { items.reverse(); },
    toggle: () => { badge = !badge; },
    toggleSurface: () => { surface = !surface; },
    toggleNote: () => { note = !note; },
  };

  $effect(() => {
    api.renders += 1;
    api.state = { name, order: items.map((i) => i.id), selected, badge, badgeClicks, surface, note };
    api.actions = actions; api.ready = true;
  });

  // Wire the canvas for as long as THAT element exists: the effect re-runs when bind:this changes (the {#if} re-creates the canvas).
  // Only `canvas` is tracked: panel/badgeEl are read inside the paint handler, which runs outside the effect.
  $effect(() => {
    if (!canvas || MODE === 'ref') return;
    const c = canvas, ctx = c.getContext('2d');
    const onPaint = () => {
      ctx.reset();
      const s = c.width / c.clientWidth;
      if (panel) ctx.drawElementImage(panel, 0, 0);
      if (badgeEl) ctx.drawElementImage(badgeEl, BADGE_AT.x * s, BADGE_AT.y * s); // bind:this is null while the {#if} is false
    };
    c.addEventListener('paint', onPaint); // survives uninstall()/install(); an onpaint property does not
    const ro = new ResizeObserver(([e]) => { const b = e.devicePixelContentBoxSize[0]; c.width = b.inlineSize; c.height = b.blockSize; });
    ro.observe(c, { box: 'device-pixel-content-box' });
    return () => { ro.disconnect(); c.removeEventListener('paint', onPaint); };
  });
</script>

{#snippet content()}
  <div id="panel" class="panel" drawable="" bind:this={panel}>
    <h2>Svelte 5 in a canvas</h2>
    <form onsubmit={(e) => e.preventDefault()}>
      <input id="name" bind:value={name} placeholder="your name">
      <span id="echo" class="echo">Hello, {name || 'nobody'}!</span>
    </form>
    <ul id="list">
      {#each items as it (it.id)}
        <li data-id={it.id} class={selected === it.id ? 'sel' : ''} style:background={it.color} onclick={() => (selected = it.id)}>{it.label}</li>
      {/each}
    </ul>
    <div class="buttons">
      <button id="btn-add" type="button" onclick={actions.add}>Add</button>
      <button id="btn-remove" type="button" onclick={actions.remove}>Remove first</button>
      <button id="btn-reverse" type="button" onclick={actions.reverse}>Reverse</button>
      <button id="btn-toggle" type="button" onclick={actions.toggle}>Badge</button>
    </div>
    <Ticker />
    <div class="status">selected: {selected ?? '-'} / badge clicks: {badgeClicks}</div>
  </div>
  {#if badge}
    <div id="badge" class="badge" drawable="" bind:this={badgeEl} onclick={() => badgeClicks++}>BADGE</div>
  {/if}
{/snippet}

<div class="app">
  {#if surface}
    {#if MODE === 'ref'}
      <div id="surface" class="surface ref">{@render content()}</div>
    {:else}
      <canvas id="surface" class="surface" content="drawable" bind:this={canvas}>{@render content()}</canvas>
    {/if}
  {/if}
  {#if note}<p id="note" class="note">A note rendered after the canvas.</p>{/if}
</div>
