const fs = require('fs'), zlib = require('zlib');
const b = zlib.gunzipSync(fs.readFileSync('public/data/tidewater/geo.bin.gz'));
const hl = b.readUInt32LE(4);
const h = JSON.parse(b.toString('utf8', 8, 8 + hl));
const payload = b.subarray(8 + hl);
const CT = { i16: Int16Array, u16: Uint16Array, i8: Int8Array, u8: Uint8Array, f32: Float32Array, u32: Uint32Array };
const buf = (name) => { const s = h.buffers.find((x) => x.name === name); const Ctor = CT[s.type]; const start = payload.byteOffset + s.byteOffset; return new Ctor(payload.buffer.slice(start, start + s.byteLength)); };
const v = h.vegetation;
console.log('veg header', JSON.stringify(v));
const data = buf(v.buffer);
const stride = v.stride;
const byType = new Map();
for (let i = 0; i < v.count; i++) {
  const o = i * stride;
  const t = data[o];
  const rec = { x: data[o + 1], y: data[o + 2], z: data[o + 3], s: data[o + 4], sy: data[o + 5], yaw: data[o + 6], seed: data[o + 7], H: data[o + 8], f: data[o + 9] };
  if (!byType.has(t)) byType.set(t, []);
  byType.get(t).push(rec);
}
for (const [t, list] of byType) {
  const name = v.types[t];
  const stat = (k) => { const a = list.map((r) => r[k]); return [Math.min(...a).toFixed(2), (a.reduce((s, x) => s + x, 0) / a.length).toFixed(2), Math.max(...a).toFixed(2)]; };
  console.log(name, 'n=' + list.length, 's[min/mean/max]', stat('s').join('/'), 'sy', stat('sy').join('/'), 'H', stat('H').join('/'), 'y', stat('y').join('/'));
  if (['palms', 'trees', 'bananas', 'shrubs', 'youngPalms', 'ferns', 'monsteras', 'heliconias', 'strelitzias', 'elephantEars'].includes(name)) {
    console.log('  sample', JSON.stringify(list[0]), JSON.stringify(list[Math.floor(list.length / 2)]));
  }
}
// spatial spread
const all = [...byType.values()].flat();
console.log('x range', Math.min(...all.map((r) => r.x)), Math.max(...all.map((r) => r.x)));
console.log('z range', Math.min(...all.map((r) => r.z)), Math.max(...all.map((r) => r.z)));
