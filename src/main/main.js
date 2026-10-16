'use strict';
const { app, BrowserWindow, ipcMain, protocol, screen, nativeTheme, Tray, Menu, nativeImage, powerMonitor, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');   // M7 S7.2：开机自启要写/删启动文件夹里的 .lnk（走 PowerShell 的 COM）

const ARGV = process.argv.slice(1);
// M0 实测结论：关掉硬件加速后亚克力玻璃依然成立，但私有内存省掉一半、GPU 进程稳定在 ~24MB。
// 因此默认关闭，需要硬件加速时显式加 --hw-accel。
const NO_HWACCEL = !ARGV.includes('--hw-accel');
function argValue(name) { const pre = name + '='; const hit = ARGV.find((a) => a.startsWith(pre)); return hit ? hit.slice(pre.length) : null; }
const READY_FILE_ARG = argValue('--ready-file');
const MINIMIZE_AFTER = Number(argValue('--minimize-after') || 0);
const ALWAYS_ON_TOP = ARGV.includes('--always-on-top'); // M0 测试用：保证截图时不被别的窗口挡住
const THEME_ARG = argValue('--theme');                   // 仅测试：临时预览深浅色，不写库
const CSS_GLASS = ARGV.includes('--css-glass');          // 仅测试：不用 DWM 亚克力，改由 CSS backdrop-filter 提供玻璃底
const MOCK_BG = argValue('--mock-bg');
const POS_ARG = argValue('--pos');                      // 仅测试："X,Y"
const SIZE_ARG = argValue('--size');                    // 仅测试："WxH"                    // 仅测试：窗内铺一层受控的彩色「假壁纸」，用于可复现的视觉 QA
const NO_FX = ARGV.includes('--no-fx');
const SHOT_ARG = argValue('--shot');                     // 仅测试：capturePage 精确导出渲染结果（与窗口在屏幕上的位置无关）
const SHOT_DELAY = Number(argValue('--shot-delay') || 2500);
const SHOT_EXIT = ARGV.includes('--shot-exit');
const PROBE_ARG = argValue('--probe');                   // 仅测试：导出关键元素布局矩形，便于精确自查
const EXEC_ARG = argValue('--exec-js');                   // 仅测试：截图前在渲染进程里执行一段脚本（文件路径）
const CENTER = ARGV.includes('--center');
// 关键：frame:false + thickFrame:false 时 Windows 不再保留非客户区，
// 客户区 == 窗口矩形 → 亚克力不再从四周露出（那圈灰边就是主人说的「无意义的边框」），
// 底部圆角也因此与顶部完全同心。代价是没有系统投影/缩放，需要用 --thick-frame 换回来。
const THICK_FRAME = ARGV.includes('--thick-frame');                  // 仅测试：切回原生厚边框（会重新露出非客户区）用于 A/B 对比
const BOUNDS_TEST = ARGV.includes('--bounds-test');                  // 仅测试：验证 thickFrame:false 下 setBounds() 是否生效
const NO_TRAY = ARGV.includes('--no-tray');                          // 仅测试：不建托盘，窗口关掉就退出
// M7 S7.2：开机自启时静默起在托盘里 —— 不建窗口（第一次点托盘才建）。
// 注意：--boot 故意不进 QA_BYPASS_LOCK：开机这一份必须和用户手动开的那个抢同一把锁。
const BOOT_ARG = ARGV.includes('--boot');
const AUTOSTART_TEST = ARGV.includes('--autostart-test');            // 仅测试：允许 QA 实例去动真启动文件夹
const DATA_DIR_ARG = argValue('--data-dir');                         // 仅测试：把数据目录指到临时目录，不碰真库
const SELFTEST_TRAY = ARGV.includes('--selftest-tray');              // 仅测试：托盘常驻自检（关窗→重开→暂停→截图）
const TRAY_TEST_FILE = argValue('--tray-test-file');                 // 仅测试：自检结果写这里
// ——— M4 内存专项开关（默认全开；带 no- 的只给 A/B 对照 / 排查用）———
const NO_TRIM = ARGV.includes('--no-trim');                          // 关掉工作集整理（对照实验）
const NO_BG_THROTTLE = ARGV.includes('--no-bg-throttle');            // 量帧率用：窗口在后台也继续出帧
/* 量帧率专用（第 28 轮）：窗口被挡住时 Chromium 根本不出帧，rAF 量不到东西。
   那就由主进程反复 capturePage 逼它出帧，把每次「出帧 + 读回」的耗时打出来 —— 只给 A/B 探针用。
   用法：--fps-capture=<次数> --fps-capture-delay=<毫秒>；配合 --exec-js 来回切 hover。 */
const FPS_CAPTURE = Number(argValue('--fps-capture') || 0);
const NO_RETREAT = ARGV.includes('--no-retreat');                    // 关掉全屏退避（对照实验）
const NET_INPROC = !ARGV.includes('--no-net-inproc');                // 网络服务并回主进程（省一个 utility 进程）
const DEVTOOLS = ARGV.includes('--devtools');                        // 默认封掉 DevTools
const IDLE_TRIM_SEC = Number(argValue('--idle-trim-sec') || 60);     // 无输入多少秒后整理工作集
const RETREAT_POLL_MS = Number(argValue('--retreat-poll-ms') || 2000);// 全屏巡检周期
const MEM_SELFTEST = ARGV.includes('--mem-selftest');                // 仅测试：跑四态内存自检后退出
const MEM_FILE = argValue('--mem-file');                             // 仅测试：自检结果写这里
const MEM_FAKE_FS = ARGV.includes('--mem-fake-fullscreen');          // 仅测试：强制进退避态
const MEM_ACTIVE_SEC = Number(argValue('--mem-active-sec') || 20);   // 仅测试：活跃态稳定时长
const MEM_BG_SEC = Number(argValue('--mem-bg-sec') || 60);           // 仅测试：后台已整理判定的等长
const MEM_DRIFT_SEC = Number(argValue('--mem-drift-sec') || 30);     // 仅测试：整理之后观察「回涨」的时长
const QUIT_AFTER = Number(argValue('--quit-after') || 0);            // 仅测试：N 秒后正常退出（会走 before-quit 落盘）
const LOG_FILE = argValue('--log-file');                             // 仅测试：退出时把事件日志写到这
const BACKUP_TEST = argValue('--backup-test');                       // 仅测试：跑一次备份自检后退出
/* ——— M8 主人第 2 号：历史应用图标回填（ManicTime 迁进来的应用没有路径/图标） ——— */
const BACKFILL_ARG = ARGV.includes('--backfill-icons');              // 仅测试：等回填跑完（默认是后台跑，不阻塞启动）
const BACKFILL_REPORT = argValue('--backfill-report');               // 仅测试：回填统计写到这里
/* ——— M6 ManicTime 历史迁移：一次性命令，不开窗口、采完就走 ———
   例：electron . --data-dir=D:\tmp\nami --migrate-manictime=auto --migrate-report=D:\tmp\r.json
   —— 默认**拒绝**写真数据目录（红线：测试一律临时绝对路径），确要迁真库再加 --migrate-allow-real */
const MIGRATE_ARG = argValue('--migrate-manictime');                 // 'auto' | ManicTimeReports.db 绝对路径
const MIGRATE_REPORT = argValue('--migrate-report');                 // 迁移结果 JSON 落到这里
const MIGRATE_MODE = argValue('--migrate-mode') || 'replace';        // replace（默认，幂等）| add
const MIGRATE_NAMING = argValue('--migrate-naming') || 'manictime';  // manictime（沿用产品名）| exe
const MIGRATE_SINCE = argValue('--migrate-since');                   // 只迁 >= 这天
const MIGRATE_UNTIL = argValue('--migrate-until');                   // 只迁 <= 这天（默认：昨天）
const MIGRATE_TODAY = ARGV.includes('--migrate-include-today');      // 连今天一起迁（默认不迁，今天留给实时采集）
const MIGRATE_ALLOW_REAL = ARGV.includes('--migrate-allow-real');    // 显式允许写真数据目录
const MIGRATE_DRY = ARGV.includes('--migrate-dry-run');              // 只读不写，先看数
const BLUR_AFTER = Number(argValue('--blur-after') || 0);            // 仅测试：N 秒后主动失焦（验证失焦整理）
const NO_HOUSEKEEPING = ARGV.includes('--no-housekeeping');          // 仅测试：关掉自动整理，由自检自己驱动
const FIRST_TRIM_SEC = Number(argValue('--first-trim-sec') || 12);   // 首屏整理：窗口开完多久后交还一次（S4.2）
const TRIM_GAP_MS = 30000;                                           // 两次整理之间至少隔这么久，免得反复缺页
/* 窗口比例（M5.5）：锁 3:2（1.5）—— 桌面工具的经典比例，列表更长、柱图更舒展。
   默认 1170×780（面积与旧默认 1080×780 几乎一样，只宽 90px），最小 930×620 = 同一个比例。
   锁死比例后「拖任意边」都是等比缩放，图标大小跟着窗口呼应（渲染进程按窗口宽算 --ico）。 */
const WIN_RATIO = 1.5, WIN_W0 = 1170, WIN_H0 = 780;
const MIN_W = 930, MIN_H = 620;

// ——— 内存纪律（蓝图 §6.6）———
if (NO_HWACCEL) app.disableHardwareAcceleration();
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=64');
// 裁剪 Electron（§6.6-4）：网络服务并回主进程、不要「备用渲染进程」，少开进程就是少一份工作集。
// M0 实测过 NetworkServiceInProcess 在 Electron 44 上不一定吃得住，所以这里只当尽力而为，
// 真正的兜底是 S4.2 的工作集整理；加 --no-net-inproc 可以关掉做 A/B。
if (NET_INPROC) {
  app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess');
  app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess');
}
// 量帧率专用（第 28 轮）：窗口被别的窗口挡住时，Chromium 会把渲染进程当"被遮挡"从而停止出帧，
// 探针里的 rAF 会掉到 1 Hz，什么都量不出来。这个开关关掉那套降级 —— 只给 A/B 探针用。
if (NO_BG_THROTTLE) app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

/* ——— 事件日志（放在最前面：下面单实例被拦时就要 note 一句） ——— */
const T0 = Date.now();
const eventLog = [];
function note(msg) {
  eventLog.push(`[+${((Date.now() - T0) / 1000).toFixed(1)}s] ${msg}`);
  if (eventLog.length > 300) eventLog.shift();
}

/* ——— 单实例（第 28 轮数据审查发现）———
   同一个数据目录绝不该有两份在跑：两份各自 setInterval 采集，每秒各记一笔，秒数直接翻倍，
   24 小时图还会出现互相盖住的片段。今天真库里就抓到同一应用、同一结束时刻、不同开始时刻的成对行。
   带测试参数的实例默认不抢锁（QA 要在主人开着软件时另开一个独立实例做对照）；
   --lock-test 强制走抢锁这条路，专门用来验证「第二份会自己退出」（见 work/m8-lock-test.ps1）。 */
const LOCK_TEST = ARGV.includes('--lock-test');
const QA_BYPASS_LOCK = !LOCK_TEST && !!(DATA_DIR_ARG || SHOT_ARG || PROBE_ARG || EXEC_ARG ||
  SELFTEST_TRAY || TRAY_TEST_FILE || MEM_SELFTEST || MEM_FILE || BACKUP_TEST || MIGRATE_ARG || READY_FILE_ARG);
const HAS_LOCK = QA_BYPASS_LOCK || app.requestSingleInstanceLock();
if (HAS_LOCK) {
  // 第二份被拦下时，把已经在跑的那一份的窗口叫回来（Windows 上点两次图标就是想要这个）
  app.on('second-instance', () => { try { showWindow(); } catch {} });
} else {
  note('已经有一份在运行：本进程直接退出（不建库、不采集、不抢托盘）');
  console.error('[Nami Time] 已经有一份在运行：本进程直接退出');   // 没拿到锁时不一定有日志文件，stdout 兜底
  // 这条路径走不到 whenReady 末尾那个 before-quit，日志只能在这里直接落盘
  try { if (LOG_FILE) fs.writeFileSync(LOG_FILE, eventLog.join('\n'), 'utf8'); } catch {}
  app.quit();
}

/* ——— M6 红线守卫 ———
   迁移的「缺省目标」正好就是真实数据目录 %LOCALAPPDATA%\NamiTime。所以在动任何文件之前先拒绝掉：
   不 setPath、不 mkdir、不开库 —— 连一个空库都不留在真目录里。 */
function realDataDir() { return path.join(process.env.LOCALAPPDATA || process.cwd(), 'NamiTime'); }
function refusesRealDataDir(dir) {
  return !!MIGRATE_ARG && !MIGRATE_ALLOW_REAL && !MIGRATE_DRY &&
         path.resolve(dir).toLowerCase() === path.resolve(realDataDir()).toLowerCase();
}

const USER_DATA = DATA_DIR_ARG ? path.resolve(DATA_DIR_ARG) : realDataDir();
if (refusesRealDataDir(USER_DATA)) {
  const msg = '拒绝写入真数据目录 ' + USER_DATA + '（红线）：请用 --data-dir=<临时绝对路径> 迁移；' +
              '确要把历史直接迁进正在使用的真库，再加 --migrate-allow-real';
  try { if (MIGRATE_REPORT) fs.writeFileSync(MIGRATE_REPORT, JSON.stringify({ ok: false, refused: 'real-data-dir', error: msg, dataDir: USER_DATA }, null, 2), 'utf8'); } catch {}
  console.error('[m6] ' + msg);
  app.exit(2);
}
app.setPath('userData', USER_DATA);
fs.mkdirSync(USER_DATA, { recursive: true });
const DB_PATH = path.join(USER_DATA, 'data.db');
const ICON_DIR = path.join(USER_DATA, 'icons');
const BACKUP_DIR = path.join(USER_DATA, 'backup');   // M5.6 定期备份：快照 / CSV / 每周概览图都落这里

const { openStore } = require(path.join(__dirname, '..', 'collector', 'store.js'));
const { createIconCache } = require(path.join(__dirname, '..', 'collector', 'icon-cache.js'));
const winIcon = require(path.join(__dirname, '..', 'collector', 'win-icon.js'));
const { createCollector } = require(path.join(__dirname, '..', 'collector', 'collector.js'));
const mtMigrate = require(path.join(__dirname, '..', 'collector', 'manictime.js'));   // M6 迁移
const CAT = require(path.join(__dirname, '..', 'collector', 'categories.js'));
const { applyRoundedChrome, setWindowDark } = require(path.join(__dirname, 'dwm.js'));
const win32probe = require(path.join(__dirname, '..', 'collector', 'win32.js'));
const memTrim = require(path.join(__dirname, 'mem.js'));
const { createBackup } = require(path.join(__dirname, 'backup.js'));
const { createIconBackfill } = require(path.join(__dirname, '..', 'collector', 'icon-backfill.js'));   // M8 图标回填

protocol.registerSchemesAsPrivileged([
  { scheme: 'nami-icon', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

// Electron 44 没有 getBackgroundMaterial()，改用系统版本判断亚克力是否可用
function acrylicSupported() {
  if (process.platform !== 'win32') return false;
  const m = os.release().match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? Number(m[3]) >= 22000 : false;
}

// （T0 / eventLog / note 已提到文件最前面：单实例被拦时就要用）

let win = null, store = null, collector = null, iconCache = null, fsOn = false;
let iconBackfill = null;    // M8 图标回填（历史应用的 exe 路径 + 图标）
let tray = null, quitting = false, lastTip = '';
let backup = null;
let bootHooksDone = false;                                           // 测试钩子只在第一个窗口上跑一次
const TRAY_ICON = path.join(__dirname, '..', '..', 'assets', 'tray.png');

/** 全部进程的工作集合合计（KB -> B），给内存报告用 */
function totalWorkingSet() {
  try { return app.getAppMetrics().reduce((s, m) => s + ((m.memory && m.memory.workingSetSize) || 0), 0) * 1024; }
  catch { return 0; }
}

/* ————————————— M4 内存专项（蓝图 §6.6 七条措施） —————————————
   ① 托盘优先：关窗 = 销毁渲染进程（M1 已做，这里只管测量与收尾）
   ② 空闲整理：窗口收起 / 无输入 60 秒 → EmptyWorkingSet
   ③ 全屏退避：前台铺满整块显示器 → 采样 1s→5s + 整理工作集
   ④ 裁剪 Electron：见上面的 command-line 开关 + webPreferences.devTools
   ⑤ 不额外开进程：采集 / 存储 / 托盘全在主进程（架构上就是如此）
   ⑥ 绝不每秒枚举进程：这里只用 Electron 自己的 getAppMetrics() 账本，不扫系统进程表
   ⑦ 内存自检：--mem-selftest 一键出四态数字（工作集 / 私有提交 / 进程数 / CPU）
   注意 git 纪律：工作集整理【不减少私有提交量】，只是把闲置页交还系统。 */

let lastTrimAt = 0;

/** 我们自己所有进程的 pid（主进程 / 渲染 / GPU / utility）——来自 Electron 的账本，不枚举系统进程 */
function ownPids() {
  try { return app.getAppMetrics().map((m) => m.pid); } catch { return [process.pid]; }
}

/** 工作集整理：把我们所有进程的闲置页交还系统，任务管理器里的数字立刻掉下来 */
function trimWorkingSet(reason) {
  if (NO_TRIM) return null;
  if (!memTrim.available()) return null;
  const res = memTrim.trimPids(ownPids());
  lastTrimAt = Date.now();
  note(`工作集整理（${reason}）：${res.filter((r) => r.ok).length}/${res.length} 个进程`);
  return res;
}

/** 一次内存快照。cpuPct 是「自上次快照以来」的用量（Electron 的语义就是这样） */
function memSnapshot(label) {
  const m = app.getAppMetrics();
  const ws = (x) => (x.memory && x.memory.workingSetSize) || 0;
  const pv = (x) => (x.memory && x.memory.privateBytes) || 0;
  const cp = (x) => (x.cpu && x.cpu.percentCPUUsage) || 0;
  const kb2mb = (k) => +(k / 1024).toFixed(1);
  return {
    label, at: new Date().toISOString(),
    procs: m.length,
    wsMB: kb2mb(m.reduce((s, x) => s + ws(x), 0)),
    privMB: kb2mb(m.reduce((s, x) => s + pv(x), 0)),
    cpuPct: +m.reduce((s, x) => s + cp(x), 0).toFixed(3),
    byType: m.map((x) => ({ type: x.type, pid: x.pid, wsMB: kb2mb(ws(x)), privMB: kb2mb(pv(x)), cpu: +cp(x).toFixed(3) }))
  };
}

let retreatOn = false;

/** 全屏退避开关（S4.4）：暂停界面刷新 + 采样放宽到 5 秒 + 整理工作集 */
function setRetreat(on, why) {
  if (on === retreatOn) return retreatOn;
  retreatOn = on;
  if (collector) collector.setSampleInterval(on ? 5000 : 1000);
  if (on) trimWorkingSet('进入全屏退避');
  note(`全屏退避：${on ? '开（' + why + '）· 采样放宽到 5 秒' : '关 · 采样回到 1 秒'}`);
  if (win && !win.isDestroyed()) { try { win.webContents.send('nami:retreat', on); } catch {} }
  return retreatOn;
}

/** 全屏巡检（S4.4）：2 秒一次，只问「前台窗口铺满屏幕了吗」，不枚举进程 */
function startRetreatWatch() {
  const t = setInterval(() => {
    if (MEM_FAKE_FS) { setRetreat(true, '自检强制'); return; }
    const fg = win32probe.getForegroundFullscreen();
    const why = `前台 ${fg.cls || '窗口'} pid=${fg.pid} · ${fg.why}`;
    setRetreat(!!fg.fullscreen && fg.pid !== process.pid, why);
  }, RETREAT_POLL_MS);
  if (t.unref) t.unref();
  return t;
}

/** 空闲整理巡检（S4.2）：窗口收起、或主人 60 秒没碰键鼠 → 把工作集交还系统。
    5 秒一次、只读一个 GetLastInputInfo；两次整理之间至少隔 60 秒，避免反复缺页反而更耗。 */
function startHousekeeping() {
  const t = setInterval(() => {
    if (retreatOn) return;                                   // 退避态有自己的节奏
    // 最小化也算「收起」：Electron 里最小化的窗口 isVisible() 仍为 true，
    // 但它一定不会被合成，工作集再留着就是纯浪费。
    const hidden = !win || win.isDestroyed() || !win.isVisible() || win.isMinimized();
    const idleMs = win32probe.getIdleMs();
    const idleSec = idleMs >= 0 ? idleMs / 1000 : 0;
    if (!hidden && idleSec < IDLE_TRIM_SEC) return;
    if (Date.now() - lastTrimAt < TRIM_GAP_MS) return;
    trimWorkingSet(hidden ? '窗口已收起' : `无输入 ${Math.round(idleSec)} 秒`);
  }, 5000);
  if (t.unref) t.unref();
  return t;
}

/**
 * 内存自检（S4.6 / 措施 ⑦）：四态工作集一键实测，结果写 JSON，主人随时可以复核。
 * 顺序：窗口打开活跃 → 窗口闲置整理后 → 关窗退到托盘 → 后台放 MEM_BG_SEC 秒 → 退避态。
 * 「活跃」必须在空闲整理之前取，否则量不到真实峰值；「闲置整理后」则是主人切去别的程序
 * （窗口失焦、渲染进程停止轮询）之后的样子 —— 那才是这台机器上「窗口开着」最常见的样子。
 */
async function runMemSelftest() {
  const R = { at: new Date().toISOString(), pid: process.pid, switches: ARGV,
              trim: memTrim.available() && !NO_TRIM, retreat: !NO_RETREAT, stages: {} };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const put = (k, s) => {
    R.stages[k] = s;
    note(`mem[${k}] 工作集 ${s.wsMB}MB · 私有 ${s.privMB}MB · ${s.procs} 进程 · CPU ${s.cpuPct}%`);
  };
  try {
    memSnapshot('预热');                                   // 吃掉首帧：percentCPUUsage 首次调用恒为 0
    await wait(MEM_ACTIVE_SEC * 1000);
    put('窗口打开·活跃', memSnapshot('活跃'));

    trimWorkingSet('自检·模拟窗口闲置');
    await wait(2500);
    put('窗口打开·首屏整理后', memSnapshot('窗口整理'));

    // 诚实采样：整理只是把闲置页挪进 standby，可见窗口会随着合成/重绘把它们重新摸回来。
    // 这一格就是把「回涨」量出来，别让「整理后 90MB」被当成常驻数字。
    await wait(MEM_DRIFT_SEC * 1000);
    put(`窗口打开·整理 ${MEM_DRIFT_SEC} 秒后（回涨）`, memSnapshot('回涨'));

    if (win && !win.isDestroyed()) win.destroy();          // 等同于点标题栏的 ✕
    await wait(2000);
    put('关窗后·常驻托盘', memSnapshot('常驻'));

    await wait(Math.max(0, MEM_BG_SEC * 1000 - 2000));     // 这段时间里 5 秒巡检会把工作集整理掉
    put(`退回后台 ${MEM_BG_SEC} 秒后（已整理）`, memSnapshot('后台'));

    if (NO_RETREAT) {                                      // 对照实验：这一格不测
      put('全屏退避（未启用）', memSnapshot('退避'));
    } else {
      setRetreat(true, '自检');
      await wait(6000);
      put('全屏退避', memSnapshot('退避'));
      setRetreat(false, '自检结束');
    }
  } catch (e) {
    R.error = String((e && e.message) || e);
  }
  R.log = eventLog.slice(-100);
  try { if (MEM_FILE) fs.writeFileSync(MEM_FILE, JSON.stringify(R, null, 2), 'utf8'); } catch {}
  quitting = true;
  app.quit();
}

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = (s) => new Date(s + 'T00:00:00');
const fmtDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (day, n) => { const d = parseDay(day); d.setDate(d.getDate() + n); return fmtDay(d); };
const startOfWeek = (day) => { const d = parseDay(day); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return fmtDay(d); };
const startOfMonth = (day) => { const d = parseDay(day); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`; };
const endOfMonth = (day) => { const d = parseDay(day); d.setMonth(d.getMonth() + 1, 0); return fmtDay(d); };

/** 把任意目标尺寸收进「3:2 + 下限 + 工作区」：以宽为准算高，宽高都不越界 */
function fitWin(w, h, work) {
  let W = Math.max(MIN_W, Math.round(Number.isFinite(w) ? w : WIN_W0));
  const maxW = work ? Math.min(work.width, Math.round(work.height * WIN_RATIO)) : 16 * WIN_W0;
  W = Math.min(W, Math.max(MIN_W, maxW));
  let H = Math.round(W / WIN_RATIO);
  if (H < MIN_H) { H = MIN_H; W = Math.round(H * WIN_RATIO); }
  return { width: W, height: H };
}
function workAreaFor(bounds) {
  try { return screen.getDisplayMatching(bounds || win.getBounds()).workAreaSize; } catch (e) { return null; }
}

/* ——— M5.5 时段分布：把原始片段按「一天里的第几小时」聚成 24 个桶（秒）———
   M9（主人 2026-10-16）修正：这里返回的仍然是**本范围真实合计**（IPC 契约不变），
   由界面把每个桶除以「活跃天数」画成「一天里这个小时平均用多久」，合计只出现在悬停提示里。
   旧版界面直接画合计 —— 30 天窗口里 20:00 那根柱子顶到「3 小时 4 分钟」，
   读起来像「这个小时用了 3 小时」；再早的版本除以**日历天数**又会把短窗口压成 1/N。
   分母必须是活跃天数，两个坑才都绕开。 */
function hourBuckets(rows, fromMs, toMs) {
  const h = new Array(24).fill(0);
  for (const r of rows) {
    let s = Math.max(r.start_ts, fromMs), e = Math.min(r.end_ts, toMs);
    while (s < e) {
      const d = new Date(s);
      const next = new Date(d); next.setMinutes(60, 0, 0);
      const cut = Math.min(e, next.getTime());
      h[d.getHours()] += (cut - s) / 1000;
      s = cut;
    }
  }
  return h;
}
const daySpan = (from, to) => { let n = 0; for (let d = from; d && d <= to; d = addDays(d, 1)) n++; return Math.max(1, n); };

function resolveRange(kind, anchor) {
  const today = dayKey();
  if (kind === 'week') { const f = startOfWeek(anchor); return { from: f, to: addDays(f, 6) }; }
  if (kind === 'month') return { from: startOfMonth(anchor), to: endOfMonth(anchor) };
  /* 滚动窗口（M5.5 详情页用）：d7 = 最近 7 天含锚点日。比「自然周」更贴「我想看最近用了多少」 */
  if (kind === 'd1') return { from: anchor, to: anchor };
  if (kind === 'd7') return { from: addDays(anchor, -6), to: anchor };
  if (kind === 'd30') return { from: addDays(anchor, -29), to: anchor };
  if (kind === 'all') return { from: store.firstDay() || anchor, to: anchor > today ? anchor : today };
  return { from: anchor, to: anchor };
}

/* ——— M5 详情页：把「逐日合计 + 逐日空闲」铺成连续日期序列（缺日补 0）———
   柱图要连续日期才看得出趋势，所以缺的日子补 0；上限 120 天，超了只画最近一段。 */
const MAX_CHART_DAYS = 120;
function buildDailySeries(from, to, daily, idleDaily) {
  const use = new Map(daily.map((x) => [x.day, x.seconds]));
  const away = new Map();
  for (const r of idleDaily) {
    const cur = away.get(r.day) || { idle: 0, lock: 0, sleep: 0 };
    cur[r.kind] = (cur[r.kind] || 0) + r.seconds;
    away.set(r.day, cur);
  }
  const all = [];
  for (let d = from; d && d <= to; d = addDays(d, 1)) {
    const a = away.get(d) || {};
    all.push({ day: d, sec: use.get(d) || 0, idle: a.idle || 0, lock: a.lock || 0, sleep: a.sleep || 0 });
    if (all.length > 4000) break;                 // 保险丝：极端 firstDay 也不撑爆内存
  }
  const clipped = all.length > MAX_CHART_DAYS;
  return { days: clipped ? all.slice(-MAX_CHART_DAYS) : all, clipped, spanDays: all.length };
}

// ——— 外观（浅色/深色/跟随系统）：以 nativeTheme 为唯一真相 ———
const themeStored = () => THEME_ARG || store.getSetting('theme', 'light');
function applyThemeSource(t) { try { nativeTheme.themeSource = (t === 'dark') ? 'dark' : (t === 'light' ? 'light' : 'system'); } catch {} }
const resolvedTheme = () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');

/* ——— 分类（M3）：分类 / 规则 / 手动成员 / 总开关，一次性打包给界面 ———
   规则匹配本身在 collector/categories.js（纯函数），这里只负责读写与拼装 */
const rulesOn = () => store.getSetting('catsAuto', '1') !== '0';
function catState() {
  const t = CAT.GAME_TEMPLATE;
  return {
    categories: store.categories(),
    rules: store.rules(),
    rulesOn: rulesOn(),
    pairs: store.manualPairs(),
    palette: CAT.PALETTE,
    kindLabel: CAT.KIND_LABEL,
    template: { name: t.name, color: t.color, count: t.rules.length },
    hasGame: !!store.categoryByName(t.name)
  };
}

// ——— 托盘（M1 S1.6）：无界面常驻；关闭窗口 = 销毁渲染进程，只留采集主进程（蓝图 §6.6-1）———
const MODE_LABEL = { active: '记录中', idle: '空闲中', lock: '已锁屏', sleep: '休眠中', paused: '已暂停' };

function fmtDur(sec) {
  if (!sec) return '0 分钟';
  if (sec < 60) return '< 1 分钟';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}小时${m}分钟` : `${h}小时`;
  return `${m}分钟`;
}

function todayTotal() {
  try { return store.topApps(dayKey(), dayKey()).reduce((s, r) => s + r.seconds, 0); } catch { return 0; }
}

let trayMenuItems = null;   // 菜单对象留个引用：Electron 的 Tray 没有 getContextMenu()（自检 / 排错要用）
function refreshTrayMenu() {
  if (!tray) return;
  const st = collector ? collector.stats : { mode: 'active', paused: false };
  const tip = `Nami Time · ${MODE_LABEL[st.mode] || '记录中'} · 今天 ${fmtDur(todayTotal())}`;
  if (tip !== lastTip) { lastTip = tip; tray.setToolTip(tip); }
  trayMenuItems = Menu.buildFromTemplate([
    { label: '打开窗口', click: () => showWindow() },
    { label: `今天已记录 ${fmtDur(todayTotal())}`, enabled: false },
    { type: 'separator' },
    { label: st.paused ? '继续记录' : '暂停记录', click: () => setPaused(!st.paused) },
    { type: 'separator' },
    { label: '退出 Nami Time', click: () => { quitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(trayMenuItems);
}

function createTray() {
  if (NO_TRAY || tray) return tray;
  let img = nativeImage.createFromPath(TRAY_ICON);
  const missing = img.isEmpty();
  if (missing) img = nativeImage.createEmpty();
  tray = new Tray(img);
  tray.on('click', () => toggleWindow());
  refreshTrayMenu();
  note('托盘已就绪' + (missing ? '（图标缺失，用空白占位）' : ''));
  const t = setInterval(() => refreshTrayMenu(), 60000);   // 提示文案每分钟对表，未变则零开销
  if (t.unref) t.unref();
  return tray;
}

function showWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    refreshTrayMenu();
    return win;
  }
  return createWindow();
}

/** 左键点托盘：开着就收起来，收着就打开 */
function toggleWindow() {
  if (win && !win.isDestroyed() && win.isVisible()) { win.destroy(); refreshTrayMenu(); return null; }
  return showWindow();
}

/* ——— M7 S7.2 开机自启（主人 2026-10-16 选定：启动文件夹快捷方式）———
   为什么不用注册表 Run 项：启动文件夹里的 .lnk 肉眼可见、想取消直接删掉就行；
   而且以后还要出便携版，exe 路径会变，藏在注册表里的残项没人会去清理。
   自启时带 --boot：只起托盘、不弹窗口（否则每次开机都往脸上糊一个窗口）。
   开关的真相在库里（setting.autostart），每次启动对账一次：库说开就确保有、库说关就确保没有。 */
const STARTUP_DIR = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const AUTOSTART_LNK = path.join(STARTUP_DIR, 'Nami Time.lnk');
const AUTOSTART_TAG = '[自启]';

function autostartTarget() {
  // 打包版：exe 就是自己；开发态：electron.exe 后面跟应用目录（和「启动 Nami Time.bat」等价）
  const appDir = path.join(__dirname, '..', '..');
  const exe = process.execPath;
  const args = app.isPackaged ? '--boot' : '"' + appDir + '" --boot';
  const work = app.isPackaged ? path.dirname(exe) : appDir;
  const icon = (app.isPackaged ? exe : path.join(appDir, 'assets', 'icon.ico')) + ',0';
  return { exe, args, work, icon };
}

function autostartOn() { return fs.existsSync(AUTOSTART_LNK); }

function autostartWrite() {
  const t = autostartTarget();
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const cmd = [
    '$s=(New-Object -ComObject WScript.Shell).CreateShortcut(' + q(AUTOSTART_LNK) + ');',
    '$s.TargetPath=' + q(t.exe) + ';',
    '$s.Arguments=' + q(t.args) + ';',
    '$s.WorkingDirectory=' + q(t.work) + ';',
    '$s.IconLocation=' + q(t.icon) + ';',
    '$s.Description=' + q('Nami Time 开机自启（删掉这个快捷方式即取消）') + ';',
    '$s.Save()'
  ].join('');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8' });
  const ok = r.status === 0 && fs.existsSync(AUTOSTART_LNK);
  note(AUTOSTART_TAG + ' 写快捷方式 ' + (ok ? '成功' : '失败') + ' → ' + AUTOSTART_LNK + (ok ? '' : ' ' + String(r.stderr || '').trim()));
  return ok;
}

function autostartRemove() {
  let ok = true;
  try { if (fs.existsSync(AUTOSTART_LNK)) fs.unlinkSync(AUTOSTART_LNK); } catch { ok = false; }
  note(AUTOSTART_TAG + ' 删快捷方式 ' + (ok ? '成功' : '失败'));
  return ok;
}

function autostartInfo() {
  const t = autostartTarget();
  return {
    on: autostartOn(),
    want: store ? store.getSetting('autostart', '1') === '1' : true,
    lnk: AUTOSTART_LNK, exe: t.exe, args: t.args, packaged: app.isPackaged
  };
}

/** 设置面板开关 + 启动对账共用：写库 + 立刻改快捷方式 */
function autostartSet(on, opt) {
  const quiet = !!(opt && opt.quiet);
  if (store) store.setSetting('autostart', on ? '1' : '0');
  const ok = on ? autostartWrite() : autostartRemove();
  if (store && on) { const t = autostartTarget(); store.setSetting('autostartCmd', t.exe + ' ' + t.args); }
  if (!quiet) note(AUTOSTART_TAG + ' 开关 → ' + (on ? '开' : '关') + (ok ? '' : '（失败）'));
  return { ...autostartInfo(), ok };
}

/** 启动对账：默认开；exe 路径变了（换便携版 / 换目录）也会自动重写 */
function autostartReconcile() {
  if (!store) return;
  if (DATA_DIR_ARG && !AUTOSTART_TEST) { note(AUTOSTART_TAG + ' QA 数据目录：跳过对账（不碰真启动文件夹）'); return; }
  const want = store.getSetting('autostart', '1') === '1';
  const t = autostartTarget();
  const cur = t.exe + ' ' + t.args;
  if (want && (!autostartOn() || store.getSetting('autostartCmd', '') !== cur)) autostartSet(true, { quiet: true });
  else if (!want && autostartOn()) autostartSet(false, { quiet: true });
}

function setPaused(on) {
  if (!collector) return false;
  const v = collector.setPaused(on);
  lastTip = '';
  refreshTrayMenu();
  broadcastState();
  note('记录' + (v ? '已暂停' : '已继续'));
  return v;
}

function broadcastState() {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send('nami:state', { ...collector.getState(), tray: !!tray }); } catch {}
}

/** 托盘常驻自检（M1 S1.6）：关窗 → 进程仍在 → 托盘重开 → 暂停/继续 → 截图 → 内存对比 */
async function runTraySelftest() {
  const R = { at: new Date().toISOString(), steps: [], mem: {} };
  const step = (k, v) => { R.steps.push({ k, v }); note('selftest ' + k + ' = ' + JSON.stringify(v)); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    step('托盘已创建', !!tray);
    const menuItems = () => {
      const m = trayMenuItems;
      return m ? m.items.map((i) => i.label).filter(Boolean) : '(空菜单)';
    };
    const menuClick = (label) => {
      try {
        const m = trayMenuItems;
        const it = m && m.items.find((i) => i.label === label);
        if (!it) return '没找到「' + label + '」';
        it.click();
        return '已点「' + label + '」';
      } catch (e) { return '点不动: ' + e.message; }
    };
    step('托盘右键菜单项', menuItems());
    step('窗口可见', !!(win && win.isVisible()));
    R.mem['窗口打开'] = totalWorkingSet();
    const before = win.getBounds();

    win.destroy();                                      // 等同于点标题栏的 ✕
    await wait(1500);
    step('关闭后窗口对象已释放', win === null);
    step('关闭后主进程仍在（还能读今天的记录）', typeof todayTotal() === 'number');
    R.mem['关窗后·常驻托盘'] = totalWorkingSet();

    showWindow();                                       // 等同于点托盘图标
    const shown = await new Promise((res) => {
      let n = 0;
      const t = setInterval(() => {
        n++;
        if (win && !win.isDestroyed() && win.isVisible()) { clearInterval(t); res(true); }
        else if (n > 60) { clearInterval(t); res(false); }
      }, 100);
    });
    step('托盘重开窗口成功', shown);
    step('重开后窗口尺寸与关闭前一致', shown ? JSON.stringify(win.getBounds()) === JSON.stringify(before) : false);
    step('重开后渲染进程已加载完', shown ? !win.webContents.isLoading() : false);
    step('菜单「打开窗口」项能点（真的走菜单回调）', menuClick('打开窗口'));
    await wait(400);
    step('点完菜单窗口仍可见', !!(win && !win.isDestroyed() && win.isVisible()));
    step('菜单「暂停记录」项能点（真的走菜单回调）', menuClick('暂停记录'));
    await wait(500);
    step('点了菜单暂停后确实暂停了', collector.stats.mode === 'paused');
    step('暂停后菜单项变成「继续记录」', menuItems().indexOf('继续记录') >= 0);
    step('菜单「继续记录」项能点（真的走菜单回调）', menuClick('继续记录'));
    await wait(500);
    step('点了菜单继续后确实恢复了', collector.stats.mode !== 'paused');
    step('继续后菜单项回到「暂停记录」', menuItems().indexOf('暂停记录') >= 0);
    R.mem['窗口重开'] = totalWorkingSet();

    await wait(1200);
    step('托盘「暂停记录」生效', setPaused(true) === true && collector.stats.mode === 'paused');
    await wait(600);
    step('托盘「继续记录」生效', setPaused(false) === false && collector.stats.mode !== 'paused');

    if (SHOT_ARG && win && !win.isDestroyed()) {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(SHOT_ARG, img.toPNG());
      step('截图已保存', SHOT_ARG);
    }
  } catch (e) {
    step('异常', String((e && e.message) || e));
  }
  try { if (TRAY_TEST_FILE) fs.writeFileSync(TRAY_TEST_FILE, JSON.stringify(R, null, 2), 'utf8'); } catch {}
  step('自检结束', true);
  quitting = true;
  app.quit();
}

/**
 * 备份自检（M5.6 主人第 6 条）：真跑一次「全量快照 + 长表 CSV + 每周概览图」，
 * 把产物逐个量出来（存在 / 大小 / 图片尺寸 / 图片不是空白 / 周键已落库 / 开关能翻）。
 */
async function runBackupSelftest() {
  const R = { at: new Date().toISOString(), pid: process.pid, dir: BACKUP_DIR, steps: [] };
  const step = (k, ok, extra) => {
    R.steps.push({ k, ok: !!ok, extra: extra === undefined ? null : extra });
    note(`[备自检] ${ok ? 'OK' : 'NG'} ${k}${extra === undefined ? '' : ' · ' + extra}`);
  };
  try {
    step('默认是开着的', backup.info().on === true);
    step('还没备份过时 last 为空', backup.info().last === null);
    const i1 = await backup.runNow('自检');
    const files = fs.readdirSync(BACKUP_DIR).map((f) => ({ name: f, bytes: fs.statSync(path.join(BACKUP_DIR, f)).size }));
    R.files = files;
    const json = files.find((f) => f.name.endsWith('.json'));
    const csv = files.find((f) => f.name.endsWith('.csv'));
    const jpg = files.find((f) => f.name.endsWith('.jpg'));
    const mtApps = files.find((f) => /^manictime-apps-.*\.csv$/.test(f.name));
    const mtUse = files.find((f) => /^manictime-usage-.*\.csv$/.test(f.name));
    step('产出 json + csv + jpg 三样', !!json && !!csv && !!jpg, files.map((f) => f.name).join(' '));
    step('json 快照有内容', !!json && json.bytes > 400, json ? json.bytes + 'B' : '-');
    step('csv 长表有内容', !!csv && csv.bytes > 80, csv ? csv.bytes + 'B' : '-');
    /* 主人第 5 条：ManicTime 兼容那份 = 两个 csv，表头必须和 Mtc.exe 导出逐字一致 */
    step('ManicTime 兼容两份都在', !!mtApps && !!mtUse,
      [mtApps && mtApps.name, mtUse && mtUse.name].filter(Boolean).join(' '));
    const headOf = (f) => (f ? fs.readFileSync(path.join(BACKUP_DIR, f.name), 'utf8').split('\r\n')[0].replace(/^\uFEFF/, '') : '');
    step('manictime-apps 表头 = Mtc.exe 的 Applications', headOf(mtApps) === 'Name,Start,End,Duration,Process', headOf(mtApps));
    step('manictime-usage 表头 = Mtc.exe 的 ComputerUsage', headOf(mtUse) === 'Name,Start,End,Duration', headOf(mtUse));
    step('概览图体积可接受（6KB~400KB）', !!jpg && jpg.bytes > 6000 && jpg.bytes < 409600, jpg ? jpg.bytes + 'B' : '-');
    const snap = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, json.name), 'utf8'));
    step('快照格式 / 版本对', snap.format === 'nami-time-backup' && snap.version === 1);
    step('快照是全量（应用 + 图标 + 逐日 + 逐段都在）',
      snap.counts.apps > 0 && snap.icons.length > 0 && snap.dayUsage.length > 0 && snap.segments.length > 0,
      JSON.stringify(snap.counts));
    const head = fs.readFileSync(path.join(BACKUP_DIR, csv.name), 'utf8').split('\r\n')[0];
    step('csv 是 BOM + 表头', head.charCodeAt(0) === 0xFEFF, JSON.stringify(head.slice(0, 22)));
    step('info 能报出文件数 / 体积', i1.files === files.length && i1.bytes > 0, i1.files + ' 个 / ' + i1.bytes + 'B');
    step('info 能报出概览图路径（界面「看概览图」要用）',
      !!(i1.image && /week-\d{4}-W\d{2}\.jpg$/.test(i1.image)), i1.image || '-');
    if (jpg) {
      const img = nativeImage.createFromPath(path.join(BACKUP_DIR, jpg.name));
      const sz = img.getSize();
      const bm = img.toBitmap();
      let sum = 0, sum2 = 0, n = 0;
      for (let i = 0; i + 3 < bm.length; i += 4 * 37) { const v = (bm[i] + bm[i + 1] + bm[i + 2]) / 3; sum += v; sum2 += v * v; n++; }
      const mean = sum / n, sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
      R.image = { w: sz.width, h: sz.height, bytes: jpg.bytes, mean: +mean.toFixed(1), sd: +sd.toFixed(1) };
      step('概览图尺寸 = 1000x620', sz.width === 1000 && sz.height === 620, sz.width + 'x' + sz.height);
      step('概览图不是空白（灰度标准差 > 8）', sd > 8, 'mean=' + mean.toFixed(1) + ' sd=' + sd.toFixed(1));
    }
    const wk = store.getSetting('lastBackupWeek', '');
    step('周键已落库（本周不会重复备）', /^\d{4}-W\d{2}$/.test(wk), wk);
    step('关掉能关', backup.setOn(false).on === false && store.getSetting('backupOn', '1') === '0');
    step('打开能开', backup.setOn(true).on === true && store.getSetting('backupOn', '1') === '1');
  } catch (e) {
    step('异常', false, String((e && e.message) || e));
  }
  R.pass = R.steps.filter((s) => s.ok).length;
  R.fail = R.steps.filter((s) => !s.ok).length;
  try { if (BACKUP_TEST) fs.writeFileSync(BACKUP_TEST, JSON.stringify(R, null, 2), 'utf8'); } catch {}
  quitting = true;
  app.quit();
}

/**
 * M8（主人第 2 号）：把 ManicTime 里的应用图标 PNG 存进图标缓存，返回内容寻址的 hash。
 * 和 icon-cache.js 同一个口径（sha256 前 16 位十六进制、文件名 <hash>.png），
 * 所以界面用 `nami-icon://<hash>` 就能直接取到，跟采集器抓的图标走完全一样的链路。
 */
function saveIconPng(png) {
  if (!png || !png.length) return null;
  const hash = crypto.createHash('sha256').update(png).digest('hex').slice(0, 16);
  fs.mkdirSync(ICON_DIR, { recursive: true });
  const file = path.join(ICON_DIR, hash + '.png');
  if (!fs.existsSync(file)) fs.writeFileSync(file, png);
  return hash;
}

/**
 * M6 / S6.2：把 ManicTime 历史一次性搬进 day_usage / day_idle。
 * —— ManicTime 全程只读（manictime.js 里 `readOnly: true`），我们是「读别人导出的数据」，不是改别人的软件。
 * —— 默认迁到「昨天」为止：今天还在被 ManicTime 记录（它同时也还在实时采集），迁今天会得到一个还在长的数字。
 * —— replace 语义：ManicTime 是历史日的权威，某天先清后写，所以可反复执行（幂等）。
 */
async function runManicTimeMigration() {
  const R = { at: new Date().toISOString(), dataDir: USER_DATA, dbPath: DB_PATH, mode: MIGRATE_MODE, naming: MIGRATE_NAMING, dryRun: !!MIGRATE_DRY };
  const say = (m) => { note('[m6] ' + m); console.log('[m6] ' + m); };
  try {
    const reports = mtMigrate.resolveReportsDb(MIGRATE_ARG);
    if (!reports) throw new Error('找不到 ManicTimeReports.db：请用 --migrate-manictime=<绝对路径> 指定');
    R.reportsDb = reports;

    const realDir = realDataDir();
    R.realDataDir = realDir;
    R.isRealDataDir = refusesRealDataDir(USER_DATA);
    if (R.isRealDataDir) throw new Error(`拒绝写入真数据目录 ${USER_DATA}（红线）：请用 --data-dir=<临时绝对路径>；确要迁真库再加 --migrate-allow-real`);
    R.until = MIGRATE_UNTIL || (MIGRATE_TODAY ? mtMigrate.dayKey() : mtMigrate.yesterdayKey());
    if (MIGRATE_UNTIL && MIGRATE_UNTIL > mtMigrate.dayKey()) throw new Error('--migrate-until 不能是未来：' + MIGRATE_UNTIL);

    const model = mtMigrate.readModel({ reportsDb: reports, since: MIGRATE_SINCE, until: R.until, naming: MIGRATE_NAMING });
    const st = model.stats;
    R.stats = st;
    say(`读到 ${st.days} 天（${st.dayList[0] || '-'} ~ ${R.until}）· ${st.appCount} 个应用 · 使用 ${(st.usageSeconds / 3600).toFixed(1)}h · 空闲 ${(st.idleSeconds / 3600).toFixed(1)}h`);
    /* M7：Applications 时间线的真实片段（→ segment）。actVsDayDelta 必须为 0：两条 SQL 求和必须相等 */
    say(`真实片段 ${st.activityRows} 条 / ${(st.activitySeconds / 3600).toFixed(1)}h（跨零点 ${st.activityCross} 条，脏行 ${st.activityBad}，范围外跳过 ${st.activityDropped}）· 与按天聚合差 ${st.actVsDayDelta}s`);
    if (st.actVsDayDelta !== 0) say('⚠ 时间线求和 ≠ 按天求和：解析可能漏行，请先别信这次迁移');
    if (st.unknownUsageNames.length) say(`⚠ 未识别的活动名（已跳过）：${st.unknownUsageNames.join(' / ')}`);
    /* M8（主人 2 号）：ManicTime 库里存了每个应用的图标（PNG），历史应用补图标就靠它 */
    say(`应用图标 ${st.iconRows} 个可读（非 PNG / 无图标 ${st.iconBadRows} 行）`);

    if (MIGRATE_DRY) {
      say('--migrate-dry-run：只读不写，结束');
    } else {
      R.import = mtMigrate.importInto(store, model, { mode: MIGRATE_MODE, log: say, saveIcon: saveIconPng });
      /* 写回读一遍：落库秒数必须和模型完全相等（replace 时），不然就是搬少了/搬多了。
         M7 修正：只统计**本次迁移窗口内的那些天**。真库里还有今天实时采集的数据，
         拿全库求和去比模型永远不等（今天那几小时不属于 ManicTime 的历史范围）。 */
      const q = store.db;
      const g = (sql) => q.prepare(sql).get();
      const lo = st.dayList[0], hi = R.until;
      R.window = { from: lo, to: hi };
      R.readback = {
        usageSeconds: g(`SELECT COALESCE(SUM(seconds),0) AS s FROM day_usage WHERE day >= '${lo}' AND day <= '${hi}'`).s,
        idleSeconds: g(`SELECT COALESCE(SUM(seconds),0) AS s FROM day_idle WHERE day >= '${lo}' AND day <= '${hi}'`).s,
        usageSecondsAll: g('SELECT COALESCE(SUM(seconds),0) AS s FROM day_usage').s,
        apps: g('SELECT COUNT(*) AS n FROM app').n,
        days: g(`SELECT COUNT(DISTINCT day) AS n FROM day_usage WHERE day >= '${lo}' AND day <= '${hi}'`).n,
        firstDay: g('SELECT MIN(day) AS d FROM day_usage').d,
        lastDay: g('SELECT MAX(day) AS d FROM day_usage').d,
        segRows: g('SELECT COUNT(*) AS n FROM segment').n
      };
      R.readbackMatchesModel = R.readback.usageSeconds === st.usageSeconds && R.readback.idleSeconds === st.idleSeconds;
      say(`回读（窗口 ${lo} ~ ${hi}）：day_usage ${R.readback.usageSeconds}s / ${R.readback.days} 天 / app ${R.readback.apps} / 全库 ${R.readback.firstDay} ~ ${R.readback.lastDay} / segment ${R.readback.segRows} 行 → ` +
          (R.readbackMatchesModel ? '与模型一致 ✅' : `不一致 ❌（模型 ${st.usageSeconds}s / ${st.idleSeconds}s）`));
      /* M7 段数据自检：窗口内 segment 秒数必须正好等于真实片段的秒数（真实起止，逐秒精确） */
      const w = R.import && R.import.segWindowFrom != null ? R.import : null;
      if (w) {
        const s = g(`SELECT COALESCE(SUM((end_ts - start_ts) / 1000),0) AS s, COUNT(*) AS n FROM segment
                     WHERE start_ts >= ${Math.round(w.segWindowFrom)} AND start_ts < ${Math.round(w.segWindowTo)}`);
        R.segReadback = { seconds: s.s, rows: s.n };
        R.segMatchesModel = Math.round(s.s) === Math.round(w.segSeconds);
        say(`回读片段：${s.n} 行 / ${(s.s / 3600).toFixed(1)}h → ` +
            (R.segMatchesModel ? '逐秒精确 ✅' : `不一致 ❌（模型 ${w.segRows} 行 / ${(w.segSeconds / 3600).toFixed(1)}h）`));
        R.ok = R.readbackMatchesModel && R.segMatchesModel;
      } else {
        R.ok = R.readbackMatchesModel;
      }
    }
    R.ok = R.ok !== false;
  } catch (e) {
    R.ok = false;
    R.error = String((e && e.message) || e);
    say('失败：' + R.error);
  }
  try { if (MIGRATE_REPORT) fs.writeFileSync(MIGRATE_REPORT, JSON.stringify(R, null, 2), 'utf8'); } catch {}
  quitting = true;
  app.quit();
}

function createWindow() {
  const sz0 = (() => { const m = /^(\d+)x(\d+)$/.exec(SIZE_ARG || ''); return m ? { width: +m[1], height: +m[2] } : null; })();
  // 锁 3:2：--size 以高度为准换算宽度（测试要量的高度别被改掉），默认走 1170×780
  const sz = sz0 ? fitWin(Math.round(sz0.height * WIN_RATIO), sz0.height) : fitWin(WIN_W0, WIN_H0);
  const ps = (() => { const m = /^(-?\d+),(-?\d+)$/.exec(POS_ARG || ''); return m ? { x: +m[1], y: +m[2] } : null; })();
  win = new BrowserWindow({
    width: sz.width, height: sz.height, minWidth: MIN_W, minHeight: MIN_H,
    ...(ps ? { x: ps.x, y: ps.y } : {}),
    frame: false, show: false, maximizable: false,
    // 可缩放：thickFrame 必须保持 false，否则 Windows 会保留一条 ~7 DIP 的非客户区，
    // 那块区域是「裸亚克力」、CSS 盖不到 —— 就是之前那圈没意义的边框（见 notes §6.1）。
    // 所以用户缩放改由渲染进程的手柄 + win.setBounds() 实现（style.css 的 .rz）。
    thickFrame: THICK_FRAME, resizable: true,
    title: 'Nami Time',
    // 第 34 轮（主人）：程序 / 任务栏图标 = 生图的机械时钟
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    backgroundMaterial: CSS_GLASS ? 'none' : 'acrylic',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // 裁剪 Electron（§6.6-4）：拼写检查、DevTools 都不用，白占一份内存与后台线程
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, devTools: DEVTOOLS,
      // 量帧率专用（第 28 轮）：窗口被挡住 / 收起时 Chromium 会停掉 rAF，探针就量不到东西。
      // 加上 --no-bg-throttle 让渲染进程即使在后台也继续出帧 —— 只给 A/B 探针用，产品默认仍然后台省电。
      ...(NO_BG_THROTTLE ? { backgroundThrottling: false } : {})
    }
  });
  win.webContents.on('console-message', (...a) => {
    const d = a[0];
    if (d && typeof d === 'object' && typeof d.message === 'string') note('renderer[' + d.level + '] ' + d.message + ' @' + (d.lineNumber || 0));
    else note('renderer[' + a[1] + '] ' + a[2] + ' @' + a[3]);
  });
  note('BrowserWindow 已创建 (acrylic=' + (() => { try { return win.getBackgroundMaterial(); } catch (e) { return 'err:' + e.message; } })() + ')');
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  win.once('ready-to-show', async () => {
    win.show();
    if (CENTER) win.center();
    // 圆角 + 去掉 DWM 亮边：必须在窗口显示后调用才生效
    globalThis.__chrome = applyRoundedChrome(win);
    if (globalThis.__chrome) note('DWM 窗角: ' + JSON.stringify(globalThis.__chrome));
    try { if (globalThis.__chrome) setWindowDark(win, resolvedTheme() === 'dark'); } catch {}
    if (ALWAYS_ON_TOP) { win.setAlwaysOnTop(true, 'screen-saver'); win.moveTop(); }
    note('窗口显示完成');
    /* 量帧率：主进程按固定间隔逼出一帧，量「绘制 + 读回」的耗时（拿列表区域，少算读回开销） */
    if (FPS_CAPTURE > 0) {
      const delayMs = Number(argValue('--fps-capture-delay') || 2500);
      const waitSec = Number(argValue('--fps-capture-wait') || 4);
      setTimeout(async () => {
        const rect = { x: 260, y: 420, width: 700, height: 300 };
        const ds = [];
        for (let i = 0; i < FPS_CAPTURE; i++) {
          const t0 = Date.now();
          try { await win.webContents.capturePage(rect); } catch (e) { note('capturePage 失败: ' + e.message); break; }
          ds.push(Date.now() - t0);
          await new Promise((r) => setTimeout(r, 12));
        }
        if (ds.length) {
          const s = [...ds].sort((a, b) => a - b);
          note(`fps-capture: n=${ds.length} avg=${(ds.reduce((a, b) => a + b, 0) / ds.length).toFixed(1)}ms p50=${s[Math.floor(s.length / 2)]}ms p95=${s[Math.floor(s.length * 0.95)]}ms max=${s[s.length - 1]}ms`);
        }
      }, waitSec * 1000);
    }
    // 首屏整理（S4.2）：窗口刚开完的十几秒里 DOM / 图层 / 字体被挨个摸过一遍，工作集冲到峰值。
    // 等它安静下来（主人 8 秒没碰键鼠）就交还系统一次 —— 之后这些页面不再被反复触摸，
    // 数字会一直停在低位，而不是挂着几百 MB 的冷缓存不放。主人一直在操作就不打扰他。
    if (!NO_HOUSEKEEPING && !MEM_SELFTEST) {
      setTimeout(() => {
        if (!win || win.isDestroyed()) return;
        const idleMs = win32probe.getIdleMs();
        if (idleMs >= 0 && idleMs >= 8000) trimWorkingSet('首屏整理');
      }, FIRST_TRIM_SEC * 1000);
    }
    if (bootHooksDone) return;      // 托盘重开的第二个窗口：不重复跑测试钩子
    bootHooksDone = true;
    if (SELFTEST_TRAY) { runTraySelftest(); return; }
    if (MEM_SELFTEST) { runMemSelftest(); return; }
    if (BACKUP_TEST) { runBackupSelftest(); return; }
    if (BOUNDS_TEST) {
      // 自绘缩放的可行性前提：thickFrame:false（无 WS_THICKFRAME）时 setBounds 仍能改尺寸
      const b0 = win.getBounds(), c0 = win.getContentBounds();
      note('bounds-test 前: outer=' + JSON.stringify(b0) + ' content=' + JSON.stringify(c0));
      win.setBounds({ width: b0.width + 80, height: b0.height + 60 });
      setTimeout(() => {
        const b1 = win.getBounds();
        note('bounds-test 后: outer=' + JSON.stringify(b1) + ' => setBounds ' +
          ((b1.width === b0.width + 80 && b1.height === b0.height + 60) ? '生效' : '未生效'));
        win.setBounds(b0);
        setTimeout(() => note('bounds-test 复位: outer=' + JSON.stringify(win.getBounds())), 350);
      }, 400);
    }
    if (SHOT_ARG || PROBE_ARG) {
      setTimeout(async () => {

        if (EXEC_ARG) {
          try {
            // exec-js 的返回值直接落盘（<脚本>.out）：界面自查脚本就不用「截图再人眼数」了
            const r = await win.webContents.executeJavaScript(require('fs').readFileSync(EXEC_ARG, 'utf8'));
            if (typeof r === 'string' && r) fs.writeFileSync(EXEC_ARG + '.out', r, 'utf8');
            else if (r && typeof r === 'object') fs.writeFileSync(EXEC_ARG + '.out', JSON.stringify(r, null, 2), 'utf8');
          } catch (e) { note('exec-js 失败: ' + e.message); }
          await new Promise((r) => setTimeout(r, 700));
        }
        if (PROBE_ARG) {
          try {
            const expr = "(() => { const sel=['.app','.titlebar','.layout','.rail','.rail-foot','.live','.main','.datenav','.segmented','#segThumb','.section-head','.card-shell','.card','.row:last-child','.footnote','#sheet','#themeSeg']; const o={vw:innerWidth,vh:innerHeight,dpr:devicePixelRatio,docH:document.documentElement.scrollHeight,bodyH:document.body.scrollHeight,rects:{}}; for(const s of sel){const e=document.querySelector(s); if(e){const r=e.getBoundingClientRect(); o.rects[s]=[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)];}} const t=getComputedStyle(document.querySelector('#segThumb')); o.thumb={w:t.width,h:t.height,radius:t.borderRadius,tx:t.getPropertyValue('--tx').trim(),bulge:t.getPropertyValue('--bulge').trim()}; o.k=getComputedStyle(document.documentElement).getPropertyValue('--k').trim(); return o; })()";
            fs.writeFileSync(PROBE_ARG, JSON.stringify(await win.webContents.executeJavaScript(expr), null, 2), 'utf8');
          } catch (e) { note('probe 失败: ' + e.message); }
        }
        if (SHOT_ARG) try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(SHOT_ARG, img.toPNG());
          note('capturePage -> ' + SHOT_ARG + ' ' + img.getSize().width + 'x' + img.getSize().height);
        } catch (e) { note('capturePage 失败: ' + e.message); }
        if (SHOT_EXIT) app.quit();
      }, SHOT_DELAY);
    }
    if (MINIMIZE_AFTER > 0) setTimeout(() => { try { win.minimize(); note('已自动最小化（内存测试）'); } catch {} }, MINIMIZE_AFTER);
    if (QUIT_AFTER > 0) setTimeout(() => { quitting = true; app.quit(); }, QUIT_AFTER * 1000);
    if (BLUR_AFTER > 0) setTimeout(() => { try { win.blur(); note('已主动失焦（内存测试）'); } catch {} }, BLUR_AFTER * 1000);
    if (READY_FILE_ARG) {
      try {
        try { globalThis.__rend = await win.webContents.executeJavaScript('({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio,sx:screenX,sy:screenY,sw:screen.width,sh:screen.height,ow:outerWidth,oh:outerHeight})'); } catch (e) { globalThis.__rend = 'err:' + e.message; }
        fs.writeFileSync(READY_FILE_ARG, JSON.stringify({
          pid: process.pid, at: Date.now(), hwaccel: !NO_HWACCEL,
          visible: win.isVisible(), alwaysOnTop: win.isAlwaysOnTop(), minimized: win.isMinimized(),
          material: acrylicSupported() ? 'acrylic' : 'none',
          bounds: win.getBounds(), gpuDisabled: ARGV.includes('--disable-gpu'), switches: ARGV,
          chrome: globalThis.__chrome || null,
          contentBounds: win.getContentBounds(),
          renderer: globalThis.__rend || null,
          log: eventLog.slice(-60),
          display: (() => { try { const d = screen.getPrimaryDisplay(); return { workAreaSize: d.workAreaSize, workArea: d.workArea, size: d.size, scaleFactor: d.scaleFactor }; } catch (e) { return 'err:' + e.message; } })()
        }, null, 2), 'utf8');
        note('已写 ready 文件: ' + READY_FILE_ARG);
      } catch (e) { note('写 ready 文件失败: ' + e.message); }
    }
  });
  win.on('closed', () => {
    win = null;
    fsOn = false;
    globalThis.__chrome = null;
    refreshTrayMenu();     // 窗口没了 = 内存掉到「常驻托盘」档，托盘提示顺便对表
    // 托盘优先的收尾（§6.6-1）：渲染进程刚销毁，等它真正退出再把闲置页交还系统
    setTimeout(() => trimWorkingSet('窗口已关闭'), 600);
  });
  // 窗口失焦（主人切去别的程序）= 这台机器上最常见的「窗口打开」形态：渲染进程已停止轮询，
  // 这时候把闲置页交还系统最划算。延迟 1.5 秒再动手，免得主人只是切了一下又马上切回来、白白多一次缺页。
  /* M8（主人 8 号）：全屏状态自己记一份。
     实测（`work/m8-qa/probe-full.js`）：这个窗口是 `frame:false` + `thickFrame:false`，进去全屏之后
     `win.isFullScreen()` 会**脱同步**报 false —— 于是「再点一次」又算成「进入全屏」，退不出来。
     所以自己维护 fsOn，并用 Electron 自己的事件校正。 */
  win.on('enter-full-screen', () => { fsOn = true; if (win && !win.isDestroyed()) win.webContents.send('nami:fullscreen', true); });
  win.on('leave-full-screen', () => { fsOn = false; if (win && !win.isDestroyed()) win.webContents.send('nami:fullscreen', false); });
  win.on('blur', () => setTimeout(() => {
    if (Date.now() - lastTrimAt < TRIM_GAP_MS) return;
    if (win && !win.isDestroyed() && win.isFocused()) return;
    trimWorkingSet('窗口失焦');
  }, 1500));
}

