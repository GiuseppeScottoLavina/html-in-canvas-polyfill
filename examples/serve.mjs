#!/usr/bin/env node
// Zero-dependency static server for the examples.
//
//   npm run build            (the examples load ../../dist/*)
//   npm run demo             (= node examples/serve.mjs)
//   node examples/serve.mjs [--port=8765] [--host=127.0.0.1]
//
// Serves ONLY /examples/** and /dist/** of this package, read-only, GET/HEAD, no directory listings, no dot files.
// It sends no COOP/COEP headers: the examples do not need cross-origin isolation.
// Import it with `import { startServer } from './serve.mjs'` (scripts/check-examples.mjs does). `files` maps a URL path
// onto an absolute file elsewhere (used by the check script to sabotage the dist path on purpose).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVED = ['examples', 'dist'];

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'], ['.md', 'text/plain; charset=utf-8'],
  ['.wgsl', 'text/plain; charset=utf-8'], ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.ico', 'image/x-icon'],
]);

/**
 * @param {{port?: number, host?: string, root?: string, files?: Record<string, string>}} [options]
 * @returns {Promise<{url: string, port: number, host: string, requests: {url: string, status: number}[], close: () => Promise<void>}>}
 */
export async function startServer({ port = 0, host = '127.0.0.1', root = PACKAGE_ROOT, files = {} } = {}) {
  const base = resolve(root);
  const requests = [];
  const server = createServer(async (req, res) => {
    let status = 200;
    const send = (code, type, body) => {
      status = code;
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'Method not allowed');
      let pathname;
      try { pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname); } catch { return send(400, 'text/plain', 'Bad request'); }
      if (pathname === '/favicon.ico') return send(204, 'image/x-icon', '');
      if (pathname === '/') { res.writeHead(302, { Location: '/examples/' }); status = 302; return res.end(); }
      if (files[pathname]) {
        const body = await readFile(files[pathname]).catch(() => null);
        return body ? send(200, MIME.get(extname(files[pathname])) ?? 'application/octet-stream', body) : send(404, 'text/plain', 'Not found: ' + pathname);
      }
      const file = resolve(base, '.' + pathname);
      const rel = file.slice(base.length + 1).split(sep);
      if (!file.startsWith(base + sep) || !SERVED.includes(rel[0])) return send(403, 'text/plain', 'Only /examples and /dist are served');
      if (rel.some((segment) => segment.startsWith('.'))) return send(403, 'text/plain', 'Dot files are not served');
      let target = file;
      const info = await stat(file).catch(() => null);
      if (!info) return send(404, 'text/plain', 'Not found: ' + pathname + (rel[0] === 'dist' ? '\n(run `npm run build` first)' : ''));
      if (info.isDirectory()) {
        if (!pathname.endsWith('/')) { res.writeHead(302, { Location: pathname + '/' }); status = 302; return res.end(); }
        target = resolve(file, 'index.html');
      }
      const body = await readFile(target).catch(() => null);
      if (!body) return send(404, 'text/plain', 'Not found: ' + pathname);
      return send(200, MIME.get(extname(target).toLowerCase()) ?? 'application/octet-stream', body);
    } catch (error) {
      return send(500, 'text/plain', 'Server error: ' + (error?.message ?? error));
    } finally {
      requests.push({ url: req.url ?? '', status });
      if (requests.length > 2000) requests.splice(0, 1000);
    }
  });
  await new Promise((ok, bad) => { server.once('error', bad); server.listen(port, host, ok); });
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://${host}:${address.port}`, port: address.port, host, requests,
    close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok(undefined)); }),
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const port = Number(arg('port') ?? process.env.PORT ?? 8765);
  const host = arg('host') ?? '127.0.0.1';
  let server;
  try { server = await startServer({ port, host }); } catch (error) {
    console.error(`could not listen on ${host}:${port}: ${error.message}\nTry another port: npm run demo -- --port=8766`);
    process.exit(1);
  }
  const dist = await stat(resolve(PACKAGE_ROOT, 'dist/hic-live-polyfill.iife.min.js')).catch(() => null);
  if (!dist) console.warn('warning: dist/ is missing. Run `npm run build` first, or every example will fail to load the polyfill.');
  console.log(`hic-live-polyfill examples: ${server.url}/examples/`);
  for (const name of ['basic', 'form', 'water-form', 'scroll-and-resize', 'webgl-texture']) console.log(`  ${server.url}/examples/${name}/`);
  console.log('Open them in desktop Chrome (the first release refuses other browsers). Ctrl+C stops the server.');
  const stop = async () => { await server.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
