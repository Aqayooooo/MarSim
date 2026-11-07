// Dekoder PNG dla warstw danych (strefy, piasek, cień…): czyta bajty pliku, bez canvasa.
// Odczyt pikseli z canvasa (getImageData) bywa celowo zaszumiony przez ochronę przed fingerprintingiem
// (np. tarcze Brave, Firefox resistFingerprinting) — dla danych to niedopuszczalne, bo klasa 2 musi zostać 2.
// Obsługa: 8 bitów, bez przeplotu; skala szarości, szarość+alfa, RGB, RGBA i paleta. Wynik: pierwszy kanał (szarość / R).

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));   // IDAT = strumień zlib
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** @returns {Promise<{width:number,height:number,data:Uint8Array}>} */
export async function decodePngGray(buffer) {
  const b = new Uint8Array(buffer), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (!SIG.every((v, i) => b[i] === v)) throw new Error('to nie jest plik PNG');
  let p = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0, palette = null;
  const idat = [];
  while (p < b.length) {
    const len = dv.getUint32(p), name = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]), d = p + 8;
    if (name === 'IHDR') { width = dv.getUint32(d); height = dv.getUint32(d + 4); depth = b[d + 8]; type = b[d + 9]; interlace = b[d + 12]; }
    else if (name === 'PLTE') palette = b.subarray(d, d + len);
    else if (name === 'IDAT') idat.push(b.subarray(d, d + len));
    else if (name === 'IEND') break;
    p = d + len + 4;                                          // + CRC
  }
  if (depth !== 8 || interlace) throw new Error(`nieobsługiwany PNG (głębia ${depth}, przeplot ${interlace})`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!ch) throw new Error(`nieobsługiwany typ koloru PNG: ${type}`);
  const total = idat.reduce((s, x) => s + x.length, 0), joined = new Uint8Array(total);
  let o = 0; for (const x of idat) { joined.set(x, o); o += x.length; }
  const raw = await inflate(joined);
  const stride = width * ch, cur = new Uint8Array(stride), prev = new Uint8Array(stride), out = new Uint8Array(width * height);
  for (let y = 0, q = 0; y < height; y++) {
    const f = raw[q++];
    for (let i = 0; i < stride; i++) {
      const x = raw[q++], a = i >= ch ? cur[i - ch] : 0, up = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + up;
      else if (f === 3) v = x + ((a + up) >> 1);
      else { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c); }
      cur[i] = v & 255;
    }
    for (let i = 0; i < width; i++) out[y * width + i] = type === 3 ? palette[cur[i * ch] * 3] : cur[i * ch];
    prev.set(cur);
  }
  return { width, height, data: out };
}
