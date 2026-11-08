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
import { backup, DatabaseSync } from 'node:sqlite';
import { messageOf } from './errors.ts';
import { isRecord } from './json.ts';

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
  reuse_key: string | null; // sha256 of the canonical request
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

// Added in user_version 3: the reuse lookup reads a key over a 12 h window.
const REUSE = `ALTER TABLE response ADD COLUMN reuse_key TEXT;
CREATE INDEX response_reuse ON response (reuse_key, time)`;

// One row: the `price` node of the last good user_data and its fetch time (pricing.md).
const PRICE = `CREATE TABLE price (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fetched_at TEXT NOT NULL,
  tree BLOB NOT NULL
)`;

// Added in user_version 4: one row per DataForSEO task id (store.md, `task`).
const TASK = `CREATE TABLE task (
  id TEXT PRIMARY KEY,
  post_response TEXT NOT NULL,
  path TEXT NOT NULL,
  variant TEXT,
  state TEXT NOT NULL,
  status_code INTEGER,
  cost REAL,
  tag TEXT,
  posted_at TEXT NOT NULL,
  collected_at TEXT,
  collect_response TEXT,
  sandbox INTEGER NOT NULL
)`;

// Added in user_version 5: the end of the last `id_list` pass per module (store.md, `sync`).
const SYNC = `CREATE TABLE sync (
  module TEXT PRIMARY KEY,
  last_pass TEXT NOT NULL
)`;

// Added in user_version 6: one row per item of a response (`tasks[].result[].items[]`, else
// `tasks[].result[]`), every string value of the item, diacritics folded (store.md, `item_fts`).
// `item` is the item number of `dfs store show <response> --from <item>`.
const ITEM_FTS = `CREATE VIRTUAL TABLE item_fts USING fts5(
  text,
  response UNINDEXED,
  item UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
)`;

export const USER_VERSION = 6;

export const configDir = (env: NodeJS.ProcessEnv): string =>
  env.DFS_CONFIG_DIR || join(homedir(), '.config', 'dfs');
export const storeFile = (env: NodeJS.ProcessEnv): string => join(configDir(env), 'store.db');
const unsavedDir = (env: NodeJS.ProcessEnv): string => join(configDir(env), 'unsaved');

export const privateDir = (dir: string): void => {
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
  'reuse_key',
];

// A fixed column list: an unsaved/ file names no SQL. On import the row may be in the Store
// already (a run stopped between insert and file delete); only that id conflict is skipped.
// The row and its item_fts rows commit together.
const insert = (db: DatabaseSync, row: Row, onConflict = ''): void => {
  const marks = ROW_COLUMNS.map((c) => (c === 'body' ? 'jsonb(?)' : '?'));
  inTransaction(db, () => {
    const { changes } = db
      .prepare(
        `INSERT INTO response (${ROW_COLUMNS.join(', ')}) VALUES (${marks.join(', ')}) ${onConflict}`,
      )
      .run(...ROW_COLUMNS.map((c) => row[c] ?? null));
    if (changes > 0 && row.body !== null) indexItems(db, row.id, row.body);
  });
};

