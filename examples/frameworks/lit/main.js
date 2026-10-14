// Lit 3 app whose UI lives inside <canvas content="drawable"> and is painted with drawElementImage from the `paint` event.
// The polyfill script (dist/hic-live-polyfill.iife.js) is loaded by index.html BEFORE this bundle. The canvas lives in the
// component's OPEN shadow root (Lit's default), which the polyfill manages like a document canvas (API-CONTRACT section 3).
import { LitElement, css, html, nothing, unsafeCSS } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { styleMap } from 'lit/directives/style-map.js';
import { ref, createRef } from 'lit/directives/ref.js';
import { BADGE_AT, CSS, MODE, TICKING, initialItems, newItem, testApi } from '../shared/app-spec.js';

class HicTicker extends LitElement {
  static properties = { n: { state: true } };
  static styles = css`:host { display: block; }`;
  constructor() { super(); this.n = 0; }
  connectedCallback() { super.connectedCallback(); if (TICKING) this.t = setInterval(() => { this.n += 1; }, 500); }
  disconnectedCallback() { super.disconnectedCallback(); clearInterval(this.t); }
  createRenderRoot() { return this; } // light DOM: the ticker's text belongs to the drawable panel's subtree, not to a nested shadow root
  render() { return html`<div class="tick">tick: ${this.n}</div>`; }
}
customElements.define('hic-ticker', HicTicker);

class HicApp extends LitElement {
  static properties = {
    name: { state: true }, items: { state: true }, selected: { state: true }, badge: { state: true }, badgeClicks: { state: true },
    surface: { state: true }, note: { state: true },
  };
  static styles = unsafeCSS(CSS);
  panelRef = createRef(); badgeRef = createRef();
  api = testApi(() => this.renderRoot);

  constructor() {
    super();
    this.name = ''; this.items = initialItems(); this.selected = null; this.badge = true; this.badgeClicks = 0;
    this.surface = true; this.note = false; // the whole canvas mounts/unmounts (think: a route change); a sibling after the canvas
    this.actions = {
      add: () => { if (this.items.length < 6) this.items = [...this.items, newItem(this.items.length)]; },
      remove: () => { this.items = this.items.slice(1); },
      reverse: () => { this.items = [...this.items].reverse(); },
      toggle: () => { this.badge = !this.badge; },
      toggleSurface: () => { this.surface = !this.surface; },
      toggleNote: () => { this.note = !this.note; },
    };
  }

  // Wire the canvas for as long as THAT element exists: Lit calls a ref callback with the element, and with undefined when it leaves
  // the DOM (a conditional template re-creates the canvas). Arrow-function field: one stable callback, so Lit does not re-invoke it per render.
  onCanvas = (canvas) => {
    this.unwire?.(); this.unwire = null;
    if (!canvas || MODE === 'ref') return;
    const ctx = canvas.getContext('2d');
    const onPaint = () => {
      ctx.reset();
      const s = canvas.width / canvas.clientWidth;
      if (this.panelRef.value) ctx.drawElementImage(this.panelRef.value, 0, 0);
      if (this.badgeRef.value) ctx.drawElementImage(this.badgeRef.value, BADGE_AT.x * s, BADGE_AT.y * s); // ref() is undefined while not rendered
    };
    canvas.addEventListener('paint', onPaint); // survives uninstall()/install(); an onpaint property does not
    const ro = new ResizeObserver(([e]) => { const b = e.devicePixelContentBoxSize[0]; canvas.width = b.inlineSize; canvas.height = b.blockSize; });
    ro.observe(canvas, { box: 'device-pixel-content-box' });
    this.unwire = () => { ro.disconnect(); canvas.removeEventListener('paint', onPaint); };
  };

  updated() {
    this.api.renders += 1;
    this.api.state = { name: this.name, order: this.items.map((i) => i.id), selected: this.selected, badge: this.badge, badgeClicks: this.badgeClicks, surface: this.surface, note: this.note };
    this.api.actions = this.actions; this.api.ready = true;
  }

  content() {
    return html`
      <div id="panel" class="panel" drawable="" ${ref(this.panelRef)}>
        <h2>Lit 3 in a canvas</h2>
        <form @submit=${(e) => e.preventDefault()}>
          <input id="name" .value=${this.name} placeholder="your name" @input=${(e) => { this.name = e.target.value; }}>
          <span id="echo" class="echo">Hello, ${this.name || 'nobody'}!</span>
        </form>
        <ul id="list">
          ${repeat(this.items, (it) => it.id, (it) => html`
            <li data-id=${it.id} class=${this.selected === it.id ? 'sel' : ''} style=${styleMap({ background: it.color })}
                @click=${() => { this.selected = it.id; }}>${it.label}</li>`)}
        </ul>
        <div class="buttons">
          <button id="btn-add" type="button" @click=${this.actions.add}>Add</button>
          <button id="btn-remove" type="button" @click=${this.actions.remove}>Remove first</button>
          <button id="btn-reverse" type="button" @click=${this.actions.reverse}>Reverse</button>
          <button id="btn-toggle" type="button" @click=${this.actions.toggle}>Badge</button>
        </div>
        <hic-ticker></hic-ticker>
        <div class="status">selected: ${this.selected ?? '-'} / badge clicks: ${this.badgeClicks}</div>
      </div>
      ${this.badge ? html`<div id="badge" class="badge" drawable="" ${ref(this.badgeRef)} @click=${() => { this.badgeClicks += 1; }}>BADGE</div>` : nothing}`;
  }

  render() {
    const surface = !this.surface ? nothing : MODE === 'ref'
      ? html`<div id="surface" class="surface ref">${this.content()}</div>`
      : html`<canvas id="surface" class="surface" content="drawable" ${ref(this.onCanvas)}>${this.content()}</canvas>`;
    return html`<div class="app">${surface}${this.note ? html`<p id="note" class="note">A note rendered after the canvas.</p>` : nothing}</div>`;
  }
}
customElements.define('hic-app', HicApp);
