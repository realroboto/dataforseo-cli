// Store: every response, saved before print (docs/spec/modules/store.md). One `node:sqlite`
// file per user; the `response` table is a contract, versioned by `PRAGMA user_version`.
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { messageOf } from './errors.ts';

export type Row = {
  id: string; // r_…
  time: string; // ISO 8601
  method: string;
  spec_path: string;
  path: string; // concrete path, parameters filled
  sandbox: 0 | 1;
  request: string | null; // JSON text of the sent body; never headers
  http_status: number;
  status_code: number | null; // envelope
  cost: number | null; // envelope
  estimate: number | null;
  reused_from: string | null;
  dfs_version: string;
  spec_sha: string;
  body: string | null; // JSON text; kept as JSONB. null: the response was not JSON
};

const SCHEMA = `CREATE TABLE response (
  id TEXT PRIMARY KEY,
  time TEXT NOT NULL,
  method TEXT NOT NULL,
  spec_path TEXT NOT NULL,
  path TEXT NOT NULL,
  sandbox INTEGER NOT NULL,
  request TEXT,
  http_status INTEGER NOT NULL,
  status_code INTEGER,
  cost REAL,
  estimate REAL,
  reused_from TEXT,
  dfs_version TEXT NOT NULL,
  spec_sha TEXT NOT NULL,
  body BLOB
)`;

export const configDir = (env: NodeJS.ProcessEnv): string =>
  env.DFS_CONFIG_DIR || join(homedir(), '.config', 'dfs');
export const storeFile = (env: NodeJS.ProcessEnv): string => join(configDir(env), 'store.db');
const unsavedDir = (env: NodeJS.ProcessEnv): string => join(configDir(env), 'unsaved');

const privateDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
};

const ROW_COLUMNS: (keyof Row)[] = [
  'id',
  'time',
  'method',
  'spec_path',
  'path',
  'sandbox',
  'request',
  'http_status',
  'status_code',
  'cost',
  'estimate',
  'reused_from',
  'dfs_version',
  'spec_sha',
  'body',
];

// A fixed column list: an unsaved/ file names no SQL. On import the row may be in the Store
// already (a run stopped between insert and file delete); only that id conflict is skipped.
const insert = (db: DatabaseSync, row: Row, onConflict = ''): void => {
  const marks = ROW_COLUMNS.map((c) => (c === 'body' ? 'jsonb(?)' : '?'));
  db.prepare(
    `INSERT INTO response (${ROW_COLUMNS.join(', ')}) VALUES (${marks.join(', ')}) ${onConflict}`,
  ).run(...ROW_COLUMNS.map((c) => row[c] ?? null));
};

// Opens (and creates) the Store, then imports the rows a failed save left in unsaved/.
export function openStore(env: NodeJS.ProcessEnv): DatabaseSync {
  privateDir(configDir(env));
  const file = storeFile(env);
  closeSync(openSync(file, 'a', 0o600)); // SQLite gives the -wal and -shm files this mode
  chmodSync(file, 0o600);
  const db = new DatabaseSync(file, { timeout: 30_000 });
  try {
    db.exec('PRAGMA journal_mode = WAL');
    const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (user_version === 0) db.exec(`BEGIN; ${SCHEMA}; PRAGMA user_version = 1; COMMIT`);
    importUnsaved(db, env);
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

function importUnsaved(db: DatabaseSync, env: NodeJS.ProcessEnv): void {
  let names: string[];
  try {
    names = readdirSync(unsavedDir(env)).filter((n) => n.endsWith('.json'));
  } catch {
    return; // no unsaved/ dir: nothing to import
  }
  for (const name of names) {
    const file = join(unsavedDir(env), name);
    try {
      insert(db, JSON.parse(readFileSync(file, 'utf8')), 'ON CONFLICT (id) DO NOTHING');
      rmSync(file);
    } catch {
      // Kept on disk: a later run tries again; the file is the only copy.
    }
  }
}

// Save before print. A failed Store write keeps the row in unsaved/<id>.json (600) for the next
// run and warns; returns false when that write fails too.
export function save(env: NodeJS.ProcessEnv, row: Row, warn: (m: string) => void): boolean {
  try {
    const db = openStore(env);
    try {
      insert(db, row);
    } finally {
      db.close();
    }
    return true;
  } catch (e) {
    try {
      privateDir(unsavedDir(env));
      const file = join(unsavedDir(env), `${row.id}.json`);
      writeFileSync(file, JSON.stringify(row), { mode: 0o600, flag: 'wx' });
      warn(
        `Store write failed (${messageOf(e)}); response kept in ${file}, imported on the next run`,
      );
      return true;
    } catch {
      return false;
    }
  }
}

const COLUMNS = 'id, time, method, spec_path, path, sandbox, http_status, status_code, cost';

export const getRow = (db: DatabaseSync, id: string): Row | undefined =>
  db
    .prepare(
      `SELECT ${COLUMNS}, request, estimate, reused_from, dfs_version, spec_sha, json(body) AS body FROM response WHERE id = ?`,
    )
    .get(id) as Row | undefined;

// Newest first, no body.
export const listRows = (db: DatabaseSync): Omit<Row, 'body'>[] =>
  db.prepare(`SELECT ${COLUMNS} FROM response ORDER BY time DESC, rowid DESC`).all() as Omit<
    Row,
    'body'
  >[];
