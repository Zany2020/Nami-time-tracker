'use strict';
/**
 * 原生图标读取（Windows / koffi FFI，无原生编译）。
 *
 * 为什么需要它：Electron 的 app.getFileIcon 在拿不到图标时【不报错】，
 * 而是静默返回一张 32x32 的「通用程序」占位图 —— 连不存在的路径也一样。
 * MSIX(WindowsApps) 应用（ChatGPT）、部分系统 exe（Taskmgr）、
 * 以及一些自绘安装的第三方程序（SakuraCat）都会踩这个坑，界面上看起来就是"未知图标"。
 *
 * 这里改走 PrivateExtractIconsW：直接从 exe 的 PE 图标资源里取，
 * 和资源管理器画文件图标用的是同一份数据，48px。
 * 图标里带 PNG 压缩帧 / 多尺寸帧都能取到；确实没有图标资源的（如 SearchHost.exe）
 * 会返回 null，交给上层用首字母兜底。
 */
const koffi = require('koffi');

const DEFAULT_SIZE = 48;

let mods = null;
let loadErr = null;
let lastErr = null;      // 最近一次失败原因（诊断用，正常路径下恒为 null）

function init() {
  if (mods || loadErr) return mods;
  try {
    const gdi32 = koffi.load('gdi32.dll');
    const user32 = koffi.load('user32.dll');

    const ICONINFO = koffi.struct('NamiIconInfo', {
      fIcon: 'int32', xHotspot: 'uint32', yHotspot: 'uint32',
      hbmMask: 'void *', hbmColor: 'void *'
    });
    const BITMAP = koffi.struct('NamiBitmap', {
      bmType: 'int32', bmWidth: 'int32', bmHeight: 'int32', bmWidthBytes: 'int32',
      bmPlanes: 'uint16', bmBitsPixel: 'uint16', bmBits: 'void *'
    });
    const BMIH = koffi.struct('NamiBmiHeader', {
      biSize: 'uint32', biWidth: 'int32', biHeight: 'int32', biPlanes: 'uint16', biBitCount: 'uint16',
      biCompression: 'uint32', biSizeImage: 'uint32', biXPelsPerMeter: 'int32', biYPelsPerMeter: 'int32',
      biClrUsed: 'uint32', biClrImportant: 'uint32'
    });
    const BITMAPINFO = koffi.struct('NamiBitmapInfo', { bmiHeader: BMIH, bmiColors: koffi.array('uint32', 3) });
    const HANDLE = koffi.struct('NamiHandle', { p: 'void *' });

    mods = {
      ICONINFO, BITMAP, BITMAPINFO, HANDLE,
      PrivateExtractIconsW: user32.func('int PrivateExtractIconsW(str16 szFile, int nIndex, int cx, int cy, void *phicon, void *piconid, int nIcons, uint32 flags)'),
      GetIconInfo: user32.func('bool GetIconInfo(void *hIcon, _Inout_ NamiIconInfo *pii)'),
      DestroyIcon: user32.func('bool DestroyIcon(void *hIcon)'),
      CreateCompatibleDC: gdi32.func('void *CreateCompatibleDC(void *hdc)'),
      DeleteDC: gdi32.func('bool DeleteDC(void *hdc)'),
      DeleteObject: gdi32.func('bool DeleteObject(void *h)'),
      GetObjectW: gdi32.func('int GetObjectW(void *h, int cb, void *pv)'),
      GetDIBits: gdi32.func('int GetDIBits(void *hdc, void *hbm, uint32 start, uint32 lines, void *bits, _Inout_ NamiBitmapInfo *bmi, uint32 usage)')
    };
  } catch (e) {
    loadErr = e;
    mods = null;
  }
  return mods;
}

