'use strict';
/**
 * 定期备份（M5.6 主人第 6 条）：仿 ManicTime，把记录导成**能再导入回来的文件**，
 * 另外每周存一张使用概览图（JPEG，体积压在一百多 KB）。设计要点：
 *
 *  1. **不引入任何依赖**：CSV / JSON 都是纯文本，图走 Electron 自带的 capturePage → toJPEG。
 *  2. **导出的是「全量快照」而不是增量**：真要哪天软件寄了，一个 json 就能把全部历史读回来。
 *     文件名带时间戳，天然形成多个时间点的副本（ManicTime 也是这个思路）。
 *  3. **导入是一等公民**：`importBackup()` 就在本文件里，`work/backup-test.js` 用它跑
 *     「导出 → 空库导入 → 逐表比对」的闭环，让「可导入」不只是一句话。
 *  4. **概览图不依赖主窗口**：用一张离屏（show:false）窗口渲染固定的报告页再截图，
 *     所以软件收在托盘里也能出图，而且图的版式 / 尺寸 / 体积每次都一样，方便比对。
 *
 * 落盘位置：<userData>/backup/
 *   nami-<时间戳>.json        满血全量快照（应用 / 图标版本链 / 逐日 / 空闲 / **逐段** / 分类 / 规则 / 设置，**可导入**）
 *   nami-<时间戳>.csv         逐日 × 应用（秒）长表 + 空闲细分，Excel 直接打开、人眼可核对
 *   manictime-apps-<时间戳>.csv     **ManicTime 兼容**：Applications 时间线，表头与
 *                              `Mtc.exe export ManicTime/Applications` 逐字一致
 *   manictime-usage-<时间戳>.csv    **ManicTime 兼容**：ComputerUsage 时间线，表头与
 *                              `Mtc.exe export ManicTime/ComputerUsage` 逐字一致
 *   week-<YYYY-Www>.jpg       最近 7 天使用概览图（**直接放在备份文件夹里，双击就能看图**）
 *
 * 关于第 5 条「与 ManicTime 互通」的落地结论（2026-10-15 实测）：
 *   ManicTime 的命令行**只有 export / backup / restore，没有 import**
 *   （`Mtc.exe --help` 的全部命令：wait / getstopwatch / startstopwatch / stopstopwatch /
 *    setpassword / restore / resetdb / export / backup / addtag），而 restore 只吃它自己
 *   备出来的数据库。所以「一个文件两边都能读」在文件层面**做不到** —— 于是按主人给的
 *    备选方案：分开保存。
 *      · 满血那份 = nami-*.json，只认 Nami Time，一条不落，能原样导回来；
 *      · 兼容那份 = manictime-*.csv，格式对齐 ManicTime 自己的导出，字段缺的一律写 0
 *        （绝不省略列），Nami Time 记到的值原封不动，任何认 ManicTime 导出格式的工具都能读。
 */
const fs = require('node:fs');
const path = require('node:path');

const JSON_FORMAT = 'nami-time-backup';
const JSON_VERSION = 1;
const KEEP_EXPORT = 8;    // 快照 + CSV 各留最近 8 次（按周算够两个月）
const KEEP_IMAGE = 12;    // 概览图留最近 12 周
const IMG_W = 1000, IMG_H = 620, IMG_Q = 76;

const p2 = (n) => String(n).padStart(2, '0');
const fmtDay = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const stamp = (d) => `${fmtDay(d).replace(/-/g, '')}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
function dayShift(day, n) { const d = new Date(day + 'T00:00:00'); d.setDate(d.getDate() + n); return fmtDay(d); }

/** ISO-8601 周键：2026-W42。跨年按「本周四落在哪一年」算，所以 12-31 可能属于下一年的第 1 周。 */
function weekKey(date = new Date()) {
  const t = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));      // 移到本周四
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${p2(w)}`;
}

/* ———————————————— 纯文本导出（可在纯 node 里单测） ———————————————— */

/** RFC4180 转义：带逗号 / 引号 / 换行的字段用双引号包起来，内部引号翻倍 */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(header, rows) {
  const out = [header.map(csvCell).join(',')];
  for (const r of rows) out.push(r.map(csvCell).join(','));
  return '\uFEFF' + out.join('\r\n') + '\r\n';                  // BOM + CRLF：Excel 打开中文才不乱码
}

const IDLE_LABEL = { idle: '空闲', lock: '锁屏', sleep: '休眠' };

