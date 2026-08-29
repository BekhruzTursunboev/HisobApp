// Generate the app icons from code, so they always match the UI.
//   node scripts/icons.js
//
// The mark is the app's own dial: a ring, mostly filled, with a gap — the
// thing you look at every day. Drawn at 4x and box-downsampled for clean
// anti-aliased edges, then written as PNG with zlib. No image library.

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(out, { recursive: true });

const BG = [9, 9, 11];          // --ink, the app's near-black
const FG = [244, 244, 246];     // the ring
const TRACK = [42, 42, 48];     // the unfilled part of the dial
const SS = 4;                   // supersample factor

/** One icon. `inset` shrinks the mark for maskable icons' safe zone. */
function render(size, inset) {
  const S = size * SS;
  const px = Buffer.alloc(S * S * 3);

  const cx = S / 2, cy = S / 2;
  const r = (S / 2) * (1 - inset) * 0.66;   // ring radius
  const w = r * 0.30;                        // ring thickness
  const inner = r - w / 2, outer = r + w / 2;
  const FILL = 0.72;                         // how much of the dial is "spent"

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      let c = BG;

      if (d >= inner && d <= outer) {
        // angle from 12 o'clock, clockwise, 0..1
        let a = Math.atan2(dx, -dy) / (Math.PI * 2);
        if (a < 0) a += 1;
        c = a <= FILL ? FG : TRACK;
      }

      const i = (y * S + x) * 3;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
    }
  }

  // box-downsample SSxSS blocks -> one pixel
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;                       // filter byte: none
    for (let x = 0; x < size; x++) {
      let r0 = 0, g0 = 0, b0 = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * S + (x * SS + sx)) * 3;
          r0 += px[i]; g0 += px[i + 1]; b0 += px[i + 2];
        }
      }
      const n = SS * SS;
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round(r0 / n);
      raw[o + 1] = Math.round(g0 / n);
      raw[o + 2] = Math.round(b0 / n);
    }
  }
  return raw;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const ICONS = [
  ["icon-180.png", 180, 0.10],   // apple-touch-icon
  ["icon-192.png", 192, 0.10],
  ["icon-512.png", 512, 0.10],
  ["maskable-512.png", 512, 0.28] // safe zone: Android crops to a circle
];

for (const [name, size, inset] of ICONS) {
  const file = join(out, name);
  writeFileSync(file, png(size, render(size, inset)));
  console.log(`  ${name.padEnd(18)} ${size}x${size}`);
}

console.log("\nIcons written to public/icons/");
