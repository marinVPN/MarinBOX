'use strict';
// Генерирует все иконки MarinBox из исходника build\logo-source.png.
// Без внешних зависимостей: свой декодер/энкодер PNG + сборщик ICO.
//
//   build\logo-source.png  — исходный artwork (правится руками, не генерируется)
//   build\icon.png         — 256x256, окно приложения / запасной значок
//   build\icon.ico         — 16..256 (мульти-размерный), Проводник, ярлыки, таскбар
//   build\tray.png/@2x.png  — 32/64, трей
//   renderer\logo.png      — 256x256, шапка приложения
//
// Запуск: npm run icon

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const MASTER = path.join(ROOT, 'build', 'logo-source.png');

// ---------------------------------------------------------------- PNG decode

function decodePNG(buf) {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error('Это не PNG');

  let pos = 8, ihdr = null, palette = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr) throw new Error('В PNG нет IHDR');
  if (ihdr.interlace) throw new Error('Interlaced PNG не поддерживается');
  if (ihdr.depth !== 8) throw new Error('Поддерживается только 8 бит на канал');

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.color];
  if (!channels) throw new Error('Неизвестный тип цвета: ' + ihdr.color);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = ihdr.width * bpp;
  const px = Buffer.alloc(ihdr.height * stride);
  let rp = 0;
  for (let y = 0; y < ihdr.height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error('Неизвестный PNG-фильтр: ' + filter);
      cur[x] = v & 0xff;
    }
  }

  const rgba = Buffer.alloc(ihdr.width * ihdr.height * 4);
  for (let i = 0, p = 0; i < ihdr.width * ihdr.height; i++) {
    let r, g, b, a = 255;
    if (ihdr.color === 0) { r = g = b = px[p]; p += 1; }
    else if (ihdr.color === 2) { r = px[p]; g = px[p + 1]; b = px[p + 2]; p += 3; }
    else if (ihdr.color === 3) { const idx = px[p++]; r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2]; if (trns && idx < trns.length) a = trns[idx]; }
    else if (ihdr.color === 4) { r = g = b = px[p]; a = px[p + 1]; p += 2; }
    else { r = px[p]; g = px[p + 1]; b = px[p + 2]; a = px[p + 3]; p += 4; }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { width: ihdr.width, height: ihdr.height, data: rgba };
}

// --------------------------------------------------------------- PNG encode

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(img) {
  const { width, height, data } = img;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------- геометрия

// Обрезка по непрозрачной части (alpha > threshold)
function trim(img, threshold = 8) {
  const { width, height, data } = img;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('Изображение полностью прозрачное');
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    data.copy(out, y * w * 4, ((y + minY) * width + minX) * 4, ((y + minY) * width + maxX + 1) * 4);
  }
  return { width: w, height: h, data: out };
}

