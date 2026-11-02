const fs = require('fs'), zlib = require('zlib');
const b = zlib.gunzipSync(fs.readFileSync('public/data/tidewater/geo.bin.gz'));
const hl = b.readUInt32LE(4);
const h = JSON.parse(b.toString('utf8', 8, 8 + hl));
const payload = b.subarray(8 + hl);
const CT = { i16: Int16Array, u16: Uint16Array, i8: Int8Array, u8: Uint8Array, f32: Float32Array, u32: Uint32Array };
const buf = (name) => { const s = h.buffers.find((x) => x.name === name); const Ctor = CT[s.type]; const start = payload.byteOffset + s.byteOffset; return new Ctor(payload.buffer.slice(start, start + s.byteLength)); };
const H = buf('height_i16');
const N = h.region, res = N.res;
const near = (x, z) => {
  const fx = Math.min(res - 1, Math.max(0, (x - N.x0) / N.texel)), fz = Math.min(res - 1, Math.max(0, (z - N.z0) / N.texel));
  const i = Math.min(res - 2, Math.floor(fx)), j = Math.min(res - 2, Math.floor(fz));
  const tx = fx - i, tz = fz - j, k = j * res + i;
  return ((H[k] * (1 - tx) + H[k + 1] * tx) * (1 - tz) + (H[k + res] * (1 - tx) + H[k + res + 1] * tx) * tz) * 0.01;
};
const IH = buf('island_h_i16');
const I = h.island;
const isl = (x, z) => {
  const fx = (x - I.x0) / I.texel, fz = (z - I.z0) / I.texel;
  const i = Math.max(0, Math.min(I.res - 2, Math.floor(fx))), j = Math.max(0, Math.min(I.res - 2, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - i)), tz = Math.max(0, Math.min(1, fz - j)), k = j * I.res + i;
  return ((IH[k] * (1 - tx) + IH[k + 1] * tx) * (1 - tz) + (IH[k + I.res] * (1 - tx) + IH[k + I.res + 1] * tx) * tz) * 0.01;
};
let maxd = 0, sum = 0, n = 0;
for (let z = -230; z <= 150; z += 2) for (let x = -180; x <= 200; x += 2) { const d = Math.abs(isl(x, z) - near(x, z)); if (d > maxd) maxd = d; sum += d; n++; }
console.log('island-vs-near: max', maxd.toFixed(3), 'mean', (sum / n).toFixed(3));
// boundary comparisons
for (const z of [-232, -230, -224]) { let line = []; for (let x = -180; x <= 200; x += 40) line.push(x + ':' + isl(x, z).toFixed(2) + '/' + near(x, z).toFixed(2)); console.log('z=' + z, line.join(' ')); }
for (const x of [-182, 202]) { let line = []; for (let z = -232; z <= 152; z += 48) line.push(z + ':' + isl(x, z).toFixed(2) + '/' + near(x, z).toFixed(2)); console.log('x=' + x, line.join(' ')); }
// island grid alignment relative window
console.log('near region', N, 'island', I);
console.log('x0 window col', (N.x0 - I.x0) / I.texel, 'x1 col', (N.x0 + N.size - I.x0) / I.texel);
console.log('z0 window row', (N.z0 - I.z0) / I.texel, 'z1 row', (N.z0 + N.size - I.z0) / I.texel);
// far tri count ratios
console.log('island cells', (I.res - 1) ** 2, 'tris', (I.res - 1) ** 2 * 2);
