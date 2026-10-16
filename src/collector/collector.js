'use strict';
const fs = require('node:fs');
const path = require('node:path');
const win32 = require('./win32');

/**
 * 采集器（M1）
 * —— 1 秒采样；时间按「毫秒区间」归属，攒够整秒才落库，所以不丢不重。
 * —— 空闲：从「用户真正停手那一刻」倒推补账（不是检测到才从当秒开始算）。
 * —— 锁屏 / 休眠：各自单独累计到 day_idle 的 lock / sleep 行（M1 细分）。
 * —— 片段：同应用连续使用合成一段；**只有无缝接上**（间隔为 0）才并回同一段。
 *    第 28 轮修正：原来允许 5 秒内的缝也并回 —— 但那段缝已经被中间那个应用记走了
 *    （切走时已经 closeSegment），并回后本段的 end_ts 会跨过别人的时间，
 *    24 小时图按应用逐秒求和就会重复计（真库里量到 +572s）。留缝就新开一段。
 * —— 崩溃续写：day_usage 每秒增量提交；片段 end_ts 每 5 秒落一次盘，
 *    进程重启后由 store.segRepair() 清掉空壳、夹回未来时间。
 */

const MERGE_ADJACENT_MS = 0; // 只并回真正无缝接上的片段（见上：跨缝合并会造成重复计）
const SEG_FLUSH_MS = 5000;   // 片段 end_ts 落盘节流：硬杀最多丢 5 秒「片段细节」，秒数不丢

function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function displayNameFromExe(exeName) {
  return exeName.replace(/\.exe$/i, '').replace(/[-_]+/g, ' ').trim() || exeName;
}

/** t 之后最近的本地午夜（用 Date 计算，不用固定 86400000，避免夏令时偏移） */
function nextMidnightMs(t) { const d = new Date(t); d.setHours(24, 0, 0, 0); return d.getTime(); }

