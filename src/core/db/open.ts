import Database from 'better-sqlite3';
import { MIGRATIONS } from './schema';

export type Db = Database.Database;

/**
 * WAL keeps the SSE readers from blocking the crawler's writes. `foreign_keys`
 * is off by default in SQLite and has to be set per connection, which is what
 * makes the `ON DELETE CASCADE` clauses actually fire.
 */
export const openDatabase = (path: string): Db => {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
};

export const migrate = (db: Db): number => {
  const [row] = db.pragma('user_version') as Array<{ user_version: number }>;
  const current = row?.user_version ?? 0;

  if (current > MIGRATIONS.length) {
    throw new Error(
      `database schema version ${current} is newer than this build understands (${MIGRATIONS.length})`,
    );
  }

  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const sql = MIGRATIONS[version];
    if (sql === undefined) continue;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.pragma(`user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (cause) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${version + 1} failed`, { cause });
    }
  }

  return MIGRATIONS.length;
};
