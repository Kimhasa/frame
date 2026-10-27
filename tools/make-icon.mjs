// Renders the approved i-frame symbol (top bar colours) into native/src/FrameConsole.ico for the exe and window icon.
import { writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const segments = [
  [[8, 3], [3, 3]], [[3, 3], [3, 8]], [[16, 3], [21, 3]], [[21, 3], [21, 8]],
  [[21, 16], [21, 21]], [[21, 21], [16, 21]], [[8, 21], [3, 21]], [[3, 21], [3, 16]],
  [[8, 8], [16, 8]], [[16, 8], [16, 16]], [[16, 16], [8, 16]], [[8, 16], [8, 8]]
];
const background = [0x2d, 0x33, 0x3b], stroke = [0x22, 0xd5, 0x81];

function distance(px, py, [[ax, ay], [bx, by]]) {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4), samples = 4, pad = size * 0.14, scale = (size - pad * 2) / 24, radius = size * 0.18;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let ink = 0, cover = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const fx = x + (sx + 0.5) / samples, fy = y + (sy + 0.5) / samples;
      const cx = Math.min(Math.max(fx, radius), size - radius), cy = Math.min(Math.max(fy, radius), size - radius);
      if (Math.hypot(fx - cx, fy - cy) <= radius) cover++;
      const ux = (fx - pad) / scale, uy = (fy - pad) / scale;
      if (segments.some(segment => distance(ux, uy, segment) <= 1.05)) ink++;
    }
    const a = ink / samples ** 2, i = (y * size + x) * 4;
    for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(background[c] * (1 - a) + stroke[c] * a);
    pixels[i + 3] = Math.round(255 * cover / samples ** 2);
  }
  return pixels;
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = buffer => { let c = 0xffffffff; for (const b of buffer) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, tail]);
}
function png(size) {
  const rgba = render(size), raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = [16, 24, 32, 48, 64, 256], images = sizes.map(png);
const header = Buffer.alloc(6 + 16 * sizes.length); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, i) => {
  const e = 6 + i * 16; header[e] = size % 256; header[e + 1] = size % 256; header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(images[i].length, e + 8); header.writeUInt32LE(offset, e + 12); offset += images[i].length;
});
await writeFile(new URL('../native/src/FrameConsole.ico', import.meta.url), Buffer.concat([header, ...images]));
console.log('native/src/FrameConsole.ico written');
