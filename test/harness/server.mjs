#!/usr/bin/env node
// Zero-dependency static server rooted at the repository.
//
//   node test/harness/server.mjs [--port=0] [--host=127.0.0.1] [--root=<dir>]
//   import { startServer } from './server.mjs'; const s = await startServer(); s.url; await s.close();
//
//  * `Cache-Control: no-store` everywhere; MIME types incl. .wgsl/.wasm/.mjs.
//  * Sends COOP/COEP/CORP headers (page is crossOriginIsolated, like a typical WebGPU demo host). Append `?iso=0` to any URL
//    to drop them, `?corp=cross-origin` to send `Cross-Origin-Resource-Policy: cross-origin` instead (a resource another origin's isolated page may load
//    without CORS, e.g. a cross-origin video that taints a canvas).
//  * GET /__hic/hash?path=/dist/polyfill.js -> {path, sha256, bytes}: assert the bundle identity under test in every experiment.
//  * GET /test/fixtures/f4-large-app/index.html?nodes=N is generated on the fly (see fixtures/f4-large-app/generate.mjs).
//  * Dot-directories (.git, .profiles, .scratch) and path traversal outside the root are refused (403).
//  * `aliases` option maps URL paths onto other files, e.g. {'/bundle.js': '/dist/hic-polyfill.iife.js'}.
//  * `files` option maps URL paths onto ABSOLUTE files anywhere on disk (not subject to the dot-directory refusal), e.g. a mutated bundle built under
//    .scratch/ served as the normal bundle path: {'/dist/hic-live-polyfill.iife.js': '/abs/.scratch/mutants/x/bundle.js'}.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT } from './lib/util.mjs';
import { generateF4Html } from '../fixtures/f4-large-app/generate.mjs';

export const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.htm', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.wgsl', 'text/plain; charset=utf-8'], ['.txt', 'text/plain; charset=utf-8'], ['.md', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
  ['.gif', 'image/gif'], ['.ico', 'image/x-icon'], ['.wasm', 'application/wasm'], ['.map', 'application/json; charset=utf-8'],
  ['.woff2', 'font/woff2'], ['.woff', 'font/woff'], ['.ttf', 'font/ttf'], ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
]);

/** Insert `snippet` as the first thing the parser runs: after `<head>` when there is one, else after the doctype. @param {string} html @param {string} snippet */
export function injectHead(html, snippet) {
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + snippet + html.slice(head.index + head[0].length);
  const doctype = /<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype.index + doctype[0].length : 0;
  return html.slice(0, at) + snippet + html.slice(at);
}

/**
 * `inject` (string, optional): HTML inserted at the top of every served .html file (the cross-browser runner uses it for its console/error recorder, because
 * classic WebDriver has no console log).
 * @param {{root?:string, port?:number, host?:string, aliases?:Record<string,string>, files?:Record<string,string>, inject?:string}} [o]
 * @returns {Promise<{server:import('node:http').Server, host:string, port:number, root:string, url:string, requests:{url:string,status:number,ms:number}[], close:()=>Promise<void>}>}
 */
export async function startServer({ root = PROJECT_ROOT, port = 0, host = '127.0.0.1', aliases = {}, files = {}, inject = '' } = {}) {
  const absRoot = resolve(root);
  const requests = [];
  const server = createServer(async (req, res) => {
    const t0 = Date.now(); let status = 200;
    let iso = true;
    let corp = 'same-origin';
    const send = (code, type, body, extra = {}) => {
      status = code;
      const h = { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra };
      if (iso) Object.assign(h, { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': corp, 'Origin-Agent-Cluster': '?1' });
      res.writeHead(code, h); res.end(body);
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      iso = url.searchParams.get('iso') !== '0';
      if (url.searchParams.get('corp') === 'cross-origin') corp = 'cross-origin';
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { return send(400, 'text/plain', 'Bad request'); }
      if (files[pathname]) {
        const body = await readFile(files[pathname]).catch(() => null);
        if (!body) return send(404, 'text/plain', 'Not found: ' + files[pathname]);
        return send(200, MIME.get(extname(files[pathname]).toLowerCase()) ?? 'application/octet-stream', body, { 'Content-Length': String(body.byteLength) });
      }
      if (aliases[pathname]) pathname = aliases[pathname];
      if (pathname === '/favicon.ico') return send(204, 'image/x-icon', '');
      if (pathname === '/__hic/hash') {
        const p = url.searchParams.get('path') ?? '';
        const f = resolve(absRoot, '.' + p);
        if (!f.startsWith(absRoot + sep)) return send(403, 'text/plain', 'Forbidden');
        const b = await readFile(f).catch(() => null);
        if (!b) return send(404, 'text/plain', 'Not found: ' + p);
        return send(200, MIME.get('.json'), JSON.stringify({ path: p, sha256: createHash('sha256').update(b).digest('hex'), bytes: b.byteLength }));
      }
      if (pathname === '/test/fixtures/f4-large-app/index.html') {
        const nodes = Number(url.searchParams.get('nodes') ?? 500);
        return send(200, MIME.get('.html'), generateF4Html({ nodes }));
      }
      if (pathname === '/') pathname = '/test/harness/README.md';
      const file = resolve(absRoot, '.' + pathname);
      if (file !== absRoot && !file.startsWith(absRoot + sep)) return send(403, 'text/plain', 'Forbidden');
      if (file.slice(absRoot.length).split(sep).some(seg => seg.startsWith('.') && seg.length > 1)) return send(403, 'text/plain', 'Forbidden (dot path)');
      let info;
      try { info = await stat(file); } catch { return send(404, 'text/plain', 'Not found: ' + pathname); }
      const target = info.isDirectory() ? resolve(file, 'index.html') : file;
      let body = await readFile(target).catch(() => null);
      if (!body) return send(404, 'text/plain', 'Not found: ' + pathname);
      if (inject && extname(target).toLowerCase() === '.html') body = Buffer.from(injectHead(body.toString('utf8'), inject));
      return send(200, MIME.get(extname(target).toLowerCase()) ?? 'application/octet-stream', body, { 'Content-Length': String(body.byteLength) });
    } catch (e) {
      return send(500, 'text/plain', 'Server error: ' + (e?.message ?? e));
    } finally {
      requests.push({ url: req.url, status, ms: Date.now() - t0 });
      if (requests.length > 2000) requests.splice(0, 1000);
    }
  });
  await new Promise((ok, bad) => { server.once('error', bad); server.listen(port, host, ok); });
  const addr = server.address();
  return { server, host, port: addr.port, root: absRoot, requests, url: `http://${host}:${addr.port}`,
    close: () => new Promise(ok => { server.closeAllConnections?.(); server.close(() => ok()); }) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const s = await startServer({ root: arg('root') ?? PROJECT_ROOT, port: Number(arg('port') ?? 0), host: arg('host') ?? '127.0.0.1' });
  console.log(`harness server: ${s.url}  (root ${s.root})`);
  const stop = async () => { await s.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
