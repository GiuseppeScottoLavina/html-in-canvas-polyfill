/**
 * ResourceCache: fetch + encode as data: URLs with an LRU byte budget and loud failures.
 * Module: snapshot-capture (src/snapshot/capture/*).
 */

import { HicUnsupportedError } from '../../contracts/errors.js';
import { skipParens, skipString } from './css-rewrite.js';

/** @typedef {import('../../contracts/types.js').HicEnv} HicEnv */
/** @typedef {import('../../contracts/types.js').ResourceCache} ResourceCache */

const DEFAULT_MAX_BYTES = 48 * 1024 * 1024;
const RETRY_AFTER_MS = 5000;

/** @type {Record<string, string>} */
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', css: 'text/css',
};

/** @param {string} url @returns {string} lower-case extension without query or hash, '' when none */
function extensionOf(url) {
  const m = /\.([a-z0-9]{2,5})(?:[?#].*)?$/i.exec(url);
  return m ? m[1].toLowerCase() : '';
}

/** @param {string} url @param {string} kind @returns {string} */
function guessMime(url, kind) {
  return MIME[extensionOf(url)] ?? (kind === 'font' ? 'font/woff2' : kind === 'css' ? 'text/css' : kind === 'svg' ? 'image/svg+xml' : 'application/octet-stream');
}

/** @param {Uint8Array} bytes @returns {string} */
function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(i, i + 0x8000)));
  return btoa(bin);
}

/**
 * @param {HicEnv} env
 * @param {string} absUrl
 * @param {'image'|'font'|'css'|'svg'} kind
 * @returns {Promise<string>}
 */
async function fetchAsDataUrl(env, absUrl, kind) {
  /** @type {URL} */
  let url;
  try {
    url = new URL(absUrl, env.document.baseURI);
  } catch {
    throw new HicUnsupportedError('resource-fetch-failed', `invalid resource URL ${absUrl}`, { path: absUrl });
  }
  const sameOrigin = url.origin === env.window.location.origin;
  /** @type {Response} */
  let res;
  try {
    res = await env.window.fetch(url.href, sameOrigin ? { credentials: 'include' } : { mode: 'cors', credentials: 'omit' });
  } catch {
    throw sameOrigin
      ? new HicUnsupportedError('resource-fetch-failed', `could not fetch ${url.href}`, { path: url.href, hint: 'Check the URL, the network and the content security policy (connect-src).' })
      : new HicUnsupportedError('cross-origin-resource', `${url.href} cannot be read: the server did not allow cross-origin (CORS) access`, { path: url.href, hint: 'Serve it with Access-Control-Allow-Origin, or host it on the same origin as the page.' });
  }
  if (!res.ok) throw new HicUnsupportedError('resource-fetch-failed', `${url.href} answered HTTP ${res.status}`, { path: url.href });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const header = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const mime = header && header !== 'application/octet-stream' ? header : guessMime(url.href, kind);
  return `data:${mime};base64,${toBase64(bytes)}`;
}

/**
 * peek (sync) / load (async) / onReady / stats / clear. Failures reject with HicUnsupportedError (cross-origin-resource | resource-fetch-failed). Budget default 48 MB.
 * @param {HicEnv} env
 * @param {number} [maxBytes]
 * @returns {ResourceCache}
 */
