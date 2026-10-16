'use strict';
// M0 probe: node:sqlite availability + per-sample CPU cost of the Win32 collector.
const koffi = require('koffi');

console.log('node version :', process.version);

// ---------- 1) node:sqlite ----------
let sqliteOk = false, sqliteErr = null, DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) { sqliteErr = e.message; }

if (DatabaseSync) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE app(id INTEGER PRIMARY KEY, exe_name TEXT UNIQUE, display_name TEXT);
           CREATE TABLE day_usage(day TEXT, app_id INTEGER, seconds INTEGER, PRIMARY KEY(day, app_id));
           CREATE TABLE app_icon(app_id INTEGER, icon_hash TEXT, effective_from_day TEXT, effective_to_day TEXT);`);
  const insApp = db.prepare('INSERT INTO app(exe_name, display_name) VALUES (?, ?)');
  const insUse = db.prepare('INSERT INTO day_usage(day, app_id, seconds) VALUES (?, ?, ?) ON CONFLICT(day, app_id) DO UPDATE SET seconds = seconds + excluded.seconds');
  const t0 = process.hrtime.bigint();
  db.exec('BEGIN');
  for (let i = 0; i < 500; i++) insApp.run('app' + i + '.exe', 'App ' + i);
  for (let i = 0; i < 5000; i++) insUse.run('2026-10-13', (i % 500) + 1, 1);
  db.exec('COMMIT');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const q = db.prepare('SELECT a.display_name, u.seconds FROM day_usage u JOIN app a ON a.id=u.app_id ORDER BY u.seconds DESC LIMIT 3').all();
  console.log('--- node:sqlite ---- OK');
  console.log('  写入 500 app + 5000 用量 耗时 :', ms.toFixed(1), 'ms');
  console.log('  UPSERT 累加后 TOP3 :', JSON.stringify(q));
  const range = db.prepare("SELECT day, SUM(seconds) s FROM day_usage WHERE day BETWEEN ? AND ? GROUP BY day").all('2026-10-01','2026-10-31');
  console.log('  区间聚合(月/全部用) :', JSON.stringify(range));
  db.close();
  sqliteOk = true;
} else {
  console.log('--- node:sqlite ---- FAILED:', sqliteErr);
}

// ---------- 2) 采样开销 ----------
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

const pidPtr = koffi.alloc('uint32', 1), sizePtr = koffi.alloc('uint32', 1);
const pathBuf = koffi.alloc('char16_t', 32768), lii = koffi.alloc(LASTINPUTINFO, 1);

function sample() {
  const hwnd = GetForegroundWindow();
  if (koffi.address(hwnd) === 0n) return 0;
  GetWindowThreadProcessId(hwnd, pidPtr);
  const pid = koffi.decode(pidPtr, 'uint32');
  const h = OpenProcess(0x1000, false, pid);
  if (koffi.address(h) !== 0n) {
    try { koffi.encode(sizePtr, 'uint32', 32768); if (QueryFullProcessImageNameW(h, 0, pathBuf, sizePtr)) koffi.decode(pathBuf, 'char16_t', koffi.decode(sizePtr, 'uint32')); }
    finally { CloseHandle(h); }
  }
  koffi.encode(lii, LASTINPUTINFO, { cbSize: 8, dwTime: 0 });
  GetLastInputInfo(lii);
  return pid;
}

for (let i = 0; i < 50; i++) sample(); // 预热
const N = 2000;
const c0 = process.cpuUsage();
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) sample();
const wall = Number(process.hrtime.bigint() - t0) / 1e6;
const cpu = process.cpuUsage(c0);
const perCall = (cpu.user + cpu.system) / 1000 / N;
console.log('--- 采样开销 (含空闲检测) ----');
console.log(`  ${N} 次 墙钟 ${wall.toFixed(1)} ms  → 每次 ${(wall/N).toFixed(3)} ms`);
console.log(`  CPU 合计 ${((cpu.user+cpu.system)/1000).toFixed(1)} ms → 每次 ${perCall.toFixed(4)} ms CPU`);
console.log(`  若 1 秒采 1 次，理论 CPU 占用 : ${(perCall/1000*100).toFixed(4)} % (单核)`);
koffi.free(pidPtr); koffi.free(sizePtr); koffi.free(pathBuf); koffi.free(lii);