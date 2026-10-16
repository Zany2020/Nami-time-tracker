'use strict';
/**
 * M6 ManicTime 历史迁移（一次性）
 * ————————————— 路线（有据可查，见 work/m6-migration-report.md）—————————————
 * 蓝图要求「先 C1（官方导出 Excel/CSV），对不上再 C2（只读聚合库）」。实测结论：
 *   · C1 通道可用：`Mtc.exe export ManicTime/Applications xx.csv` 能跑通（86,064 段）。
 *   · 但 C1 的 CSV 只有 `Process` 列 = ManicTime 的**产品显示名**（如 "Codex"），
 *     **没有 exe 文件名**；而 Nami Time 的业务主键是 `app.exe_name`（collector.js:153）。
 *     强行落库会把「历史」与「将来的采集」割裂成两个 app（同一个 chatgpt.exe 两行）。
 *   · 所以按 S6.4 走 C2：只读 `ManicTimeReports.db` 的 Ar_* 聚合表，从
 *     `Ar_CommonGroup.Key`（格式 `exe名;产品名`）拿回 exe 身份。
 *   · C1 导出不浪费：它作为**独立裁判**参与验收（work/m6-crosscheck.js / m6-verify.js），
 *     逐秒证明 C2 抽出的数字与官方导出完全一致。
 *
 * 红线：ManicTime 的一切只读（`readOnly: true`），绝不反编译 / 修改 / 重打包。
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { dayKey } = require('./collector.js');

/** ManicTime 数据目录的候选位置（5.x 装在 %LOCALAPPDATA%\<厂商>\ManicTime，本机是 Finkit） */
function reportsDbCandidates(env = process.env) {
  const la = env.LOCALAPPDATA || '';
  return [
    path.join(la, 'Finkit', 'ManicTime', 'ManicTimeReports.db'),
    path.join(la, 'ManicTime', 'ManicTimeReports.db'),
    path.join(la, 'ManicTimeReports.db')
  ];
}

/** 'auto' / 空 → 探测候选位置；否则当作显式路径 */
function resolveReportsDb(arg, env = process.env) {
  if (arg && arg !== 'auto') return fs.existsSync(arg) ? arg : null;
  for (const p of reportsDbCandidates(env)) if (fs.existsSync(p)) return p;
  return null;
}

/**
 * `Ar_CommonGroup.Key` = `exe名;产品名`（如 `chatgpt.exe;codex`）。
 * 取分号前那段作为 Nami Time 的 app 主键，规则（实测 404 个 type=1 的组）：
 *   ① ManicTime 的 Key **一律小写**；Nami Time 的 `app.exe_name` 是 `UNIQUE COLLATE NOCASE`（store.js:9），
 *      所以小写落库，将来采集端存 `ChatGPT.exe` 也能命中同一行，历史与实时不会劈成两个 app。
 *   ② 382 个键本来就以 `.exe;` 结尾 —— 原样保留。
 *   ③ 22 个键根本没有扩展名：`dwm` / `gameinputsvc`（真是 dwm.exe、GameInputSvc.exe，采集端
 *      `path.basename()` 拿到的是带 .exe 的），这类补 `.exe`。
 *   ④ 另一类没扩展名的是 NSIS 安装器进程：`install.tmp` / `git-2.51.2-64-bit.tmp` —— 进程映像名
 *      真的就是 `.tmp`，**不能**补 `.exe`，否则历史里会多出一批永远匹配不上的假 app。
 *      → 判据用「有没有点」而不是「是不是 .exe 结尾」，两类都能对。
 *   ⑤ 0 个键没有分号。
 */
function exeFromKey(key) {
  const s = String(key == null ? '' : key).trim();
  if (!s) return null;
  const i = s.indexOf(';');
  const raw = (i >= 0 ? s.slice(0, i) : s).trim();
  if (!raw) return null;
  const exe = raw.toLowerCase();
  return exe.includes('.') ? exe : exe + '.exe';
}

/* ————————————————— 时间工具（全部按本地时区，与 ManicTime 一致） ————————————————— */