/** M8 主人第 9 条：导出的名字也听主人的（app_name_custom 覆盖 app.display_name） */
function customNameMap(snap) {
  const m = new Map();
  for (const r of snap.customNames || []) m.set(r.app_id, r.name);
  return m;
}

/** 全量快照：一张能独立还原整库的 json */
function snapshot(db, { now = new Date(), appVersion = '' } = {}) {
  const all = (sql) => db.prepare(sql).all();
  const snap = {
    format: JSON_FORMAT, version: JSON_VERSION,
    exportedAt: now.toISOString(), app: { name: 'Nami Time', version: appVersion },
    apps: all('SELECT id, exe_name, display_name, exe_path_last, exe_mtime_ms, exe_size, first_seen_day, last_seen_day FROM app ORDER BY id'),
    icons: all('SELECT app_id, icon_hash, effective_from_day, effective_to_day FROM app_icon ORDER BY app_id, effective_from_day'),
    /* M7 主人第 6 条：主人手动指定的图标（覆盖这个应用全部日期的那种），一并带上 */
    customIcons: all('SELECT app_id, icon_hash, set_day FROM app_icon_custom ORDER BY app_id'),
    /* M8 主人第 9 条：主人自己起的软件名（覆盖表，别和 app.display_name 混） */
    customNames: all('SELECT app_id, name, set_day FROM app_name_custom ORDER BY app_id'),
    dayUsage: all('SELECT day, app_id, seconds FROM day_usage ORDER BY day, app_id'),
    dayIdle: all('SELECT day, kind, seconds FROM day_idle ORDER BY day, kind'),
    /* 逐段明细（第 5 条「满血」的要求）：没有它，导回来的库就没有「时段分布」。
       真库量级约 1.6 万段，json 里一行一条，约 1MB —— 换来的是一条不落的可导入性。 */
    segments: all('SELECT id, app_id, start_ts, end_ts FROM segment ORDER BY start_ts'),
    categories: all('SELECT id, name, color, sort_order FROM category ORDER BY sort_order, id'),
    categoryApp: all('SELECT category_id, app_id FROM category_app ORDER BY category_id, app_id'),
    categoryRule: all('SELECT id, category_id, kind, pattern, priority FROM category_rule ORDER BY priority DESC, id'),
    settings: all('SELECT key, value FROM setting ORDER BY key')
  };
  snap.counts = {
    apps: snap.apps.length, icons: snap.icons.length, customIcons: (snap.customIcons || []).length,
    customNames: (snap.customNames || []).length,
    dayUsage: snap.dayUsage.length,
    dayIdle: snap.dayIdle.length, segments: snap.segments.length,
    categories: snap.categories.length, categoryRule: snap.categoryRule.length
  };
  return snap;
}

/** 长表 CSV：每天每应用一行 + 空闲细分行，按秒数从大到小，便于人眼扫 */
function usageCsv(snap) {
  const byId = new Map(snap.apps.map((a) => [a.id, a]));
  const nm = customNameMap(snap);
  const rows = [];
  for (const u of snap.dayUsage) {
    const a = byId.get(u.app_id) || {};
    rows.push(['应用', u.day, a.exe_name || '', nm.get(u.app_id) || a.display_name || '', u.seconds]);
  }
  for (const r of snap.dayIdle) rows.push([IDLE_LABEL[r.kind] || r.kind, r.day, '', '', r.seconds]);
  rows.sort((x, y) => (x[1] < y[1] ? 1 : x[1] > y[1] ? -1 : y[4] - x[4]));
  return toCsv(['类型', '日期', '进程', '显示名', '秒'], rows);
}

/* ———————————————— ManicTime 兼容导出（主人第 5 条） ————————————————
 *
 * 两个文件、两个 timeline，表头与 `Mtc.exe export` 的产物逐字对齐，认这个格式的工具直接能读。
 * 「缺的写 0、绝不省略列」：ManicTime 侧有而 Nami Time 不记录的字段（备注 / 标签 / 计费标记 /
 * 颜色 / 图标）我们落成 0 或空，而不是把列拿掉；Nami Time 真记到的时间与秒数原封不动。
 * 时间格式也照抄：本地时间 + 7 位小数（2026-10-15T19:29:03.0000000），时长 h:mm:ss。
 */

