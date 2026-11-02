const fs = require('fs'), zlib = require('zlib');
const b = zlib.gunzipSync(fs.readFileSync('public/data/tidewater/geo.bin.gz'));
const hl = b.readUInt32LE(4);
const h = JSON.parse(b.toString('utf8', 8, 8 + hl));
const payload = b.subarray(8 + hl);
const CT = { i16: Int16Array, u16: Uint16Array, i8: Int8Array, u8: Uint8Array, f32: Float32Array, u32: Uint32Array };
const buf = (name) => { const s = h.buffers.find((x) => x.name === name); const Ctor = CT[s.type]; const start = payload.byteOffset + s.byteOffset; return new Ctor(payload.buffer.slice(start, start + s.byteLength)); };
const res = h.region.res, R = h.region;
const H = buf('height_i16');
const idx = (x, z) => Math.round((z - R.z0)) * res + Math.round((x - R.x0));
const masks = {}; for (const m of h.masks) masks[m.name] = buf('mask_' + m.name);
for (const name of Object.keys(masks)) {
  const a = masks[name];
  let sum = 0, nz = 0, hi = 0, mx = 0;
  for (let i = 0; i < a.length; i++) { sum += a[i]; if (a[i] > 0) nz++; if (a[i] > 128) hi++; if (a[i] > mx) mx = a[i]; }
  console.log(name.padEnd(9), 'mean', (sum / a.length).toFixed(1), 'nz%', (100 * nz / a.length).toFixed(1), '>128%', (100 * hi / a.length).toFixed(1), 'max', mx);
}
const pick = (name, pts) => pts.map(([x, z]) => `${name}@${x},${z}=${masks[name][idx(x, z)]}`);
console.log(pick('rock', [[40, -118], [0, -150], [0, -190], [100, -150], [-120, -150], [150, 0], [0, 20], [-60, 28]]).join(' '));
console.log(pick('sand', [[40, -118], [0, -150], [0, -190], [100, -150], [-120, -150], [150, 0], [0, 20], [-60, 28], [54, -16], [0, 100], [-150, 100]]).join(' '));
// sand vs height scatter
const buckets = new Map();
for (let j = 0; j < res; j += 2) for (let i = 0; i < res; i += 2) {
  const y = H[j * res + i] * 0.01; const s = masks.sand[j * res + i];
  const k = Math.floor((y + 20) / 5) * 5 - 20;
  if (!buckets.has(k)) buckets.set(k, [0, 0, 0]);
  const o = buckets.get(k); o[0]++; o[1] += s; o[2] += s > 200 ? 1 : 0;
}
for (const k of [...buckets.keys()].sort((a, b2) => a - b2)) { const o = buckets.get(k); console.log('h~' + k, 'meanSand', (o[1] / o[0]).toFixed(0), 'frac>200', (o[2] / o[0]).toFixed(2)); }