export function createResourceCache(env, maxBytes = DEFAULT_MAX_BYTES) {
  /** @type {Map<string, string>} insertion order = recency (peek re-inserts) */
  const store = new Map();
  /** @type {Map<string, Promise<string>>} */
  const inflight = new Map();
  /** @type {Set<(absUrl: string) => void>} */
  const listeners = new Set();
  let bytes = 0;
  let epoch = 0;

  /** @param {string} key @param {string} value */
  const remember = (key, value) => {
    const old = store.get(key);
    if (old !== undefined) bytes -= old.length;
    store.set(key, value);
    bytes += value.length;
    for (const k of store.keys()) {
      if (bytes <= maxBytes || k === key) break;
      bytes -= store.get(k)?.length ?? 0;
      store.delete(k);
    }
  };

  /** @param {string} absUrl */
  const notify = (absUrl) => { for (const cb of [...listeners]) { try { cb(absUrl); } catch (err) { env.reporter.caught(err, 'resource-ready'); } } };

  return {
    peek(absUrl) {
      if (absUrl.startsWith('data:')) return absUrl;
      const hit = store.get(absUrl);
      if (hit === undefined) return null;
      store.delete(absUrl);
      store.set(absUrl, hit);
      return hit;
    },
    load(absUrl, kind) {
      if (absUrl.startsWith('data:')) return Promise.resolve(absUrl);
      const hit = store.get(absUrl);
      if (hit !== undefined) return Promise.resolve(hit);
      const running = inflight.get(absUrl);
      if (running) return running;
      const mine = epoch;
      const p = fetchAsDataUrl(env, absUrl, kind).then((dataUrl) => {
        inflight.delete(absUrl);
        if (dataUrl.length > maxBytes) throw new HicUnsupportedError('resource-fetch-failed', `${absUrl} is larger than the resource cache budget (${maxBytes} bytes)`, { path: absUrl });
        if (mine !== epoch) return dataUrl;
        remember(absUrl, dataUrl);
        notify(absUrl);
        return dataUrl;
      }, (err) => { inflight.delete(absUrl); notify(absUrl); throw err; }); // a failure also settles the load: the next capture sees it and reports it (otherwise nothing would ever re-run the capture)
      inflight.set(absUrl, p);
      return p;
    },
    settle(what) { notify(what); },
    onReady(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    stats: () => ({ entries: store.size, bytes }),
    clear() {
      store.clear();
      inflight.clear();
      bytes = 0;
      epoch++;
    },
  };
}

// ---------------------------------------------------------------------------------------------- non-blocking use

/** @type {WeakMap<ResourceCache, Map<string, {error: HicUnsupportedError|null, at: number}>>} */
const memos = new WeakMap();

/** @param {string} absUrl @returns {'image'|'font'|'css'|'svg'} best guess from the extension */
export function kindOfUrl(absUrl) {
  const ext = extensionOf(absUrl);
  if (ext === 'woff' || ext === 'woff2' || ext === 'ttf' || ext === 'otf') return 'font';
  if (ext === 'svg') return 'svg';
  if (ext === 'css') return 'css';
  return 'image';
}

/**
 * The hot-path question of every capture: is this resource a data: URL yet? Starts the load when it is not cached and remembers a failure for a few seconds,
 * so that a broken URL is reported once and not refetched by every capture.
 * @param {ResourceCache} cache
 * @param {string} absUrl
 * @param {'image'|'font'|'css'|'svg'} [kind]
 * @returns {{state: 'ready', url: string} | {state: 'pending'} | {state: 'failed', error: HicUnsupportedError}}
 */
export function resolveResource(cache, absUrl, kind = kindOfUrl(absUrl)) {
  const hit = cache.peek(absUrl);
  if (hit) return { state: 'ready', url: hit };
  let memo = memos.get(cache);
  if (!memo) memos.set(cache, (memo = new Map()));
  const seen = memo.get(absUrl);
  if (seen) {
    if (seen.error && Date.now() - seen.at < RETRY_AFTER_MS) return { state: 'failed', error: seen.error };
    if (!seen.error) return { state: 'pending' };
  }
  memo.set(absUrl, { error: null, at: Date.now() });
  const m = memo;
  cache.load(absUrl, kind).then(
    () => { m.delete(absUrl); },
    (err) => { m.set(absUrl, { error: err instanceof HicUnsupportedError ? err : new HicUnsupportedError('resource-fetch-failed', String(err?.message ?? err), { path: absUrl }), at: Date.now() }); },
  );
  return { state: 'pending' };
}

const URL_TOKEN = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)"'\s][^)]*?))\s*\)/gi;

