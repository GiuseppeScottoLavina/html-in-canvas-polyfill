// Minimal zero-dependency PNG decode/encode (8-bit; decode also 16-bit, rounded to 8; non-interlaced, color types 0/2/3/4/6).
// decodePng(buf) -> {width,height,data:Uint8Array RGBA}
// encodePng({width,height,data}) -> Buffer
import { inflateSync, deflateSync } from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(buf) {
  buf = Buffer.from(buf);
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('latin1', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len); off += 12 + len;
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); bitDepth = body[8]; colorType = body[9]; interlace = body[12]; }
    else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
  }
  // 16-bit samples (screenshots of a wide-colour iPad display, Safari on iPadOS 27) are rounded to 8 bits; a palette image is 8-bit only
  if (bitDepth !== 8 && !(bitDepth === 16 && colorType !== 3)) throw new Error('unsupported bit depth ' + bitDepth);
  const bps = bitDepth / 8;
  if (interlace) throw new Error('interlaced PNG unsupported');
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!ch) throw new Error('unsupported color type ' + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch * bps, unit = ch * bps;
  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= unit ? cur[i - unit] : 0, b = prev[i], c = i >= unit ? prev[i - unit] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[i] = v & 255;
    }
    prev = cur;
  }
  // the samples as 8-bit values: a 16-bit sample is big-endian, rounded (v * 255 / 65535)
  const s8 = bps === 1 ? out : Uint8Array.from({ length: out.length / 2 }, (_, i) => Math.round(((out[i * 2] << 8) | out[i * 2 + 1]) / 257));
  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    let r, g, b, a = 255;
    if (colorType === 6) { r = s8[p * 4]; g = s8[p * 4 + 1]; b = s8[p * 4 + 2]; a = s8[p * 4 + 3]; }
    else if (colorType === 2) { r = s8[p * 3]; g = s8[p * 3 + 1]; b = s8[p * 3 + 2]; }
    else if (colorType === 0) { r = g = b = s8[p]; }
    else if (colorType === 4) { r = g = b = s8[p * 2]; a = s8[p * 2 + 1]; }
    else { const i = s8[p]; r = palette[i * 3]; g = palette[i * 3 + 1]; b = palette[i * 3 + 2]; if (trns && i < trns.length) a = trns[i]; }
    data[p * 4] = r; data[p * 4 + 1] = g; data[p * 4 + 2] = b; data[p * 4 + 3] = a;
  }
  return { width, height, data };
}

let crcTable;
function crc32(buf) {
  if (!crcTable) { crcTable = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; } }
  let c = -1; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0;
}
function chunk(type, body) {
  const t = Buffer.from(type, 'latin1'); const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, body])));
  return Buffer.concat([len, t, body, crc]);
}
export function encodePng({ width, height, data }) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1); }
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