function createCollector({ store, iconCache, idleThresholdSec = 120, onChange = () => {}, probe = win32, clock = () => Date.now() }) {
  const now = clock;   // 注入时钟：测试里可以精确控制「现在几点」，跑跨天 / 休眠场景
  const stats = {
    ticks: 0, usageSeconds: 0, idleSeconds: 0, lockSeconds: 0, sleepSeconds: 0,
    iconRefreshes: 0, segments: 0, merges: 0, switches: 0, unforegrounded: 0,
    startedAt: now(), current: null, lastSampleMs: 0, mode: 'active', paused: false, away: null, sampleMs: 1000
  };

  let timer = null;
  let cursorMs = now();  // 时间已经归属到哪一刻
  let pendMs = 0;        // 不满 1 秒的零头
  let pendKey = null;    // 'app' | 'idle' | 'lock' | 'sleep'
  let pendAppId = null;
  let seg = null;        // { id, appId, startTs, writtenMs }
  const recentSegs = []; // 最近关掉的片段（按应用找，只有无缝接上才并回同一段）
  let lastApp = null;    // 最近归属过的应用行（同步补账用，避免异步）
  let awayKind = null;   // null | 'lock' | 'sleep'
  let awakeBeforeSleep = null;
  let paused = false;
  let lastHash = null;
  let sampleMs = 1000;          // 采样周期：正常 1 秒；全屏退避时放宽到 5 秒（M4 S4.4）
  const appCache = new Map();   // exeName -> 行（每秒只读内存，绝不每秒查库）

  /* ————————————— 落库 ————————————— */

  function writeSeconds(key, appId, day, sec) {
    if (sec <= 0) return;
    if (key === 'app') {
      stats.usageSeconds += sec;
      store.tx(() => {
        store.addUsage(day, appId, sec);
        if (seg && cursorMs - seg.writtenMs >= SEG_FLUSH_MS) {
          seg.writtenMs = cursorMs;
          store.segExtend(seg.id, cursorMs);
        }
      });
      return;
    }
    if (key === 'idle') stats.idleSeconds += sec;
    else if (key === 'lock') stats.lockSeconds += sec;
    else stats.sleepSeconds += sec;
    store.addIdle(day, sec, key);
  }

  /** 把攒够的整秒落库；drop=true 时连零头一起丢掉（换状态那一刻的亚秒舍入） */
  function flushWhole(drop) {
    const sec = Math.floor(pendMs / 1000);
    if (sec > 0) {
      pendMs -= sec * 1000;
      writeSeconds(pendKey, pendAppId, dayKey(new Date(cursorMs - 1)), sec);
    } else if (!drop) return;
    if (drop) pendMs = 0;
  }

  /* ————————————— 片段 ————————————— */

  function openSegment(appId, startTs) {
    // 只有「紧贴着上一段的尾巴」才并回（间隔 0）：中间那段缝属于别的应用/空闲，并进来就是重复计
    const i = recentSegs.findIndex((s) => s.appId === appId && startTs - s.endTs <= MERGE_ADJACENT_MS && startTs >= s.endTs);
    if (i >= 0) {                   // 同一刻切走又切回（中间那个状态是空壳被丢掉）：并回同一段
      const cand = recentSegs.splice(i, 1)[0];
      seg = { id: cand.id, appId, startTs, writtenMs: startTs };
      stats.merges++;
      return;
    }
    seg = { id: store.segOpen(appId, startTs), appId, startTs, writtenMs: startTs };
    stats.segments++;
  }

  function closeSegment(endTs) {
    if (!seg) return;
    const s = seg;
    seg = null;
    if (!(endTs > s.startTs)) { store.segDrop(s.id); return; }   // 空壳不要
    store.segExtend(s.id, endTs);
    recentSegs.unshift({ id: s.id, appId: s.appId, endTs });
    if (recentSegs.length > 8) recentSegs.length = 8;
  }

  /* ————————————— 归属 ————————————— */

  function setKey(key, appId) {
    // 注意 seg 判空：stop() 关过片段之后，同一个应用再回来也要重新开一段
    if (key === pendKey && appId === pendAppId && (key !== 'app' || seg)) return;
    flushWhole(true);
    if (pendKey === 'app') closeSegment(cursorMs);
    pendKey = key;
    pendAppId = appId;
    if (key === 'app') openSegment(appId, cursorMs);
  }

  /** 把 [fromMs, toMs) 记在 key 名下；跨本地午夜自动切成两天两笔 */
  function attribute(key, appId, fromMs, toMs) {
    if (!(toMs > fromMs)) return;
    setKey(key, appId);
    let t = Math.max(fromMs, cursorMs);
    while (t < toMs) {
      const end = Math.min(nextMidnightMs(t), toMs);
      pendMs += end - t;
      cursorMs = end;
      flushWhole(false);
      t = end;
    }
  }

  function setMode(m) { stats.mode = m; stats.away = awayKind; }

  /** 同步补账：只用已知状态 + 内存里的应用行，不做任何异步 / 查库（给锁屏、休眠、暂停、退出用） */
  function syncTo(nowMs) {
    if (paused || awayKind === 'sleep') { cursorMs = nowMs; return; }
    if (awayKind === 'lock') { attribute('lock', null, cursorMs, nowMs); return; }
    const idleMs = probe.getIdleMs();
    if (idleMs >= 0 && idleMs >= Math.max(1, idleThresholdSec) * 1000) {
      attribute('idle', null, Math.max(cursorMs, nowMs - idleMs), nowMs);
      return;
    }
    if (lastApp) attribute('app', lastApp.id, cursorMs, nowMs);
    else cursorMs = nowMs;
  }

  /* ————————————— 应用行维护（exe 名为键，重装合并） ————————————— */

  async function ensureApp(fg, day) {
    const exeName = path.basename(fg.path);
    let mtimeMs = 0, size = 0;
    try { const st = fs.statSync(fg.path); mtimeMs = Math.round(st.mtimeMs); size = st.size; } catch {}

    let row = appCache.get(exeName) || null;
    if (!row) { row = store.getAppByName(exeName); if (row) appCache.set(exeName, row); }

    if (!row) {
      const created = store.insertApp({ exeName, displayName: displayNameFromExe(exeName), exePath: fg.path, mtimeMs, size, day });
      appCache.set(exeName, created);
      const hash = await iconCache.ensure(fg.path);
      if (hash) { store.setIcon(created.id, hash, day); stats.iconRefreshes++; }
      return created;
    }
    if (row.exe_mtime_ms !== mtimeMs || row.exe_size !== size) {   // 只在 mtime/大小变了才重取图标
      iconCache.forget(fg.path);
      const hash = await iconCache.ensure(fg.path, true);
      if (hash && store.setIcon(row.id, hash, day)) stats.iconRefreshes++;
      store.touchApp(row.id, fg.path, mtimeMs, size, day);
      row = { ...row, exe_path_last: fg.path, exe_mtime_ms: mtimeMs, exe_size: size, last_seen_day: day };
      appCache.set(exeName, row);
    } else if (row.last_seen_day !== day) {
      store.touchLastSeen(row.id, day);
      row.last_seen_day = day;
    }
    return row;
  }

  /* ————————————— 一次采样 ————————————— */

  async function tickBody(nowMs) {
    stats.ticks++;

    if (paused) { syncTo(nowMs); setMode('paused'); return; }
    if (awayKind === 'sleep') { setMode('sleep'); return; }        // 睡眠中不推进，醒来一次性补
    if (awayKind === 'lock') {
      attribute('lock', null, cursorMs, nowMs);
      stats.current = null; setMode('lock'); return;
    }

    const idleMs = probe.getIdleMs();
    if (idleMs >= 0 && idleMs >= Math.max(1, idleThresholdSec) * 1000) {
      // 关键：从「停手那一刻」开始算，而不是检测到空闲的当秒
      attribute('idle', null, Math.max(cursorMs, nowMs - idleMs), nowMs);
      stats.current = null; setMode('idle'); return;
    }

    const fg = probe.getForeground();
    if (!fg || !fg.path) {                                         // 没有前台窗口（桌面 / UAC 等）
      attribute('idle', null, cursorMs, nowMs);
      stats.unforegrounded++; stats.current = null; setMode('idle'); return;
    }

    const day = dayKey(new Date(nowMs));
    const row = await ensureApp(fg, day);
    // 只有「上一刻还在空闲」才需要切开：空闲一直算到用户真正回来那一刻，之后才归应用。
    // 正常连着用的采样（idleMs≈0 且上一刻也是应用）整段都算应用，绝不误判成空闲。
    if (pendKey === 'idle') {
      const wakeMs = Math.min(nowMs, nowMs - Math.max(0, idleMs));   // 用户真正回来那一刻
      if (wakeMs > cursorMs) attribute('idle', null, cursorMs, wakeMs);
      // 就算这一秒没有剩余时间，也要把状态切成应用：否则空闲尾巴会在每个 tick 里被重复算一遍
      setKey('app', row.id);
    }
    attribute('app', row.id, cursorMs, nowMs);

    lastApp = row;
    stats.current = { appId: row.id, exeName: row.exe_name, displayName: row.display_name, path: fg.path };
    setMode('active');

    const h = row.id + '|' + row.exe_name;
    if (h !== lastHash) { lastHash = h; stats.switches++; onChange(stats.current); }
  }

  async function tick() {
    const t0 = process.hrtime.bigint();
    const nowMs = now();
    try { await tickBody(nowMs); }
    finally { stats.lastSampleMs = Number(process.hrtime.bigint() - t0) / 1e6; }
  }

  /* ————————————— 外部事件 ————————————— */

  /** powerMonitor：'lock' | 'sleep' | null（解锁 / 唤醒） */
  function setAway(kind, nowMs = now()) {
    if (kind === 'lock') {
      if (awayKind === 'lock') return;
      syncTo(nowMs);
      awayKind = 'lock';
    } else if (kind === 'sleep') {
      if (awayKind === 'sleep') return;
      syncTo(nowMs);
      awakeBeforeSleep = awayKind;
      awayKind = 'sleep';
    } else {
      if (awayKind === 'sleep') {
        attribute('sleep', null, cursorMs, nowMs);   // 休眠期间没有 tick，整段补成 sleep
        awayKind = awakeBeforeSleep || null;
        awakeBeforeSleep = null;
        cursorMs = nowMs;
      } else if (awayKind === 'lock') {
        awayKind = null;
        cursorMs = nowMs;
      }
    }
    stats.away = awayKind;
    stats.mode = awayKind === 'sleep' ? 'sleep' : (awayKind === 'lock' ? 'lock' : 'active');
    return awayKind;
  }

  function setPaused(v, nowMs = now()) {
    const on = !!v;
    if (on === paused) return paused;
    if (on) syncTo(nowMs);
    paused = on;
    flushWhole(true);
    if (seg) closeSegment(nowMs);
    cursorMs = now();
    stats.paused = on;
    stats.mode = on ? 'paused' : 'active';
    return paused;
  }

  return {
    stats,
    dayKey,
    start() {
      if (timer) return;
      cursorMs = now();
      timer = setInterval(() => { tick().catch(() => {}); }, sampleMs);
    },
    async stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (!paused && awayKind !== 'sleep') syncTo(now());
      flushWhole(true);
      if (seg) closeSegment(now());
    },
    tick,
    /** 采样周期（毫秒）：全屏退避期间放宽到 5 秒，回到前台立刻收回 1 秒。返回生效值。
     *  时间归属靠 cursorMs 时间戳，所以改周期不会丢秒、也不会重复计。 */
    setSampleInterval(ms) {
      const v = Math.max(500, Math.min(60000, Math.round(Number(ms) || 1000)));
      if (v === sampleMs) return sampleMs;
      sampleMs = v;
      stats.sampleMs = v;
      if (timer) { clearInterval(timer); timer = setInterval(() => { tick().catch(() => {}); }, sampleMs); }
      return sampleMs;
    },
    setAway,
    setPaused,
    /** M8（主人 9 号）：主人给应用起了自定义名字后，采集器缓存里那份旧名字要跟着换，
     *  否则左下角「正在记录 · xxx」会一直显示旧名，直到重启。 */
    applyCustomName(appId, name) {
      const nm = String(name || '').trim();
      for (const [exe, row] of appCache) {
        if (row && row.id === appId) appCache.set(exe, { ...row, display_name: nm || row.display_name });
      }
      if (stats.current && stats.current.appId === appId && nm) stats.current.displayName = nm;
      return true;
    },
    getState() { return { mode: stats.mode, paused, away: awayKind, cursorMs, appId: lastApp ? lastApp.id : null }; }
  };
}

module.exports = { createCollector, dayKey, displayNameFromExe, MERGE_ADJACENT_MS };
