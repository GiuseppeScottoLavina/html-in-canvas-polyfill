// Pure RGBA image helpers: statistics (the non-blank test), comparison, compositing, cropping.
// An image is {width, height, data: Uint8Array|Uint8ClampedArray RGBA}.

/**
 * Colour statistics. `nonBlank` is true only when the image has more than 8 distinct colours, at least `minFraction` of its
 * pixels differ from the dominant colour, and it is not fully transparent. A cleared canvas, a flat fill and a fully
 * transparent bitmap are all "blank".
 */
export function pixelStats({ width, height, data }, { minFraction = 0.005 } = {}) {
  const n = width * height; const hist = new Map(); let alphaSum = 0;
  for (let i = 0; i < n; i++) {
    const k = (data[i * 4] << 24 | data[i * 4 + 1] << 16 | data[i * 4 + 2] << 8 | data[i * 4 + 3]) >>> 0;
    hist.set(k, (hist.get(k) ?? 0) + 1); alphaSum += data[i * 4 + 3];
  }
  let dom = 0, domK = 0; for (const [k, c] of hist) if (c > dom) { dom = c; domK = k; }
  const nonDominantFraction = n ? (n - dom) / n : 0;
  return { width, height, distinctColors: hist.size, dominantColor: [domK >>> 24, (domK >>> 16) & 255, (domK >>> 8) & 255, domK & 255],
    dominantShare: n ? dom / n : 0, nonDominantFraction, meanAlpha: n ? alphaSum / n / 255 : 0, nonBlank: n > 0 && hist.size > 8 && nonDominantFraction >= minFraction && alphaSum > 0 };
}

/** Alpha-composite over an opaque background colour (the reference is opaque; a canvas bitmap may be transparent). */
export function compositeOver({ width, height, data }, bg = [0, 0, 0]) {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(data[i * 4 + c] * a + bg[c] * (1 - a));
    out[i * 4 + 3] = 255;
  }
  return { width, height, data: out };
}

export function cropImage({ width, data }, x, y, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let r = 0; r < h; r++) out.set(data.subarray(((y + r) * width + x) * 4, ((y + r) * width + x + w) * 4), r * w * 4);
  return { width: w, height: h, data: out };
}

/**
 * Compare two equally sized RGBA images. delta(pixel) = max |channel difference| over RGB.
 * `countOver16`/`fraction` are the gate metric (pixels with delta > tolerance); `diffPixels`/`diffFraction` count ANY difference.
 * @returns {{sizeMatch:false,sizes:object}|CompareResult}
 * @typedef {object} CompareResult
 * @property {true} sizeMatch
 * @property {number} totalPixels
 * @property {number} diffPixels pixels with delta > 0
 * @property {number} maxDiff largest delta seen
 * @property {number} countOver16 pixels with delta > tolerance (named for the default tolerance 16)
 * @property {number} fraction countOver16 / totalPixels  (the number the 3 % gate applies to)
 * @property {number} diffFraction diffPixels / totalPixels
 * @property {{x:number,y:number,w:number,h:number}|null} overBBox bounding box of the over-tolerance pixels
 * @property {object} deltaHistogram
 * @property {{width:number,height:number,data:Uint8Array}|null} diffImage red heat map (black = identical)
 */
export function compareImages(a, b, { tolerance = 16, diffImage = true } = {}) {
  if (a.width !== b.width || a.height !== b.height) return { sizeMatch: false, sizes: { a: [a.width, a.height], b: [b.width, b.height] } };
  const n = a.width * a.height; let diffPixels = 0, maxDiff = 0, over = 0;
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  const hist = new Array(8).fill(0); // 1, 2-4, 5-8, 9-16, 17-32, 33-64, 65-128, 129-255
  const diff = diffImage ? new Uint8Array(n * 4) : null;
  for (let i = 0; i < n; i++) {
    let d = 0; for (let c = 0; c < 3; c++) { const v = Math.abs(a.data[i * 4 + c] - b.data[i * 4 + c]); if (v > d) d = v; }
    if (d > 0) {
      diffPixels++; if (d > maxDiff) maxDiff = d;
      hist[d === 1 ? 0 : d <= 4 ? 1 : d <= 8 ? 2 : d <= 16 ? 3 : d <= 32 ? 4 : d <= 64 ? 5 : d <= 128 ? 6 : 7]++;
      if (d > tolerance) { over++; const x = i % a.width, y = (i / a.width) | 0; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (diff) { const v = d === 0 ? 0 : Math.min(255, 80 + d * 2); diff[i * 4] = v; diff[i * 4 + 1] = d > tolerance ? 0 : v >> 2; diff[i * 4 + 2] = 0; diff[i * 4 + 3] = 255; }
  }
  return {
    sizeMatch: true, totalPixels: n, diffPixels, maxDiff, tolerance, countOver16: over, fraction: n ? over / n : 0, diffFraction: n ? diffPixels / n : 0,
    overBBox: over ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
    deltaHistogram: { '1': hist[0], '2-4': hist[1], '5-8': hist[2], '9-16': hist[3], '17-32': hist[4], '33-64': hist[5], '65-128': hist[6], '129-255': hist[7] },
    diffImage: diff ? { width: a.width, height: a.height, data: diff } : null,
  };
}
