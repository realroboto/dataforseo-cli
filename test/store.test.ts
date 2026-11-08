import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fakeFetch } from './helpers/fetch.ts';
import { dfs } from './helpers/io.ts';

const LOGIN = { DATAFORSEO_LOGIN: 'me@example.com', DATAFORSEO_PASSWORD: 's3cret' };
const env = () => ({ DFS_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dfs-store-')), ...LOGIN });
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const leaf = (cost: number) => ({ priority_normal: [{ cost_type: 'per_request', cost }] });
const envelope = (tasks: unknown[]) => ({
  status_code: 20000,
  status_message: 'Ok.',
  cost: 0,
  tasks_count: tasks.length,
  tasks,
});
const USER_DATA = envelope([
  {
    id: 'u',
    status_code: 20000,
    cost: 0,
    result: [{ price: { serp: { live: { advanced: leaf(0.002) } } } }],
  },
]);

// A fake DataForSEO: user_data has the price tree; a Live call answers one task of `items`.
let n = 0;
const api = (items: unknown[], cost = 0.002) =>
  fakeFetch((url, init) => {
    if (url.endsWith('/user_data')) return json(USER_DATA);
    const [data] = JSON.parse(init?.body as string);
    return json(
      envelope([
        {
          id: `t${++n}`,
          status_code: 20000,
          cost,
          data,
          result: [{ keyword: data.keyword, items }],
        },
      ]),
    );
  }).fetch;
const LIVE = ['serp', 'google', 'organic', 'live', 'advanced'];
const live = (
  e: NodeJS.ProcessEnv,
  body: unknown,
  items: unknown[],
  extra: string[] = [],
  now?: () => number,
) =>
  dfs([...LIVE, '--body', JSON.stringify(body), ...extra], {
    env: e,
    fetch: api(items),
    ...(now && { now }),
  });
const savedId = (stderr: string) => /saved=(r_[0-9a-f]+)/.exec(stderr)?.[1] ?? '';
const lines = (s: string) =>
  s
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const query = (e: NodeJS.ProcessEnv, sql: string) => {
  const db = new DatabaseSync(join(e.DFS_CONFIG_DIR as string, 'store.db'), {
    readOnly: true,
    timeout: 30_000,
  });
  try {
    return db
      .prepare(sql)
      .all()
      .map((r) => ({ ...r }));
  } finally {
    db.close();
  }
};

test('node:sqlite smoke: FTS5 with folded diacritics, JSONB, WAL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dfs-smoke-'));
  const db = new DatabaseSync(join(dir, 's.db'));
  assert.equal(
    (db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string }).journal_mode,
    'wal',
  );
  db.exec("CREATE VIRTUAL TABLE f USING fts5(t, tokenize = 'unicode61 remove_diacritics 2')");
  db.prepare('INSERT INTO f VALUES (?)').run('Migração rápida');
  assert.equal(
    db.prepare('SELECT count(*) AS c FROM f WHERE f MATCH ?').get('"migracao" "RAPIDA"')?.c,
    1,
  );
  assert.deepEqual(
    { ...db.prepare('SELECT json(jsonb(\'{"a":[1]}\')) AS j').get() },
    { j: '{"a":[1]}' },
  );
  db.close();
});

