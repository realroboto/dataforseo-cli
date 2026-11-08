import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fakeFetch } from './helpers/fetch.ts';
import { dfs } from './helpers/io.ts';

const LOGIN = { DATAFORSEO_LOGIN: 'me@example.com', DATAFORSEO_PASSWORD: 's3cret' };
const env = (extra: Record<string, string> = {}) => ({
  DFS_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dfs-call-')),
  ...LOGIN,
  ...extra,
});

test('a missing credential variable exits 2 with its name; nothing sent', async () => {
  for (const name of ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD']) {
    const { fetch, calls } = fakeFetch(() => new Response('{}'));
    const e = env();
    delete e[name as keyof typeof e];
    const { code, stdout, stderr } = await dfs(['appendix', 'user_data'], { env: e, fetch });
    assert.equal(code, 2);
    assert.equal(stdout, '');
    assert.match(stderr, new RegExp(`^dfs: ${name} is not set`));
    assert.equal(calls.length, 0);
  }
});

const USER_DATA = {
  version: '0.1.20261020',
  status_code: 20000,
  status_message: 'Ok.',
  time: '0.0412 sec.',
  cost: 0,
  tasks_count: 1,
  tasks_error: 0,
  tasks: [
    {
      id: '11071200-1535-0216-0000-5b8c1e2a7f10',
      status_code: 20000,
      status_message: 'Ok.',
      time: '0.0108 sec.',
      cost: 0,
      result_count: 1,
      path: ['v3', 'appendix', 'user_data'],
      data: { api: 'appendix', function: 'user_data' },
      result: [
        {
          login: 'me@example.com',
          timezone: 'UTC',
          rates: { limits: { day: { total: 0 } } },
          money: { total: 100, balance: 42.5, limits: {} },
          backlinks_subscription_expiry_date: null,
          llm_mentions_subscription_expiry_date: '',
        },
      ],
    },
  ],
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const rows = (dir: string) => {
  const db = new DatabaseSync(join(dir, 'store.db'), { readOnly: true });
  try {
    return db.prepare('SELECT *, json(body) AS text FROM response').all();
  } finally {
    db.close();
  }
};

test('user_data: one GET with basic auth, saved before stdout, Compact output', async () => {
  const e = env();
  const { fetch, calls } = fakeFetch(() => json(USER_DATA));
  let seenAtFirstWrite: unknown[] | undefined;
  let stdout = '';
  const { code, stderr } = await dfs(['appendix', 'user_data'], {
    env: e,
    fetch,
    stdout: {
      write: (s: string) => {
        seenAtFirstWrite ??= rows(e.DFS_CONFIG_DIR);
        stdout += s;
      },
    },
  });
  assert.equal(code, 0, stderr);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.dataforseo.com/v3/appendix/user_data');
  assert.equal(calls[0].init?.method, 'GET');
  const auth = new Headers(calls[0].init?.headers).get('authorization');
  assert.equal(auth, `Basic ${Buffer.from('me@example.com:s3cret').toString('base64')}`);

  const id = /saved=(r_[0-9a-z]+)\n$/.exec(stderr)?.[1];
  assert.ok(id, stderr);
  assert.equal(stderr, `dfs: 20000 /v3/appendix/user_data tasks=1 cost=$0 est=$0 saved=${id}\n`);
  assert.equal(
    stdout,
    '{"dfs":"task","id":"11071200-1535-0216-0000-5b8c1e2a7f10","status_code":20000}\n' +
      '{"timezone":"UTC","rates":{"limits":{"day":{"total":0}}},"money":{"total":100,"balance":42.5}}\n',
  );

  assert.equal(seenAtFirstWrite?.length, 1, 'row saved before the first stdout write');
  const [row] = rows(e.DFS_CONFIG_DIR) as Record<string, unknown>[];
  assert.equal(row.id, id);
  assert.equal(row.method, 'GET');
  assert.equal(row.spec_path, '/v3/appendix/user_data');
  assert.equal(row.path, '/v3/appendix/user_data');
  assert.equal(row.http_status, 200);
  assert.equal(row.status_code, 20000);
  assert.equal(row.sandbox, 0);
  const text = String(row.text);
  for (const secret of ['me@example.com', 's3cret', 'Basic', 'authorization']) {
    assert.ok(!text.includes(secret) && !JSON.stringify(row).includes(secret), secret);
  }
});

// Runs `dfs <argv>` against one config dir; returns the saved id from the status line.
const callAndId = async (e: ReturnType<typeof env>, argv: string[], body: unknown) => {
  const { fetch, calls } = fakeFetch(() =>
    typeof body === 'string' ? new Response(body) : json(body),
  );
  const r = await dfs(argv, { env: e, fetch });
  return { ...r, calls, id: /saved=(r_[0-9a-f]+)/.exec(r.stderr)?.[1] ?? '' };
};

test('store show, --full and store path reprint from the Store with no API call', async () => {
  const e = env();
  // Number digits as the API wrote them: --full keeps them.
  const text = JSON.stringify(USER_DATA).replace('"balance":42.5', '"balance":42.50');
  const first = await callAndId(e, ['appendix', 'user_data', '--full'], text);
  assert.equal(first.code, 0);
  const exact = text.replace('"login":"me@example.com",', '');
  assert.equal(first.stdout, `${exact}\n`);

  const shown = await dfs(['store', 'show', first.id], { env: e });
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /^\{"dfs":"task",.*\n\{"timezone":"UTC",.*"balance":42.5\}\}\n$/);
  assert.equal(shown.stderr, '');
  const full = await dfs(['store', 'show', first.id, '--full'], { env: e });
  assert.equal(full.stdout, `${exact}\n`);

  const path = await dfs(['store', 'path'], { env: e });
  assert.equal(path.stdout, `${join(e.DFS_CONFIG_DIR, 'store.db')}\n`);
  const list = await dfs(['store', 'list'], { env: e });
  assert.equal(
    list.stdout,
    `{"id":"${first.id}","time":"2026-11-07T12:00:00.000Z","method":"GET","spec_path":"/v3/appendix/user_data","path":"/v3/appendix/user_data","sandbox":0,"http_status":200,"status_code":20000,"cost":0}\n`,
  );
  const unknown = await dfs(['store', 'show', 'r_nope'], { env: e });
  assert.equal(unknown.code, 3);
  assert.equal(unknown.stderr, 'dfs: no response r_nope in the Store; see: dfs store list\n');
});