/** A declaration of a mask layer image: `mask`, `mask-image` and their -webkit- forms (not -webkit-mask-box-image, not -webkit-box-reflect). */
const MASK_DECL = /(?:^|[;{\s])((?:-webkit-)?mask(?:-image)?)\s*:/gi;
/**
 * A mask layer whose image is not drawn: CSS Masking 1 (mask-image) treats "a mask reference that is an empty image, ... that fails to download, ... or cannot be displayed" as a
 * transparent black image layer, so the masked element is masked away; read-back-allowed rendering makes a CORS-cross-origin image such an image (WHATWG HTML PR 12554, "Read-back-allowed
 * rendering": CSS <url> references to CORS-cross-origin content are invisible). Chromium draws the element UNMASKED for the empty `data:,` the other properties get, so a mask layer gets
 * an image that loads and is transparent everywhere (WPT privacy/box-mask-*, privacy/fragment-mask-*). A -webkit-box-reflect mask is not a mask layer: natively the reflection is then
 * drawn unmasked (WPT privacy/box-reflect-images-in-iframe-moved-ignored), which `data:,` gives.
 */
const TRANSPARENT_MASK = 'linear-gradient(transparent,transparent)';

/**
 * PURE. The [start, end) ranges of the mask layer declarations of a stylesheet or a style attribute (strings and parentheses skipped).
 * @param {string} css
 * @returns {Array<[number, number]>}
 */
export function maskDeclarationRanges(css) {
  /** @type {Array<[number, number]>} */
  const out = [];
  if (!/mask/i.test(css)) return out;
  MASK_DECL.lastIndex = 0;
  for (let m = MASK_DECL.exec(css); m; m = MASK_DECL.exec(css)) {
    const start = m.index + m[0].length;
    let i = start;
    for (; i < css.length; i++) {
      const c = css.charCodeAt(i);
      if (c === 34 || c === 39) i = skipString(css, i) - 1;
      else if (c === 40) i = skipParens(css, i) - 1;
      else if (c === 92) i++;
      else if (c === 59 || c === 123 || c === 125) break;
    }
    out.push([start, i]);
    MASK_DECL.lastIndex = i;
  }
  return out;
}

/**
 * Replace every url() of css by cached data: URLs resolved against baseUrl; uncached ones are started and listed in pending (and replaced by an empty data: URL,
 * so that the SVG image never tries the network); resources that failed are listed in failed. In a mask layer declaration both become a transparent image instead
 * (TRANSPARENT_MASK): the element stays masked away until its mask image is drawn, and is never drawn unmasked.
 * @param {string} css
 * @param {string} baseUrl
 * @param {ResourceCache} cache
 * @returns {{css: string, pending: string[], failed: Array<{url: string, error: HicUnsupportedError}>}}
 */
export function inlineCssUrls(css, baseUrl, cache) {
  /** @type {string[]} */
  const pending = [];
  /** @type {Array<{url: string, error: HicUnsupportedError}>} */
  const failed = [];
  if (!/url\(/i.test(css)) return { css, pending, failed };
  const masks = maskDeclarationRanges(css);
  const out = css.replace(URL_TOKEN, (whole, dq, sq, bare, /** @type {number} */ offset) => {
    const raw = String(dq ?? sq ?? bare).replace(/\\(.)/g, '$1');
    if (raw.startsWith('data:') || raw.startsWith('#') || raw.startsWith('about:') || !raw) return whole;
    let abs;
    try {
      abs = new URL(raw, baseUrl).href;
    } catch {
      return whole;
    }
    const r = resolveResource(cache, abs);
    if (r.state === 'ready') return `url("${r.url}")`;
    if (r.state === 'pending') pending.push(abs);
    else failed.push({ url: abs, error: r.error });
    return masks.some(([a, b]) => offset >= a && offset < b) ? TRANSPARENT_MASK : 'url("data:,")';
  });
  return { css: out, pending, failed };
}