test('store search finds items with diacritics folded; --path and --since filter; more shows the item', async () => {
  const e = env();
  const old = await live(
    e,
    { keyword: 'a' },
    [
      { type: 'organic', title: 'Plano de migração rápida', url: 'https://a.example/' },
      { type: 'organic', title: 'other', url: 'https://b.example/' },
    ],
    [],
    () => Date.parse('2026-11-06T12:00:00Z'),
  );
  assert.equal(old.code, 0, old.stderr);
  const fresh = await live(e, { keyword: 'b' }, [{ type: 'organic', title: 'MIGRACAO de dados' }]);
  const [a, b] = [savedId(old.stderr), savedId(fresh.stderr)];

  const r = await dfs(['store', 'search', 'migracao'], { env: e });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), [
    {
      id: b,
      time: '2026-11-07T12:00:00.000Z',
      path: '/v3/serp/google/organic/live/advanced',
      item: 1,
      snippet: 'organic\n[MIGRACAO] de dados',
      more: `dfs store show ${b} --from 1`,
    },
    {
      id: a,
      time: '2026-11-06T12:00:00.000Z',
      path: '/v3/serp/google/organic/live/advanced',
      item: 1,
      snippet: 'organic\nPlano de [migração] rápida\nhttps://a.example/',
      more: `dfs store show ${a} --from 1`,
    },
  ]);
  // The input folds too; every word must match one item; FTS5 syntax is plain text.
  assert.deepEqual(
    lines((await dfs(['store', 'search', 'migração', 'b.example'], { env: e })).stdout),
    [],
  );
  assert.equal(
    lines((await dfs(['store', 'search', 'plano', 'rapida'], { env: e })).stdout)[0].id,
    a,
  );
  assert.equal((await dfs(['store', 'search', 'NEAR(" AND'], { env: e })).code, 0);

  const since = await dfs(['store', 'search', 'migracao', '--since', '1d'], { env: e });
  assert.deepEqual(
    lines(since.stdout).map((h) => h.id),
    [b, a],
  );
  const hour = await dfs(['store', 'search', 'migracao', '--since', '1h'], { env: e });
  assert.deepEqual(
    lines(hour.stdout).map((h) => h.id),
    [b],
  );
  for (const path of ['serp google', 'serp/google/organic', '/v3/serp']) {
    const p = await dfs(['store', 'search', 'migracao', '--path', path], { env: e });
    assert.equal(lines(p.stdout).length, 2, path);
  }
  for (const path of ['backlinks', 'serp goo']) {
    const p = await dfs(['store', 'search', 'migracao', '--path', path], { env: e });
    assert.equal(p.stdout, '', path);
  }
  const list = await dfs(['store', 'list', '--since', '1h', '--path', 'serp'], { env: e });
  assert.deepEqual(
    lines(list.stdout).map((l) => l.id),
    [b],
  );

  const second = await dfs(['store', 'search', 'other'], { env: e });
  const [hit] = lines(second.stdout);
  assert.equal(hit.item, 2);
  const shown = await dfs(hit.more.split(' ').slice(1), { env: e });
  assert.match(shown.stdout, /^\{"dfs":"task",.*\n\{"type":"organic","title":"other",/);
});

test('store search, list and spend usage faults exit 3', async () => {
  const e = env();
  for (const argv of [
    ['store', 'search'],
    ['store', 'search', 'x', '--since', '5x'],
    ['store', 'search', 'x', '--path', '/'],
    ['store', 'list', '--by', 'tag'],
    ['store', 'spend', '--by', 'week'],
    ['store', 'sql'],
    ['store', 'backup'],
    ['store', 'nope'],
  ]) {
    const r = await dfs(argv, { env: e });
    assert.equal(r.code, 3, argv.join(' '));
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^dfs: /);
  }
  assert.equal(
    (await dfs(['store', 'spend', '--by', 'week'], { env: e })).stderr,
    'dfs: --by week: want day, module, path, tag\n',
  );
});

test('store sql reads; a write fails on the read-only connection, nothing changes', async () => {
  const e = env();
  const r = await live(e, { keyword: 'k' }, [{ title: 'x' }]);
  const id = savedId(r.stderr);
  const ok = await dfs(
    [
      'store',
      'sql',
      "SELECT id, json_extract(body, '$.tasks[0].id') AS task, body FROM response WHERE spec_path LIKE '%/live/%'",
    ],
    { env: e },
  );
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(
    ok.stdout,
    new RegExp(
      `^\\{"id":"${id}","task":"t\\d+","body":"<blob \\d+ bytes; select json\\(…\\)>"\\}\\n$`,
    ),
  );
  for (const write of [
    'DELETE FROM response',
    'UPDATE task SET cost = 9',
    'CREATE TABLE x (y)',
    'PRAGMA user_version = 1',
    `VACUUM INTO '${join(e.DFS_CONFIG_DIR, 'copy.db')}'`,
  ]) {
    const w = await dfs(['store', 'sql', write], { env: e });
    assert.equal(w.code, 3, write);
    assert.match(
      w.stderr,
      /^dfs: store sql: (attempt to write a readonly database|not a query that returns rows) — /,
      write,
    );
  }
  assert.equal(existsSync(join(e.DFS_CONFIG_DIR, 'copy.db')), false);
  assert.equal(query(e, 'SELECT count(*) AS c FROM response')[0].c, 2); // user_data + Live
  assert.equal(query(e, 'SELECT cost FROM task')[0].cost, 0.002);
  const bad = await dfs(['store', 'sql', 'SELECT nope FROM response'], { env: e });
  assert.equal(bad.code, 3);
});

