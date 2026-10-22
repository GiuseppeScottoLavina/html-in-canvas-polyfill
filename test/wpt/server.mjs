// HTTPS static server for the vendored WPT tree (test/vendor/wpt), the smallest part of wptserve the tests need:
//  * every URL is served from test/vendor/wpt at the same path (`/resources/testharness.js`, `/html/canvas/...`);
//  * `/resources/testharnessreport.js` is the upstream stub followed by our reporter (test/wpt/lib/report.js), and
//    `/resources/testdriver-vendor.js` is our CDP-backed driver (test/wpt/lib/testdriver-vendor.js);
//  * files with `.sub.` in the name get the `{{location[host]}}`, `{{ports[https][0]}}`, `{{hosts[alt][www]}}` substitutions;
//  * `<file>.headers` (`Name: value` lines) are applied as response headers, and so is the wptserve pipe `?pipe=header(Name,value)` (the only pipe the tests use);
//  * a self-signed certificate is generated with the system `openssl` into .scratch/wpt/cert (Chrome runs with
//    --ignore-certificate-errors and a host-resolver rule that maps the test host names to 127.0.0.1).
import { createServer } from 'node:https';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extname, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIME } from '../harness/server.mjs';
import { PROJECT_ROOT, SCRATCH_DIR } from '../harness/lib/util.mjs';

const here = dirname(fileURLToPath(import.meta.url));
/** The vendored tree; HIC_WPT_ROOT points the runner at another checkout of the same paths (to measure a candidate revision before re-pinning). */
export const VENDOR_ROOT = process.env.HIC_WPT_ROOT ? resolve(process.env.HIC_WPT_ROOT) : resolve(PROJECT_ROOT, 'test/vendor/wpt');
export const MAIN_HOST = 'web-platform.test';
export const ALT_DOMAIN = 'not-web-platform.test';
/** --host-resolver-rules for Chrome: every name of the two domains (and subdomains) resolves to the loopback server. */
export const HOST_RULES = `MAP ${MAIN_HOST} 127.0.0.1, MAP *.${MAIN_HOST} 127.0.0.1, MAP ${ALT_DOMAIN} 127.0.0.1, MAP *.${ALT_DOMAIN} 127.0.0.1`;

function certificate() {
  const dir = resolve(SCRATCH_DIR, 'wpt/cert');
  const key = resolve(dir, 'key.pem'), cert = resolve(dir, 'cert.pem');
  if (!existsSync(key) || !existsSync(cert)) {
    execFileSync('mkdir', ['-p', dir]);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '30',
      '-subj', `/CN=${MAIN_HOST}`, '-addext', `subjectAltName=DNS:${MAIN_HOST},DNS:*.${MAIN_HOST},DNS:${ALT_DOMAIN},DNS:*.${ALT_DOMAIN}`], { stdio: 'ignore' });
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

/** wptserve-style `{{...}}` substitution for the keys the HTML-in-Canvas tests use. */
export function substitute(text, port) {
  return text.replace(/\{\{([^}]+)\}\}/g, (all, expr) => {
    const e = expr.trim();
    if (e === 'location[host]') return `${MAIN_HOST}:${port}`;
    if (e === 'location[hostname]' || e === 'host') return MAIN_HOST;
    if (e === 'location[port]') return String(port);
    if (e === 'location[scheme]') return 'https';
    let m = e.match(/^ports\[(https?)\]\[(\d+)\]$/); if (m) return String(port);
    m = e.match(/^hosts\[alt\]\[(\w*)\]$/); if (m) return m[1] ? `${m[1]}.${ALT_DOMAIN}` : ALT_DOMAIN;
    m = e.match(/^hosts\[\]\[(\w*)\]$/); if (m) return m[1] ? `${m[1]}.${MAIN_HOST}` : MAIN_HOST;
    m = e.match(/^domains\[(\w*)\]$/); if (m) return m[1] ? `${m[1]}.${MAIN_HOST}` : MAIN_HOST;
    return all;
  });
}