/**
 * 图标修复：早期版本踩了 app.getFileIcon 的坑 —— 拿不到图标时它返回的
 * 32x32「通用程序」占位图被当成了真图标存进版本链。这里开一次就把这些记录换成真图标。
 * 只认「当前生效版本 == 占位图」的行（占位图有 750B / 745B 两种编码，像素一样，
 * 所以按像素比、不按 hash 比），拿不到更好的就原样留着，绝不误伤。
 */
async function repairPlaceholderIcons() {
  const bad = await iconCache.detectPlaceholder();
  if (!bad) { note('图标修复：跳过（原生图标回退不可用）'); return; }
  // 占位图不止一种字节编码，按 hash 查会漏；把所有「当前生效」的图标拿回来逐个比像素
  const targets = store.openIcons().filter((r) => iconCache.isPlaceholderFile(r.icon_hash));
  if (!targets.length) return;
  let fixed = 0;
  const stuck = [];
  for (const r of targets) {
    if (!r.exe_path) { stuck.push(r.app_id + '(没记路径)'); continue; }
    iconCache.forget(r.exe_path);
    const h = await iconCache.ensure(r.exe_path, true).catch(() => null);
    if (!h || iconCache.isPlaceholderFile(h)) {     // exe 没了 / 确实没图标资源 → 保持原样
      const why = winIcon.lastError();
      stuck.push(r.app_id + '(' + (why ? why.message : '没换成') + ')');
      continue;
    }
    store.fixIconHash(r.app_id, r.icon_hash, r.from_day, h);
    fixed++;
  }
  note(`图标修复：${fixed}/${targets.length} 个占位图换成真图标` + (stuck.length ? ' · 没换成的：' + stuck.join('、') : ''));
}

