const fs = require('fs'), zlib = require('zlib');
const b = zlib.gunzipSync(fs.readFileSync('public/data/tidewater/geo.bin.gz'));
const hl = b.readUInt32LE(4);
const h = JSON.parse(b.toString('utf8', 8, 8 + hl));
const payload = b.subarray(8 + hl);
const CT = { i16: Int16Array, u16: Uint16Array, i8: Int8Array, u8: Uint8Array, f32: Float32Array, u32: Uint32Array };
const buf = (name) => { const s = h.buffers.find((x) => x.name === name); const Ctor = CT[s.type]; const start = payload.byteOffset + s.byteOffset; return new Ctor(payload.buffer.slice(start, start + s.byteLength)); };
const H = buf('height_i16');
const res = h.region.res, R = h.region;
const at = (x, z) => { const i = Math.round((x - R.x0) / R.texel), j = Math.round((z - R.z0) / R.texel); return H[j * res + i] * 0.01; };
console.log('--- profile x=0, z -232..152 step 8 ---');
for (let z = -232; z <= 152; z += 8) console.log('z', z, at(0, z).toFixed(1));
console.log('--- profile x=55, z -232..152 step 8 ---');
for (let z = -232; z <= 152; z += 8) console.log('z', z, at(55, z).toFixed(1));
console.log('--- profile z=-118, x -182..202 step 16 ---');
for (let x = -182; x <= 202; x += 16) console.log('x', x, at(x, -118).toFixed(1));
// slopes: fraction of steep
const masks = {};
for (const m of h.masks) masks[m.name] = buf('mask_' + m.name);
const maskAt = (name, x, z) => masks[name][Math.round((z - R.z0) / R.texel) * res + Math.round((x - R.x0) / R.texel)];
for (const p of [['beach', 54, -16], ['beach2', 54, -5], ['shore', 54, -30], ['village', 40, -118], ['ridge', 0, -196], ['north', 0, -225], ['west', -150, 0], ['east', 190, 0], ['south', 0, 140], ['pierhead', 55, 40]]) {
  const [n, x, z] = p;
  const row = h.masks.map((m) => m.name + '=' + maskAt(m.name, x, z)).join(' ');
  console.log('masks', n, x, z, 'h=' + at(x, z).toFixed(2), row);
}
// height histogram above water
let hist = new Array(12).fill(0);
for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) { const y = H[j * res + i] * 0.01; const b2 = Math.max(0, Math.min(11, Math.floor((y + 2) / 4))); hist[b2]++; }
console.log('hist bins from -2 step4', hist);
// slope distribution
const grad = (x, z) => { const e = 1; const hx = at(x + e, z) - at(x - e, z); const hz = at(x, z + e) - at(x, z - e); return Math.hypot(hx, hz) / (2 * e); };
let steep = 0, steep06 = 0, total = 0;
for (let z = -230; z <= 150; z += 4) for (let x = -180; x <= 200; x += 4) { const g = grad(x, z); total++; if (g > 0.6) steep06++; if (g > 1.0) steep++; }
console.log('slope frac >0.6', (steep06 / total).toFixed(3), '>1.0', (steep / total).toFixed(3));
// where is sand=255 (beach) bbox
let sx0 = 1e9, sx1 = -1e9, sz0 = 1e9, sz1 = -1e9, cnt = 0;
const S = masks.sand;
for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) { if (S[j * res + i] > 220) { cnt++; const x = R.x0 + i, z = R.z0 + j; if (x < sx0) sx0 = x; if (x > sx1) sx1 = x; if (z < sz0) sz0 = z; if (z > sz1) sz1 = z; } }
console.log('sand>220 bbox', sx0, sx1, sz0, sz1, 'count', cnt);
const Rk = masks.rock; let rx = 1e9, ry = -1e9, rz = 1e9, rw = -1e9, rc = 0;
for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) { if (Rk[j * res + i] > 180) { rc++; const x = R.x0 + i, z = R.z0 + j; if (x < rx) rx = x; if (x > ry) ry = x; if (z < rz) rz = z; if (z > rw) rw = z; } }
console.log('rock>180 bbox', rx, ry, rz, rw, 'count', rc);