// Масштабирование: усреднение по площади с премньютипликацией альфы
function resize(img, dstW, dstH) {
  const { width, height, data } = img;
  const out = Buffer.alloc(dstW * dstH * 4);
  const sx = width / dstW, sy = height / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const y0 = Math.floor(dy * sy), y1 = Math.max(y0 + 1, Math.min(height, Math.ceil((dy + 1) * sy)));
    for (let dx = 0; dx < dstW; dx++) {
      const x0 = Math.floor(dx * sx), x1 = Math.max(x0 + 1, Math.min(width, Math.ceil((dx + 1) * sx)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          const al = data[i + 3] / 255;
          r += data[i] * al; g += data[i + 1] * al; b += data[i + 2] * al; a += al; n++;
        }
      }
      const o = (dy * dstW + dx) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return { width: dstW, height: dstH, data: out };
}

// Вписать картинку в квадрат: cover (обрезаем лишнее) или contain (с полями)
function fitSquare(img, size, mode = 'cover', pad = 0.03) {
  const inner = size * (1 - pad * 2);
  const scale = mode === 'cover'
    ? Math.max(inner / img.width, inner / img.height)
    : Math.min(inner / img.width, inner / img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const scaled = resize(img, w, h);
  const out = Buffer.alloc(size * size * 4);
  const ox = Math.round((size - w) / 2), oy = Math.round((size - h) / 2);
  for (let y = 0; y < h; y++) {
    const dst = ((oy + y) * size + ox) * 4;
    scaled.data.copy(out, dst, y * w * 4, (y + 1) * w * 4);
  }
  return { width: size, height: size, data: out };
}

// -------------------------------------------------------------- сборка ICO

function buildICO(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  const dir = Buffer.alloc(16 * frames.length);
  let offset = 6 + dir.length;
  const parts = [header, dir];
  frames.forEach((f, i) => {
    const png = encodePNG(f.img);
    const o = i * 16;
    dir[o] = f.size >= 256 ? 0 : f.size;
    dir[o + 1] = f.size >= 256 ? 0 : f.size;
    dir[o + 2] = 0; dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
    parts.push(png);
  });
  return Buffer.concat(parts);
}

// --------------------------------------------------- плоский знак для мелких

// Скруглённый квадрат с буквой M — читается даже в 16 px.
function flatMark(size, c1 = [109, 1, 212], c2 = [153, 40, 255]) {
  const S = 3;
  const radius = size * 0.24;
  const lo = size * 0.02, hi = size * 0.98;
  const stroke = size * 0.115;
  const M = [
    [size * 0.27, size * 0.72], [size * 0.27, size * 0.31],
    [size * 0.5, size * 0.55], [size * 0.73, size * 0.31],
    [size * 0.73, size * 0.72],
  ];
  const distSeg = (px, py, [ax, ay], [bx, by]) => {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const inM = (x, y) => M.slice(1).some((p, i) => distSeg(x, y, M[i], p) <= stroke);
  const inRR = (x, y) => {
    if (x < lo || x > hi || y < lo || y > hi) return false;
    const cx = Math.min(Math.max(x, lo + radius), hi - radius);
    const cy = Math.min(Math.max(y, lo + radius), hi - radius);
    return Math.hypot(x - cx, y - cy) <= radius;
  };
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0, r = 0, g = 0, b = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const px = x + (sx + 0.5) / S, py = y + (sy + 0.5) / S;
        if (!inRR(px, py)) continue;
        a++;
        const t = (px + py) / (2 * size);
        let c = [0, 1, 2].map((k) => c1[k] + (c2[k] - c1[k]) * t);
        if (inM(px, py)) c = [255, 255, 255];
        r += c[0]; g += c[1]; b += c[2];
      }
      const o = (y * size + x) * 4;
      if (a) { r /= a; g /= a; b /= a; }
      data[o] = Math.round(r); data[o + 1] = Math.round(g); data[o + 2] = Math.round(b);
      data[o + 3] = Math.round((a / (S * S)) * 255);
    }
  }
  return { width: size, height: size, data };
}

// ------------------------------------------------------------------ main

function main() {
  if (!fs.existsSync(MASTER)) {
    console.error('Нет исходника: ' + MASTER);
    console.error('Положите туда PNG 512x512 или больше — скрипт сам нарежет все размеры.');
    process.exit(1);
  }
  const master = trim(decodePNG(fs.readFileSync(MASTER)));
  console.log(`Исходник: ${master.width}x${master.height} (обрезано по альфе)`);

  // Мелкие размеры — плоский знак (3D-детали не читаются в таскбаре),
  // крупные — объёмный artwork.
  const SMALL = [16, 20, 24, 32, 40, 48];
  const LARGE = [64, 96, 128, 256];

  const frames = [];
  for (const size of SMALL) frames.push({ size, img: flatMark(size) });
  for (const size of LARGE) frames.push({ size, img: fitSquare(master, size, 'cover', 0.04) });

  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), buildICO(frames));

  // Значок окна и таскбара, логотип в шапке, трей — плоский знак (читается в 16–32 px).
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), encodePNG(flatMark(256)));
  fs.writeFileSync(path.join(ROOT, 'renderer', 'logo.png'), encodePNG(flatMark(256)));
  fs.writeFileSync(path.join(ROOT, 'build', 'tray.png'), encodePNG(flatMark(32)));
  fs.writeFileSync(path.join(ROOT, 'build', 'tray@2x.png'), encodePNG(flatMark(64)));

  console.log('Готово:');
  console.log('  build\\icon.ico        ' + SMALL.concat(LARGE).join(', '));
  console.log('  build\\icon.png         256x256 (окно, таскбар)');
  console.log('  build\\tray.png/@2x.png 32/64 (трей)');
  console.log('  renderer\\logo.png     256x256 (шапка)');
}

if (require.main === module) main();

module.exports = { decodePNG, encodePNG, trim, resize, fitSquare, buildICO, flatMark };