test('store spend sums non-sandbox task.cost once per task, by tag, day, module and path', async () => {
  const e = env();
  const day1 = () => Date.parse('2026-11-06T12:00:00Z');
  assert.equal((await live(e, { keyword: 'a', tag: 'x' }, [], [], day1)).code, 0);
  assert.equal((await live(e, { keyword: 'b', tag: 'x' }, [])).code, 0);
  assert.equal((await live(e, { keyword: 'c', tag: 'y' }, [])).code, 0);
  // The same request again is reused at $0: a reuse row, no task row.
  const reused = await live(e, { keyword: 'c', tag: 'y' }, []);
  assert.match(reused.stderr, /reused=r_/);
  // Sandbox costs are dummy data.
  assert.equal((await live(e, { keyword: 'd', tag: 'y' }, [], ['--sandbox'])).code, 0);
  assert.equal(query(e, 'SELECT count(*) AS c FROM task')[0].c, 4);

  const total = await dfs(['store', 'spend'], { env: e });
  assert.equal(total.stdout, '{"dfs":"spend","since":null,"cost":0.006,"tasks":3}\n');
  const tag = await dfs(['store', 'spend', '--by', 'tag'], { env: e });
  assert.deepEqual(lines(tag.stdout), [
    { dfs: 'spend', since: null, cost: 0.006, tasks: 3 },
    { tag: 'x', cost: 0.004, tasks: 2 },
    { tag: 'y', cost: 0.002, tasks: 1 },
  ]);
  const day = await dfs(['store', 'spend', '--by', 'day'], { env: e });
  assert.deepEqual(lines(day.stdout).slice(1), [
    { day: '2026-11-07', cost: 0.004, tasks: 2 },
    { day: '2026-11-06', cost: 0.002, tasks: 1 },
  ]);
  const module = await dfs(['store', 'spend', '--by', 'module', '--since', '1h'], { env: e });
  assert.deepEqual(lines(module.stdout), [
    { dfs: 'spend', since: '2026-11-07T11:00:00.000Z', cost: 0.004, tasks: 2 },
    { module: 'serp', cost: 0.004, tasks: 2 },
  ]);
  const path = await dfs(['store', 'spend', '--by', 'path'], { env: e });
  assert.deepEqual(lines(path.stdout)[1], {
    path: '/v3/serp/google/organic/live/advanced',
    cost: 0.006,
    tasks: 3,
  });
});

const STORE_TS = new URL('../src/store.ts', import.meta.url).href;
// A separate dfs process that saves `count` rows through the Store module.
const writer = (dir: string, prefix: string, count: number) =>
  promisify(execFile)(
    'node',
    [
      '--input-type=module',
      '-e',
      `import { save } from ${JSON.stringify(STORE_TS)};
       for (let i = 0; i < ${count}; i++) {
         const ok = save(process.env, {
           id: '${prefix}' + i, time: new Date().toISOString(), method: 'POST',
           spec_path: '/v3/serp/x', path: '/v3/serp/x', sandbox: 0, request: null,
           http_status: 200, status_code: 20000, cost: 0, estimate: 0, reused_from: null,
           dfs_version: '0', spec_sha: '0', reuse_key: null,
           body: JSON.stringify({ tasks: [{ result: [{ items: [{ title: 'row ${prefix}' + i }] }] }] }),
         }, (w) => console.error(w));
         if (!ok) process.exitCode = 1;
       }`,
    ],
    { env: { ...process.env, DFS_CONFIG_DIR: dir } },
  );

test('two dfs processes write one Store at once without loss (seam 2)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dfs-two-'));
  await Promise.all([writer(dir, 'r_a', 150), writer(dir, 'r_b', 150)]);
  const e = { DFS_CONFIG_DIR: dir };
  assert.deepEqual(query(e, 'SELECT count(*) AS c FROM response'), [{ c: 300 }]);
  assert.deepEqual(query(e, 'SELECT count(*) AS c FROM item_fts'), [{ c: 300 }]);
  assert.equal(existsSync(join(dir, 'unsaved')), false, 'no save fell back to unsaved/');
});

