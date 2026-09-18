/**
 * A QR encoder.
 *
 * Written here rather than fetched from a chart service because the one thing
 * this application puts in a QR code is a TOTP secret, and sending that to a
 * third party would hand them the key to every account set up this way. It
 * never leaves the browser.
 *
 * Byte mode, error-correction level L, versions 1–10 — which covers any
 * otpauth:// URI this product produces. Everything below follows ISO/IEC
 * 18004: the block structure, the alignment patterns, the BCH-coded format
 * and version information, and mask pattern 0.
 *
 * Verified by decoding the output: see tests/qr.test.js.
 */

/**
 * Per version, at error-correction level L:
 *   ec      — error-correction codewords per block
 *   groups  — [blockCount, dataCodewordsPerBlock] for each group
 */
const VERSIONS = [
  { ec: 7,  groups: [[1, 19]] },
  { ec: 10, groups: [[1, 34]] },
  { ec: 15, groups: [[1, 55]] },
  { ec: 20, groups: [[1, 80]] },
  { ec: 26, groups: [[1, 108]] },
  { ec: 18, groups: [[2, 68]] },
  { ec: 20, groups: [[2, 78]] },
  { ec: 24, groups: [[2, 97]] },
  { ec: 30, groups: [[2, 116]] },
  { ec: 18, groups: [[2, 68], [2, 69]] },
];

/** Alignment-pattern centre coordinates, per version. Version 1 has none. */
const ALIGNMENT = [
  [], [6, 18], [6, 22], [6, 26], [6, 30],
  [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

/**
 * Encode text as a QR matrix of booleans, true meaning dark.
 * Throws when the text is longer than version 10 at level L can carry.
 */
export function encodeQr(text) {
  const data = new TextEncoder().encode(text);

  const versionIndex = VERSIONS.findIndex((spec, i) => data.length <= capacityOf(spec, i + 1));
  if (versionIndex < 0) {
    throw new Error('That is too long to put in a QR code at this error-correction level.');
  }

  const version = versionIndex + 1;
  const spec = VERSIONS[versionIndex];
  const size = version * 4 + 17;
  const codewords = interleave(bitStream(data, version, spec), spec);

  const { matrix, reserved } = skeleton(version, size);
  placeData(matrix, reserved, codewords, size);
  applyMask(matrix, reserved, size);
  placeFormat(matrix, size);
  if (version >= 7) placeVersion(matrix, version, size);

  return matrix;
}

/** How many bytes this version can carry, allowing for the header. */
function capacityOf(spec, version) {
  const dataCodewords = spec.groups.reduce((sum, [blocks, per]) => sum + blocks * per, 0);
  const headerBits = 4 + (version < 10 ? 8 : 16);
  return Math.floor((dataCodewords * 8 - headerBits) / 8);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
function bitStream(data, version, spec) {
  const dataCodewords = spec.groups.reduce((sum, [blocks, per]) => sum + blocks * per, 0);
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };

  push(0b0100, 4);                                    // byte mode
  push(data.length, version < 10 ? 8 : 16);           // character count
  for (const byte of data) push(byte, 8);

  const capacityBits = dataCodewords * 8;
  push(0, Math.min(4, capacityBits - bits.length));   // terminator
  while (bits.length % 8) bits.push(0);

  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    out.push(bits.slice(i, i + 8).reduce((n, bit) => (n << 1) | bit, 0));
  }

  const PAD = [0xEC, 0x11];
  while (out.length < dataCodewords) out.push(PAD[(out.length - bits.length / 8) % 2]);
  return out;
}

/**
 * Split into blocks, compute each block's error correction, and interleave —
 * which is what makes a QR code survive a coffee ring over one corner.
 */
function interleave(codewords, spec) {
  const blocks = [];
  let offset = 0;

  for (const [count, per] of spec.groups) {
    for (let i = 0; i < count; i += 1) {
      const block = codewords.slice(offset, offset + per);
      offset += per;
      blocks.push({ data: block, ec: reedSolomon(block, spec.ec) });
    }
  }

  const out = [];
  const longest = Math.max(...blocks.map(b => b.data.length));
  for (let i = 0; i < longest; i += 1) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  }
  for (let i = 0; i < spec.ec; i += 1) {
    for (const block of blocks) out.push(block.ec[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reed–Solomon over GF(256), primitive polynomial 0x11D
// ---------------------------------------------------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11D : 0);
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

const multiply = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/**
 * The generator polynomial for `degree` error-correction codewords, returned
 * highest-degree coefficient first — which is the order the division below
 * consumes it in.
 */
function generator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= multiply(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly.reverse();
}

function reedSolomon(block, degree) {
  const gen = generator(degree);
  const remainder = new Array(degree).fill(0);

  for (const codeword of block) {
    const factor = codeword ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    if (factor === 0) continue;
    for (let i = 0; i < degree; i += 1) {
      remainder[i] ^= multiply(gen[i + 1], factor);
    }
  }
  return remainder;
}

// ---------------------------------------------------------------------------
// Function patterns
// ---------------------------------------------------------------------------
function skeleton(version, size) {
  const matrix = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const set = (y, x, value) => {
    if (y < 0 || x < 0 || y >= size || x >= size) return;
    matrix[y][x] = value;
    reserved[y][x] = true;
  };

  // Finder patterns, with their separators.
  for (const [row, col] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let y = -1; y <= 7; y += 1) {
      for (let x = -1; x <= 7; x += 1) {
        const onRing = (y === 0 || y === 6) ? x >= 0 && x <= 6
          : (x === 0 || x === 6) ? y >= 0 && y <= 6 : false;
        const inCore = y >= 2 && y <= 4 && x >= 2 && x <= 4;
        set(row + y, col + x, onRing || inCore);
      }
    }
  }

  // Timing patterns.
  for (let i = 8; i < size - 8; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Alignment patterns, skipping the three that would sit on a finder.
  const centres = ALIGNMENT[version - 1];
  for (const cy of centres) {
    for (const cx of centres) {
      const nearFinder = (cy <= 8 && cx <= 8)
        || (cy <= 8 && cx >= size - 9)
        || (cy >= size - 9 && cx <= 8);
      if (nearFinder) continue;
      for (let y = -2; y <= 2; y += 1) {
        for (let x = -2; x <= 2; x += 1) {
          set(cy + y, cx + x, Math.max(Math.abs(x), Math.abs(y)) !== 1);
        }
      }
    }
  }

  // The always-dark module, and the reserved format-information areas.
  set(size - 8, 8, true);
  for (let i = 0; i < 9; i += 1) {
    if (!reserved[8][i]) { matrix[8][i] = false; reserved[8][i] = true; }
    if (!reserved[i][8]) { matrix[i][8] = false; reserved[i][8] = true; }
  }
  for (let i = 0; i < 8; i += 1) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }

  // Version information, for version 7 and up.
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const row = Math.floor(i / 3);
      const col = i % 3;
      reserved[row][size - 11 + col] = true;
      reserved[size - 11 + col][row] = true;
    }
  }

  return { matrix, reserved };
}

/** Zig-zag upward from the bottom right, two columns at a time. */
function placeData(matrix, reserved, codewords, size) {
  let bit = 0;
  let upward = true;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;                          // the timing column
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let offset = 0; offset < 2; offset += 1) {
        const x = col - offset;
        if (reserved[row][x]) continue;
        const byte = codewords[bit >> 3] ?? 0;
        matrix[row][x] = ((byte >> (7 - (bit & 7))) & 1) === 1;
        bit += 1;
      }
    }
    upward = !upward;
  }
}

