'use strict';
/**
 * 内存整理（M4 · S4.2 空闲整理 / S4.4 全屏退避）。
 *
 * 只做一件事：对指定 pid 调 psapi!EmptyWorkingSet。它就是任务管理器「内存」那一列的来源 ——
 * 调用后 Windows 立刻把闲置页挪进 standby 列表（别的程序可以即时回收），
 * 界面下次用到时按需缺页读回，代价是一次几十毫秒的重绘。
 *
 * 老实说清楚：这【不减少私有提交量】，别把它讲成「释放内存」。它换来的是
 * ① 任务管理器里的数字立刻掉下去；② 这些物理页在内存紧张时能被游戏/大型软件马上拿走。
 *
 * 只碰调用方给的 pid（来自 app.getAppMetrics()，全是我们自己的进程），
 * 不做任何跨进程枚举 —— 这是蓝图 §6.6 第 6 条的要求。
 */
const koffi = require('koffi');

const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_INFORMATION = 0x0400;
const ACCESS = PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION;

let mods = null;
let loadErr = null;
let lastErr = null;      // 最近一次失败原因（诊断用，正常路径恒为 null）

function init() {
  if (mods || loadErr) return mods;
  try {
    const psapi = koffi.load('psapi.dll');
    const kernel32 = koffi.load('kernel32.dll');
    mods = {
      EmptyWorkingSet: psapi.func('bool EmptyWorkingSet(void *hProcess)'),
      OpenProcess: kernel32.func('void *OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)'),
      CloseHandle: kernel32.func('bool CloseHandle(void *hObject)'),
      GetCurrentProcess: kernel32.func('void *GetCurrentProcess()')
    };
  } catch (e) {
    loadErr = e;
    mods = null;
  }
  return mods;
}

/** 原生整理是否可用（psapi 装载失败时恒 false，上层自动降级为「不整理」） */
function available() { return !!init(); }
function lastError() { return lastErr || loadErr; }

/** 整理一个进程的工作集；成功 true。自己的进程走伪句柄，省一次 OpenProcess */
function trimPid(pid) {
  const m = init();
  if (!m) return false;
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    if (n === process.pid) return !!m.EmptyWorkingSet(m.GetCurrentProcess());
    const h = m.OpenProcess(ACCESS, false, n);
    if (koffi.address(h) === 0n) { lastErr = new Error('OpenProcess 失败 pid=' + n); return false; }
    try { return !!m.EmptyWorkingSet(h); } finally { m.CloseHandle(h); }
  } catch (e) {
    lastErr = e;
    return false;
  }
}

/** 批量整理（去重）；返回 [{pid, ok}] */
function trimPids(pids) {
  const out = [];
  const seen = new Set();
  for (const p of pids || []) {
    const n = Number(p);
    if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push({ pid: n, ok: trimPid(n) });
  }
  return out;
}

module.exports = { available, trimPid, trimPids, lastError };