function inTransaction(db: DatabaseSync, f: () => void): void {
  db.exec('BEGIN IMMEDIATE'); // takes the write lock at once, under the busy timeout
  try {
    f();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Items in the numbering of Compact output (render.ts `units`, `store show --from`).
function* items(body: unknown): Generator<unknown> {
  const tasks = isRecord(body) && Array.isArray(body.tasks) ? body.tasks : [];
  for (const t of tasks) {
    if (!isRecord(t)) continue;
    for (const r of Array.isArray(t.result) ? t.result : []) {
      if (isRecord(r) && Array.isArray(r.items)) yield* r.items;
      else yield r;
    }
  }
}

function* strings(v: unknown): Generator<string> {
  if (typeof v === 'string') yield v;
  else if (Array.isArray(v)) for (const x of v) yield* strings(x);
  else if (isRecord(v)) for (const x of Object.values(v)) yield* strings(x);
}

function indexItems(db: DatabaseSync, id: string, body: string): void {
  const stmt = db.prepare('INSERT INTO item_fts (text, response, item) VALUES (?, ?, ?)');
  let n = 0;
  for (const item of items(JSON.parse(body))) {
    n++;
    const text = [...strings(item)].join('\n');
    if (text) stmt.run(text, id, n);
  }
}

// Opens (and creates) the Store, then imports the rows a failed save left in unsaved/.
export function openStore(env: NodeJS.ProcessEnv): DatabaseSync {
  privateDir(configDir(env));
  const file = storeFile(env);
  closeSync(openSync(file, 'a', 0o600)); // SQLite gives the -wal and -shm files this mode
  chmodSync(file, 0o600);
  const db = new DatabaseSync(file, { timeout: 30_000 });
  try {
    wal(db);
    migrate(db);
    importUnsaved(db, env);
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

// A new file switches to WAL under a lock SQLite does not wait for (SQLITE_BUSY, no busy
// handler), so two processes that create the Store at once retry for the busy timeout.
function wal(db: DatabaseSync): void {
  const end = Date.now() + 30_000;
  for (;;) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (e) {
      if ((e as { errcode?: number }).errcode !== 5 || Date.now() > end) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

// Forward migration, one step per user_version (store.md, "Schema contract"). The version is read
// inside the write transaction, so two processes never run the same step.
function migrate(db: DatabaseSync): void {
  const version = () =>
    (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version() >= USER_VERSION) return;
  inTransaction(db, () => {
    const v = version();
    if (v < 1) db.exec(SCHEMA);
    if (v < 2) db.exec(PRICE);
    if (v < 3) db.exec(REUSE);
    if (v < 4) db.exec(TASK);
    if (v < 5) db.exec(SYNC);
    if (v < 6) {
      db.exec(ITEM_FTS);
      const rows = db
        .prepare('SELECT id, json(body) AS body FROM response WHERE body IS NOT NULL')
        .all() as { id: string; body: string }[];
      for (const r of rows) indexItems(db, r.id, r.body);
    }
    db.exec(`PRAGMA user_version = ${USER_VERSION}`);
  });
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

const FULL = `${COLUMNS}, request, estimate, reused_from, dfs_version, spec_sha, json(body) AS body, reuse_key`;

export const getRow = (db: DatabaseSync, id: string): Row | undefined =>
  db.prepare(`SELECT ${FULL} FROM response WHERE id = ?`).get(id) as Row | undefined;

// Sent responses with this key and a body, at or after `since` (ISO 8601), newest first.
export const reuseRows = (db: DatabaseSync, key: string, since: string): Row[] =>
  db
    .prepare(
      `SELECT ${FULL} FROM response WHERE reuse_key = ? AND time >= ? AND reused_from IS NULL AND body IS NOT NULL ORDER BY time DESC, rowid DESC`,
    )
    .all(key, since) as Row[];

// Response filters of `store list` and `store search`: `since` (ISO 8601) and a spec path prefix
// (`/v3/serp/google` matches itself and every path below it).
export type Filter = { since?: string; path?: string };

const filterSql = ({ since, path }: Filter): { sql: string; args: string[] } => ({
  sql: `time >= ?${path ? " AND substr(spec_path || '/', 1, length(?) + 1) = ? || '/'" : ''}`,
  args: [since ?? '', ...(path ? [path, path] : [])],
});

// Newest first, no body.
export function listRows(db: DatabaseSync, f: Filter = {}): Omit<Row, 'body'>[] {
  const w = filterSql(f);
  return db
    .prepare(`SELECT ${COLUMNS} FROM response WHERE ${w.sql} ORDER BY time DESC, rowid DESC`)
    .all(...w.args) as Omit<Row, 'body'>[];
}

export type Hit = { id: string; time: string; path: string; item: number; snippet: string };

// Items whose strings hold every word (diacritics folded), newest response first. Each word is
// an FTS5 string, so FTS5 syntax in the words is plain text.
export function searchItems(db: DatabaseSync, words: string[], f: Filter = {}): Hit[] {
  const query = words.map((w) => `"${w.replaceAll('"', '""')}"`).join(' ');
  const w = filterSql(f);
  return db
    .prepare(
      `SELECT r.id, r.time, r.spec_path AS path, item_fts.item AS item,
       snippet(item_fts, 0, '[', ']', '…', 12) AS snippet
       FROM item_fts JOIN response r ON r.id = item_fts.response
       WHERE item_fts MATCH ? AND ${w.sql} ORDER BY r.time DESC, r.rowid DESC, item_fts.item`,
    )
    .all(query, ...w.args) as Hit[];
}

// `store spend` groups (store.md, "Spend source"): task.cost of non-sandbox tasks.
const SPEND_KEYS = {
  day: 'substr(posted_at, 1, 10)', // UTC day
  module: "substr(path, 5, instr(substr(path, 5) || '/', '/') - 1)", // after /v3/
  path: 'path',
  tag: 'tag',
} as const;
export type SpendBy = keyof typeof SPEND_KEYS;
export const SPEND_BY = Object.keys(SPEND_KEYS) as SpendBy[];
export type Spend = { key?: string | null; cost: number; tasks: number };

// Total first, then one row per group: days newest first, other groups by cost. Costs round to
// 10 decimals, so float sums print as the API reports them.
export function spend(db: DatabaseSync, since: string | undefined, by?: SpendBy): Spend[] {
  const sql = (key: string) =>
    `SELECT ${key} round(total(cost), 10) AS cost, count(*) AS tasks FROM task
     WHERE sandbox = 0 AND posted_at >= ?`;
  const total = db.prepare(sql('')).get(since ?? '') as Spend;
  if (!by) return [total];
  const order = by === 'day' ? 'key DESC' : 'cost DESC, key';
  const groups = db
    .prepare(`${sql(`${SPEND_KEYS[by]} AS key,`)} GROUP BY key ORDER BY ${order}`)
    .all(since ?? '') as Spend[];
  return [total, ...groups];
}

// A read-only connection to the Store (created and migrated first): writes fail in SQLite.
export function openReadOnly(env: NodeJS.ProcessEnv): DatabaseSync {
  openStore(env).close();
  return new DatabaseSync(storeFile(env), { readOnly: true, timeout: 30_000 });
}

// A consistent copy of the Store in `file` (mode 600) while other processes write: one backup
// step copies every page inside one read transaction, so writers never restart it.
export async function backupStore(env: NodeJS.ProcessEnv, file: string): Promise<number> {
  const db = openStore(env);
  try {
    closeSync(openSync(file, 'a', 0o600));
    chmodSync(file, 0o600);
    return await backup(db, file, { rate: 2 ** 31 - 1 });
  } finally {
    db.close();
  }
}

export type Price = { at: string; tree: unknown }; // at: ISO 8601 fetch time

export function readPrice(db: DatabaseSync): Price | undefined {
  const row = db.prepare('SELECT fetched_at, json(tree) AS tree FROM price WHERE id = 1').get() as
    | { fetched_at: string; tree: string }
    | undefined;
  return row && { at: row.fetched_at, tree: JSON.parse(row.tree) };
}

export const writePrice = (db: DatabaseSync, { at, tree }: Price): void => {
  db.prepare('INSERT OR REPLACE INTO price (id, fetched_at, tree) VALUES (1, ?, jsonb(?))').run(
    at,
    JSON.stringify(tree),
  );
};

export type TaskState = 'pending' | 'collected' | 'failed' | 'expired';
export type Task = {
  id: string;
  post_response: string; // response id of the post
  path: string; // task_post spec path
  variant: string | null; // collect variant; null: the level has one collect path with no word
  state: TaskState;
  status_code: number | null; // last known task code
  cost: number | null;
  tag: string | null;
  posted_at: string; // ISO 8601
  collected_at: string | null;
  collect_response: string | null;
  sandbox: 0 | 1;
};

const TASK_COLUMNS: (keyof Task)[] = [
  'id',
  'post_response',
  'path',
  'variant',
  'state',
  'status_code',
  'cost',
  'tag',
  'posted_at',
  'collected_at',
  'collect_response',
  'sandbox',
];

// A task already in the Store keeps its row: a replayed post never resets a task's state.
export function insertTasks(db: DatabaseSync, tasks: Task[]): void {
  const stmt = db.prepare(
    `INSERT INTO task (${TASK_COLUMNS.join(', ')}) VALUES (${TASK_COLUMNS.map(() => '?').join(', ')}) ON CONFLICT (id) DO NOTHING`,
  );
  for (const t of tasks) stmt.run(...TASK_COLUMNS.map((c) => t[c] ?? null));
}

export const getTask = (db: DatabaseSync, id: string): Task | undefined =>
  db.prepare('SELECT * FROM task WHERE id = ?').get(id) as Task | undefined;

// A later report replaces the cost only when non-zero (store.md, `task` cost rule).
export function updateTask(
  db: DatabaseSync,
  id: string,
  u: Pick<Task, 'state' | 'status_code' | 'collected_at' | 'collect_response' | 'cost'>,
): void {
  db.prepare(
    `UPDATE task SET state = ?, status_code = ?, collected_at = ?, collect_response = ?,
     cost = CASE WHEN ? IS NOT NULL AND ? != 0 THEN ? ELSE cost END WHERE id = ?`,
  ).run(u.state, u.status_code, u.collected_at, u.collect_response, u.cost, u.cost, u.cost, id);
}

// A cost reported after the charging call (`id_list`) replaces it only when non-zero.
export const setCost = (db: DatabaseSync, id: string, cost: number | null): void => {
  if (cost) db.prepare('UPDATE task SET cost = ? WHERE id = ?').run(cost, id);
};

// Pending tasks whose task_post path starts with `prefix`, oldest first.
export const pendingTasks = (db: DatabaseSync, prefix: string): Task[] =>
  db
    .prepare(`SELECT * FROM task WHERE state = 'pending' AND path LIKE ? || '%' ORDER BY rowid`)
    .all(prefix) as Task[];

// Start of the next id_list pass of a module: the last pass, else the Store's creation, which is
// the time of its first response (lifecycle.md); undefined for an empty Store.
export function syncStart(db: DatabaseSync, module: string): string | undefined {
  const row = db.prepare('SELECT last_pass FROM sync WHERE module = ?').get(module) as
    | { last_pass: string }
    | undefined;
  if (row) return row.last_pass;
  const first = db.prepare('SELECT min(time) AS t FROM response').get() as { t: string | null };
  return first.t ?? undefined;
}

export const setSync = (db: DatabaseSync, module: string, at: string): void => {
  db.prepare('INSERT OR REPLACE INTO sync (module, last_pass) VALUES (?, ?)').run(module, at);
};