const serp = (items: unknown[]) => ({
  ...USER_DATA,
  cost: 0.002,
  tasks: [
    {
      id: '11071201-1535-0139-0000-9d2c4f1e0a11',
      status_code: 20000,
      status_message: 'Ok.',
      cost: 0.002,
      data: { api: 'serp', function: 'live', keyword: 'pizza', tag: 'run-7' },
      result: [{ keyword: 'pizza', se_domain: 'google.com', spell: null, items }],
    },
  ],
});
// A config dir whose price tree was just loaded: serp live advanced $0.002, task_post $0.0006.
const priced = async () => {
  const e = env();
  const leaf = (cost: number) => ({ priority_normal: [{ cost_type: 'per_request', cost }] });
  const data = structuredClone(USER_DATA);
  Object.assign(data.tasks[0].result[0], {
    price: { serp: { live: { advanced: leaf(0.002) }, task_post: leaf(0.0006) } },
  });
  assert.equal((await callAndId(e, ['appendix', 'user_data'], data)).code, 0);
  return e;
};
const SERP_ARGV = ['serp', 'google', 'organic', 'live', 'advanced', '--max-cost', '1'];
const ITEMS = Array.from({ length: 100 }, (_, i) => ({
  type: 'organic',
  rank_absolute: i + 1,
  url: `https://example.com/${i + 1}`,
  description: 'x'.repeat(150),
  links: null,
}));

