const { DatabaseSync } = require('node:sqlite');
const os = require('node:os'), path = require('node:path');
const dbPath = path.join(process.env.LOCALAPPDATA, 'NamiTime', 'data.db');
const db = new DatabaseSync(dbPath, { readOnly: true });
console.log('DB:', dbPath);
for (const t of ['app','app_icon','day_usage','day_idle','setting','category']) {
  const n = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  console.log(`  表 ${t.padEnd(12)} 行数 ${n}`);
}
console.log('\n今日各应用用量:');
for (const r of db.prepare(`SELECT a.display_name, a.exe_name, u.seconds, a.exe_path_last
                            FROM day_usage u JOIN app a ON a.id=u.app_id
                            WHERE u.day=? ORDER BY u.seconds DESC`).all(new Date().toISOString().slice(0,10))) {
  console.log(`  ${String(r.seconds).padStart(5)}s  ${r.display_name.padEnd(14)} ${r.exe_name}`);
}
console.log('\n图标版本链:');
for (const r of db.prepare(`SELECT a.display_name, i.icon_hash, i.effective_from_day, i.effective_to_day
                            FROM app_icon i JOIN app a ON a.id=i.app_id ORDER BY a.id`).all()) {
  console.log(`  ${r.display_name.padEnd(14)} ${r.icon_hash}  ${r.effective_from_day} → ${r.effective_to_day || '(当前)'}`);
}
db.close();