test('store backup makes a consistent copy, file 600, while another process writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dfs-backup-'));
  const e = { ...LOGIN, DFS_CONFIG_DIR: dir };
  assert.equal((await live(e, { keyword: 'k' }, [{ title: 'kept' }])).code, 0);
  const file = join(mkdtempSync(join(tmpdir(), 'dfs-copy-')), 'copy.db');
  const busy = writer(dir, 'r_w', 400);
  // Back up while the writer runs.
  while (Number(query(e, 'SELECT count(*) AS c FROM response')[0].c) < 20)
    await new Promise((r) => setTimeout(r, 10));
  const r = await dfs(['store', 'backup', file], { env: e });
  await busy;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `${file}\n`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const copy = new DatabaseSync(file, { readOnly: true });
  try {
    assert.deepEqual(
      { ...copy.prepare('PRAGMA integrity_check').get() },
      { integrity_check: 'ok' },
    );
    assert.deepEqual({ ...copy.prepare('PRAGMA user_version').get() }, { user_version: 6 });
    const { c } = copy.prepare('SELECT count(*) AS c FROM response').get() as { c: number };
    assert.ok(c >= 21 && c <= 401, String(c));
    // Every copied response has its item row: response and item_fts from one moment.
    assert.equal((copy.prepare('SELECT count(*) AS c FROM item_fts').get() as { c: number }).c, c);
  } finally {
    copy.close();
  }
});

test('a Store at user_version 1 migrates forward on open; old items become searchable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dfs-old-'));
  const old = new DatabaseSync(join(dir, 'store.db'));
  old.exec(`CREATE TABLE response (id TEXT PRIMARY KEY, time TEXT NOT NULL, method TEXT NOT NULL,
    spec_path TEXT NOT NULL, path TEXT NOT NULL, sandbox INTEGER NOT NULL, request TEXT,
    http_status INTEGER NOT NULL, status_code INTEGER, cost REAL, estimate REAL, reused_from TEXT,
    dfs_version TEXT NOT NULL, spec_sha TEXT NOT NULL, body BLOB); PRAGMA user_version = 1`);
  old
    .prepare(`INSERT INTO response VALUES ('r_old', '2026-10-01T00:00:00.000Z', 'POST', '/v3/serp/x',
      '/v3/serp/x', 0, NULL, 200, 20000, 0, 0, NULL, '0.0.1', 'abc', jsonb(?))`)
    .run(
      JSON.stringify({
        tasks: [{ result: [{ items: [{ title: 'Ação' }, { title: 'São Paulo' }] }] }],
      }),
    );
  old.close();
  const r = await dfs(['store', 'search', 'sao'], { env: { DFS_CONFIG_DIR: dir } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(
    lines(r.stdout).map((h) => [h.id, h.item]),
    [['r_old', 2]],
  );
  const e = { DFS_CONFIG_DIR: dir };
  assert.deepEqual(query(e, 'PRAGMA user_version'), [{ user_version: 6 }]);
  assert.deepEqual(
    query(
      e,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('price', 'task', 'sync', 'item_fts') ORDER BY name",
    ).map((t) => t.name),
    ['item_fts', 'price', 'sync', 'task'],
  );
  assert.deepEqual(query(e, "SELECT reuse_key FROM response WHERE id = 'r_old'"), [
    { reuse_key: null },
  ]);
});

test('the schema in store.md is the schema dfs creates', async () => {
  const e = { DFS_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dfs-schema-')) };
  await dfs(['store', 'list'], { env: e });
  const created = query(
    e,
    "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'item_fts_%' ORDER BY rowid",
  )
    .map((r) => `${r.sql};`)
    .join('\n');
  const doc = readFileSync(new URL('../docs/spec/modules/store.md', import.meta.url), 'utf8');
  const block = /```sql\n([^`]*)```/.exec(doc)?.[1];
  assert.equal(block?.trim(), created);
  assert.match(doc, /PRAGMA user_version = 6/);
});