test('Compact output stops after a whole item within 9,000 characters; --from continues', async () => {
  const e = await priced();
  const first = await callAndId(e, [...SERP_ARGV, '--body', '{"keyword":"pizza"}'], serp(ITEMS));
  assert.equal(first.code, 0, first.stderr);
  assert.equal(
    first.stderr,
    `dfs: 20000 /v3/serp/google/organic/live/advanced tasks=1 cost=$0.002 est=$0.002 saved=${first.id}\n`,
  );
  assert.ok(first.stdout.length + first.stderr.length <= 9000);
  const lines = first.stdout.trimEnd().split('\n');
  assert.equal(
    lines[0],
    '{"dfs":"task","id":"11071201-1535-0139-0000-9d2c4f1e0a11","status_code":20000,"tag":"run-7","keyword":"pizza","se_domain":"google.com"}',
  );
  const shown = lines.length - 2;
  assert.equal(
    lines[1],
    `{"type":"organic","rank_absolute":1,"url":"https://example.com/1","description":"${'x'.repeat(150)}"}`,
  );
  assert.equal(
    lines.at(-1),
    `{"dfs":"cut","shown":${shown},"total":100,"more":"dfs store show ${first.id} --from ${shown + 1}"}`,
  );
  const next = await dfs(['store', 'show', first.id, '--from', String(shown + 1)], { env: e });
  assert.equal(next.code, 0);
  const more = next.stdout.split('\n');
  assert.match(more[0], /^\{"dfs":"task","id":"11071201-/);
  assert.equal(JSON.parse(more[1]).rank_absolute, shown + 1);
  assert.ok(next.stdout.length <= 9000);
});

test('an item larger than the budget prints as an outline line', async () => {
  const e = await priced();
  const big = { type: 'organic', rank_absolute: 1, description: 'y'.repeat(12_000) };
  const r = await callAndId(e, [...SERP_ARGV, '--body', '[{"keyword":"pizza"}]'], serp([big]));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    r.stdout.split('\n')[1],
    `{"dfs":"outline","item":1,"keys":{"type":9,"rank_absolute":1,"description":12002},"more":"dfs store show ${r.id} --full"}`,
  );
});

// The unknown-price refusal: price.test.ts (every path has a rule; only a missing tree is unknown).
test('--sandbox sends at est $0 with no price tree; a bad --max-cost exits 3', async () => {
  const live = ['serp', 'google', 'organic', 'live', 'advanced', '--body', '{"keyword":"pizza"}'];
  const { fetch, calls } = fakeFetch(() => json(serp([])));
  const sandbox = await dfs([...live, '--sandbox'], { env: env(), fetch });
  assert.equal(sandbox.code, 0, sandbox.stderr);
  assert.equal(calls[0].url, 'https://sandbox.dataforseo.com/v3/serp/google/organic/live/advanced');
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[0].init?.body, '[{"keyword":"pizza"}]');
  assert.match(sandbox.stderr, / est=\$0 saved=r_/);
  assert.equal((await dfs([...live, '--max-cost', 'lots'], { env: env(), fetch })).code, 3);
});

