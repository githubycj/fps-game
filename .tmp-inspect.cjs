const fs = require('fs'), zlib = require('zlib');
const b = zlib.gunzipSync(fs.readFileSync('public/data/tidewater/geo.bin.gz'));
const hl = b.readUInt32LE(4);
const h = JSON.parse(b.toString('utf8', 8, 8 + hl));
const payload = b.subarray(8 + hl);
const CT = { i16: Int16Array, u16: Uint16Array, i8: Int8Array, u8: Uint8Array, f32: Float32Array, u32: Uint32Array };
const buf = (name) => {
  const s = h.buffers.find((x) => x.name === name);
  const Ctor = CT[s.type];
  const start = payload.byteOffset + s.byteOffset;
  return new Ctor(payload.buffer.slice(start, start + s.byteLength));
};
const H = buf('height_i16');
const res = h.region.res, R = h.region;
const at = (x, z) => {
  const i = Math.round((x - R.x0) / R.texel), j = Math.round((z - R.z0) / R.texel);
  return H[j * res + i] * 0.01;
};
const pts = [['village', 40, -118], ['pier', 55, 30], ['pier head', 55, 40], ['beach', -60, 28], ['beach sea', -40, 40], ['ridge-view', 0, -196], ['house', 84, -60], ['north edge', 0, -232], ['west edge', -182, 0], ['east edge', 202, 0], ['south edge', 0, 152], ['spawn?', 0, 0]];
for (const [n, x, z] of pts) console.log(n, x, z, 'h=', at(x, z).toFixed(2));
let mn = 1e9, mx = -1e9;
for (const v of H) { const y = v * 0.01; if (y < mn) mn = y; if (y > mx) mx = y; }
console.log('height range', mn, mx);
const I = buf('island_h_i16');
let imn = 1e9, imx = -1e9;
for (const v of I) { const y = v * 0.01; if (y < imn) imn = y; if (y > imx) imx = y; }
console.log('island range', imn, imx);
const isl = (x, z) => {
  const s = h.island;
  const i = Math.round((x - s.x0) / s.texel), j = Math.round((z - s.z0) / s.texel);
  return I[j * s.res + i] * 0.01;
};
console.log('island north', isl(0, -500).toFixed(1), isl(0, -400).toFixed(1), isl(-200, -400).toFixed(1), isl(200, -450).toFixed(1), isl(0, 100).toFixed(1));
const V = buf('veg_rec');
const types = h.vegetation.types;
const counts = {};
for (let k = 0; k < h.vegetation.count; k++) { const t = types[V[k * 10]] || V[k * 10]; counts[t] = (counts[t] || 0) + 1; }
console.log('veg counts', counts);
for (let k = 0; k < 6; k++) { const o = k * 10; console.log('veg', types[V[o]], [...V.slice(o, o + 10)].map((v) => +v.toFixed(2)).join(',')); }
let vy = 1e9, vY = -1e9; for (let k = 0; k < h.vegetation.count; k++) { const y = V[k * 10 + 2]; if (y < vy) vy = y; if (y > vY) vY = y; }
console.log('veg y range', vy, vY);
for (const name of h.masks.map((m) => m.name)) {
  const M = buf('mask_' + name);
  const g = (x, z) => { const i = Math.round((x - R.x0) / R.texel), j = Math.round((z - R.z0) / R.texel); return M[j * res + i]; };
  console.log('mask', name, 'village', g(40, -118), 'beach', g(-60, 28), 'ridge', g(0, -196), 'pier', g(55, 30), 'north', g(0, -225));
}
// count mask coverage
for (const name of h.masks.map((m) => m.name)) {
  const M = buf('mask_' + name);
  let n = 0, mx2 = 0; for (const v of M) { if (v > 0) n++; if (v > mx2) mx2 = v; }
  console.log('mask coverage', name, n, 'max', mx2);
}
// island alignment: does island grid include window edges exactly?
console.log('island window', h.island.x0, h.island.z0, 'cols for x=-182..202', (-182 - h.island.x0) / 8, (202 - h.island.x0) / 8, 'rows', (-232 - h.island.z0) / 8, (152 - h.island.z0) / 8);