/** HICON -> { width, height, rgba }；失败返回 null。调用方负责 DestroyIcon。 */
function iconToRgba(m, hIcon) {
  const ii = koffi.alloc(m.ICONINFO, 1);
  if (!m.GetIconInfo(hIcon, ii)) return null;
  const info = koffi.decode(ii, m.ICONINFO);
  const bitmap = koffi.alloc(m.BITMAP, 1);
  let w = 0, h = 0;
  try {
    if (m.GetObjectW(info.hbmColor, koffi.sizeof(m.BITMAP), bitmap) > 0) {
      const bm = koffi.decode(bitmap, m.BITMAP);
      w = bm.bmWidth; h = bm.bmHeight;
    }
    if (!(w > 0) || !(h > 0)) {           // 单色图标没有彩色位图：掩码高度是两倍
      if (!m.GetObjectW(info.hbmMask, koffi.sizeof(m.BITMAP), bitmap)) return null;
      const bm = koffi.decode(bitmap, m.BITMAP);
      w = bm.bmWidth; h = bm.bmHeight > 0 ? bm.bmHeight / 2 : -bm.bmHeight / 2;
    }
    if (!(w > 0) || !(h > 0)) return null;

    const dc = m.CreateCompatibleDC(null);
    if (!koffi.address(dc)) return null;
    try {
      const bmi = koffi.alloc(m.BITMAPINFO, 1);
      const px = koffi.alloc('uint8', w * h * 4);
      const setBmi = (bits) => koffi.encode(bmi, m.BITMAPINFO, {
        bmiHeader: {
          biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: bits,
          biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0
        },
        bmiColors: [0, 0, 0]
      });

      setBmi(32);
      if (!m.GetDIBits(dc, info.hbmColor, 0, h, px, bmi, 0)) return null;
      const bgra = koffi.decode(px, 'uint8', w * h * 4);

      let hasAlpha = false;
      for (let i = 3; i < bgra.length; i += 4) if (bgra[i] !== 0) { hasAlpha = true; break; }

      const rgba = Buffer.alloc(w * h * 4);
      if (!hasAlpha) {
        // 老式 24bit/单色图标：透明度在 1bpp 掩码里（1 = 透明），每行 4 字节对齐
        const stride = ((w + 31) >> 5) << 2;
        const mbmi = koffi.alloc(m.BITMAPINFO, 1);
        koffi.encode(mbmi, m.BITMAPINFO, {
          bmiHeader: {
            biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 1,
            biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0
          },
          bmiColors: [0, 0, 0]
        });
        const mp = koffi.alloc('uint8', stride * h);
        const okMask = m.GetDIBits(dc, info.hbmMask, 0, h, mp, mbmi, 0);
        const mask = okMask ? koffi.decode(mp, 'uint8', stride * h) : null;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const s = (y * w + x) * 4, d = y * stride + (x >> 3);
            const transparent = mask ? ((mask[d] >> (7 - (x & 7))) & 1) === 1 : false;
            rgba[s] = bgra[s + 2]; rgba[s + 1] = bgra[s + 1]; rgba[s + 2] = bgra[s]; rgba[s + 3] = transparent ? 0 : 255;
          }
        }
      } else {
        for (let i = 0; i < bgra.length; i += 4) {
          rgba[i] = bgra[i + 2]; rgba[i + 1] = bgra[i + 1]; rgba[i + 2] = bgra[i]; rgba[i + 3] = bgra[i + 3];
        }
      }
      return { width: w, height: h, rgba };
    } finally {
      m.DeleteDC(dc);
    }
  } finally {
    if (koffi.address(info.hbmColor)) m.DeleteObject(info.hbmColor);
    if (koffi.address(info.hbmMask)) m.DeleteObject(info.hbmMask);
  }
}

/** exe 路径 -> { width, height, rgba }；取不到（无图标资源 / 平台不支持）返回 null */
function readIcon(exePath, size = DEFAULT_SIZE) {
  lastErr = null;
  const m = init();
  if (!m) { lastErr = loadErr || new Error('koffi/user32 不可用'); return null; }
  if (!exePath) { lastErr = new Error('路径为空'); return null; }
  let hIcon = null;
  try {
    const holder = koffi.alloc(m.HANDLE, 1);
    const ids = koffi.alloc('uint32', 1);
    const n = m.PrivateExtractIconsW(pathToString(exePath), 0, size, size, holder, ids, 1, 0);
    if (!(n > 0)) { lastErr = new Error('PrivateExtractIcons 返回 ' + n + '（该 exe 没有图标资源）'); return null; }
    hIcon = koffi.decode(holder, m.HANDLE).p;
    if (!koffi.address(hIcon)) { lastErr = new Error('拿到空 HICON'); return null; }
    const rgba = iconToRgba(m, hIcon);
    if (!rgba) lastErr = new Error('HICON -> 像素失败');
    return rgba;
  } catch (e) {
    lastErr = e;
    return null;
  } finally {
    if (hIcon) { try { m.DestroyIcon(hIcon); } catch { /* 忽略 */ } }
  }
}

function pathToString(p) { return String(p); }

/** 供自检：koffi / dll 是否可用 */
function available() { return !!init(); }

/** 诊断：最近一次 readIcon 失败的原因 */
function lastError() { return lastErr; }

module.exports = { readIcon, available, lastError, DEFAULT_SIZE };