test('--body takes an object, an array, @file or - for stdin; bad input exits 3', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dfs-body-'));
  const file = join(dir, 'tasks.json');
  writeFileSync(file, '[{"keyword":"a"},{"keyword":"b"}]');
  const argv = ['serp', 'google', 'organic', 'task_post', '--max-cost', '1'];
  const sent = async (body: string, stdin = Readable.from([])) => {
    const { fetch, calls } = fakeFetch(() => json(serp([])));
    const r = await dfs([...argv, '--body', body], { env: await priced(), fetch, stdin });
    assert.equal(r.code, 0, r.stderr);
    return calls[0].init?.body;
  };
  assert.equal(await sent('{"keyword":"a"}'), '[{"keyword":"a"}]');
  assert.equal(await sent(`@${file}`), '[{"keyword":"a"},{"keyword":"b"}]');
  assert.equal(await sent('-', Readable.from(['[{"keyword"', ':"c"}]'])), '[{"keyword":"c"}]');

  const { fetch, calls } = fakeFetch(() => json(serp([])));
  for (const [args, message] of [
    [[...argv, '--body', '{nope'], /^dfs: --body is not JSON: /],
    [[...argv, '--body', '"pizza"'], /^dfs: --body must be a JSON object or array\n$/],
    [[...argv, '--body', '@/no/such/file'], /^dfs: --body @\/no\/such\/file: /],
    [argv, /^dfs: --body required; task fields: dfs schema serp google organic task_post\n$/],
    [
      ['appendix', 'user_data', '--body', '{}'],
      /^dfs: dfs appendix user_data is GET: it takes no --body\n$/,
    ],
  ] as const) {
    const r = await dfs([...args], { env: env(), fetch });
    assert.equal(r.code, 3, args.join(' '));
    assert.match(r.stderr, message);
  }
  assert.equal(calls.length, 0);
});

const envelope = (status_code: number, status_message: string, tasks: unknown[] = []) => ({
  ...USER_DATA,
  status_code,
  status_message,
  tasks_count: tasks.length,
  tasks,
});
const task = (status_code: number, status_message = 'Ok.') => ({
  id: `11071202-0000-0000-0000-${String(status_code).padStart(12, '0')}`,
  status_code,
  status_message,
  result: status_code === 20000 ? [{ timezone: 'UTC' }] : null,
});

test('exit 0, 1, 2 and 6 follow the exit table; every response is saved', async () => {
  // Fresh per call: a retried transient code reads the body again.
  const cases: [string, () => Response, number, RegExp][] = [
    [
      'HTTP 500',
      () => new Response('<html>oops</html>', { status: 500 }),
      1,
      /^dfs: HTTP 500 — full/m,
    ],
    [
      'HTTP 401',
      () => json(envelope(40100, 'You are not authorized.'), 401),
      2,
      /^dfs: 40100 You are not authorized\. — the account owner must act/m,
    ],
    ['HTTP 402', () => json(envelope(40200, 'Payment Required.'), 402), 2, /^dfs: 40200 /m],
    [
      '40501',
      () => json(envelope(40501, 'Invalid Field.')),
      1,
      /^dfs: 40501 Invalid Field\. — full response: dfs store show r_/m,
    ],
    ['50000', () => json(envelope(50000, 'Internal Error.')), 1, /^dfs: 50000 /m],
    [
      'task 40210',
      () => json(envelope(20000, 'Ok.', [task(20000), task(40210, 'Not enough money.')])),
      2,
      /^dfs: task \S+ failed 40210 Not enough money\.$/m,
    ],
    [
      'all tasks failed',
      () => json(envelope(20000, 'Ok.', [task(40501, 'Invalid Field.')])),
      1,
      /^dfs: task \S+ failed 40501 /m,
    ],
    [
      'one task failed',
      () => json(envelope(20000, 'Ok.', [task(20000), task(40501, 'Invalid Field.')])),
      6,
      /^dfs: task \S+ failed 40501 /m,
    ],
    [
      '40102 warning',
      () => json(envelope(20000, 'Ok.', [task(40102, 'No Search Results.')])),
      0,
      /^dfs: 20000 /,
    ],
  ];
  for (const [name, res, exit, stderr] of cases) {
    const e = env();
    const { fetch } = fakeFetch(res);
    const r = await dfs(['appendix', 'user_data'], { env: e, fetch });
    assert.equal(r.code, exit, `${name}: ${r.stderr}`);
    assert.match(r.stderr, stderr, name);
    assert.match(r.stderr, / saved=r_[0-9a-f]+\n/, name);
    assert.equal(rows(e.DFS_CONFIG_DIR).length, 1, name);
  }
});

