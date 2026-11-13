// The mobile gate's CDP socket on Android (test/mobile/android.mjs): a socket that does not open rejects with an Error that names it. A bare ErrorEvent has no message,
// and the local suite of 2026-11-13 printed the emulator "NOT RUN: " with no reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { openSocket } from '../../mobile/android.mjs';

/** A loopback port that nothing listens on. @returns {Promise<number>} */
const closedPort = () => new Promise((ok, bad) => { const s = createServer(); s.once('error', bad); s.listen(0, '127.0.0.1', () => { const p = /** @type {import('node:net').AddressInfo} */ (s.address()).port; s.close(() => ok(p)); }); });

test('a CDP socket that is refused rejects with an Error naming its endpoint', async () => {
  const url = `ws://127.0.0.1:${await closedPort()}/devtools/page/X`;
  const e = await openSocket(url).then(() => null, (err) => err);
  assert.ok(e instanceof Error, `rejected with ${e?.constructor?.name}, not an Error`);
  assert.ok(e.message.includes(url), e.message);
});

test('a CDP socket that opens resolves with the open socket', async () => {
  // the smallest WebSocket server: the opening handshake of RFC 6455, then nothing
  const srv = createHttpServer();
  /** @type {import('node:stream').Duplex[]} */ const socks = [];
  srv.on('upgrade', (req, sock) => {
    socks.push(sock);
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sock.on('error', () => { /* closed by the client */ });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(undefined)));
  try {
    const ws = await openSocket(`ws://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (srv.address()).port}/devtools/page/X`);
    assert.equal(ws.readyState, WebSocket.OPEN);
  } finally { for (const s of socks) s.destroy(); await new Promise((ok) => srv.close(() => ok(undefined))); }
});
