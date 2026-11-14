// Generates scripts/icon-source.png (1024x1024) — the pult mark: a dark
// rounded square with an accent prompt glyph (chevron + caret), reading as
// "drive the agent from one prompt" (§6.1 composer is the signature element).
// Run: node scripts/gen-icon.mjs   (then: pnpm tauri icon scripts/icon-source.png)
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const px = new Uint8Array(SIZE * SIZE * 4);

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    crc32.table = table;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function setPx(x, y, [r, g, b], alpha) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = alpha;
}

function fillRoundedRect(x0, y0, w, h, rad, color) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const dx = x < x0 + rad ? x0 + rad - x : x > x0 + w - 1 - rad ? x - (x0 + w - 1 - rad) : 0;
      const dy = y < y0 + rad ? y0 + rad - y : y > y0 + h - 1 - rad ? y - (y0 + h - 1 - rad) : 0;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= rad + 0.5) {
        const a = Math.round(255 * Math.min(1, Math.max(0, rad + 0.5 - d)));
        setPx(x, y, color, a);
      }
    }
  }
}

function fillCircle(cx, cy, rad, color) {
  for (let y = Math.floor(cy - rad - 1); y <= Math.ceil(cy + rad + 1); y++) {
    for (let x = Math.floor(cx - rad - 1); x <= Math.ceil(cx + rad + 1); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= rad + 0.5) {
        const a = Math.round(255 * Math.min(1, Math.max(0, rad + 0.5 - d)));
        setPx(x, y, color, a);
      }
    }
  }
}

/** Anti-aliased round-cap stroke between two points. */
function strokeSegment([x0, y0], [x1, y1], width, color) {
  const r = width / 2;
  const min = [Math.floor(Math.min(x0, x1) - r - 1), Math.floor(Math.min(y0, y1) - r - 1)];
  const max = [Math.ceil(Math.max(x0, x1) + r + 1), Math.ceil(Math.max(y0, y1) + r + 1)];
  const vx = x1 - x0;
  const vy = y1 - y0;
  const len2 = vx * vx + vy * vy;
  for (let y = min[1]; y <= max[1]; y++) {
    for (let x = min[0]; x <= max[0]; x++) {
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - x0) * vx + (y - y0) * vy) / len2));
      const px0 = x0 + t * vx;
      const py0 = y0 + t * vy;
      const d = Math.hypot(x - px0, y - py0);
      if (d <= r + 0.5) {
        const a = Math.round(255 * Math.min(1, Math.max(0, r + 0.5 - d)));
        setPx(x, y, color, a);
      }
    }
  }
}

const DARK = [0x0a, 0x0a, 0x0a];
const ACCENT = [0x34, 0x6b, 0xf1];
const ACCENT_DIM = [0x2a, 0x53, 0xbb];

fillRoundedRect(0, 0, SIZE, SIZE, 224, DARK);

// Prompt chevron: > shape, round-capped accent stroke.
strokeSegment([300, 288], [520, 512], 108, ACCENT);
strokeSegment([520, 512], [300, 736], 108, ACCENT);

// Caret: a shorter vertical bar with a dim foot — mid-blink prompt cursor.
strokeSegment([660, 300], [660, 724], 108, ACCENT_DIM);
fillRoundedRect(600, 664, 120, 184, 54, ACCENT);

// Encode PNG (RGBA, 8-bit, filter 0 per scanline).
const stride = SIZE * 4 + 1;
const raw = Buffer.alloc(SIZE * stride);
for (let y = 0; y < SIZE; y++) {
  raw[y * stride] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * stride + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "icon-source.png"), png);
console.log("wrote scripts/icon-source.png:", png.length, "bytes");