async function parseHeaders(file) {
  const t = await readFile(file + '.headers', 'utf8').catch(() => '');
  return Object.fromEntries(t.split('\n').map(l => l.match(/^([^:\s]+):\s*(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));
}

/**
 * The `header(Name,value)` steps of a wptserve `pipe` query (`|`-separated; `header(Name,value,True)` appends, which a single value makes the same). Other pipes are
 * not implemented and throw, so a test that needs one fails loudly instead of loading a different response.
 * @param {string|null} pipe @returns {Record<string, string>}
 */
export function pipeHeaders(pipe) {
  const out = {};
  if (!pipe) return out;
  for (const step of pipe.split('|').map(x => x.trim()).filter(Boolean)) {
    const m = step.match(/^header\(([^,()]+),([^,()]*)(?:,(?:True|False))?\)$/);
    if (!m) throw new Error(`wptserve pipe not implemented: ${step}`);
    out[m[1].trim()] = m[2].trim();
  }
  return out;
}

/** Upstream harness stub + our reporter, upstream driver vendor stub + ours. */
async function virtualFile(pathname) {
  const read = f => readFile(resolve(VENDOR_ROOT, f), 'utf8');
  if (pathname === '/resources/testharnessreport.js') return (await read('resources/testharnessreport.js')) + '\n' + await readFile(resolve(here, 'lib/report.js'), 'utf8');
  if (pathname === '/resources/testdriver-vendor.js') return await readFile(resolve(here, 'lib/testdriver-vendor.js'), 'utf8');
  return null;
}

/**
 * The RELAXED variant (`?relax=1`, triage only): the tests' own "wait one frame" helpers (`rAF` then `setTimeout(resolve, 0)`) wait 300 ms instead. A subtest that fails strictly and passes relaxed fails only
 * because the polyfill's snapshot cannot be taken in the same frame as the DOM change (deviation `paint-timing`).
 * @param {string} html
 */
export function relaxFrameWaits(html) {
  return html.replace(/setTimeout\(resolve,\s*0\)/g, 'setTimeout(resolve, 300)').replace(/await new Promise\(setTimeout\)/g, 'await new Promise(r => setTimeout(r, 300))');
}

/** @returns {Promise<{port:number, origin:string, requests:string[], close:()=>Promise<void>}>} */
export async function startWptServer({ port = 0 } = {}) {
  const requests = [];
  const server = createServer(certificate(), async (req, res) => {
    const reply = (code, type, body, extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra }); res.end(body); };
    try {
      const url = new URL(req.url ?? '/', 'https://x');
      const pathname = decodeURIComponent(url.pathname);
      requests.push(pathname);
      if (requests.length > 5000) requests.splice(0, 2500);
      if (pathname === '/favicon.ico') return reply(204, 'image/x-icon', '');
      const virt = await virtualFile(pathname);
      if (virt !== null) return reply(200, MIME.get('.js'), virt);
      const probe = pathname.startsWith('/__probe/');   // developer pages in .scratch/wpt/probe (never part of a gate run)
      const root = probe ? resolve(SCRATCH_DIR, 'wpt/probe') : VENDOR_ROOT;
      const file = resolve(root, '.' + (probe ? pathname.slice(8) : pathname));
      if (!file.startsWith(root + sep)) return reply(403, 'text/plain', 'Forbidden');
      let info; try { info = await stat(file); } catch { return reply(404, 'text/plain', 'Not found: ' + pathname); }
      if (info.isDirectory()) return reply(404, 'text/plain', 'Directory: ' + pathname);
      const type = MIME.get(extname(file).toLowerCase()) ?? 'application/octet-stream';
      const headers = { ...await parseHeaders(file), ...pipeHeaders(url.searchParams.get('pipe')) };
      if (/\.sub\./.test(file)) return reply(200, type, substitute(await readFile(file, 'utf8'), server.address().port), headers);
      if (url.searchParams.has('relax') && type.startsWith('text/html')) return reply(200, type, relaxFrameWaits(await readFile(file, 'utf8')), headers);
      return reply(200, type, await readFile(file), headers);
    } catch (e) { return reply(500, 'text/plain', 'Server error: ' + (e?.message ?? e)); }
  });
  await new Promise((ok, bad) => { server.once('error', bad); server.listen(port, '127.0.0.1', ok); });
  const p = server.address().port;
  return { port: p, origin: `https://${MAIN_HOST}:${p}`, requests,
    close: () => new Promise(ok => { server.closeAllConnections?.(); server.close(() => ok()); }) };
}
