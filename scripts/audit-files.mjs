/* P2-15 文件索引审计（只读，不删文件）
 * 用法：DB_FILE=data/clinical.db UPLOAD_DIR=uploads node scripts/audit-files.mjs
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dbFile = process.env.DB_FILE || path.join(process.cwd(), 'data', 'clinical.db');
const uploadDir = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
if (!fs.existsSync(dbFile)) {
  console.error('DB not found:', dbFile);
  process.exit(2);
}
const db = new Database(dbFile, { readonly: true });
const rows = db.prepare(`SELECT id, patient_id, source, source_id, stored_name, bytes FROM file_assets
                         WHERE deleted_at IS NULL ORDER BY id`).all();
const indexed = new Set(rows.map(r => r.stored_name.replace(/\\/g, '/')));
const missing = rows.filter(r => !fs.existsSync(path.join(uploadDir, r.stored_name)));
const disk = [];
function walk(dir, base = '') {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + ent.name : ent.name;
    if (ent.isDirectory()) walk(path.join(dir, ent.name), rel);
    else disk.push(rel);
  }
}
if (fs.existsSync(uploadDir)) walk(uploadDir);
const orphan = disk.filter(f => !indexed.has(f) && !/\.(txt|json)$/i.test(f));
console.log(JSON.stringify({
  dbFile, uploadDir, indexed: rows.length, missingOnDisk: missing.length,
  diskFiles: disk.length, unindexedDiskFiles: orphan.length,
  missing: missing.slice(0, 20), orphan: orphan.slice(0, 20)
}, null, 2));
db.close();
