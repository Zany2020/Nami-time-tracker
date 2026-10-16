'use strict';
// Windows 11 原生窗角处理（koffi FFI，无原生编译）。
//
// 为什么必须做：
//   DWM 亚克力（Acrylic）会铺满整个「方形」窗口矩形。
//   如果 CSS 里 .app 的圆角比 DWM 裁剪的圆角大，
//   角上就会露出一圈亚克力 —— 看起来就是一圈没有意义的浅色边框。
// 做法：显式要求 DWM 把窗口裁成圆角，并把 DWM 默认那条 1px 亮边设为透明。
const koffi = require('koffi');

const dwmapi = koffi.load('dwmapi.dll');
const DwmSetWindowAttribute = dwmapi.func(
  'int DwmSetWindowAttribute(uintptr_t hwnd, uint32 dwAttribute, const void *pvAttribute, uint32 cbAttribute)'
);

const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
const DWMWA_BORDER_COLOR = 34;          // Win11 22000+
const DWMWCP_ROUND = 2;                 // 系统圆角
const DWMWA_COLOR_NONE = 0xFFFFFFFE;    // 让边框颜色为「无」

function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length === 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
}

/** @returns {{corner:number, border:number, hwnd:string}|null} HRESULT（0 = S_OK） */
function applyRoundedChrome(win) {
  if (process.platform !== 'win32') return null;
  try {
    const hwnd = hwndOf(win);
    const v = Buffer.alloc(4);
    v.writeUInt32LE(DWMWCP_ROUND, 0);
    const corner = DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, v, 4);
    v.writeUInt32LE(DWMWA_COLOR_NONE, 0);
    const border = DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, v, 4);
    return { corner, border, hwnd: '0x' + hwnd.toString(16) };
  } catch (e) {
    return { corner: -1, border: -1, hwnd: 'err:' + e.message };
  }
}

const DWMWA_USE_IMMERSIVE_DARK_MODE = 20;   // Win11 22000+

/** 让系统亚克力的色调跟随应用主题（浅色玻璃 / 深色玻璃），而不是跟着系统跑 */
function setWindowDark(win, isDark) {
  if (process.platform !== 'win32') return -1;
  try {
    const v = Buffer.alloc(4);
    v.writeUInt32LE(isDark ? 1 : 0, 0);
    return DwmSetWindowAttribute(hwndOf(win), DWMWA_USE_IMMERSIVE_DARK_MODE, v, 4);
  } catch { return -1; }
}

module.exports = { applyRoundedChrome, setWindowDark };
