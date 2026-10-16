'use strict';
/**
 * M8 图标回填（主人 2 号）
 * ============================================================
 * 问题：从 ManicTime 迁进来的 346 个应用只有 exe 名字（`Ar_CommonGroup.Key` 里就一个 `exe;产品名`），
 * 没有路径、没有图标记录 —— 界面只能退化成首字母方块，「最常用」前几名本来有图标的软件全成了字母。
 * 采集器只认识「正在运行 / 刚跑到过的 exe」，这些历史应用早就不跑了，所以永远等不到图标。
 *
 * 做法：不去猜单个应用的安装位置，而是把「可能有 exe 的那几棵目录树」走一遍，顺手把
 * 名字对得上的 exe 收下来（一次遍历服务全部应用），拿到路径后走既有链路：
 *   iconCache.ensure(路径) → hash → store.setIcon(appId, hash, 首次出现那天)
 * 这样历史日期也能显示图标，且不是「当场抓一张塞今天」，版本链语义不变。
 *
 * 三条自我约束：
 *  1. 绝不阻塞主进程：按时间片走目录（每片 budgetMs），片与片之间让出事件循环 ——
 *     启动时窗口照样秒开，扫描在后台慢慢跑。
 *  2. 只走白名单目录 + 跳过系统/缓存目录 + 深度上限；同名 exe 多个候选时取路径最短的那个
 *     （越短越像「安装根目录」，越短越不像某个游戏里的私有副本）。
 *  3. 找到就记 exe_path_last，下次图标变了还能刷新；没找到就保留首字母兜底，不乱塞占位图。
 */
const fs = require('node:fs');
const path = require('node:path');

/** 走目录时一律不进的名字（系统目录、包缓存、依赖、临时） */
const SKIP = new Set([
  'windows', 'winsxs', 'installer', 'installshield installation information', 'driverstore',
  '$recycle.bin', 'system volume information', 'package cache', 'packages',
  'node_modules', '.git', '.svn', '.cache', 'cache', 'temp', 'tmp', 'logs', 'log',
  'resources', 'locales', 'swiftshader', 'crashpad', 'debug', 'obj', 'bin', 'lib',
  '__pycache__', 'redist', 'redistributable', 'dotnet', 'windowsapps', 'assembly',
  'microsoft', 'microsoft.net', 'windows defender', 'windows nt', 'common files'
]);

/** 可能出现「主人的应用」的目录（存在才走） */
function baseRoots() {
  const la = process.env.LOCALAPPDATA || '';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const pd = process.env.ProgramData || 'C:\\ProgramData';
  const out = [pf, pf86, pd];
  if (la) { out.push(path.join(la, 'Programs')); out.push(la); }
  if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, '..', 'Local', 'Programs'));
  return out;
}

/** Steam / 其他盘的游戏库：`<盘>:\SteamLibrary`、`<盘>:\Games`、`<盘>:\steamapps\common` */
function gameRoots() {
  const out = [];
  const vdf = [
    'C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf',
    'C:\\Program Files\\Steam\\steamapps\\libraryfolders.vdf'
  ];
  for (const f of vdf) {
    try {
      const s = fs.readFileSync(f, 'utf8');
      for (const m of s.matchAll(/"path"\s+"([^"]+)"/g)) out.push(path.join(m[1].replace(/\\\\/g, '\\'), 'steamapps', 'common'));
    } catch { /* 没装 Steam 就算了 */ }
  }
  // 别的盘上的常见库目录（只探一层，很便宜）
  for (let i = 68; i <= 90; i++) {                       // D: .. Z:
    const d = String.fromCharCode(i) + ':\\';
    try { if (!fs.existsSync(d)) continue; } catch { continue; }
    for (const sub of ['SteamLibrary\\steamapps\\common', 'steamapps\\common', 'Games', 'Steam\\steamapps\\common', 'Program Files']) {
      try { if (fs.existsSync(path.join(d, sub))) out.push(path.join(d, sub)); } catch { /* 跳过 */ }
    }
  }
  return out;
}

