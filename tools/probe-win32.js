'use strict';
// M0 probe: verify koffi can call the 4 cheap Win32 APIs we need.
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

// Allocate once, reuse forever (this is what keeps CPU ~0%).
const pidPtr = koffi.alloc('uint32', 1);
const sizePtr = koffi.alloc('uint32', 1);
const pathBuf = koffi.alloc('char16_t', BUF_CHARS);
const lii = koffi.alloc(LASTINPUTINFO, 1);

function getForeground() {
  const hwnd = GetForegroundWindow();
  if (koffi.address(hwnd) === 0n) return { pid: 0, path: null, hwnd: 0n };
  GetWindowThreadProcessId(hwnd, pidPtr);
  const pid = koffi.decode(pidPtr, 'uint32');
  let path = null;
  const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (koffi.address(h) !== 0n) {
    try {
      koffi.encode(sizePtr, 'uint32', BUF_CHARS);
      const ok = QueryFullProcessImageNameW(h, 0, pathBuf, sizePtr);
      if (ok) {
        const len = koffi.decode(sizePtr, 'uint32');
        path = koffi.decode(pathBuf, 'char16_t', len);
      }
    } finally { CloseHandle(h); }
  }
  return { pid, path, hwnd: koffi.address(hwnd) };
}

function getIdleMs() {
  koffi.encode(lii, LASTINPUTINFO, { cbSize: 8, dwTime: 0 });
  if (!GetLastInputInfo(lii)) return -1;
  const info = koffi.decode(lii, LASTINPUTINFO);
  return GetTickCount() - info.dwTime;
}

// ---- run ----
console.log('koffi version :', koffi.version);
console.log('--- 前台窗口采样 8 次（每 1 秒）---');
let n = 0;
const t0 = process.hrtime.bigint();
const timer = setInterval(() => {
  const f = getForeground();
  console.log(`[${String(++n).padStart(2)}] pid=${String(f.pid).padStart(6)}  idle=${String(getIdleMs()).padStart(6)}ms  ${f.path}`);
  if (n >= 8) {
    clearInterval(timer);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`--- 完成，总耗时 ${ms.toFixed(0)} ms ---`);
    const cpu = process.cpuUsage();
    console.log(`本进程 CPU 时间: user=${(cpu.user/1000).toFixed(1)}ms sys=${(cpu.system/1000).toFixed(1)}ms`);
    koffi.free(pidPtr); koffi.free(sizePtr); koffi.free(pathBuf); koffi.free(lii);
    process.exit(0);
  }
}, 1000);