/** Mask 0: invert every data module where (row + column) is even. */
function applyMask(matrix, reserved, size) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (reserved[y][x]) continue;
      if ((y + x) % 2 === 0) matrix[y][x] = !matrix[y][x];
    }
  }
}

/** Format information: level L with mask 0, BCH(15,5) coded and XOR-masked. */
function placeFormat(matrix, size) {
  const bits = formatBits(0b01, 0);                   // 01 = level L, mask 0

  // The specification numbers these from the most significant bit, which is
  // placed first. Reading them the other way round produces a code that looks
  // perfectly well formed and cannot be scanned.
  for (let i = 0; i < 15; i += 1) {
    const bit = ((bits >> (14 - i)) & 1) === 1;

    // Around the top-left finder.
    if (i < 6) matrix[8][i] = bit;
    else if (i === 6) matrix[8][7] = bit;
    else if (i === 7) matrix[8][8] = bit;
    else if (i === 8) matrix[7][8] = bit;
    else matrix[14 - i][8] = bit;

    // The duplicate copy: seven bits up the left column of the bottom-left
    // finder, then eight along the row beside the top-right one. The eighth
    // module of that column is the always-dark one, not a format bit.
    if (i < 7) matrix[size - 1 - i][8] = bit;
    else matrix[8][size - 8 + (i - 7)] = bit;
  }
}

function formatBits(level, mask) {
  const data = (level << 3) | mask;
  let value = data << 10;
  for (let i = 4; i >= 0; i -= 1) {
    if ((value >> (10 + i)) & 1) value ^= 0b10100110111 << i;
  }
  return ((data << 10) | value) ^ 0b101010000010010;
}

/** Version information: BCH(18,6), in two blocks, for version 7 and up. */
function placeVersion(matrix, version, size) {
  let value = version << 12;
  for (let i = 5; i >= 0; i -= 1) {
    if ((value >> (12 + i)) & 1) value ^= 0b1111100100101 << i;
  }
  const bits = (version << 12) | value;

  for (let i = 0; i < 18; i += 1) {
    const bit = ((bits >> i) & 1) === 1;
    const row = Math.floor(i / 3);
    const col = i % 3;
    matrix[row][size - 11 + col] = bit;
    matrix[size - 11 + col][row] = bit;
  }
}

/**
 * The matrix as an SVG element, ready to put on a screen.
 * The quiet zone is part of the specification; without it many readers fail.
 */
export function qrSvg(text, { scale = 6, quiet = 4 } = {}) {
  const matrix = encodeQr(text);
  const size = matrix.length;
  const dimension = (size + quiet * 2) * scale;
  const ns = 'http://www.w3.org/2000/svg';

  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${dimension} ${dimension}`);
  svg.setAttribute('width', String(dimension));
  svg.setAttribute('height', String(dimension));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code');

  const background = document.createElementNS(ns, 'rect');
  background.setAttribute('width', String(dimension));
  background.setAttribute('height', String(dimension));
  background.setAttribute('fill', '#ffffff');
  svg.append(background);

  let path = '';
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!matrix[y][x]) continue;
      path += `M${(x + quiet) * scale},${(y + quiet) * scale}h${scale}v${scale}h-${scale}z`;
    }
  }

  const shape = document.createElementNS(ns, 'path');
  shape.setAttribute('d', path);
  shape.setAttribute('fill', '#000000');
  svg.append(shape);
  return svg;
}
