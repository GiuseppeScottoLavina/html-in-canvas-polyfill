// Vue 3 app whose UI lives inside <canvas content="drawable"> and is painted with drawElementImage from the `paint` event.
// The polyfill script (dist/hic-live-polyfill.iife.js) is loaded by index.html BEFORE this bundle. Templates are compiled at runtime
// (vue.esm-bundler with the compiler), so the template below is exactly what a single-file component would contain.
import { createApp, defineComponent, onBeforeUnmount, onMounted, onUpdated, ref, watch } from 'vue';
import { BADGE_AT, CSS, MODE, TICKING, initialItems, newItem, testApi } from '../shared/app-spec.js';

const api = testApi(() => document);

const Ticker = defineComponent({
  setup() {
    const n = ref(0);
    let t;
    onMounted(() => { if (TICKING) t = setInterval(() => { n.value += 1; }, 500); });
    onBeforeUnmount(() => clearInterval(t));
    return { n };
  },
  template: `<div class="tick">tick: {{ n }}</div>`,
});

const App = defineComponent({
  components: { Ticker },
  setup() {
    const canvas = ref(null), panel = ref(null), badgeEl = ref(null);
    const name = ref(''), items = ref(initialItems()), selected = ref(null), badge = ref(true), badgeClicks = ref(0);
    const surface = ref(true), note = ref(false); // the whole canvas mounts/unmounts; a sibling after the canvas
    const actions = {
      add: () => { if (items.value.length < 6) items.value.push(newItem(items.value.length)); },
      remove: () => { items.value.shift(); },
      reverse: () => { items.value.reverse(); },
      toggle: () => { badge.value = !badge.value; },
      toggleSurface: () => { surface.value = !surface.value; },
      toggleNote: () => { note.value = !note.value; },
    };
    const expose = () => {
      api.renders += 1;
      api.state = { name: name.value, order: items.value.map((i) => i.id), selected: selected.value, badge: badge.value, badgeClicks: badgeClicks.value, surface: surface.value, note: note.value };
      api.actions = actions; api.ready = true;
    };
    // Wire the canvas for as long as THAT element exists: watch the template ref (it changes when v-if re-creates the canvas).
    watch(canvas, (c, _old, onCleanup) => {
      if (!c || MODE === 'ref') return;
      const ctx = c.getContext('2d');
      const onPaint = () => {
        ctx.reset();
        const s = c.width / c.clientWidth;
        if (panel.value) ctx.drawElementImage(panel.value, 0, 0);
        if (badgeEl.value) ctx.drawElementImage(badgeEl.value, BADGE_AT.x * s, BADGE_AT.y * s); // template ref is null while unmounted
      };
      c.addEventListener('paint', onPaint); // survives uninstall()/install(); an onpaint property does not
      const ro = new ResizeObserver(([e]) => { const b = e.devicePixelContentBoxSize[0]; c.width = b.inlineSize; c.height = b.blockSize; });
      ro.observe(c, { box: 'device-pixel-content-box' });
      onCleanup(() => { ro.disconnect(); c.removeEventListener('paint', onPaint); });
    }, { flush: 'post' });
    onMounted(expose);
    onUpdated(expose);
    return { canvas, panel, badgeEl, name, items, selected, badge, badgeClicks, actions, surface, note,
      surfaceTag: MODE === 'ref' ? 'div' : 'canvas', surfaceClass: MODE === 'ref' ? 'surface ref' : 'surface',
      contentAttr: MODE === 'ref' ? null : 'drawable' };
  },
  template: `<div class="app">
    <component v-if="surface" :is="surfaceTag" id="surface" ref="canvas" :class="surfaceClass" :content="contentAttr">
      <div id="panel" class="panel" drawable="" ref="panel">
        <h2>Vue 3 in a canvas</h2>
        <form @submit.prevent>
          <input id="name" v-model="name" placeholder="your name">
          <span id="echo" class="echo">Hello, {{ name || 'nobody' }}!</span>
        </form>
        <ul id="list">
          <li v-for="it in items" :key="it.id" :data-id="it.id" :class="selected === it.id ? 'sel' : ''"
              :style="{ background: it.color }" @click="selected = it.id">{{ it.label }}</li>
        </ul>
        <div class="buttons">
          <button id="btn-add" type="button" @click="actions.add">Add</button>
          <button id="btn-remove" type="button" @click="actions.remove">Remove first</button>
          <button id="btn-reverse" type="button" @click="actions.reverse">Reverse</button>
          <button id="btn-toggle" type="button" @click="actions.toggle">Badge</button>
        </div>
        <Ticker />
        <div class="status">selected: {{ selected ?? '-' }} / badge clicks: {{ badgeClicks }}</div>
      </div>
      <div v-if="badge" id="badge" class="badge" drawable="" ref="badgeEl" @click="badgeClicks++">BADGE</div>
    </component>
    <p v-if="note" id="note" class="note">A note rendered after the canvas.</p>
  </div>`,
});

document.head.append(Object.assign(document.createElement('style'), { textContent: CSS }));
const app = createApp(App);
app.config.errorHandler = (err, _vm, info) => { console.error('[vue errorHandler]', info, err?.stack ?? err); };
app.mount('#root');
