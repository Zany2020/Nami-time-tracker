'use strict';
/* ============================================================
   分类规则引擎（M3 · S3.3）
   · 纯函数，不碰数据库、不碰 Electron —— 所以能离线跑单元测试
   · 三种规则：exe（exe 文件名通配）/ path（完整路径通配）/ title（标题正则）
   · 手动优先：一个应用只要被手动归过类，规则就整体让位（界面上有「恢复自动」）
   ============================================================ */

/** 把「/」统一成「\」，方便主人两种写法都能用 */
const normPath = (p) => String(p || '').replace(/\//g, '\\');

/**
 * 通配转正则：* = 任意多个字符，? = 一个字符，其余字符按字面量。
 * 路径里反斜杠太多，不做严格分隔符拆分 —— 宽松匹配更好用，也更不容易误伤。
 */
function glob(pat) {
  const s = String(pat || '').trim();
  if (!s) return null;
  const body = s
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  try { return new RegExp('^' + body + '$', 'i'); } catch { return null; }
}

const KIND_LABEL = { exe: 'exe 名', path: '路径', title: '标题' };

/** 一条规则打中一个应用吗？app = { exe_name, exe_path_last, display_name } */
function ruleHit(rule, app) {
  if (!rule || !app) return false;
  if (rule.kind === 'exe') {
    const re = glob(rule.pattern);
    return !!re && re.test(String(app.exe_name || ''));
  }
  if (rule.kind === 'path') {
    const re = glob(normPath(rule.pattern));
    return !!re && re.test(normPath(app.exe_path_last || ''));
  }
  if (rule.kind === 'title') {
    try { return new RegExp(String(rule.pattern || ''), 'i').test(String(app.display_name || '')); }
    catch { return false; }
  }
  return false;
}

/** 规则的执行顺序：先按 priority 从大到小，再按 id 稳定排序 */
const sortRules = (rules) => (rules || []).slice().sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.id - b.id);

/**
 * 算出「每个应用属于哪些分类」。
 * @param apps        [{ id, exe_name, exe_path_last, display_name }]
 * @param manualPairs [{ category_id, app_id }]（category_app 表）
 * @param rules       [{ id, category_id, kind, pattern, priority }]
 * @param rulesOn     自动规则总开关
 * @returns Map<appId, Set<categoryId>>
 *
 * 语义（写清楚，免得以后自己都忘了）：
 *  ① 手动的应用 = 完全听主人的，规则一律不管它；
 *  ② 其余应用 = 规则命中几个分类就算几个（一个应用可属于多个分类）；
 *  ③ priority 只决定「谁先被匹配到」，不会让低优先级规则失效 —— 故意的，分类是并集不是互斥。
 */
function resolve(apps, manualPairs, rules, rulesOn = true) {
  const out = new Map();
  const manual = new Map();
  for (const p of manualPairs || []) {
    if (!manual.has(p.app_id)) manual.set(p.app_id, new Set());
    manual.get(p.app_id).add(p.category_id);
  }
  const ordered = sortRules(rules);
  for (const a of apps || []) {
    const m = manual.get(a.id);
    if (m && m.size) { out.set(a.id, new Set(m)); continue; }
    const hit = new Set();
    if (rulesOn) for (const r of ordered) if (ruleHit(r, a)) hit.add(r.category_id);
    out.set(a.id, hit);
  }
  return out;
}

/** 分类视图用：按分类把时长加起来。一个应用属于两个分类就在两边各算一次（合计 = 成员之和，重合不抵消） */
function rollup(rows, resolved, categories) {
  const byId = new Map((categories || []).map((c) => [c.id, c]));
  const bucket = new Map();
  for (const r of rows || []) {
    for (const cid of resolved.get(r.id) || []) {
      if (!byId.has(cid)) continue;
      if (!bucket.has(cid)) bucket.set(cid, { id: cid, name: byId.get(cid).name, color: byId.get(cid).color, seconds: 0, apps: [] });
      const b = bucket.get(cid);
      b.seconds += r.seconds;
      b.apps.push({ id: r.id, name: r.name, exeName: r.exeName, icon: r.icon, seconds: r.seconds });
    }
  }
  const order = new Map((categories || []).map((c, i) => [c.id, i]));
  const list = [...bucket.values()];
  for (const b of list) { b.apps.sort((a, z) => z.seconds - a.seconds); }
  list.sort((a, z) => z.seconds - a.seconds || (order.get(a.id) || 0) - (order.get(z.id) || 0));
  return list;
}

/** 预置「游戏」分类模板（M3 · S3.5）：一键启用，规则都写在明面上，主人随时能改 */
const GAME_TEMPLATE = {
  name: '游戏',
  color: '#4C7BB5',
  rules: [
    { kind: 'path', pattern: '*\\steamapps\\common\\*', note: 'Steam 游戏库' },
    { kind: 'path', pattern: '*\\Epic Games\\*', note: 'Epic' },
    { kind: 'path', pattern: '*\\GOG Galaxy\\Games\\*', note: 'GOG' },
    { kind: 'path', pattern: '*\\Battle.net\\*', note: '战网' },
    { kind: 'path', pattern: '*\\Riot Games\\*', note: '拳头' },
    { kind: 'path', pattern: '*\\Ubisoft\\*', note: '育碧' },
    { kind: 'path', pattern: '*\\Games\\*', note: '常见 Games 目录' },
    { kind: 'exe', pattern: 'metaphor.exe', note: '暗喻幻想' },
    { kind: 'exe', pattern: 'eldenring.exe', note: '艾尔登法环' },
    { kind: 'exe', pattern: 'yuanshen.exe', note: '原神' },
    { kind: 'exe', pattern: 'genshinimpact.exe', note: '原神（国际服）' },
    { kind: 'exe', pattern: 'starrail.exe', note: '星穹铁道' },
    { kind: 'exe', pattern: 'cs2.exe', note: 'CS2' },
    { kind: 'exe', pattern: 'dota2.exe', note: 'DOTA2' },
    { kind: 'exe', pattern: 'hades.exe', note: 'Hades' },
    { kind: 'exe', pattern: 'stardew valley.exe', note: '星露谷物语' },
    { kind: 'exe', pattern: 'terraria.exe', note: '泰拉瑞亚' },
    { kind: 'exe', pattern: 'witcher3.exe', note: '巫师 3' },
    { kind: 'exe', pattern: 'cyberpunk2077.exe', note: '赛博朋克 2077' },
    { kind: 'exe', pattern: 'minecraft.exe', note: 'Minecraft' }
  ]
};

/** 预设配色（新建分类时点一下就能用）
    M7（主人 2 号）换肤：把原来的紫 #8B5CF6 / 品紫 #BF5AF2 换成一路钢蓝，
    和新的「忧郁高级感蓝」主题同一个色系，不再有老气的蓝紫撞色。功能色（绿/橙/红/黄）保留。 */
const PALETTE = ['#3E6FA8', '#5B8FC7', '#2E8BC0', '#5AC8FA', '#30D158', '#FF9F0A', '#FF375F', '#FFD60A'];

module.exports = { glob, normPath, ruleHit, resolve, rollup, sortRules, GAME_TEMPLATE, PALETTE, KIND_LABEL };
