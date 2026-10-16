'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app(
  id INTEGER PRIMARY KEY,
  exe_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  exe_path_last TEXT,
  exe_mtime_ms INTEGER,
  exe_size INTEGER,
  first_seen_day TEXT,
  last_seen_day TEXT
);
CREATE TABLE IF NOT EXISTS app_icon(
  app_id INTEGER NOT NULL,
  icon_hash TEXT NOT NULL,
  effective_from_day TEXT NOT NULL,
  effective_to_day TEXT,
  PRIMARY KEY(app_id, icon_hash, effective_from_day)
);
CREATE TABLE IF NOT EXISTS day_usage(
  day TEXT NOT NULL,
  app_id INTEGER NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day, app_id)
);
-- 空闲细分（M1）：同一天可以有 idle / lock / sleep 三行，界面里仍合并成一整行显示
CREATE TABLE IF NOT EXISTS day_idle(
  day TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'idle',
  seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day, kind)
);
-- 原始片段（秒精度）：段合并 + 后续「应用详情页」用；查询层永不扫它（蓝图 §6.3）
CREATE TABLE IF NOT EXISTS segment(
  id INTEGER PRIMARY KEY,
  app_id INTEGER NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS segment_app_start ON segment(app_id, start_ts);
CREATE INDEX IF NOT EXISTS segment_start ON segment(start_ts);
CREATE TABLE IF NOT EXISTS setting(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS category(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT, sort_order INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS category_app(category_id INTEGER NOT NULL, app_id INTEGER NOT NULL, PRIMARY KEY(category_id, app_id));
-- 自动归类规则（M3 · S3.3）：kind = exe | path | title；priority 大的先匹配
CREATE TABLE IF NOT EXISTS category_rule(
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  pattern TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS category_rule_cat ON category_rule(category_id);
-- M7 主人第 6 条（自定义图标）：一行 = 这个应用的全部日期都改用这张图。
-- 单独开一张表而不是塞进 app_icon 版本链：自动采集永远不该覆盖主人手动指定的图。
CREATE TABLE IF NOT EXISTS app_icon_custom(
  app_id INTEGER PRIMARY KEY,
  icon_hash TEXT NOT NULL,
  set_day TEXT
);
-- M8 主人第 9 条（右键改软件名）：一行 = 这个应用以后都叫这个名字。
-- 同样不覆盖 app.display_name：那列是「自动认出来的名字」（采集器写入 / ManicTime 迁移写入），
-- 留着它才能「恢复自动名称」，也不会跟采集器打架。读取时一律用 COALESCE(自定义, 自动)。
CREATE TABLE IF NOT EXISTS app_name_custom(
  app_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  set_day TEXT
);
`;

function prevDay(day) {
  const d = new Date(day + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 迁移：day_idle 从「一天一行」升级为「一天 × 种类一行」（M1 空闲/锁屏/休眠细分）。
 * 老库里的既有秒数一律归为 idle，不丢数据。
 */
function migrateDayIdle(db) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('day_idle')").all().map((r) => r.name);
  if (cols.includes('kind')) return false;
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE day_idle RENAME TO day_idle_old');
    db.exec(`CREATE TABLE day_idle(
      day TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'idle', seconds INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(day, kind))`);
    db.exec("INSERT OR IGNORE INTO day_idle(day, kind, seconds) SELECT day, 'idle', seconds FROM day_idle_old");
    db.exec('DROP TABLE day_idle_old');
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  return true;
}

/**
 * 迁移：M7（主人 2 号）换肤。
 * 老库里的分类颜色是**建表时**抄下来的，代码换了调色板它不会跟着变 —— 于是界面上
 * 还留着旧的紫 / 品紫柱子，看着跟「老气」的旧版一样。这里把两个旧紫一次性挪到新钢蓝。
 * 幂等：映射不到的、已经换过的都不会被碰。
 */
const COLOR_MOVE = [['#8B5CF6', '#4C7BB5'], ['#BF5AF2', '#5B8FC7']];
function migrateColors(db) {
  const up = db.prepare('UPDATE category SET color=? WHERE color=?');
  let n = 0;
  for (const [from, to] of COLOR_MOVE) n += up.run(to, from).changes;
  return n;
}

/**
 * M8（主人 9 号）：读出来的那一行，名字一律以自定义为准。
 * SQL 只负责把 app_name_custom.name 取成 custom_name，这里统一「改名」，
 * 好让 main.js / 界面所有消费点不用各自记得这件事。
 */
function withCustomName(row) {
  if (!row) return row;
  const c = row.custom_name;
  return (c === null || c === undefined || c === '') ? row : { ...row, display_name: c };
}

function openStore(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  const migrated = migrateDayIdle(db);
  const colorsMoved = migrateColors(db);

  const q = {
    appByName: db.prepare(`SELECT a.*, n.name AS custom_name FROM app a
                           LEFT JOIN app_name_custom n ON n.app_id = a.id WHERE a.exe_name = ?`),
    insertApp: db.prepare(`INSERT INTO app(exe_name, display_name, exe_path_last, exe_mtime_ms, exe_size, first_seen_day, last_seen_day)
                           VALUES(?,?,?,?,?,?,?)`),
    touchApp: db.prepare('UPDATE app SET exe_path_last=?, exe_mtime_ms=?, exe_size=?, last_seen_day=? WHERE id=?'),
    lastSeen: db.prepare('UPDATE app SET last_seen_day=? WHERE id=?'),
    openIcon: db.prepare('SELECT icon_hash, effective_from_day FROM app_icon WHERE app_id=? AND effective_to_day IS NULL ORDER BY effective_from_day DESC LIMIT 1'),
    closeIcon: db.prepare('UPDATE app_icon SET effective_to_day=? WHERE app_id=? AND icon_hash=? AND effective_from_day=?'),
    dropIcon: db.prepare('DELETE FROM app_icon WHERE app_id=? AND icon_hash=? AND effective_from_day=?'),
    insIcon: db.prepare('INSERT OR REPLACE INTO app_icon(app_id, icon_hash, effective_from_day, effective_to_day) VALUES(?,?,?,NULL)'),
    iconForDay: db.prepare(`SELECT icon_hash FROM app_icon
                            WHERE app_id=? AND effective_from_day<=? AND (effective_to_day IS NULL OR effective_to_day>=?)
                            ORDER BY effective_from_day DESC LIMIT 1`),
    /* M5.6 图标兜底（主人 4 号）：① 那天或之前最后一次换的图标（补区间空洞）
       ② 有史以来最早的一张（补「那天比所有图标记录都早」） */
    iconAtOrBefore: db.prepare(`SELECT icon_hash FROM app_icon WHERE app_id=? AND effective_from_day<=?
                                ORDER BY effective_from_day DESC LIMIT 1`),
    iconEarliest: db.prepare('SELECT icon_hash FROM app_icon WHERE app_id=? ORDER BY effective_from_day ASC LIMIT 1'),
    openIconApps: db.prepare(`SELECT a.id AS app_id, a.exe_path_last AS exe_path, i.effective_from_day AS from_day
                              FROM app_icon i JOIN app a ON a.id = i.app_id
                              WHERE i.effective_to_day IS NULL AND i.icon_hash = ?`),
    openIconsAll: db.prepare(`SELECT a.id AS app_id, a.exe_path_last AS exe_path, i.icon_hash AS icon_hash, i.effective_from_day AS from_day
                              FROM app_icon i JOIN app a ON a.id = i.app_id
                              WHERE i.effective_to_day IS NULL`),
    fixIconHash: db.prepare('UPDATE app_icon SET icon_hash=? WHERE app_id=? AND icon_hash=? AND effective_from_day=?'),
    /* M7 主人第 6 条（自定义图标） */
    customIconGet: db.prepare('SELECT icon_hash, set_day FROM app_icon_custom WHERE app_id=?'),
    customIconAll: db.prepare('SELECT app_id, icon_hash, set_day FROM app_icon_custom ORDER BY app_id'),
    customIconSet: db.prepare('INSERT OR REPLACE INTO app_icon_custom(app_id, icon_hash, set_day) VALUES(?,?,?)'),
    customIconDel: db.prepare('DELETE FROM app_icon_custom WHERE app_id=?'),
    /* M8 主人第 9 条：自定义软件名（覆盖表，见 SCHEMA 里的说明） */
    nameGet: db.prepare('SELECT name, set_day FROM app_name_custom WHERE app_id=?'),
    nameAll: db.prepare('SELECT app_id, name, set_day FROM app_name_custom'),
    nameSet: db.prepare('INSERT OR REPLACE INTO app_name_custom(app_id, name, set_day) VALUES(?,?,?)'),
    nameDel: db.prepare('DELETE FROM app_name_custom WHERE app_id=?'),
    /* M8 主人第 2 号（历史应用图标回填）：从 ManicTime 迁进来的应用只有 exe 名，没有路径也没有
       图标记录 —— 它们早就不跑了，采集器永远等不到；回填器要的是「谁还缺图标」这份名单。 */
    appsNoIcon: db.prepare(`SELECT a.id, a.exe_name, a.display_name, a.exe_path_last, a.first_seen_day,
                                   COALESCE((SELECT SUM(seconds) FROM day_usage u WHERE u.app_id = a.id), 0) AS seconds
                            FROM app a
                            WHERE a.exe_name IS NOT NULL AND a.exe_name <> ''
                              AND NOT EXISTS (SELECT 1 FROM app_icon i WHERE i.app_id = a.id)
                              AND NOT EXISTS (SELECT 1 FROM app_icon_custom c WHERE c.app_id = a.id)
                            ORDER BY seconds DESC`),
    setAppPath: db.prepare('UPDATE app SET exe_path_last=?, exe_mtime_ms=?, exe_size=? WHERE id=?'),
    addUsage: db.prepare(`INSERT INTO day_usage(day, app_id, seconds) VALUES(?,?,?)
                          ON CONFLICT(day, app_id) DO UPDATE SET seconds = seconds + excluded.seconds`),
    addIdle: db.prepare(`INSERT INTO day_idle(day, kind, seconds) VALUES(?,?,?)
                         ON CONFLICT(day, kind) DO UPDATE SET seconds = seconds + excluded.seconds`),
    topApps: db.prepare(`SELECT a.id, a.exe_name, a.display_name, a.exe_path_last, n.name AS custom_name, SUM(u.seconds) AS seconds
                         FROM day_usage u JOIN app a ON a.id = u.app_id
                         LEFT JOIN app_name_custom n ON n.app_id = a.id
                         WHERE u.day BETWEEN ? AND ?
                         GROUP BY a.id ORDER BY seconds DESC`),
    idleRange: db.prepare('SELECT COALESCE(SUM(seconds),0) AS s FROM day_idle WHERE day BETWEEN ? AND ?'),
    idleByKind: db.prepare(`SELECT kind, SUM(seconds) AS seconds FROM day_idle
                            WHERE day BETWEEN ? AND ? GROUP BY kind ORDER BY seconds DESC`),
    dayTotals: db.prepare(`SELECT day, SUM(seconds) AS seconds FROM day_usage
                           WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day`),
    segInsert: db.prepare('INSERT INTO segment(app_id, start_ts, end_ts) VALUES(?,?,?)'),
    segExtend: db.prepare('UPDATE segment SET end_ts=? WHERE id=?'),
    segDelete: db.prepare('DELETE FROM segment WHERE id=?'),
    segRecent: db.prepare(`SELECT * FROM segment WHERE app_id=? AND end_ts>=? AND end_ts<=?
                           ORDER BY end_ts DESC LIMIT 1`),
    segZero: db.prepare('DELETE FROM segment WHERE end_ts <= start_ts'),
    segClamp: db.prepare('UPDATE segment SET end_ts=? WHERE end_ts > ?'),
    segLastEnd: db.prepare('SELECT MAX(end_ts) AS t FROM segment'),
    /* ——— M5.5 时段分布：按「时间窗口」切 segment。走 start_ts 索引，窗口越窄扫得越少 ——— */
    segRangeTs: db.prepare('SELECT app_id, start_ts, end_ts FROM segment WHERE start_ts<=? AND end_ts>=? ORDER BY start_ts'),
    segAppTs: db.prepare('SELECT start_ts, end_ts FROM segment WHERE app_id=? AND start_ts<=? AND end_ts>=? ORDER BY start_ts'),
    /* ——— M7 迁移补数据：把 ManicTime 的逐小时用量写成 segment，历史日也就有「时段分布」了 ———
       只按 [from,to) 的半开窗口整段替换，绝不碰窗口外的实时采集片段。 */
    segDeleteWin: db.prepare('DELETE FROM segment WHERE start_ts >= ? AND start_ts < ?'),
    segCountWin: db.prepare('SELECT COUNT(*) AS n FROM segment WHERE start_ts >= ? AND start_ts < ?'),
    appsAll: db.prepare(`SELECT a.id, a.exe_name, a.display_name, a.exe_path_last, n.name AS custom_name
                         FROM app a LEFT JOIN app_name_custom n ON n.app_id = a.id`),
    firstDay: db.prepare('SELECT MIN(day) AS d FROM day_usage'),
    /* ——— M5 应用详情页：单应用切片，全部走索引 / 主键，永不扫全表 ——— */
    appById: db.prepare(`SELECT a.*, n.name AS custom_name FROM app a
                         LEFT JOIN app_name_custom n ON n.app_id = a.id WHERE a.id=?`),
    appDaily: db.prepare('SELECT day, seconds FROM day_usage WHERE app_id=? AND day BETWEEN ? AND ? ORDER BY day'),
    idleDaily: db.prepare('SELECT day, kind, seconds FROM day_idle WHERE day BETWEEN ? AND ? ORDER BY day'),
    appFirstLast: db.prepare(`SELECT MIN(start_ts) AS first_ts, MAX(end_ts) AS last_ts FROM segment
                              WHERE app_id=? AND end_ts>=? AND start_ts<=?`),
    getSetting: db.prepare('SELECT value FROM setting WHERE key=?'),
    setSetting: db.prepare('INSERT INTO setting(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    ,
    /* ——— 分类（M3）：分类本身 / 手动归类的成员 / 自动规则 ——— */
    catAll: db.prepare('SELECT * FROM category ORDER BY sort_order, id'),
    catById: db.prepare('SELECT * FROM category WHERE id=?'),
    catByName: db.prepare('SELECT * FROM category WHERE name=?'),
    catIns: db.prepare('INSERT INTO category(name, color, sort_order) VALUES(?,?,?)'),
    catUpd: db.prepare('UPDATE category SET name=?, color=? WHERE id=?'),
    catDel: db.prepare('DELETE FROM category WHERE id=?'),
    catMaxSort: db.prepare('SELECT COALESCE(MAX(sort_order),-1) AS m FROM category'),
    pairAll: db.prepare('SELECT category_id, app_id FROM category_app'),
    pairIns: db.prepare('INSERT OR IGNORE INTO category_app(category_id, app_id) VALUES(?,?)'),
    pairDelCat: db.prepare('DELETE FROM category_app WHERE category_id=?'),
    pairDelApp: db.prepare('DELETE FROM category_app WHERE app_id=?'),
    ruleAll: db.prepare('SELECT * FROM category_rule ORDER BY priority DESC, id'),
    ruleIns: db.prepare('INSERT INTO category_rule(category_id, kind, pattern, priority) VALUES(?,?,?,?)'),
    ruleDel: db.prepare('DELETE FROM category_rule WHERE id=?'),
    ruleDelCat: db.prepare('DELETE FROM category_rule WHERE category_id=?')
  };

  return {
    db, path: dbPath, prevDay, migratedDayIdle: migrated, colorsMoved,
    getAppByName: (n) => withCustomName(q.appByName.get(n)) || null,
    insertApp({ exeName, displayName, exePath, mtimeMs, size, day }) {
      q.insertApp.run(exeName, displayName, exePath, mtimeMs, size, day, day);
      return withCustomName(q.appByName.get(exeName));
    },
    touchApp(id, exePath, mtimeMs, size, day) { q.touchApp.run(exePath, mtimeMs, size, day, id); },
    touchLastSeen(id, day) { q.lastSeen.run(day, id); },
    /** 图标版本链：同 hash 不动；变了就开新版本（当天生效），旧版本收口到前一天 */
    setIcon(appId, hash, day) {
      const cur = q.openIcon.get(appId);
      if (cur && cur.icon_hash === hash) return false;
      if (cur) {
        if (cur.effective_from_day === day) q.dropIcon.run(appId, cur.icon_hash, cur.effective_from_day);
        else q.closeIcon.run(prevDay(day), appId, cur.icon_hash, cur.effective_from_day);
      }
      q.insIcon.run(appId, hash, day);
      return true;
    },
    /* M5.6 修正（主人 4 号：steamwebhelper 主页有图标、点进详情页却没了）：
       旧实现只认「effective_from_day <= 那天 <= effective_to_day」，而图标是「应用第一次被看到那天」
       才抓的 —— 主人翻到更早的日期就查不到，界面退化成首字母。
       图标本来就是「缓存下来的资产」，查不到时用「离那天最近的一张」兜底：语义不变、版本链不动。 */
    iconForDay(appId, day) {
      const c = q.customIconGet.get(appId);          // 自定义图标压过版本链，且覆盖全部日期
      if (c) return c.icon_hash;
      const r = q.iconForDay.get(appId, day, day);
      if (r) return r.icon_hash;
      const b = q.iconAtOrBefore.get(appId, day);
      if (b) return b.icon_hash;
      const e = q.iconEarliest.get(appId);
      return e ? e.icon_hash : null;
    },
    /** 图标修复用：当前生效版本正好是这个 hash 的应用（顺带带回 exe 路径） */
    appsWithOpenIcon(hash) { return q.openIconApps.all(hash); },
    /** 图标修复用：所有「当前生效」的图标版本（占位图有好几种字节编码，按 hash 查会漏，所以全拿回来自己比） */
    openIcons() { return q.openIconsAll.all(); },
    /** 就地改写一条图标版本记录（只用于修正「通用占位图」这类错误记录，版本区间保持不动） */
    fixIconHash(appId, oldHash, fromDay, newHash) { q.fixIconHash.run(newHash, appId, oldHash, fromDay); },
    /* M7 主人第 6 条（自定义图标）：主人手动挑的那张图，覆盖这个应用的全部日期。
       优先级高于版本链、且自动采集永远不碰它 —— 「恢复自动图标」就是把这行删掉。 */
    customIcon(appId) { const r = q.customIconGet.get(appId); return r ? r.icon_hash : null; },
    customIcons() { return q.customIconAll.all(); },
    setCustomIcon(appId, hash, day) { q.customIconSet.run(appId, hash, day || null); return true; },
    clearCustomIcon(appId) { return q.customIconDel.run(appId).changes; },
    /* M8 主人第 2 号：缺图标的应用（按用量从多到少）+ 只更新路径（不碰 last_seen_day） */
    appsMissingIcon() { return q.appsNoIcon.all(); },
    setAppPath(id, exePath, mtimeMs, size) { q.setAppPath.run(exePath, mtimeMs ?? null, size ?? null, id); },
    addUsage(day, appId, seconds) { q.addUsage.run(day, appId, seconds); },
    /** kind: idle | lock | sleep（M1 空闲细分） */
    addIdle(day, seconds, kind = 'idle') { q.addIdle.run(day, kind, seconds); },
    topApps(from, to) { return q.topApps.all(from, to).map(withCustomName); },
    idleRange(from, to) { return q.idleRange.get(from, to).s; },
    idleByKind(from, to) { return q.idleByKind.all(from, to); },
    /** 日历用：逐日汇总（有记录的日子在日历上带一个小圆点） */
    dayTotals(from, to) { return q.dayTotals.all(from, to); },
    firstDay() { const r = q.firstDay.get(); return r ? r.d : null; },
    /* ——— M5 应用详情页：单个应用在 [from,to] 内的逐日切片 ——— */
    appById(id) { const r = q.appById.get(id); return r ? withCustomName(r) : null; },
    /** 所有应用（M5.5 主界面小时图要按分类汇总，得先把 app_id 映射到分类） */
    allApps() { return q.appsAll.all().map(withCustomName); },
    /* ——— M8 主人第 9 条：自定义软件名 ——— */
    customName(appId) { const r = q.nameGet.get(appId); return r ? r.name : null; },
    customNames() { return q.nameAll.all(); },
    setCustomName(appId, name, day) { q.nameSet.run(appId, String(name), day ?? null); },
    clearCustomName(appId) { return q.nameDel.run(appId).changes; },
    /** 某个应用在窗口内的原始片段（秒精度）→ 「时段分布」24 小时直方图 */
    appSegments(id, fromMs, toMs) { return q.segAppTs.all(id, toMs, fromMs); },
    /** 所有应用在窗口内的原始片段（主界面「最近 7 天」按分类堆叠的小时图） */
    segmentsIn(fromMs, toMs) { return q.segRangeTs.all(toMs, fromMs); },
    appDaily(id, from, to) { return q.appDaily.all(id, from, to); },
    dailyIdle(from, to) { return q.idleDaily.all(from, to); },
    /** 范围内首次 / 末次使用（segment 有 (app_id,start_ts) 索引，单应用切片很便宜） */
    appFirstLast(id, from, to) {
      const r = q.appFirstLast.get(id, Date.parse(from + 'T00:00:00'), Date.parse(to + 'T23:59:59.999'));
      return r || { first_ts: null, last_ts: null };
    },
    getSetting(k, dflt) { const r = q.getSetting.get(k); return r ? r.value : dflt; },
    setSetting(k, v) { q.setSetting.run(k, v); },

    /* ——— 分类（M3）：这里只管读写，规则匹配交给 categories.js（纯函数，好测） ——— */
    categories() { return q.catAll.all(); },
    categoryByName(name) { return q.catByName.get(name) || null; },
    categoryAdd(name, color) {
      const sort = Number(q.catMaxSort.get().m) + 1;
      const info = q.catIns.run(name, color || null, sort);
      return q.catById.get(Number(info.lastInsertRowid));
    },
    categoryUpdate(id, name, color) { q.catUpd.run(name, color || null, id); return q.catById.get(id) || null; },
    /** 删分类 = 成员 + 规则一起清（不留孤儿行） */
    categoryDelete(id) {
      db.exec('BEGIN');
      try {
        q.pairDelCat.run(id); q.ruleDelCat.run(id);
        const n = q.catDel.run(id).changes;
        db.exec('COMMIT'); return n;
      } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
    /** 手动归类：整表替换这个应用的手动成员；传空数组 = 恢复自动 */
    categorySetAppsFor(appId, categoryIds) {
      db.exec('BEGIN');
      try {
        q.pairDelApp.run(appId);
        for (const cid of categoryIds || []) q.pairIns.run(cid, appId);
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
      return (categoryIds || []).length;
    },
    manualPairs() { return q.pairAll.all(); },
    manualPairsFor(appId) { return q.pairAll.all().filter((p) => p.app_id === appId); },
    rules() { return q.ruleAll.all(); },
    ruleAdd(categoryId, kind, pattern, priority = 0) {
      const info = q.ruleIns.run(categoryId, kind, String(pattern || '').trim(), priority);
      return Number(info.lastInsertRowid);
    },
    ruleDelete(id) { return q.ruleDel.run(id).changes; },

    /* ——— 原始片段：开 / 延长 / 合并(<5s) / 崩溃修复 ——— */
    segOpen(appId, ts) { return Number(q.segInsert.run(appId, ts, ts).lastInsertRowid); },
    segExtend(id, endTs) { q.segExtend.run(endTs, id); },
    segDrop(id) { q.segDelete.run(id); },
    /** 找一条「刚刚」结束、且间隔 < gapMs 的同应用片段，用于把碎片并回一段 */
    segMergable(appId, fromTs, toTs) { return q.segRecent.get(appId, fromTs, toTs) || null; },
    /**
     * 崩溃续写：进程重启后调用。
     * ① 删掉「零长度」片段（崩在切换那一瞬间留下的空壳）；
     * ② 把结束时间落在未来的片段夹回启动时刻（时钟回拨 / 硬杀）；
     * 返回修复数量，写进启动日志给主人核对。
     */
    segRepair(nowMs) {
      const dropped = q.segZero.run().changes;
      const clamped = q.segClamp.run(nowMs, nowMs).changes;
      const r = q.segLastEnd.get();
      return { dropped, clamped, lastEndTs: r ? r.t : null };
    },
    /* ——— M7 迁移专用：直接写一条「已知起止」的片段（不走 segOpen 的零长度创建） ——— */
    segAdd(appId, startTs, endTs) { q.segInsert.run(appId, startTs, endTs); },
    /** 按 [fromMs,toMs) 半开窗口清片段（迁移 replace 模式用；返回删掉的条数） */
    segDeleteWindow(fromMs, toMs) { return q.segDeleteWin.run(fromMs, toMs).changes; },
    /** 窗口内片段条数（迁移报告用） */
    segCountWindow(fromMs, toMs) { return Number(q.segCountWin.get(fromMs, toMs).n); },
    /** 一次事务里写多条，减少 WAL 提交次数 */
    tx(fn) {
      db.exec('BEGIN');
      try { const r = fn(); db.exec('COMMIT'); return r; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
    close() { try { db.close(); } catch {} }
  };
}

module.exports = { openStore, prevDay };