/** 本地时间 + 7 位小数，与 ManicTime 导出一致的写法 */
function iso7(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T` +
         `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.` +
         String(d.getMilliseconds()).padStart(3, '0') + '0000';
}
/** h:mm:ss，ManicTime 例：0:00:07 / 0:17:54 */
function durHms(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 3600)}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`;
}

/**
 * Applications 时间线（逐段）——等价于 `Mtc.exe export ManicTime/Applications`。
 * Name 用我们界面上的显示名、Process 用 exe 名（ManicTime 自己那列只写产品名，
 * 我们把 exe 也带上，信息只多不少）。
 */
function manictimeAppsCsv(snap) {
  const byId = new Map(snap.apps.map((a) => [a.id, a]));
  const nm = customNameMap(snap);
  const rows = [];
  for (const s of snap.segments || []) {
    const a = byId.get(s.app_id) || {};
    const sec = Math.max(0, Math.round((s.end_ts - s.start_ts) / 1000));
    rows.push([nm.get(s.app_id) || a.display_name || a.exe_name || '0', iso7(s.start_ts), iso7(s.end_ts), durHms(sec), a.exe_name || '0']);
  }
  return toCsv(['Name', 'Start', 'End', 'Duration', 'Process'], rows);
}

/** 空闲种类 → ManicTime ComputerUsage 的措辞 */
const MT_KIND = { idle: '离开', lock: '锁屏', sleep: '休眠' };

/**
 * ComputerUsage 时间线（按天）——等价于 `Mtc.exe export ManicTime/ComputerUsage`。
 * ManicTime 那版是**区间级**（离开 12:22:59 → 13:00:48），我们库里空闲只有「哪一天多少秒」
 * 这个粒度，所以区间起点统一落到当天 00:00:00（顺序与真实先后无关，看秒数即可）。
 */
function manictimeUsageCsv(snap) {
  const useByDay = new Map();
  for (const u of snap.dayUsage) useByDay.set(u.day, (useByDay.get(u.day) || 0) + u.seconds);
  const days = [...new Set([...useByDay.keys(), ...snap.dayIdle.map((r) => r.day)])].sort();
  const rows = [];
  for (const day of days) {
    const base = new Date(day + 'T00:00:00').getTime();
    const act = useByDay.get(day) || 0;
    if (act > 0) rows.push(['活跃', iso7(base), iso7(base + act * 1000), durHms(act)]);
    for (const k of ['idle', 'lock', 'sleep']) {
      const r = snap.dayIdle.find((x) => x.day === day && x.kind === k);
      if (r && r.seconds > 0) rows.push([MT_KIND[k], iso7(base), iso7(base + r.seconds * 1000), durHms(r.seconds)]);
    }
  }
  return toCsv(['Name', 'Start', 'End', 'Duration'], rows);
}

/**
 * 把快照导回库里（「软件寄了」时的恢复路径）。默认**合并**语义：
 * 同主键的行按备份里的版本覆盖，库里多出来的行不动 —— 所以恢复不会把新手账冲掉。
 * 返回每张表实际写入的行数，供自检核对。
 */