function createIconBackfill({ store, iconCache, log = () => {}, budgetMs = 12, maxDepth = 4, maxApps = 300 }) {
  const stats = {
    wanted: 0, scannedDirs: 0, scannedFiles: 0, found: 0, icons: 0, failed: 0,
    ms: 0, done: false, skipped: false, missing: []
  };
  let running = false;

  /** 本机当天（本地时区）—— 找 exe 是个慢活，一天最多走一遍，别每次开窗都扫 */
  function todayLocal() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /** 时间片式广度遍历：一边走目录，一边把命中 wanted 的 exe 记下来 */
  async function walk(wanted) {
    const seen = new Set();
    const roots = [...baseRoots(), ...gameRoots()]
      .filter((r) => { try { return fs.existsSync(r) && fs.statSync(r).isDirectory(); } catch { return false; } })
      .map((r) => path.resolve(r));
    const uniq = [];
    for (const r of roots) { const k = r.toLowerCase(); if (!seen.has(k)) { seen.add(k); uniq.push(r); } }
    const queue = uniq.map((p) => ({ dir: p, depth: 0 }));
    const hit = new Map();                                  // exe 小写名 -> 最短路径
    const t0 = Date.now();

    while (queue.length) {
      const slice = Date.now() + budgetMs;
      while (queue.length && Date.now() < slice) {
        const { dir, depth } = queue.shift();
        let ents;
        try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
        stats.scannedDirs++;
        for (const e of ents) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (depth + 1 > maxDepth) continue;
            const low = e.name.toLowerCase();
            if (SKIP.has(low) || low.startsWith('.')) continue;
            if (e.name.length > 1 && e.name.endsWith('$')) continue;   // 隐藏共享
            queue.push({ dir: full, depth: depth + 1 });
          } else if (e.isFile()) {
            stats.scannedFiles++;
            const low = e.name.toLowerCase();
            if (!low.endsWith('.exe')) continue;
            if (!wanted.has(low)) continue;
            const cur = hit.get(low);
            if (!cur || full.length < cur.length) hit.set(low, full);
          }
        }
      }
      await new Promise((r) => setImmediate(r));             // 让出事件循环：窗口 / 采集器不受影响
    }
    return { hit, ms: Date.now() - t0 };
  }

  async function run(force) {
    if (running) return stats;
    running = true;
    const t0 = Date.now();
    try {
      /* 找 exe 是全盘漫步（本机约 1.2s、数千目录）。一天只走一遍就够：
         历史应用不会凭空多出来，而**新**应用由采集器自己抓图标，不靠这里。
         想再走一遍（自检 / CLI）就传 force。 */
      const day = todayLocal();
      if (!force && store.getSetting('iconScanDay', null) === day) {
        stats.skipped = true;
        stats.done = true;
        stats.ms = Date.now() - t0;
        log('图标回填：今天已经找过一遍了，跳过');
        running = false;
        return stats;
      }
      const apps = store.appsMissingIcon().slice(0, maxApps);
      stats.wanted = apps.length;
      if (!apps.length) { stats.done = true; stats.ms = Date.now() - t0; running = false; return stats; }
      store.setSetting('iconScanDay', day);
      const wanted = new Set(apps.map((a) => String(a.exe_name || '').toLowerCase()).filter((s) => s.endsWith('.exe')));
      log(`图标回填：${apps.length} 个应用缺图标，开始找 exe（${wanted.size} 个名字）`);
      const { hit } = await walk(wanted);
      stats.found = hit.size;
      for (const a of apps) {
        const p = hit.get(String(a.exe_name || '').toLowerCase());
        if (!p) { stats.missing.push(a.exe_name); continue; }
        try {
          const st = await fs.promises.stat(p);
          iconCache.forget(p);
          const h = await iconCache.ensure(p, true);
          if (!h || iconCache.isPlaceholderFile(h)) { stats.failed++; stats.missing.push(a.exe_name); continue; }
          store.setIcon(a.id, h, a.first_seen_day || undefined);
          store.setAppPath(a.id, p, st.mtimeMs, st.size);
          stats.icons++;
        } catch (e) { stats.failed++; stats.missing.push(a.exe_name + '(' + (e && e.message) + ')'); }
      }
      log(`图标回填：扫 ${stats.scannedDirs} 目录 / ${stats.scannedFiles} 文件 · 找到 ${stats.found} 个 exe · 补上 ${stats.icons} 个图标` +
        (stats.failed ? ` · ${stats.failed} 个抓不到` : ''));
    } catch (e) {
      log('图标回填出错：' + (e && e.message));
    }
    stats.done = true;
    stats.ms = Date.now() - t0;
    running = false;
    return stats;
  }

  return {
    stats,
    /** 后台跑（启动时用）：不 await，也不抛 */
    start() { run().catch(() => {}); },
    /** 等它跑完（自检 / CLI 用） */
    run
  };
}

module.exports = { createIconBackfill, baseRoots, gameRoots, SKIP };
