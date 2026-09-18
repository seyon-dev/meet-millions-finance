import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const dir = 'database/migrations';
const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');

for (const f of files) {
  const sql = readFileSync(path.join(dir, f), 'utf8');
  try {
    db.exec(sql);
    console.log(`  ok   ${f}`);
  } catch (err) {
    console.error(`  FAIL ${f}\n       ${err.message}`);
    process.exit(1);
  }
}

const tables = db.prepare(
  `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
).all().map(r => r.name);
const indexes = db.prepare(
  `SELECT count(*) AS c FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'`
).get().c;

const fkIssues = db.prepare('PRAGMA foreign_key_check').all();
if (fkIssues.length) { console.error('FK issues:', fkIssues); process.exit(1); }

console.log(`\n${tables.length} tables, ${indexes} indexes`);
console.log(tables.join(', '));