test('a network error exits 1', async () => {
  const r = await dfs(['appendix', 'user_data'], {
    env: env(),
    fetch: () => Promise.reject(new TypeError('fetch failed')),
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^dfs: network error: fetch failed — /);
});

test('Store: dir 700, file 600, WAL', async () => {
  const e = env();
  await callAndId(e, ['appendix', 'user_data'], USER_DATA);
  assert.equal(statSync(e.DFS_CONFIG_DIR).mode & 0o777, 0o700);
  assert.equal(statSync(join(e.DFS_CONFIG_DIR, 'store.db')).mode & 0o777, 0o600);
  const db = new DatabaseSync(join(e.DFS_CONFIG_DIR, 'store.db'), { readOnly: true });
  assert.deepEqual({ ...db.prepare('PRAGMA journal_mode').get() }, { journal_mode: 'wal' });
  assert.deepEqual({ ...db.prepare('PRAGMA user_version').get() }, { user_version: 6 });
  db.close();
});

test('a failed save keeps the response in unsaved/<id>.json; the next run imports it', async () => {
  const e = env();
  mkdirSync(join(e.DFS_CONFIG_DIR, 'store.db')); // the Store file cannot open
  const r = await callAndId(e, ['appendix', 'user_data'], USER_DATA);
  assert.equal(r.code, 0, r.stderr);
  const file = join(e.DFS_CONFIG_DIR, 'unsaved', `${r.id}.json`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!readFileSync(file, 'utf8').includes('me@example.com'));
  assert.match(
    r.stderr,
    new RegExp(
      `^dfs: warning: Store write failed \\(.*\\); response kept in ${file}, imported on the next run$`,
      'm',
    ),
  );
  assert.match(r.stdout, /^\{"timezone":"UTC"/m);

  rmSync(join(e.DFS_CONFIG_DIR, 'store.db'), { recursive: true });
  const shown = await dfs(['store', 'show', r.id], { env: e });
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(shown.stdout, r.stdout);
  assert.ok(!existsSync(file));
});

test('Store and unsaved/ both failing: full output on stdout, exit 5', async () => {
  const e = env();
  mkdirSync(join(e.DFS_CONFIG_DIR, 'store.db'));
  writeFileSync(join(e.DFS_CONFIG_DIR, 'unsaved'), ''); // a file, so unsaved/ cannot exist
  const r = await callAndId(e, ['appendix', 'user_data'], USER_DATA);
  assert.equal(r.code, 5);
  assert.equal(r.stderr, 'dfs: 5 response not saved — stdout is the only copy\n');
  assert.deepEqual(JSON.parse(r.stdout).tasks[0].result[0].money.balance, 42.5);
});

test('store list stops within 9,000 characters with a cut line', async () => {
  const e = env();
  for (let i = 0; i < 50; i++) await callAndId(e, ['appendix', 'user_data'], USER_DATA);
  const { code, stdout } = await dfs(['store', 'list'], { env: e });
  assert.equal(code, 0);
  assert.ok(stdout.length <= 9000);
  const lines = stdout.trimEnd().split('\n');
  assert.equal(lines.at(-1), `{"dfs":"cut","shown":${lines.length - 1},"total":50}`);
});

test('an unsaved/ row the Store refuses stays on disk', async () => {
  const e = env();
  await dfs(['store', 'list'], { env: e });
  mkdirSync(join(e.DFS_CONFIG_DIR, 'unsaved'));
  const file = join(e.DFS_CONFIG_DIR, 'unsaved', 'r_bad.json');
  writeFileSync(file, '{"id":"r_bad"}'); // NOT NULL columns missing
  const r = await dfs(['store', 'list'], { env: e });
  assert.equal(r.code, 0);
  assert.ok(existsSync(file));
});