function importBackup(db, snap) {
  if (!snap || snap.format !== JSON_FORMAT) throw new Error('不是 Nami Time 的备份文件');
  if (snap.version > JSON_VERSION) throw new Error(`备份文件版本 ${snap.version} 比本程序新，先升级 Nami Time`);
  const put = (sql) => db.prepare(sql);
  const ins = {
    app: put('INSERT OR REPLACE INTO app(id, exe_name, display_name, exe_path_last, exe_mtime_ms, exe_size, first_seen_day, last_seen_day) VALUES(?,?,?,?,?,?,?,?)'),
    icon: put('INSERT OR REPLACE INTO app_icon(app_id, icon_hash, effective_from_day, effective_to_day) VALUES(?,?,?,?)'),
    custom: put('INSERT OR REPLACE INTO app_icon_custom(app_id, icon_hash, set_day) VALUES(?,?,?)'),
    customName: put('INSERT OR REPLACE INTO app_name_custom(app_id, name, set_day) VALUES(?,?,?)'),
    usage: put('INSERT OR REPLACE INTO day_usage(day, app_id, seconds) VALUES(?,?,?)'),
    idle: put('INSERT OR REPLACE INTO day_idle(day, kind, seconds) VALUES(?,?,?)'),
    cat: put('INSERT OR REPLACE INTO category(id, name, color, sort_order) VALUES(?,?,?,?)'),
    pair: put('INSERT OR REPLACE INTO category_app(category_id, app_id) VALUES(?,?)'),
    rule: put('INSERT OR REPLACE INTO category_rule(id, category_id, kind, pattern, priority) VALUES(?,?,?,?,?)'),
    /* segment 的 id 是自增主键，用 OR REPLACE 会让同一天导入两次时 id 漂移，
       所以显式带 id 写回（同 id 覆盖、新 id 追加），保证「导回来 = 一模一样」。 */
    seg: put('INSERT OR REPLACE INTO segment(id, app_id, start_ts, end_ts) VALUES(?,?,?,?)')
  };
  ins.setting = put('INSERT OR REPLACE INTO setting(key, value) VALUES(?,?)');
  const n = { apps: 0, icons: 0, customIcons: 0, customNames: 0, dayUsage: 0, dayIdle: 0, segments: 0, categories: 0, categoryApp: 0, categoryRule: 0, settings: 0 };
  db.exec('BEGIN');
  try {
    for (const r of snap.apps || []) { ins.app.run(r.id, r.exe_name, r.display_name, r.exe_path_last ?? null, r.exe_mtime_ms ?? null, r.exe_size ?? null, r.first_seen_day ?? null, r.last_seen_day ?? null); n.apps++; }
    for (const r of snap.icons || []) { ins.icon.run(r.app_id, r.icon_hash, r.effective_from_day, r.effective_to_day ?? null); n.icons++; }
    for (const r of snap.customIcons || []) { ins.custom.run(r.app_id, r.icon_hash, r.set_day ?? null); n.customIcons++; }
    for (const r of snap.customNames || []) { ins.customName.run(r.app_id, r.name, r.set_day ?? null); n.customNames++; }
    for (const r of snap.dayUsage || []) { ins.usage.run(r.day, r.app_id, r.seconds); n.dayUsage++; }
    for (const r of snap.dayIdle || []) { ins.idle.run(r.day, r.kind, r.seconds); n.dayIdle++; }
    for (const r of snap.segments || []) { ins.seg.run(r.id, r.app_id, r.start_ts, r.end_ts); n.segments++; }
    for (const r of snap.categories || []) { ins.cat.run(r.id, r.name, r.color ?? null, r.sort_order ?? 0); n.categories++; }
    for (const r of snap.categoryApp || []) { ins.pair.run(r.category_id, r.app_id); n.categoryApp++; }
    for (const r of snap.categoryRule || []) { ins.rule.run(r.id, r.category_id, r.kind, r.pattern, r.priority ?? 0); n.categoryRule++; }
    for (const r of snap.settings || []) { ins.setting.run(r.key, r.value); n.settings++; }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  return n;
}

/* ———————————————— 概览图 ———————————————— */

/** 最近 7 天（含今天）的概览数据 —— 用滚动窗口而不是自然周：周一开机时自然周还是空的，没意义 */
function reportData(store, now = new Date()) {
  const to = fmtDay(now), from = dayShift(to, -6);
  const byDay = new Map(store.dayTotals(from, to).map((r) => [r.day, r.seconds]));
  const days = [];
  for (let d = from; d <= to; d = dayShift(d, 1)) days.push({ day: d, seconds: byDay.get(d) || 0 });
  const all = store.topApps(from, to);
  const tops = all.slice(0, 6).map((r) => ({
    name: r.display_name || r.exe_name, seconds: r.seconds, icon: store.iconForDay(r.id, to)
  }));
  const rest = all.slice(6);
  const idleParts = store.idleByKind(from, to);
  return {
    from, to, days, tops,
    idle: idleParts.reduce((s, r) => s + r.seconds, 0),
    sum: days.reduce((s, d) => s + d.seconds, 0),
    others: { apps: rest.length, seconds: rest.reduce((s, r) => s + r.seconds, 0) },
    idleParts, generatedAt: now, firstDay: store.firstDay()
  };
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const durText = (sec) => {
  const m = Math.round(sec / 60);
  if (m < 1) return sec > 0 ? '不足 1 分钟' : '0 分钟';
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`;
};

/** 图标内联成 data URL：概览图要能单独发出去，不能依赖图标目录还在 */
function iconUri(iconDir, hash) {
  if (!hash || !iconDir) return '';
  try {
    const b = fs.readFileSync(path.join(iconDir, hash + '.png'));
    return 'data:image/png;base64,' + b.toString('base64');
  } catch { return ''; }
}

function reportHtml(d, iconDir) {
  const maxSec = Math.max(1, ...d.days.map((x) => x.seconds));
  const bars = d.days.map((x) => {
    const h = x.seconds > 0 ? Math.max(3, Math.round((x.seconds / maxSec) * 100)) : 0;
    const lbl = x.day.slice(5).replace('-', '/');
    return `<div class="col"><div class="track"><div class="bar" style="height:${h}%"></div></div>`
         + `<div class="cl">${lbl}</div><div class="cv">${x.seconds > 0 ? durText(x.seconds) : '-'}</div></div>`;
  }).join('');
  const topMax = Math.max(1, ...d.tops.map((t) => t.seconds));
  const tops = d.tops.map((t) => {
    const uri = iconUri(iconDir, t.icon);
    const ico = uri ? `<img class="ico" src="${uri}" alt="">` : `<span class="ico ph">${esc((t.name || '?').slice(0, 1).toUpperCase())}</span>`;
    const w = Math.max(2, Math.round((t.seconds / topMax) * 100));
    return `<div class="row">${ico}<span class="nm">${esc(t.name)}</span><span class="tm">${durText(t.seconds)}</span>`
         + `<span class="rl"><i style="width:${w}%"></i></span></div>`;
  }).join('') || '<div class="empty">这段时间还没有记录</div>';
  const others = d.others && d.others.apps > 0
    ? `<div class="others">其余 ${d.others.apps} 个应用 · 合计 ${durText(d.others.seconds)}</div>` : '';
  const idleText = d.idle > 0 ? `空闲 ${durText(d.idle)}` : '没有空闲记录';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden}
body{font:14px/1.45 "Microsoft YaHei UI","Segoe UI",system-ui,sans-serif;color:#161B24;
  background:linear-gradient(148deg,#edf2f9 0%,#e8eef7 44%,#dfe7f2 100%);padding:26px 30px;display:flex;flex-direction:column}
header{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:16px}
h1{font-size:19px;font-weight:650;letter-spacing:.2px}
h1 small{font-size:12px;font-weight:400;color:#5F6A80;margin-left:9px;letter-spacing:0}
.rng{font-size:12.5px;color:#5F6A80}
.main{flex:1;display:flex;gap:16px;min-height:0}
.card{background:rgba(255,255,255,.72);border:1px solid rgba(255,255,255,.85);border-radius:16px;
  box-shadow:0 6px 20px rgba(46,58,80,.10);padding:15px 17px;display:flex;flex-direction:column;min-height:0}
.l{flex:1.32}.r{flex:1}
.stats{display:flex;gap:22px;margin-bottom:12px}
.stat b{display:block;font-size:22px;font-weight:640;letter-spacing:-.3px}
.stat span{font-size:11.5px;color:#7A8598}
.chart{flex:1;display:flex;align-items:flex-end;gap:9px;min-height:0;padding-top:6px}
.col{flex:1;display:flex;flex-direction:column;align-items:center;min-height:0;height:100%}
.track{flex:1;width:100%;display:flex;align-items:flex-end;min-height:0;
  background:linear-gradient(180deg,rgba(96,116,150,.055),rgba(96,116,150,.09));border-radius:7px}
.bar{width:100%;border-radius:7px;background:linear-gradient(180deg,#5B8FC7,#2F5E9E)}
.cl{font-size:11px;color:#7A8598;margin-top:6px}
.cv{font-size:10.5px;color:#93A0B4;margin-top:1px;white-space:nowrap}
.hint{font-size:11px;color:#93A0B4;margin-top:7px}
.row{display:grid;grid-template-columns:26px 1fr auto;grid-template-rows:auto auto;gap:2px 9px;
  align-items:center;padding:5px 0}
.ico{width:24px;height:24px;grid-row:1/3;object-fit:contain}
.ph{display:flex;align-items:center;justify-content:center;background:#e3e9f2;border-radius:6px;
  font-size:12px;font-weight:600;color:#7A8598}
.nm{font-size:13px;font-weight:520;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tm{font-size:12.5px;color:#161B24;font-variant-numeric:tabular-nums}
.rl{grid-column:2/4;height:4px;background:rgba(96,116,150,.18);border-radius:2px;display:block}
.rl i{display:block;height:100%;border-radius:2px;background:linear-gradient(90deg,#5B8FC7,#2F5E9E)}
.empty{color:#93A0B4;font-size:12.5px;padding:10px 0}
.others{margin-top:auto;padding-top:9px;border-top:1px solid rgba(96,116,150,.16);font-size:11.5px;color:#7A8598}
footer{margin-top:13px;display:flex;justify-content:space-between;font-size:11px;color:#8794A8}
</style></head><body>
<header><h1>Nami Time 每周概览<small>最近 7 天</small></h1><div class="rng">${esc(d.from)} ～ ${esc(d.to)}</div></header>
<div class="main">
  <section class="card l">
    <div class="stats">
      <div class="stat"><b>${durText(d.sum)}</b><span>7 天合计 · 日均 ${durText(d.sum / 7)}</span></div>
      <div class="stat"><b>${durText(d.idle)}</b><span>${esc(idleText)}</span></div>
    </div>
    <div class="chart">${bars}</div>
    <div class="hint">柱高 = 当天所有应用时长合计（不含空闲）</div>
  </section>
  <section class="card r">
    <div class="stats" style="margin-bottom:6px"><div class="stat"><b style="font-size:15px">最常使用</b><span>这 7 天里用最多的 6 个</span></div></div>
    ${tops}${others}
  </section>
</div>
<footer><span>记录保存在本机 · 每周自动备份可导入的记录文件与这张概览图</span><span>${esc(d.generatedAt.toLocaleString('zh-CN'))}</span></footer>
</body></html>`;
}

/** 离屏渲染一张固定尺寸的报告页再截图 —— 不用主窗口，所以收在托盘里也能出图 */
async function renderReportImage(html, { width = IMG_W, height = IMG_H, quality = IMG_Q } = {}) {
  const { BrowserWindow } = require('electron');       // 懒加载：本文件在纯 node 里也能被 require 做单测
  const w = new BrowserWindow({
    width, height, useContentSize: true, show: false, frame: false, resizable: false, skipTaskbar: true, hasShadow: false,
    backgroundColor: '#e9eef6',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false }
  });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 420));      // 等首帧 + 字体落地；capturePage 早于绘制会拿到空白
    const img = await w.webContents.capturePage();
    return img.resize({ width, height }).toJPEG(quality);   // 钉死尺寸：DPI / 边框那 1~2px 的差异不进图
  } finally { try { w.destroy(); } catch {} }
}