const LOCAL_TS = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/;
function parseLocalMs(s) {
  const m = LOCAL_TS.exec(String(s == null ? '' : s));
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

/** 把 [startMs,endMs) 按本地日界切开，逐段回调 (day, seconds) —— 跨零点的段必须裁 */
function eachDaySlice(startMs, endMs, cb) {
  let cur = startMs;
  let guard = 0;
  while (cur < endMs && guard++ < 400) {
    const d = new Date(cur);
    d.setHours(24, 0, 0, 0);
    const wall = d.getTime();
    const sliceEnd = wall < endMs ? wall : endMs;
    if (sliceEnd > cur) cb(dayKey(new Date(cur)), (sliceEnd - cur) / 1000);
    if (wall >= endMs) break;
    cur = wall;
  }
}

/* ————————————————— ComputerUsage 活动 → Nami Time 的 day_idle 种类 ————————————————— */

/**
 * ComputerUsage 活动名 → Nami Time 的 day_idle.kind。
 * 注意：**报表库里存的是英文**（Active / Away / Session lock / Power off），
 * 而 `mtc export` 导出的 CSV 是中文（活跃 / 离开 / 锁定 / 关闭电源）——两套名字都要认。
 * 值 null = 活跃（不写 day_idle）；undefined（未命中）= 交给调用方当「不认识」报警。
 */
const USAGE_KIND = new Map(Object.entries({
  'active': null, '活跃': null, '使用中': null,
  'away': 'idle', '离开': 'idle', 'idle': 'idle', '空闲': 'idle',
  'session lock': 'lock', 'locked': 'lock', 'lock': 'lock', '锁定': 'lock',
  'power off': 'sleep', 'off': 'sleep', 'shutdown': 'sleep', '关闭电源': 'sleep',
  'sleep': 'sleep', 'hibernate': 'sleep', '休眠': 'sleep', '睡眠': 'sleep'
}));
const IDLE_KIND = { idle: 'idle', lock: 'lock', sleep: 'sleep' };

function usageKindOf(name) {
  const k = String(name == null ? '' : name).trim().toLowerCase();
  if (!k) return undefined;
  return USAGE_KIND.has(k) ? USAGE_KIND.get(k) : undefined;
}

/** 兼容旧名：只要空闲种类，活跃/不认识都给 null */
function idleKindOf(name) { return usageKindOf(name) || null; }

/** 读 ComputerUsage 时间线（ReportId=2）→ 每天每种空闲的秒数 */
function readIdleFromDb(db, { since, until, stats }) {
  const rows = db.prepare(`SELECT Name, StartLocalTime, EndLocalTime FROM Ar_Activity
                           WHERE ReportId = 2 ORDER BY StartLocalTime`).all();
  const out = new Map();   // day -> kind -> seconds
  const unknown = new Set();
  let activeSeconds = 0;
  for (const r of rows) {
    const kind = usageKindOf(r.Name);
    if (kind === undefined) { unknown.add(String(r.Name)); continue; }
    const a = parseLocalMs(r.StartLocalTime), b = parseLocalMs(r.EndLocalTime);
    if (a == null || b == null || b <= a) continue;
    if (kind === null) {          // 活跃：只统计总量，用来和「有应用归属的秒数」对账
      eachDaySlice(a, b, (day, sec) => {
        if (since && day < since) return;
        if (until && day > until) return;
        activeSeconds += sec;
      });
      continue;
    }
    const day0 = dayKey(new Date(a));
    if (since && day0 < since) continue;
    if (until && day0 > until) continue;
    eachDaySlice(a, b, (day, sec) => {
      if (since && day < since) return;
      if (until && day > until) return;
      if (!out.has(day)) out.set(day, new Map());
      const m = out.get(day);
      m.set(kind, (m.get(kind) || 0) + sec);
    });
  }
  if (stats) {
    stats.unknownUsageNames = [...unknown];
    stats.activeSeconds = Math.round(activeSeconds);
  }
  return out;
}

/* ————————————————— Applications 聚合表 → 天 × exe 秒数 ————————————————— */

/**
 * 读 `Ar_ApplicationByDay`（名字叫 ByDay，实测是**小时桶**：TotalSeconds 上限正好 3600，
 * 一天有多个 Hour；所以按 substr(Hour,1,10) 求和 = 当天该应用总秒数）。
 */
function readApplicationsFromDb(db, { since, until, stats }) {
  const rows = db.prepare(`
    SELECT substr(a.Hour, 1, 10) AS day, g.Key AS key, g.Name AS name, SUM(a.TotalSeconds) AS seconds
    FROM Ar_ApplicationByDay a JOIN Ar_CommonGroup g ON g.CommonId = a.CommonId
    WHERE g.ReportGroupType = 1
    GROUP BY day, a.CommonId
    ORDER BY day`).all();

  const usage = new Map();        // day -> exe -> seconds
  const nameVotes = new Map();    // exe -> Name -> seconds（取秒数最大的那个当显示名）
  const span = new Map();         // exe -> { first, last }
  let noSemicolon = 0, unknownKey = 0;

  for (const r of rows) {
    const day = String(r.day);
    if (since && day < since) continue;
    if (until && day > until) continue;
    if (!String(r.key || '').includes(';')) noSemicolon++;
    const exe = exeFromKey(r.key);
    if (!exe) { unknownKey++; continue; }
    if (!usage.has(day)) usage.set(day, new Map());
    const d = usage.get(day);
    d.set(exe, (d.get(exe) || 0) + r.seconds);
    if (!nameVotes.has(exe)) nameVotes.set(exe, new Map());
    const vote = nameVotes.get(exe);
    /* Name 是 ManicTime 定宽遗留字段，**尾部带大量空格**（实测 "Cursor                    "）→ 必须 trim，
       否则界面上每个应用名后面拖一串空白 */
    const nm = String(r.name == null ? '' : r.name).trim();
    vote.set(nm, (vote.get(nm) || 0) + r.seconds);
    const sp = span.get(exe);
    if (!sp) span.set(exe, { first: day, last: day });
    else { if (day < sp.first) sp.first = day; if (day > sp.last) sp.last = day; }
  }

  /* 显示名：一个 exe 可能在 ManicTime 里对应好几个「产品名」（Key 的第二段不同），
     取历史秒数最大的那个；同时统计冲突数量，写进报告。 */
  const apps = new Map();
  let conflicted = 0;
  for (const [exe, vote] of nameVotes) {
    const ranked = [...vote.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length > 1) conflicted++;
    apps.set(exe, { exe, displayName: ranked[0][0] || exe, altNames: ranked.slice(1).map((x) => x[0]) });
  }
  if (stats) { stats.keysWithoutSemicolon = noSemicolon; stats.badKeys = unknownKey; stats.nameConflicts = conflicted; }

  /* 汇总 */
  let usageSeconds = 0;
  for (const m of usage.values()) for (const s of m.values()) usageSeconds += s;
  return { usage, apps, span, usageSeconds };
}

/* ————————————————— 真实片段 → segment（M7 补数据 · 第 28 轮升级） ————————————————— */

/**
 * 读 `Ar_Activity` 的 Applications 时间线（ReportId=3），拿**真实起止时间**。
 *
 * ⚠️ 必须 join `CommonGroupId`（不是 `GroupId`）：
 *    第 26 轮用 `GroupId` 试过一次，得出「两个 ID 空间对不上、绝对不要用 Ar_Activity」——
 *    那个结论是错的。`Ar_Activity.GroupId` 指的是**这份报表自己的**分组表，只有
 *    14,775/86,605 行能 join 上；`Ar_Activity.CommonGroupId → Ar_CommonGroup.CommonId`
 *    是 86,605/86,605 全中，且总和与 `Ar_ApplicationByDay` 逐秒相等（6,525,846s）。
 *
 * 一条 segment = 一次真实的前台应用片段（几秒 ~ 几分钟）。跨零点的整段原样保留，
 * 消费方（main.js 的 appSegments / segmentsIn）本来就会按查询窗口裁剪。
 * 相比第 26 轮「整点桶近似」的好处：历史日的「首次 / 最后使用」时刻是真的，
 * 不再是整点边界；每日总量完全不变（已逐天逐应用对账到 0 误差）。
 */
function readActivityFromDb({ rows, exeOfKey, since, until, stats }) {
  const acts = [];                // { exe, s, e }
  let sec = 0, bad = 0, cross = 0, dropped = 0;
  for (const r of rows) {
    const exe = exeOfKey(r.key);
    const a = parseLocalMs(r.s), b = parseLocalMs(r.e);
    if (!exe || a == null || b == null || b <= a) { bad++; continue; }
    const day = dayKey(new Date(a));
    if (since && day < since) { dropped++; continue; }
    if (until && day > until) { dropped++; continue; }
    if (dayKey(new Date(b - 1)) !== day) cross++;
    acts.push({ exe, s: a, e: b });
    sec += (b - a) / 1000;
  }
  if (stats) {
    stats.activityRows = acts.length;
    stats.activitySeconds = sec;
    stats.activityCross = cross;         // 跨零点的片段数（写进报告，便于解释逐天求和的切片）
    stats.activityBad = bad;
    stats.activityDropped = dropped;     // 被 since/until 挡在外面的
  }
  return acts;
}

/* ————————————————— 读全量模型 ————————————————— */

/**
 * @param {object} o
 * @param {string} o.reportsDb   ManicTimeReports.db 绝对路径
 * @param {string} [o.since]     'YYYY-MM-DD'（含）
 * @param {string} [o.until]     'YYYY-MM-DD'（含）；默认到「昨天」，今天留给实时采集
 * @param {boolean} [o.includeToday]
 * @param {string} [o.naming]    'manictime'（默认，沿用 ManicTime 产品名）| 'exe'
 */
function readModel(o) {
  const reportsDb = o.reportsDb;
  const until = o.until || yesterdayKey(o.now || new Date());
  const since = o.since || null;
  const naming = o.naming || 'manictime';
  const stats = { reportsDb, since, until, naming, unknownUsageNames: [] };

  const db = new DatabaseSync(reportsDb, { readOnly: true });   // ← 只读，红线
  let appRes, idleMap, actRows, iconRows;
  try {
    appRes = readApplicationsFromDb(db, { since, until, stats });
    idleMap = readIdleFromDb(db, { since, until, stats });
    /* M7：Applications 时间线的原始片段（真实起止时间），下面会变成 segment。
       第 28 轮改：原来读的是 `Ar_ApplicationByDay` 的整点桶（近似），
       现在读 `Ar_Activity`（真起止）—— join 的是 CommonGroupId，见函数注释。 */
    actRows = db.prepare(`
      SELECT g.Key AS key, a.StartLocalTime AS s, a.EndLocalTime AS e
      FROM Ar_Activity a JOIN Ar_CommonGroup g ON g.CommonId = a.CommonGroupId
      WHERE a.ReportId = 3 AND g.ReportGroupType = 1
      ORDER BY a.StartLocalTime`).all();
    /* M8：应用图标（PNG blob）—— 历史应用补图标的唯一来源 */
    iconRows = db.prepare(`
      SELECT g.Key AS key, g.Icon32 AS i32, g.Icon16 AS i16
      FROM Ar_CommonGroup g WHERE g.ReportGroupType = 1`).all();
  } finally {
    try { db.close(); } catch {}
  }

  const { usage, apps, span, usageSeconds } = appRes;
  /* M8 图标：与 segment 同一个来源表，一起读出来 */
  const { icons, bad: iconBad } = readIconsFromDb(iconRows, exeFromKey);
  stats.iconRows = icons.size;
  stats.iconBadRows = iconBad;
  /* M7 补数据：真实片段 → segment 行 */
  const activities = readActivityFromDb({
    rows: actRows, exeOfKey: exeFromKey, since, until, stats
  });
  /* 自检：时间线求和必须等于按天聚合求和（两条 SQL 读的是同一批事实，不等就是解析漏了行） */
  stats.actVsDayDelta = Math.round(stats.activitySeconds || 0) - Math.round(usageSeconds || 0);
  const { displayNameFromExe } = require('./collector.js');
  const appList = [...apps.values()].map((a) => {
    const sp = span.get(a.exe) || { first: null, last: null };
    return {
      exe: a.exe,
      displayName: naming === 'exe' ? displayNameFromExe(a.exe) : a.displayName,
      manictimeName: a.displayName,
      altNames: a.altNames,
      firstDay: sp.first,
      lastDay: sp.last
    };
  }).sort((a, b) => a.exe.localeCompare(b.exe));

  /* 空闲：同一天把浮点秒四舍五入成整数 */
  const idle = new Map();
  let idleSeconds = 0;
  for (const [day, m] of idleMap) {
    const out = new Map();
    for (const [kind, sec] of m) {
      const v = Math.round(sec);
      if (v > 0) { out.set(kind, v); idleSeconds += v; }
    }
    if (out.size) idle.set(day, out);
  }

  const days = new Set([...usage.keys(), ...idle.keys()]);
  stats.days = days.size;
  stats.appCount = appList.length;
  stats.usageSeconds = usageSeconds;
  stats.idleSeconds = idleSeconds;
  stats.dayList = [...days].sort();

  return { usage, idle, apps: appList, activities, icons, stats };
}

/* ————————————————— 图标（M8 主人第 2 号） —————————————————
 * ManicTime 把每个应用的图标也存进了库里：`Ar_CommonGroup.Icon32` / `Icon16` 都是 PNG
 * （前 8 字节 89 50 4E 47 0D 0A 1A 0A）。历史应用早就不跑了，采集器永远等不到它们，
 * 这份图标是唯一可靠的来源 —— 比去磁盘上找 exe 靠谱得多（卸载了也还在）。
 */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function readIconsFromDb(iconRows, exeOfKey) {
  const icons = new Map();
  let bad = 0;
  const rows = iconRows || [];
  for (const r of rows) {
    const exe = exeOfKey(r.key);
    if (!exe) { bad++; continue; }
    const raw = r.i32 || r.i16;
    if (!raw || !raw.length) { bad++; continue; }
    const b = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    let ok = b.length > 8;
    for (let i = 0; ok && i < 8; i++) if (b[i] !== PNG_MAGIC[i]) ok = false;
    if (!ok) { bad++; continue; }                    // 不是 PNG 就丢（极少数行是别的编码）
    if (!icons.has(exe)) icons.set(exe, b);
  }
  return { icons, bad };
}

function yesterdayKey(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  return dayKey(d);
}

/* ————————————————— 落库 ————————————————— */

/**
 * 把模型写进 Nami Time 的库。
 * mode='replace'（默认）：ManicTime 是历史日的权威 —— 先把该日的 day_usage / day_idle 清掉再写，
 *                          所以可重复执行（幂等），也不会和自己的采集叠加成双倍。
 * mode='add'：累加（不会用，留着做对照实验）。
 */
function importInto(store, model, { mode = 'replace', log = () => {}, saveIcon = null } = {}) {
  const db = store.db;
  const delUsage = db.prepare('DELETE FROM day_usage WHERE day = ?');
  const delIdle = db.prepare('DELETE FROM day_idle WHERE day = ?');
  const fixSpan = db.prepare(`UPDATE app SET
      first_seen_day = MIN(COALESCE(first_seen_day, ?1), ?1),
      last_seen_day  = MAX(COALESCE(last_seen_day,  ?2), ?2)
    WHERE id = ?3`);

  const idOf = new Map();
  const res = {
    appsCreated: 0, appsReused: 0, usageRows: 0, usageSeconds: 0, idleRows: 0, idleSeconds: 0,
    segRows: 0, segSeconds: 0, segDeleted: 0, segWindowFrom: null, segWindowTo: null, days: 0, mode,
    icons: 0, iconSkipped: 0, iconFailed: 0
  };

  /* M7：segment 的替换窗口 = 本次迁移覆盖到的那些天（半开 [第一天 00:00, 最后一天次日 00:00)）。
     默认 until = 昨天，所以窗口绝不会盖到今天，实时采集的片段一条都不会被误删；
     只有显式 --migrate-include-today 才会连今天一起替换（那时本来就是「ManicTime 当权威」）。 */
  const buckets = model.activities || [];
  if (buckets.length || model.usage.size) {
    let lo = null, hi = null;
    const scan = (d) => { if (lo === null || d < lo) lo = d; if (hi === null || d > hi) hi = d; };
    for (const d of (model.stats && model.stats.dayList) || []) scan(d);
    for (const d of model.usage.keys()) scan(d);
    if (lo && hi) {
      const a = new Date(lo + 'T00:00:00');
      const b = new Date(hi + 'T00:00:00');
      b.setDate(b.getDate() + 1);
      res.segWindowFrom = a.getTime();
      res.segWindowTo = b.getTime();
    }
  }

  store.tx(() => {
    for (const a of model.apps) {
      let row = store.getAppByName(a.exe);
      if (!row) {
        row = store.insertApp({ exeName: a.exe, displayName: a.displayName, exePath: null, mtimeMs: null, size: null, day: a.firstDay });
        res.appsCreated++;
      } else {
        res.appsReused++;
      }
      idOf.set(a.exe, row.id);
      if (a.firstDay) fixSpan.run(a.firstDay, a.lastDay || a.firstDay, row.id);
    }

    /* M8（主人 2 号）：把 ManicTime 里存的应用图标补上。
       只补「现在还没有任何图标」的应用 —— 实时采集从 exe 抓的 48px 图标质量更好，绝不覆盖。
       可重复执行：iconForDay 一查就知道有没有，所以重跑不会重复写。 */
    if (saveIcon && model.icons && model.icons.size) {
      const have = new Set(store.openIcons().map((r) => r.app_id));
      for (const r of store.customIcons()) have.add(r.app_id);      // 自定义图标也算「已有」
      const firstOf = new Map(model.apps.map((a) => [a.exe, a.firstDay]));
      for (const [exe, png] of model.icons) {
        const id = idOf.get(exe);
        if (id == null) continue;
        if (have.has(id)) { res.iconSkipped++; continue; }
        try {
          const h = saveIcon(png);
          if (!h) { res.iconFailed++; continue; }
          store.setIcon(id, h, firstOf.get(exe) || dayKey(new Date()));
          res.icons++;
          have.add(id);                                   // 同一应用多行图标时只写第一条
        } catch { res.iconFailed++; }
      }
    }

    for (const [day, m] of model.usage) {
      if (mode === 'replace') delUsage.run(day);
      for (const [exe, seconds] of m) {
        const sec = Math.round(seconds);
        if (sec <= 0) continue;
        store.addUsage(day, idOf.get(exe), sec);
        res.usageRows++; res.usageSeconds += sec;
      }
      res.days++;
    }

    for (const [day, m] of model.idle) {
      if (mode === 'replace') delIdle.run(day);
      for (const [kind, seconds] of m) {
        store.addIdle(day, seconds, kind);
        res.idleRows++; res.idleSeconds += seconds;
      }
    }

    /* M7：真实片段。先清空整个替换窗口再写，保证可重复执行（幂等）。
       两端都夹进窗口：窗口边界本来就是本地零点、片段也按本地时间走，夹一次纯属防脏数据。 */
    if (mode === 'replace' && res.segWindowFrom != null) {
      res.segDeleted = store.segDeleteWindow(res.segWindowFrom, res.segWindowTo);
    }
    for (const a of buckets) {
      const appId = idOf.get(a.exe);
      if (!appId) continue;
      let s = a.s, e = a.e;
      if (res.segWindowFrom != null) {
        if (s < res.segWindowFrom) s = res.segWindowFrom;
        if (e > res.segWindowTo) e = res.segWindowTo;
      }
      if (e <= s) continue;
      store.segAdd(appId, s, e);
      res.segRows++; res.segSeconds += (e - s) / 1000;
    }
    if (res.segWindowFrom != null) {
      res.segInWindow = store.segCountWindow(res.segWindowFrom, res.segWindowTo);
    }
  });
  log(`落库：新建应用 ${res.appsCreated} / 复用 ${res.appsReused} · day_usage ${res.usageRows} 行 ${(res.usageSeconds / 3600).toFixed(1)}h · day_idle ${res.idleRows} 行 ${(res.idleSeconds / 3600).toFixed(1)}h · segment ${res.segRows} 行 ${(res.segSeconds / 3600).toFixed(1)}h（窗口内共 ${res.segInWindow == null ? '-' : res.segInWindow} 行，替换前清了 ${res.segDeleted} 行）` +
    ` · 图标 ${res.icons} 个（已有跳过 ${res.iconSkipped}，失败 ${res.iconFailed}）`);
  return res;
}

module.exports = {
  reportsDbCandidates, resolveReportsDb, exeFromKey, parseLocalMs, eachDaySlice, dayKey,
  idleKindOf, usageKindOf, readModel, importInto, yesterdayKey, IDLE_KIND,
  readActivityFromDb, readIconsFromDb
};