app.whenReady().then(async () => {
  if (!HAS_LOCK) return;   // 第二份：已经在自我退出了，绝不建库 / 开窗 / 采集
  store = openStore(DB_PATH);
  if (MIGRATE_ARG) { await runManicTimeMigration(); return; }   // M6：迁移模式，不开窗口/托盘/采集
  iconCache = createIconCache({
    dir: ICON_DIR,
    getFileIcon: (p, o) => app.getFileIcon(p, o),
    readNativeIcon: (p, size) => winIcon.readIcon(p, size)   // shell 拿不到时直读 exe 图标资源
  });
  collector = createCollector({ store, iconCache, idleThresholdSec: 120, onChange: (c) => note('切换到 ' + c.exeName) });
  backup = createBackup({ store, dir: BACKUP_DIR, iconDir: ICON_DIR, log: note, appVersion: () => app.getVersion() });
  // 崩溃续写自检：清掉硬杀留下的空壳片段、把落在未来的结束时间夹回来（M1 S1.5）
  const repair = store.segRepair(Date.now());
  note(`片段自检：空壳 ${repair.dropped} · 未来时间夹回 ${repair.clamped} · 末段结束 ${repair.lastEndTs ? new Date(repair.lastEndTs).toLocaleString('zh-CN') : '无'}` +
       (store.migratedDayIdle ? ' · day_idle 已迁移到「空闲/锁屏/休眠」细分' : '') +
       (store.colorsMoved ? ` · ${store.colorsMoved} 个分类的旧紫色已换成钢蓝` : ''));
  await repairPlaceholderIcons();
  /* M8（主人 2 号）：ManicTime 迁进来的历史应用只有 exe 名 —— 没路径、没图标记录，界面只能退化成
     首字母方块。它们早就不跑了，采集器永远等不到，所以这里主动走一遍「可能有 exe 的目录树」把名字
     对得上的 exe 找回来，再走既有链路抓图标。
     找目录是慢活，默认后台跑（时间片让出事件循环，窗口秒开不受影响）；--backfill-icons 才等它跑完。 */
  iconBackfill = createIconBackfill({ store, iconCache, log: note });
  if (BACKFILL_ARG) {
    const st = await iconBackfill.run(true);
    note(`图标回填（自检）：缺 ${st.wanted} · 找到 ${st.found} 个 exe · 补上 ${st.icons} · 抓不到 ${st.failed} · ${st.ms}ms`);
    if (BACKFILL_REPORT) { try { fs.writeFileSync(BACKFILL_REPORT, JSON.stringify(st, null, 2), 'utf8'); } catch { /* 写不了就算了 */ } }
  } else {
    iconBackfill.start();
  }

  protocol.handle('nami-icon', async (req) => {
    const url = new URL(req.url);
    const hash = (url.hostname || url.pathname.replace(/^\/+/, '')).replace(/[^a-f0-9]/gi, '');
    const file = hash ? path.join(ICON_DIR, hash + '.png') : null;
    if (!file || !fs.existsSync(file)) return new Response('', { status: 404 });
    return new Response(fs.readFileSync(file), { headers: { 'content-type': 'image/png' } });
  });

  ipcMain.handle('nami:init', () => ({
    dataDir: USER_DATA, dbPath: DB_PATH, iconDir: ICON_DIR,
    theme: themeStored(), resolvedTheme: resolvedTheme(),
    glass: Number(store.getSetting('glass', '0.55')),
    icon: Number(store.getSetting('icon', '48')),
    iconLevel: store.getSetting('iconLevel', null) != null ? Number(store.getSetting('iconLevel', null)) : null,
    idleThresholdSec: 120,
    tray: !!tray,
    // M7：首次运行引导（S7.3）+ 开机自启开关（S7.2）
    onboarded: store.getSetting('onboarded', '0') === '1',
    autostart: autostartInfo(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    memTrim: memTrim.available() && !NO_TRIM,
    retreat: retreatOn,
    paused: collector.stats.paused,
    mode: collector.stats.mode,
    pid: process.pid,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    osRelease: os.release(),
    hardwareAcceleration: !NO_HWACCEL,
    material: CSS_GLASS ? 'css' : (acrylicSupported() ? 'acrylic' : 'none'),
    acrylic: acrylicSupported() && !CSS_GLASS,
    cssGlass: CSS_GLASS,
    refract: ARGV.includes('--liquid-refract'),
    mockBg: MOCK_BG,
    noFx: NO_FX,
    minSize: { w: MIN_W, h: MIN_H },
    /* M5.5：渲染进程要自己算等比缩放 + 图标随窗口缩放，比例 / 设计尺寸由主进程给唯一真相 */
    aspect: WIN_RATIO, designW: WIN_W0, designH: WIN_H0,
    winSize: win && !win.isDestroyed() ? win.getBounds() : null,
    resizable: !THICK_FRAME,
    firstDay: store.firstDay(),
    categories: store.categories(),
    rulesOn: rulesOn()
  }));

  ipcMain.handle('nami:range', (_e, { kind, anchor }) => {
    const a = anchor || dayKey();
    const r = resolveRange(kind, a);
    const iconDay = kind === 'all' ? dayKey() : r.to;
    const rows = store.topApps(r.from, r.to).map((x) => ({
      id: x.id, exeName: x.exe_name, name: x.display_name, seconds: x.seconds,
      exePath: x.exe_path_last || '',
      icon: store.iconForDay(x.id, iconDay),
      customIcon: !!store.customIcon(x.id),
      customName: x.custom_name || ''
    }));
    // M3 分类：手动优先 + 规则自动，命中结果直接挂在每一行上（前端不用自己算）
    const categories = store.categories();
    const resolved = CAT.resolve(
      rows.map((x) => ({ id: x.id, exe_name: x.exeName, exe_path_last: x.exePath, display_name: x.name })),
      store.manualPairs(), store.rules(), rulesOn());
    for (const x of rows) x.cats = [...(resolved.get(x.id) || [])];
    return {
      kind, anchor: a, from: r.from, to: r.to, rows,
      categories, catRows: CAT.rollup(rows, resolved, categories), rulesOn: rulesOn(),
      max: rows.length ? rows[0].seconds : 1,
      idle: store.idleRange(r.from, r.to),
      idleParts: store.idleByKind(r.from, r.to),
      total: rows.reduce((s, x) => s + x.seconds, 0)
    };
  });
  /* ——— M5 应用详情页（F5）：单个应用在范围内的逐日切片 ———
     全走已有索引（day_usage 主键 / segment(app_id,start_ts)），单应用查询很便宜。 */
  ipcMain.handle('nami:appDetail', (_e, { appId, kind, anchor }) => {
    const id = Number(appId);
    const app = store.appById(id);
    if (!app) return { ok: false, error: '找不到这个应用喵' };
    const k = kind || 'day';
    const a = anchor || dayKey();
    const r = resolveRange(k, a);
    const daily = store.appDaily(id, r.from, r.to);
    const series = buildDailySeries(r.from, r.to, daily, store.dailyIdle(r.from, r.to));
    /* 时段分布：窗口与柱图一致（「全部」时柱图只画最近 120 天，小时图也跟着截，
       两张图的横轴口径才不会打架） */
    const hFrom = series.days.length ? series.days[0].day : r.from;
    const hFromMs = Date.parse(hFrom + 'T00:00:00');
    const hToMs = Date.parse(r.to + 'T23:59:59.999');
    const hRows = store.appSegments(id, hFromMs, hToMs);
    const fl = store.appFirstLast(id, r.from, r.to);
    const resolved = CAT.resolve(
      [{ id: app.id, exe_name: app.exe_name, exe_path_last: app.exe_path_last, display_name: app.display_name }],
      store.manualPairs(), store.rules(), rulesOn());
    return {
      ok: true, kind: k, anchor: a, from: r.from, to: r.to, today: dayKey(),
      app: {
        id: app.id, name: app.display_name, exeName: app.exe_name, path: app.exe_path_last || '',
        firstSeenDay: app.first_seen_day, lastSeenDay: app.last_seen_day, customName: app.custom_name || ''
      },
      icon: store.iconForDay(id, k === 'all' ? dayKey() : r.to),
      customIcon: !!store.customIcon(id),
      days: series.days, clipped: series.clipped, spanDays: series.spanDays,
      hours: hourBuckets(hRows, hFromMs, hToMs),   // 24 桶（秒）= 本范围真实合计（M7 起界面不再除天数）
      hoursFrom: hFrom, hoursDays: daySpan(hFrom, r.to), hoursSegs: hRows.length,
      total: daily.reduce((s, x) => s + (x.seconds || 0), 0),
      idleParts: store.idleByKind(r.from, r.to),
      firstTs: fl.first_ts, lastTs: fl.last_ts,
      cats: [...(resolved.get(id) || [])],
      categories: store.categories(),
      manual: store.manualPairsFor(id).length > 0
    };
  });

  /* ——— M5.5 主界面「最近 N 天」概览（仿苹果「屏幕时间」主页）———
     上：逐日堆叠（应用 / 空闲 / 锁屏·休眠）+ 平均虚线
     下：24 小时按分类堆叠（跨天平均每小时），图例 = 时长最多的 3 个分类 + 其他
     只走 day_usage / day_idle 主键 + segment 的 start_ts 索引，不扫全表。 */
  ipcMain.handle('nami:overview', (_e, { anchor, days }) => {
    const n = Math.min(60, Math.max(2, Number(days) || 7));
    const a = anchor || dayKey();
    const to = a, from = addDays(a, -(n - 1));
    const series = buildDailySeries(from, to, store.dayTotals(from, to), store.dailyIdle(from, to));
    const list = series.days;
    const total = list.reduce((s, x) => s + x.sec, 0);
    const activeN = Math.max(1, list.filter((x) => x.sec > 0 || x.idle || x.lock).length);
    const avg = Math.round(total / activeN);
    const maxDay = list.reduce((m, x) => Math.max(m, x.sec + x.idle + x.lock + x.sleep), 0);

    const firstMs = Date.parse(from + 'T00:00:00'), lastMs = Date.parse(to + 'T23:59:59.999');
    const rows = store.segmentsIn(firstMs, lastMs);
    const catOf = CAT.resolve(store.allApps(), store.manualPairs(), store.rules(), rulesOn());
    const oneCatOf = (id) => {
      const s = catOf.get(id);
      if (!s || s.size !== 1) return 0;              // 没归类 / 归了多个 = 「其他」
      for (const v of s) return v;
      return 0;
    };
    /* 图例：先把窗口内的分类总时长排出来，留前 3，其余并进「其他」 */
    const catTotals = new Map();
    let otherTotal = 0;
    for (const x of store.topApps(from, to)) {
      const cid = oneCatOf(x.id);
      if (cid) catTotals.set(cid, (catTotals.get(cid) || 0) + x.seconds);
      else otherTotal += x.seconds;
    }
    const cats = store.categories();
    const ranked = [...catTotals.entries()].sort((p, q2) => q2[1] - p[1]);
    const top = ranked.slice(0, 3);
    for (const [, s] of ranked.slice(3)) otherTotal += s;
    const legend = top.map(([id, sec]) => {
      const c = cats.find((y) => y.id === id) || {};
      return { id, name: c.name || '分类', color: c.color || '#8E8E93', sec };
    });
    if (otherTotal > 0) legend.push({ id: 0, name: '其他', color: null, sec: otherTotal });
    const keep = new Set(top.map(([id]) => id));

    const perApp = new Map();
    for (const r of rows) {
      let hb = perApp.get(r.app_id);
      if (!hb) { hb = new Array(24).fill(0); perApp.set(r.app_id, hb); }
      let s = Math.max(r.start_ts, firstMs), e = Math.min(r.end_ts, lastMs);
      while (s < e) {
        const d = new Date(s);
        const next = new Date(d); next.setMinutes(60, 0, 0);
        const cut = Math.min(e, next.getTime());
        hb[d.getHours()] += (cut - s) / 1000;
        s = cut;
      }
    }
    const hm = Array.from({ length: 24 }, () => new Map());
    for (const [appId, hb] of perApp) {
      const cid = oneCatOf(appId);
      const key = (cid && keep.has(cid)) ? ('c' + cid) : 'o';
      for (let i = 0; i < 24; i++) if (hb[i] > 0.5) hm[i].set(key, (hm[i].get(key) || 0) + hb[i]);
    }
    const hours = hm.map((m) => [...m.entries()].map(([k, s]) => ({ k, s: Math.round(s) })).sort((p, q2) => q2.s - p.s));
    const hourMax = hours.reduce((m, segs) => Math.max(m, segs.reduce((s, x) => s + x.s, 0)), 0);

    return {
      ok: true, from, to, days: list, total, avg, maxDay,
      hours, hourMax, hoursDays: daySpan(from, to), legend,
      /* M9（主人 2026-10-16）：24 小时图改成「平均一天」，分母必须和 avg 的活跃天数一致 */
      activeN,
      segs: rows.length, firstDay: store.firstDay(), today: dayKey()
    };
  });

  /* ——— 分类（M3）：增删改 / 手动归类 / 规则 / 游戏模板 ——— */
  ipcMain.handle('nami:cats', () => catState());

  ipcMain.handle('nami:catSave', (_e, { id, name, color }) => {
    const nm = String(name || '').trim();
    if (!nm) return { ok: false, error: '分类名字不能空着喵' };
    const dup = store.categoryByName(nm);
    if (dup && dup.id !== id) return { ok: false, error: '已经有一个同名分类了' };
    if (id) store.categoryUpdate(id, nm, color); else store.categoryAdd(nm, color);
    return { ok: true, ...catState() };
  });

  ipcMain.handle('nami:catDelete', (_e, id) => { store.categoryDelete(id); return { ok: true, ...catState() }; });

  ipcMain.handle('nami:catAssign', (_e, { appId, categoryIds }) => {
    store.categorySetAppsFor(appId, categoryIds || []);
    return { ok: true, ...catState() };
  });

  /* M7 主人第 6 条（自定义图标）：挑一张图 → 等比缩进 48×48 → 存进图标缓存目录
     （内容寻址，和自动抓的图标同一套走法，界面还是 nami-icon://<hash> 取图）→
     写进 app_icon_custom：一条记录就覆盖这个应用的全部日期。
     自动采集永远不碰这张表，所以换 exe / 换图标都不会把它冲掉。 */
  ipcMain.handle('nami:pickIcon', async (_e, appId, srcPath) => {
    const id = Number(appId);
    const app = store.appById(id);
    if (!app) return { ok: false, error: '找不到这个应用喵' };
    /* srcPath 是自检通道（界面永远不传它）：跳过系统选图弹窗，好让 --exec-js 能把整条链路跑通 */
    let src = typeof srcPath === 'string' ? srcPath : '';
    if (!src) {
      const picked = await dialog.showOpenDialog(win, {
        title: `给「${app.display_name}」挑一张图标`,
        buttonLabel: '用这张',
        properties: ['openFile'],
        filters: [{ name: '图片 / 图标', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'ico'] }]
      });
      if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
      src = picked.filePaths[0];
    }
    let img = null;
    try { img = nativeImage.createFromPath(src); } catch { img = null; }
    if (!img || img.isEmpty()) return { ok: false, error: '这张图读不出来喵，换一张试试' };
    const sz = img.getSize();
    const k = 48 / Math.max(1, Math.max(sz.width, sz.height));
    const w = Math.max(1, Math.round(sz.width * k));
    const h = Math.max(1, Math.round(sz.height * k));
    if (w !== sz.width || h !== sz.height) img = img.resize({ width: w, height: h, quality: 'best' });
    const png = img.toPNG();
    const hash = crypto.createHash('sha256').update(png).digest('hex').slice(0, 16);
    fs.mkdirSync(ICON_DIR, { recursive: true });
    fs.writeFileSync(path.join(ICON_DIR, hash + '.png'), png);
    store.setCustomIcon(id, hash, dayKey());
    note(`自定义图标：${app.display_name}`);
    return { ok: true, appId: id, hash };
  });

  /* 恢复自动图标：删掉那条自定义记录，iconForDay 自动回落到原来的版本链 */
  ipcMain.handle('nami:clearIcon', (_e, appId) => {
    const id = Number(appId);
    const n = store.clearCustomIcon(id);
    note(`恢复自动图标：${id}`);
    return { ok: true, appId: id, cleared: n };
  });

  /* M8 主人第 9 条：自定义软件名（右键软件里那个「自定义名称…」）。
     传空名字 = 恢复自动名称（删掉覆盖表里那行）。 */
  ipcMain.handle('nami:renameApp', (_e, appId, rawName) => {
    const id = Number(appId);
    const app = store.appById(id);
    if (!app) return { ok: false, error: '找不到这个应用喵' };
    // 名字里的换行 / 制表符会把列表撑坏，统一压成空格；两端空白不要
    const name = String(rawName === null || rawName === undefined ? '' : rawName)
      .replace(/[\r\n\t]+/g, ' ').trim();
    if (!name) {
      const n = store.clearCustomName(id);
      if (collector && collector.applyCustomName) collector.applyCustomName(id, '');
      note(`恢复自动名称：${app.exe_name}`);
      return { ok: true, appId: id, name: app.display_name, custom: false, cleared: n };
    }
    if ([...name].length > 40) return { ok: false, error: '名字最多 40 个字喵' };
    store.setCustomName(id, name, dayKey());
    if (collector && collector.applyCustomName) collector.applyCustomName(id, name);
    note(`自定义名称：${app.exe_name} → ${name}`);
    return { ok: true, appId: id, name, custom: true };
  });

  ipcMain.handle('nami:ruleAdd', (_e, { categoryId, kind, pattern }) => {
    const p = String(pattern || '').trim();
    if (!p) return { ok: false, error: '规则内容不能空着喵' };
    if (!['exe', 'path', 'title'].includes(kind)) return { ok: false, error: '规则类型不对' };
    if (kind === 'title') { try { new RegExp(p); } catch { return { ok: false, error: '正则写得不对哦' }; } }
    store.ruleAdd(categoryId, kind, p, 0);
    return { ok: true, ...catState() };
  });

  ipcMain.handle('nami:ruleDelete', (_e, id) => { store.ruleDelete(id); return { ok: true, ...catState() }; });

  ipcMain.handle('nami:catRulesOn', (_e, on) => { store.setSetting('catsAuto', on ? '1' : '0'); return { ok: true, ...catState() }; });

  /** 一键启用预置「游戏」分类（S3.5）：已有就不重复建，规则补进去 */
  ipcMain.handle('nami:gameTemplate', () => {
    const t = CAT.GAME_TEMPLATE;
    let c = store.categoryByName(t.name);
    if (!c) c = store.categoryAdd(t.name, t.color);
    for (const r of t.rules) store.ruleAdd(c.id, r.kind, r.pattern, 0);
    return { ok: true, categoryId: c.id, added: t.rules.length, ...catState() };
  });

  // 日历：逐日汇总（只回传「哪一天有多少秒」，不传明细，几千天也只是一串小数字）
  ipcMain.handle('nami:days', (_e, { from, to }) => ({
    days: store.dayTotals(from, to),
    idle: store.dailyIdle(from, to),       // M5.5 左栏热力图：悬停时一起显示空闲 / 锁屏
    firstDay: store.firstDay(),
    today: dayKey()
  }));

  ipcMain.handle('nami:current', () => ({
    current: collector.stats.current,
    stats: { ...collector.stats, lastSampleMs: Number(collector.stats.lastSampleMs.toFixed(4)) },
    icons: iconCache.stats,
    state: { ...collector.getState(), tray: !!tray },
    log: eventLog.slice(-40)
  }));

  // 暂停/继续（托盘菜单主入口，UI 只是显示状态）
  ipcMain.handle('nami:setPaused', (_e, on) => setPaused(on));

  /* M7 S7.2 开机自启：设置面板那个开关（真相在 setting.autostart，快捷方式只是它的投影） */
  ipcMain.handle('nami:autostart', (_e, on) => autostartSet(!!on));
  ipcMain.handle('nami:autostartInfo', () => autostartInfo());
  /* M7 S7.3 首次运行一句话引导：点过「知道了」写库，之后再启动就不弹了 */
  ipcMain.handle('nami:onboarded', () => { store.setSetting('onboarded', '1'); return { ok: true }; });

  /* M5.6 定期备份（主人第 6 条）：开关 / 立刻备一次，都回一份可直接显示的状态 */
  ipcMain.handle('nami:backupInfo', () => backup.info());
  ipcMain.handle('nami:backup', async (_e, q) => {
    if (q && typeof q.on === 'boolean') return backup.setOn(q.on);
    return backup.runNow('手动');
  });
  /* 主人第 5 条：备份文件夹里那张每周概览图要「能直接看见」——给两个动作：
     打开备份文件夹（资源管理器）/ 直接用系统看图程序打开最新那张 jpg。 */
  ipcMain.handle('nami:backupOpen', async () => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const err = await shell.openPath(BACKUP_DIR);
    return { ok: !err, dir: BACKUP_DIR, err: err || null };
  });
  ipcMain.handle('nami:backupImage', async () => {
    const p = backup.info().image;
    if (!p) return { ok: false, err: '还没有概览图，先备一次' };
    const err = await shell.openPath(p);
    return { ok: !err, path: p, err: err || null };
  });

  // M4 内存：随时取一份自检同款快照 / 手动整理一次（设置面板与自查用）
  ipcMain.handle('nami:mem', () => ({ snapshot: memSnapshot('手动'), trim: memTrim.available() && !NO_TRIM, retreat: retreatOn }));
  ipcMain.handle('nami:trim', () => { const r = trimWorkingSet('手动'); return { ok: !!r, procs: r ? r.length : 0 }; });

  ipcMain.handle('nami:setTheme', (_e, t) => {
    if (!THEME_ARG) store.setSetting('theme', t);
    applyThemeSource(t);
    const r = resolvedTheme();
    try { if (globalThis.__chrome) setWindowDark(win, r === 'dark'); } catch {}
    return r;
  });
  ipcMain.handle('nami:setGlass', (_e, v) => {
    const k = Math.min(1, Math.max(0, Number(v) || 0));
    store.setSetting('glass', k.toFixed(3));
    return k;
  });
  // 列表图标大小（28..60px），与行高/圆角/缩进一起缩放
  ipcMain.handle('nami:setIcon', (_e, v) => {
    const px = Math.min(60, Math.max(28, Math.round(Number(v) || 48)));
    store.setSetting('icon', String(px));
    return px;
  });
  /* M5.5：图标倍率（×100，55..145）单独一个键存。像素值不再持久化 ——
     它由窗口宽 × 倍率实时算出来，所以拖窗口时图标会跟着窗口大小一起变化。 */
  ipcMain.handle('nami:setIconLevel', (_e, v) => {
    const lv = Math.min(145, Math.max(55, Math.round(Number(v) || 100)));
    store.setSetting('iconLevel', String(lv));
    return lv;
  });
  ipcMain.handle('nami:window', (_e, action) => {
    if (action === 'show') { showWindow(); return true; }
    if (!win) return false;
    if (action === 'minimize') win.minimize();
    /* 第 28 轮（主人）：后台运行 —— 和「关闭」同样是销毁渲染进程（内存最省的一刀），
       区别只在于：这条路径是主人明确表达的「我要它继续在后台记」，所以给一次托盘气泡反馈。 */
    else if (action === 'background') {
      note('界面已收进托盘，采集继续在后台跑');
      try {
        if (tray) tray.displayBalloon({ title: 'Nami Time 还在后台记录', content: '数据继续保存；双击托盘图标可以再打开界面。' });
      } catch {}
      win.destroy();
    }
    // 关闭 = 直接销毁渲染进程（不是隐藏）：这是内存最大的一刀，进程留在托盘继续记录
    else if (action === 'close') win.destroy();
    /* M8（主人 8 号）：全屏开关。回传新状态，界面据此换图标 / 提示。
       不用 win.isFullScreen() —— 这个无边框窗口上它会脱同步，见 window 创建处的注释。 */
    else if (action === 'fullscreen') {
      fsOn = !fsOn;
      win.setFullScreen(fsOn);
      return fsOn;
    }
    return true;
  });
  // 自绘缩放：thickFrame:false 时 Windows 不提供可拖拽的缩放边框，
  // 由渲染进程的边缘手柄把目标矩形发过来，这里只夹一次下限再 setBounds。
  ipcMain.handle('nami:getBounds', () => (win ? win.getBounds() : null));
  ipcMain.handle('nami:setBounds', (_e, b) => {
    if (!win || !b) return null;
    /* M8（主人 8 号）：全屏时自绘缩放手柄一律不生效，免得把窗口从全屏里拽出来 */
    if (fsOn || win.isFullScreen()) return win.getBounds();
    const cur = win.getBounds();
    const num = (v, d) => (Number.isFinite(v) ? Math.round(v) : d);
    /* M5.5：窗口锁 3:2 —— 只认宽度，高度按比例算出来，所以拖四个边 / 四个角都是等比缩放。
       这里再夹一次下限 + 工作区上限，保证「缩放中的窗口本身合法」。 */
    const want = fitWin(num(b.width, cur.width), num(b.height, cur.height), workAreaFor(cur));
    win.setBounds({
      x: num(b.x, cur.x), y: num(b.y, cur.y),
      width: want.width, height: want.height,
    });
    return win.getBounds();
  });

  applyThemeSource(themeStored());
  nativeTheme.on('updated', () => {
    if (!win) return;
    const r = resolvedTheme();
    win.webContents.send('nami:theme', r);
    try { if (globalThis.__chrome) setWindowDark(win, r === 'dark'); } catch {}
  });
  collector.start();
  note('采集器已启动 (1s 采样, 空闲阈值 120s)');
  autostartReconcile();                                 // M7 S7.2：开机自启对账（默认开，快捷方式丢了会自愈）
  if (BOOT_ARG) {
    // 开机自启这一份：只起托盘，不建窗口（省内存也免得糊脸）；第一次点托盘再建
    note('开机自启（--boot）：只起托盘，不建窗口');
    createTray();
  } else {
    createWindow();
    createTray();
  }
  if (!NO_HOUSEKEEPING) startHousekeeping();            // S4.2 空闲整理
  if (!NO_HOUSEKEEPING) backup.startAuto();             // M5.6 每周自动备份巡检
  if (!NO_RETREAT) startRetreatWatch();                 // S4.4 全屏退避

  // 锁屏 / 休眠：交给 powerMonitor，采集器只负责把这段单独记成 lock / sleep（M1 S1.2）
  powerMonitor.on('lock-screen', () => { collector.setAway('lock'); lastTip = ''; refreshTrayMenu(); broadcastState(); note('已锁屏'); });
  powerMonitor.on('unlock-screen', () => { collector.setAway(null); lastTip = ''; refreshTrayMenu(); broadcastState(); note('已解锁'); });
  powerMonitor.on('suspend', () => { collector.setAway('sleep'); lastTip = ''; refreshTrayMenu(); note('系统休眠'); });
  powerMonitor.on('resume', () => {
    collector.setAway(null); lastTip = ''; refreshTrayMenu(); broadcastState();
    note('系统唤醒：休眠时长已补记');
  });
  // 关机 / 注销：先把当前状态落盘（硬杀也没事，day_usage 是每秒增量提交的）
  powerMonitor.on('shutdown', () => { try { collector.stop(); } catch {} });

  // 有托盘就常驻：关掉窗口不再退出程序
  app.on('window-all-closed', () => { if (quitting || NO_TRAY) app.quit(); });
  app.on('before-quit', () => {
    quitting = true;
    try { collector.stop(); } catch {}
    try { store.close(); } catch {}
    try { if (tray) { tray.destroy(); tray = null; } } catch {}
    try { if (LOG_FILE) fs.writeFileSync(LOG_FILE, eventLog.join('\n'), 'utf8'); } catch {}
  });
});
