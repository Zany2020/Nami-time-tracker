'use strict';
// 只用 4 个廉价只读 Win32 API（koffi FFI，无原生编译、无需 VS）。
// 缓冲区一次分配、长期复用 —— 这是 CPU 占用能压在 0.00x% 的关键。
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const GetForegroundWindow = user32.func('void *GetForegroundWindow()');
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *lpdwProcessId)');
const OpenProcess = kernel32.func('void *OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)');
const CloseHandle = kernel32.func('bool CloseHandle(void *hObject)');
const QueryFullProcessImageNameW = kernel32.func('bool QueryFullProcessImageNameW(void *hProcess, uint32 dwFlags, char16_t *lpExeName, _Inout_ uint32 *lpdwSize)');

const LASTINPUTINFO = koffi.struct('LASTINPUTINFO', { cbSize: 'uint32', dwTime: 'uint32' });
const GetLastInputInfo = user32.func('bool GetLastInputInfo(_Inout_ LASTINPUTINFO *plii)');
const GetTickCount = kernel32.func('uint32 GetTickCount()');

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const BUF_CHARS = 32768;

// ——— 全屏探测（M4 S4.4）：只在退避巡检里调用，一次 4 个只读 API，缓冲区全程复用 ———
const RECT = koffi.struct('NamiRect', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const MONITORINFO = koffi.struct('NamiMonitorInfo', { cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32' });
const MONITORINFO_SIZE = 40;                       // 4 + 16 + 16 + 4，Windows 的 MONITORINFO 固定这么大
const GetWindowRect = user32.func('bool GetWindowRect(void *hWnd, _Out_ NamiRect *lpRect)');
const MonitorFromWindow = user32.func('void *MonitorFromWindow(void *hwnd, uint32 dwFlags)');
const GetMonitorInfoW = user32.func('bool GetMonitorInfoW(void *hMonitor, _Inout_ NamiMonitorInfo *lpmi)');
const GetClassNameW = user32.func('int GetClassNameW(void *hWnd, char16_t *lpClassName, int nMaxCount)');
const GetWindowLongW = user32.func('int32 GetWindowLongW(void *hWnd, int nIndex)');
const POINT = koffi.struct('NamiPoint', { x: 'int32', y: 'int32' });
const WINDOWPLACEMENT = koffi.struct('NamiWindowPlacement', {
  length: 'uint32', flags: 'uint32', showCmd: 'uint32',
  ptMinPosition: POINT, ptMaxPosition: POINT, rcNormalPosition: RECT
});
const WINDOWPLACEMENT_SIZE = 44;   // 4+4+4+8+8+16：Windows 的 WINDOWPLACEMENT 固定这么大
const SW_SHOWMAXIMIZED = 3;
const GetWindowPlacement = user32.func('bool GetWindowPlacement(void *hWnd, _Inout_ NamiWindowPlacement *lpwndpl)');

const fgRect = koffi.alloc(RECT, 1);
const monInfo = koffi.alloc(MONITORINFO, 1);
const clsBuf = koffi.alloc('char16_t', 256);
const wpBuf = koffi.alloc(WINDOWPLACEMENT, 1);
const DESKTOP_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd']);
const GWL_STYLE = -16;
const WS_CAPTION = 0x00C00000;     // 有标题栏 = 是普通窗口（最大化也算），不是全屏

const pidPtr = koffi.alloc('uint32', 1);
const sizePtr = koffi.alloc('uint32', 1);
const pathBuf = koffi.alloc('char16_t', BUF_CHARS);
const lii = koffi.alloc(LASTINPUTINFO, 1);

/** 前台窗口所属进程：{ pid, path }。无窗口 / 拿不到权限时 path 为 null。 */
function getForeground() {
  const hwnd = GetForegroundWindow();
  if (koffi.address(hwnd) === 0n) return { pid: 0, path: null };
  GetWindowThreadProcessId(hwnd, pidPtr);
  const pid = koffi.decode(pidPtr, 'uint32');
  let path = null;
  const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (koffi.address(h) !== 0n) {
    try {
      koffi.encode(sizePtr, 'uint32', BUF_CHARS);
      if (QueryFullProcessImageNameW(h, 0, pathBuf, sizePtr)) {
        path = koffi.decode(pathBuf, 'char16_t', koffi.decode(sizePtr, 'uint32'));
      }
    } finally { CloseHandle(h); }
  }
  return { pid, path };
}

/** 距上次键鼠输入的毫秒数；失败返回 -1。 */
function getIdleMs() {
  koffi.encode(lii, LASTINPUTINFO, { cbSize: 8, dwTime: 0 });
  if (!GetLastInputInfo(lii)) return -1;
  return (GetTickCount() - koffi.decode(lii, LASTINPUTINFO).dwTime) >>> 0;
}

/**
 * 前台窗口是不是「铺满了整块显示器」—— 全屏退避（M4 S4.4）的唯一判据。
 * 判据两条一起看：① 窗口矩形 == 显示器矩形；② 没有 WS_CAPTION。
 * 第 ② 条是关键：最大化的窗口在 Windows 上同样铺满显示器，但它有标题栏样式，
 * 少这一条的话「最大化一个记事本」会被当成在打游戏。
 * 独占全屏和无边框全屏两条都满足，都吃得下；
 * 桌面 / 任务栏那几个壳窗口显式排除，否则盯着桌面发呆也会被当成在打游戏。
 * 返回 { fullscreen, pid, cls }；没有前台窗口时 fullscreen=false。
 */
function getForegroundFullscreen() {
  const out = { fullscreen: false, pid: 0, cls: null, style: 0, maximized: false, rect: null, monitor: null, why: 'no-window' };
  const hwnd = GetForegroundWindow();
  if (koffi.address(hwnd) === 0n) return out;
  GetWindowThreadProcessId(hwnd, pidPtr);
  const pid = koffi.decode(pidPtr, 'uint32');
  out.pid = pid;
  const n = GetClassNameW(hwnd, clsBuf, 256);
  const cls = n > 0 ? koffi.decode(clsBuf, 'char16_t', n) : null;
  out.cls = cls;
  if (cls && DESKTOP_CLASSES.has(cls)) { out.why = 'desktop-shell'; return out; }
  const style = GetWindowLongW(hwnd, GWL_STYLE) >>> 0;
  out.style = style;
  if (style & WS_CAPTION) { out.why = 'has-caption'; return out; }   // 有标题栏 → 普通/最大化窗口
  // 最大化 ≠ 全屏：Windows 上最大化窗口同样铺满显示器，靠 GetWindowPlacement 的 showCmd 才分得开
  koffi.encode(wpBuf, 'uint32', WINDOWPLACEMENT_SIZE);
  if (GetWindowPlacement(hwnd, wpBuf) && koffi.decode(wpBuf, WINDOWPLACEMENT).showCmd === SW_SHOWMAXIMIZED) {
    out.maximized = true; out.why = 'maximized'; return out;
  }
  if (!GetWindowRect(hwnd, fgRect)) { out.why = 'no-rect'; return out; }
  const hmon = MonitorFromWindow(hwnd, 2);                 // MONITOR_DEFAULTTONEAREST
  if (koffi.address(hmon) === 0n) { out.why = 'no-monitor'; return out; }
  koffi.encode(monInfo, 'uint32', MONITORINFO_SIZE);       // 结构体第一个字段就是 cbSize
  if (!GetMonitorInfoW(hmon, monInfo)) { out.why = 'no-monitor-info'; return out; }
  const r = koffi.decode(fgRect, RECT);
  const m = koffi.decode(monInfo, MONITORINFO).rcMonitor;
  out.rect = [r.left, r.top, r.right, r.bottom];
  out.monitor = [m.left, m.top, m.right, m.bottom];
  const tol = 2;                                           // 有些程序会差 1~2 px
  out.fullscreen = Math.abs(r.left - m.left) <= tol && Math.abs(r.top - m.top) <= tol &&
    Math.abs(r.right - m.right) <= tol && Math.abs(r.bottom - m.bottom) <= tol;
  out.why = out.fullscreen ? 'covers-monitor' : 'rect-mismatch';
  return out;
}

module.exports = { getForeground, getIdleMs, getForegroundFullscreen };
