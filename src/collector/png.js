'use strict';
/**
 * 极简 PNG 编解码（零依赖，只用 node:zlib）。
 * 编码：8bit RGBA、无隔行、filter 恒为 0 —— 正好是图标缓存需要的样子。
 * 解码：只认自己编出来的这种 PNG（8bit RGBA / filter 0），用于自检与测试，不当通用解码器使。
 * decodeAnyPng / pixelKey：宽容版，专门做「像素比对」用 ——
 *   同一张图换个 filter / 压缩级别，字节不同但像素一样（app.getFileIcon 给的通用占位图
 *   就有 750B 和 745B 两种编码），光比字节 hash 会漏，所以要多一层像素指纹。
 */
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

/** { width, height, rgba } -> PNG Buffer（rgba 长度须为 width*height*4） */
function encodePng({ width, height, rgba }) {
  if (!(width > 0) || !(height > 0)) throw new Error('encodePng: 宽高必须为正整数');
  const stride = width * 4;
  if (!rgba || rgba.length < stride * height) throw new Error('encodePng: 像素数据长度不足');
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type: truecolor + alpha
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** 解自己编的 PNG -> { width, height, rgba }；不是这种格式就抛错 */
function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('decodePng: 不是 PNG');
  let off = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    const data = buf.subarray(off + 8, off + 8 + len);
    if (crc32(buf.subarray(off + 4, off + 8 + len)) !== buf.readUInt32BE(off + 8 + len)) throw new Error('decodePng: CRC 校验失败');
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; color = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || color !== 6 || interlace !== 0) throw new Error('decodePng: 只支持 8bit RGBA 非隔行');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    if (raw[o] !== 0) throw new Error('decodePng: 只支持 filter 0');
    raw.copy(rgba, y * stride, o + 1, o + 1 + stride);
  }
  return { width, height, rgba };
}

/**
 * 宽容解码（只给「像素比对」用，不当通用解码器）：8bit、非隔行的 灰度 / RGB / RGBA 都吃，filter 0~4 全支持。
 * 解出来一律铺成 RGBA，方便两张图直接逐字节比。
 */
function decodeAnyPng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('decodeAnyPng: 不是 PNG');
  let off = 8, ihdr = null;
  const idat = [];
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('decodeAnyPng: 缺 IHDR');
  if (ihdr.depth !== 8) throw new Error('decodeAnyPng: 只支持 8bit');
  if (ihdr.interlace !== 0) throw new Error('decodeAnyPng: 不支持隔行');
  const chans = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.color];
  if (!chans) throw new Error('decodeAnyPng: 不支持的颜色类型 ' + ihdr.color);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * chans;
  const px = Buffer.alloc(stride * ihdr.height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < ihdr.height; y++) {
    const o = y * (stride + 1);
    const ft = raw[o];
    if (ft > 4) throw new Error('decodeAnyPng: 未知 filter ' + ft);
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= chans ? cur[i - chans] : 0;
      const b = prev[i];
      const c = i >= chans ? prev[i - chans] : 0;
      let v = raw[o + 1 + i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 255;
    }
    cur.copy(px, y * stride);
    prev = cur;
  }
  if (chans === 4) return { width: ihdr.width, height: ihdr.height, rgba: px };
  const rgba = Buffer.alloc(ihdr.width * ihdr.height * 4);
  for (let i = 0, n = ihdr.width * ihdr.height; i < n; i++) {
    const s = i * chans, d = i * 4;
    if (chans === 3) { rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2]; rgba[d + 3] = 255; }
    else if (chans === 1) { rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s]; rgba[d + 3] = 255; }
    else { rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s]; rgba[d + 3] = px[s + 1]; }   // 灰度 + alpha
  }
  return { width: ihdr.width, height: ihdr.height, rgba };
}

/** 像素指纹：同一张图不论字节怎么变，key 都一样；解不开就返回 null（宁漏勿错） */
function pixelKey(buf) {
  try {
    const { width, height, rgba } = decodeAnyPng(buf);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(width, 0);
    head.writeUInt32BE(height, 4);
    return width + 'x' + height + ':' + crypto.createHash('sha256').update(Buffer.concat([head, rgba])).digest('hex').slice(0, 16);
  } catch { return null; }
}

module.exports = { encodePng, decodePng, decodeAnyPng, pixelKey, crc32 };
