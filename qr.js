/* ============================================================================
   QR — a small, standards-correct QR Code generator (byte mode, error
   correction level M, versions 1–10). No dependencies.
   Used for the verification code printed on OLS certificates.
   Reference: ISO/IEC 18004. Structure follows the classic reference design
   (Reed–Solomon over GF(256), BCH format/version info, 8 masks scored by the
   four standard penalty rules).
   ========================================================================== */
window.QR = (function () {
  'use strict';
  /* ---------------- GF(256) arithmetic ---------------- */
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

  /* ---- EC level M: [ecCodewordsPerBlock, [[blocks, dataCodewords], …]] ---- */
  const RS_M = [null,
    [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]], [24, [[2, 43]]],
    [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]], [22, [[3, 36], [2, 37]]], [26, [[4, 43], [1, 44]]]];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const CAP_M = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213];   // byte-mode capacity

  function genPoly(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= mul(g[j], EXP[i]); }
      g = ng;
    }
    return g;                                    // descending, g[0] === 1
  }
  function ecc(data, n) {
    const g = genPoly(n), res = new Uint8Array(data.length + n);
    res.set(data);
    for (let i = 0; i < data.length; i++) {
      const f = res[i];
      if (f) for (let j = 1; j < g.length; j++) res[i + j] ^= mul(g[j], f);
      res[i] = 0;
    }
    return res.slice(data.length);
  }

  /* ---------------- bit stream → interleaved codewords ---------------- */
  function utf8(str) {
    const out = [];
    for (const ch of unescape(encodeURIComponent(str))) out.push(ch.charCodeAt(0));
    return out;
  }
  function buildCodewords(bytes, ver) {
    const [ecLen, groups] = RS_M[ver];
    const totalData = groups.reduce((s, [n, d]) => s + n * d, 0);
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(0b0100, 4);                                   // byte mode
    push(bytes.length, ver < 10 ? 8 : 16);             // character count
    bytes.forEach(b => push(b, 8));
    for (let i = 0; i < 4 && bits.length < totalData * 8; i++) bits.push(0);   // terminator
    while (bits.length % 8) bits.push(0);
    const cw = [];
    for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; cw.push(v); }
    for (let i = 0; cw.length < totalData; i++) cw.push(i % 2 ? 0x11 : 0xEC);  // pad bytes

    const dBlocks = [], eBlocks = [];
    let p = 0;
    groups.forEach(([n, d]) => {
      for (let i = 0; i < n; i++) { const blk = cw.slice(p, p + d); p += d; dBlocks.push(blk); eBlocks.push(ecc(Uint8Array.from(blk), ecLen)); }
    });
    const out = [];
    const maxD = Math.max(...dBlocks.map(b => b.length));
    for (let i = 0; i < maxD; i++) dBlocks.forEach(b => { if (i < b.length) out.push(b[i]); });
    for (let i = 0; i < ecLen; i++) eBlocks.forEach(b => out.push(b[i]));
    return out;
  }

  /* ---------------- matrix ---------------- */
  function build(text) {
    const bytes = utf8(text);
    let ver = 0;
    for (let v = 1; v <= 10; v++) if (bytes.length <= CAP_M[v]) { ver = v; break; }
    if (!ver) return null;                              // too long for v10-M
    const size = 17 + 4 * ver;
    const m = [], fixed = [];
    for (let i = 0; i < size; i++) { m.push(new Array(size).fill(0)); fixed.push(new Array(size).fill(0)); }
    const set = (r, c, v) => { m[r][c] = v ? 1 : 0; fixed[r][c] = 1; };

    // finder patterns + separators
    const finder = (R, C) => {
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
        const rr = R + r, cc = C + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        set(rr, cc, on);
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
    // timing
    for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    // alignment
    const ap = ALIGN[ver];
    ap.forEach(r => ap.forEach(c => {
      if ((r < 9 && c < 9) || (r < 9 && c > size - 10) || (r > size - 10 && c < 9)) return;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++)
        set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }));
    // reserve format areas + dark module
    for (let i = 0; i < 9; i++) { if (!fixed[8][i]) set(8, i, 0); if (!fixed[i][8]) set(i, 8, 0); }
    for (let i = 0; i < 8; i++) { if (!fixed[8][size - 1 - i]) set(8, size - 1 - i, 0); if (!fixed[size - 1 - i][8]) set(size - 1 - i, 8, 0); }
    set(size - 8, 8, 1);                                // dark module
    // version info (v ≥ 7)
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      const vb = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = (vb >>> i) & 1, a = Math.floor(i / 3), b = i % 3;
        set(size - 11 + b, a, bit); set(a, size - 11 + b, bit);
      }
    }

    // data placement (zigzag, right→left, skipping the vertical timing column)
    const cw = buildCodewords(bytes, ver);
    let bi = 0;
    const bitAt = i => (cw[i >>> 3] >>> (7 - (i & 7))) & 1;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          const upward = ((right + 1) & 2) === 0;
          const r = upward ? size - 1 - vert : vert;
          if (fixed[r][c]) continue;
          m[r][c] = bi < cw.length * 8 ? bitAt(bi) : 0;
          bi++;
        }
      }
    }

    // pick the mask with the lowest penalty
    const maskFn = [
      (r, c) => (r + c) % 2 === 0, (r, c) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
      (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
      (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0, (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0];
    let best = null, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const g = m.map(row => row.slice());
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fixed[r][c] && maskFn[mask](r, c)) g[r][c] ^= 1;
      // format info
      let data = (0 << 3) | mask, rem = data;          // EC level M → 0
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const fb = ((data << 10) | rem) ^ 0x5412;
      for (let i = 0; i <= 5; i++) g[8][i] = (fb >>> i) & 1;
      g[8][7] = (fb >>> 6) & 1; g[8][8] = (fb >>> 7) & 1; g[7][8] = (fb >>> 8) & 1;
      for (let i = 9; i < 15; i++) g[14 - i][8] = (fb >>> i) & 1;
      // second copy: bits 0–7 along ROW 8 (right edge), bits 8–14 down COLUMN 8
      // (bottom edge) — transposing these two halves is a classic mistake.
      for (let i = 0; i < 8; i++) g[8][size - 1 - i] = (fb >>> i) & 1;
      for (let i = 8; i < 15; i++) g[size - 15 + i][8] = (fb >>> i) & 1;
      g[size - 8][8] = 1;                              // dark module (outside both copies)
      const s = penalty(g, size);
      if (s < bestScore) { bestScore = s; best = g; }
    }
    return {size, modules: best, version: ver};
  }
  function penalty(g, size) {
    let p = 0;
    const run = line => {
      let n = 1, s = 0;
      for (let i = 1; i < size; i++) {
        if (line[i] === line[i - 1]) { n++; } else { if (n >= 5) s += 3 + (n - 5); n = 1; }
      }
      if (n >= 5) s += 3 + (n - 5);
      return s;
    };
    for (let r = 0; r < size; r++) p += run(g[r]);
    for (let c = 0; c < size; c++) p += run(g.map(row => row[c]));
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++)
      if (g[r][c] === g[r][c + 1] && g[r][c] === g[r + 1][c] && g[r][c] === g[r + 1][c + 1]) p += 3;
    const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const hasPat = (arr, i) => pat.every((v, k) => arr[i + k] === v);
    for (let r = 0; r < size; r++) for (let c = 0; c + 11 <= size; c++) {
      if (hasPat(g[r], c)) p += 40;
      const col = []; for (let k = 0; k < 11; k++) col.push(g[c + k][r]);
      if (hasPat(col, 0)) p += 40;
    }
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += g[r][c];
    p += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
    return p;
  }

  /* ---------------- output ---------------- */
  function svg(text, opts) {
    opts = opts || {};
    const q = build(text);
    if (!q) return '';
    const quiet = opts.quiet == null ? 4 : opts.quiet;
    const total = q.size + quiet * 2;
    const dark = opts.dark || '#000', light = opts.light || '#fff';
    let d = '';
    for (let r = 0; r < q.size; r++) for (let c = 0; c < q.size; c++)
      if (q.modules[r][c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"${opts.cls ? ` class="${opts.cls}"` : ''}>` +
      `<rect width="${total}" height="${total}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
  }
  return {build, svg};
})();