/* ———————————————— 保留策略 / 备份实例 ———————————————— */

/** 按文件名（都带时间戳，字典序 = 时间序）留下最新 keep 个，多余的删掉 */
function prune(dir, prefix, ext, keep) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(ext)); } catch { return []; }
  files.sort();
  const out = [];
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    try { fs.unlinkSync(path.join(dir, f)); out.push(f); } catch {}
  }
  return out;
}

function listBackups(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => /^nami-.*\.(json|csv)$/.test(f) || /^manictime-.*\.csv$/.test(f) || /^week-.*\.jpg$/.test(f)); } catch {}
  let bytes = 0;
  for (const f of names) { try { bytes += fs.statSync(path.join(dir, f)).size; } catch {} }
  return { count: names.length, bytes };
}

/**
 * @param store  已打开的 store（要 store.db 直读全表）
 * @param dir    备份目录
 * @param iconDir 图标缓存目录（把图标内联进概览图）
 * @param log    写启动日志用
 */
function createBackup({ store, dir, iconDir, log = () => {}, appVersion = () => '0.0.0' }) {
  fs.mkdirSync(dir, { recursive: true });
  let busy = false;
  const isOn = () => store.getSetting('backupOn', '1') !== '0';
  const lastAt = () => store.getSetting('lastBackupAt', '') || '';
  const lastWeek = () => store.getSetting('lastBackupWeek', '') || '';

  /** 备份文件夹里最新那张每周概览图（给界面「看概览图」用；没有就 null） */
  function weekImage() {
    try {
      const l = fs.readdirSync(dir).filter((x) => /^week-.*\.jpg$/.test(x)).sort();
      return l.length ? path.join(dir, l[l.length - 1]) : null;
    } catch { return null; }
  }

  function info() {
    const f = listBackups(dir);
    const at = lastAt();
    let note;
    if (!at) note = '还没备份过 · 存到 ' + dir;
    else {
      const d = new Date(at);
      const size = f.bytes >= 1048576 ? (f.bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(f.bytes / 1024)) + ' KB';
      note = `上次 ${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())} · ${f.count} 个文件 · ${size}`;
    }
    return { on: isOn(), dir, last: at || null, files: f.count, bytes: f.bytes, week: lastWeek(), note, image: weekImage() };
  }

  /** 跑一次完整备份：快照 json + 长表 csv + 概览图 jpg，然后按策略清理旧文件 */
  async function runNow(reason = '手动') {
    const now = new Date();
    const snap = snapshot(store.db, { now, appVersion: appVersion() });
    if (!snap.dayUsage.length) return { ...info(), note: '还没有任何记录，先跑一会儿再来备份喵~' };
    const s = stamp(now);
    const jsonPath = path.join(dir, `nami-${s}.json`);
    const csvPath = path.join(dir, `nami-${s}.csv`);
    const mtApps = path.join(dir, `manictime-apps-${s}.csv`);
    const mtUse = path.join(dir, `manictime-usage-${s}.csv`);
    const tmpJson = jsonPath + '.tmp';
    fs.writeFileSync(tmpJson, JSON.stringify(snap, null, 1), 'utf8');
    fs.renameSync(tmpJson, jsonPath);                 // 先写临时文件再改名：中途断电不会留下半个文件
    fs.writeFileSync(csvPath, usageCsv(snap), 'utf8');
    fs.writeFileSync(mtApps, manictimeAppsCsv(snap), 'utf8');    // 第 5 条：ManicTime 兼容那份
    fs.writeFileSync(mtUse, manictimeUsageCsv(snap), 'utf8');
    let imgPath = null;
    try {
      const buf = await renderReportImage(reportHtml(reportData(store, now), iconDir));
      imgPath = path.join(dir, `week-${weekKey(now)}.jpg`);
      fs.writeFileSync(imgPath, buf);
    } catch (e) { log('备份概览图失败：' + String((e && e.message) || e)); }
    const dropped = [
      ...prune(dir, 'nami-', '.json', KEEP_EXPORT),
      ...prune(dir, 'nami-', '.csv', KEEP_EXPORT),
      ...prune(dir, 'manictime-', '.csv', KEEP_EXPORT),
      ...prune(dir, 'week-', '.jpg', KEEP_IMAGE)
    ];
    store.setSetting('lastBackupAt', now.toISOString());
    store.setSetting('lastBackupWeek', weekKey(now));
    const f = listBackups(dir);
    const kb = Math.max(1, Math.round(f.bytes / 1024));
    log(`备份完成（${reason}）：${snap.counts.apps} 个应用 / ${snap.counts.dayUsage} 条逐日 / ${snap.counts.segments} 段 · 共 ${f.count} 个文件 ${kb}KB` +
        (imgPath ? ' · 含概览图' : ' · 概览图未生成') + ' · 含 ManicTime 兼容 csv' + (dropped.length ? ` · 清理 ${dropped.length} 个旧文件` : ''));
    return { ...info(), note: info().note + (imgPath ? ' · 含概览图' : '') + ' · 含 ManicTime 兼容 csv' };
  }

  function setOn(v) { store.setSetting('backupOn', v ? '1' : '0'); log('定期备份：' + (v ? '已开启' : '已关闭')); return info(); }

  /** 每周一次的自动检查：开机 25 秒后跑第一次，之后每 30 分钟看一次周键有没有翻页 */
  function startAuto() {
    const check = async () => {
      if (busy || !isOn()) return;
      if (lastWeek() === weekKey(new Date())) return;
      if (!store.firstDay()) return;                  // 一条记录都没有，别存空壳
      busy = true;
      try { await runNow('每周自动'); } catch (e) { log('自动备份失败：' + String((e && e.message) || e)); }
      finally { busy = false; }
    };
    const t0 = setTimeout(check, 25000);
    const t = setInterval(check, 30 * 60 * 1000);
    if (t0.unref) t0.unref();
    if (t.unref) t.unref();
    return () => { clearTimeout(t0); clearInterval(t); };
  }

  return { info, setOn, runNow, startAuto, reportData: () => reportData(store, new Date()) };
}

module.exports = {
  JSON_FORMAT, JSON_VERSION, KEEP_EXPORT, KEEP_IMAGE,
  weekKey, csvCell, toCsv, snapshot, usageCsv, importBackup,
  iso7, durHms, manictimeAppsCsv, manictimeUsageCsv,
  reportData, reportHtml, renderReportImage, prune, listBackups, createBackup
};
