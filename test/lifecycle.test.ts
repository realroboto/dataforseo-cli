import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fakeFetch } from './helpers/fetch.ts';
import { dfs } from './helpers/io.ts';

const LOGIN = { DATAFORSEO_LOGIN: 'me@example.com', DATAFORSEO_PASSWORD: 's3cret' };
const env = () => ({ DFS_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dfs-life-')), ...LOGIN });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const leaf = (cost: number) => ({ priority_normal: [{ cost_type: 'per_request', cost }] });
const USER_DATA = {
  status_code: 20000,
  cost: 0,
  tasks_count: 1,
  tasks: [
    {
      id: 'u1',
      status_code: 20000,
      cost: 0,
      result: [
        { price: { serp: { task_post: leaf(0.0006) }, on_page: { task_post: leaf(0.000125) } } },
      ],
    },
  ],
};
const envelope = (tasks: unknown[], cost = 0) => ({
  status_code: 20000,
  status_message: 'Ok.',
  cost,
  tasks_count: tasks.length,
  tasks,
});

// A fake DataForSEO: task_post creates tasks t1, t2, …; tasks_ready lists `ready()` (ids of
// this run and others); task_get and on_page summary answer one task.
function api(
  opts: {
    ready?: (posted: string[]) => string[];
    crawl?: (id: string) => string;
    get?: (id: string) => { status_code: number; status_message: string } | undefined;
    post?: unknown; // the answer of every task_post
    down?: (path: string) => boolean; // true: this call fails as a network error
  } = {},
) {
  const posted: string[] = [];
  let n = 0;
  const { fetch, calls } = fakeFetch(async (url, init) => {
    const path = new URL(url).pathname;
    if (opts.down?.(path)) throw new TypeError('fetch failed');
    if (path.endsWith('/user_data')) return json(USER_DATA);
    if (path.endsWith('/task_post') && opts.post) return json(opts.post);
    if (path.endsWith('/task_post')) {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>[];
      const tasks = body.map((data) => {
        const id = `t${++n}`;
        posted.push(id);
        return {
          id,
          status_code: 20100,
          status_message: 'Task Created.',
          cost: 0.0006,
          data,
          result: null,
        };
      });
      return json(envelope(tasks, 0.0006 * tasks.length));
    }
    if (path.endsWith('/tasks_ready')) {
      const ids = (opts.ready ?? ((p) => p))(posted);
      return json(
        envelope([{ id: 'r', status_code: 20000, cost: 0, result: ids.map((id) => ({ id })) }]),
      );
    }
    const id = path.split('/').at(-1) as string;
    if (path.includes('/on_page/summary/')) {
      return json(
        envelope([
          {
            id,
            status_code: 20000,
            cost: 0,
            result: [{ crawl_progress: opts.crawl?.(id) ?? 'finished', pages_crawled: 3 }],
          },
        ]),
      );
    }
    if (!path.includes('/task_get/')) throw new Error(`unexpected call ${path}`);
    const code = opts.get?.(id);
    if (code) return json(envelope([{ id, ...code, cost: 0, result: null }]));
    return json(
      envelope([
        {
          id,
          status_code: 20000,
          status_message: 'Ok.',
          cost: 0,
          result: [{ keyword: id, items: [{ rank_group: 1, url: `https://${id}.example` }] }],
        },
      ]),
    );
  });
  return { fetch, calls, posted };
}

// A clock that only sleep moves: the wait loop sees time pass.
function clock() {
  let t = Date.parse('2026-11-07T12:00:00Z');
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance: (ms: number) => {
      t += ms; // a slow answer
    },
  };
}

const ORGANIC = ['serp', 'google', 'organic', '+run', 'advanced'];
const bodyOf = (n: number) =>
  JSON.stringify(Array.from({ length: n }, (_, i) => ({ keyword: `k${i}`, tag: `tag${i}` })));
const paths = (calls: { url: string }[]) =>
  calls.map((c) => new URL(c.url).pathname).filter((p) => !p.endsWith('/user_data'));

function tasks(e: NodeJS.ProcessEnv) {
  const db = new DatabaseSync(join(e.DFS_CONFIG_DIR as string, 'store.db'), { readOnly: true });
  try {
    return db.prepare('SELECT * FROM task ORDER BY rowid').all();
  } finally {
    db.close();
  }
}

test('+run posts 250 tasks in 3 posts under one guard and collects them', async () => {
  const e = env();
  const { fetch, calls } = api();
  const c = clock();
  const r = await dfs([...ORGANIC, '--body', bodyOf(250)], { env: e, fetch, ...c });
  assert.equal(r.code, 0, r.stderr);
  const sent = paths(calls);
  assert.deepEqual(
    sent.filter((p) => p.endsWith('/task_post')),
    Array(3).fill('/v3/serp/google/organic/task_post'),
  );
  const sizes = calls
    .filter((x) => x.url.endsWith('/task_post'))
    .map((x) => JSON.parse(x.init?.body as string).length);
  assert.deepEqual(sizes, [100, 100, 50]);
  assert.equal(sent.filter((p) => p.includes('/task_get/advanced/')).length, 250);
  assert.ok(sent.includes('/v3/serp/google/organic/tasks_ready'));
  const rows = tasks(e) as Record<string, unknown>[];
  assert.equal(rows.length, 250);
  assert.ok(rows.every((t) => t.state === 'collected' && t.collect_response));
  // 250 collected tasks pass the budget: whole tasks, then one cut line naming the Store list.
  assert.ok(
    r.stdout.length + r.stderr.length <= 9000,
    `${r.stdout.length}+${r.stderr.length}\n${r.stdout.slice(-400)}`,
  );
  const last = JSON.parse(r.stdout.trimEnd().split('\n').at(-1) as string);
  assert.equal(last.dfs, 'cut');
  assert.equal(last.total, 250);
  assert.equal(last.more, 'dfs store list');
  assert.equal((r.stdout.match(/"dfs":"task"/g) ?? []).length, last.tasks);
});

test('the guard sums all posts: a refusal sends none', async () => {
  const e = env();
  const { fetch, calls } = api();
  // 100 tasks cost $0.06 each post, $0.15 together; the ceiling is $0.1.
  const r = await dfs([...ORGANIC, '--body', bodyOf(250), '--max-cost', '0.1'], {
    env: e,
    fetch,
    ...clock(),
  });
  assert.equal(r.code, 4, r.stderr);
  assert.deepEqual(paths(calls), []);
});

test('--wait 0: post responses and pending task rows are saved; exit 6 lists every id', async () => {
  const e = env();
  const { fetch, calls } = api();
  const r = await dfs([...ORGANIC, '--body', bodyOf(2), '--wait', '0'], {
    env: e,
    fetch,
    ...clock(),
  });
  assert.equal(r.code, 6, r.stderr);
  assert.deepEqual(paths(calls), ['/v3/serp/google/organic/task_post']);
  assert.match(
    r.stderr,
    /^dfs: 20000 \/v3\/serp\/google\/organic\/task_post tasks=2 cost=\$0\.0012 est=\$0\.0012 saved=r_\w+\n/,
  );
  assert.match(
    r.stderr,
    /\ndfs: task t1 pending 20100\ndfs: task t2 pending 20100\ndfs: 6 2 tasks pending after 0 s — collect them later: dfs \+collect\n$/,
  );
  assert.equal(r.stdout, '');
  const rows = tasks(e).map(({ post_response, posted_at, ...t }) => {
    assert.match(String(post_response), /^r_/);
    assert.equal(posted_at, '2026-11-07T12:00:00.000Z');
    return t;
  });
  const row = (id: string, tag: string) => ({
    id,
    path: '/v3/serp/google/organic/task_post',
    variant: 'advanced',
    state: 'pending',
    status_code: 20100,
    cost: 0.0006,
    tag,
    collected_at: null,
    collect_response: null,
    sandbox: 0,
  });
  assert.deepEqual(
    rows.map((t) => ({ ...t })),
    [row('t1', 'tag0'), row('t2', 'tag1')],
  );
});

test("another run's ready id in tasks_ready is neither fetched nor printed", async () => {
  const e = env();
  const { fetch, calls } = api({ ready: (p) => ['other-1', ...p, 'other-2'] });
  const r = await dfs([...ORGANIC, '--body', bodyOf(1)], { env: e, fetch, ...clock() });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(paths(calls), [
    '/v3/serp/google/organic/task_post',
    '/v3/serp/google/organic/tasks_ready',
    '/v3/serp/google/organic/task_get/advanced/t1',
  ]);
  assert.doesNotMatch(r.stdout + r.stderr, /other-/);
  assert.match(
    r.stdout,
    /^\{"dfs":"task","id":"t1","status_code":20000,"keyword":"t1"\}\n\{"rank_group":1,/,
  );
});

test('polls tasks_ready at 5 s doubling to 30 s; timeout exits 6 with the pending ids', async () => {
  const e = env();
  const queued = { status_code: 40602, status_message: 'Task In Queue.' };
  const { fetch, calls } = api({ ready: () => [], get: () => queued });
  const c = clock();
  const r = await dfs([...ORGANIC, '--body', bodyOf(1)], { env: e, fetch, ...c });
  assert.equal(r.code, 6, r.stderr);
  assert.deepEqual(c.sleeps, [5000, 10_000, 20_000, 30_000, 25_000]);
  assert.equal(paths(calls).filter((p) => p.endsWith('/tasks_ready')).length, 5);
  assert.match(
    r.stderr,
    /dfs: task t1 pending 40602\ndfs: 6 1 tasks pending after 90 s — collect them later: dfs \+collect\n$/,
  );
});

// tasks_ready lists at most 1000 tasks and never a postback_url task (vendor docs).
test('the last poll collects own pending ids that tasks_ready did not list', async () => {
  const e = env();
  const { fetch, calls } = api({ ready: () => [] });
  const r = await dfs([...ORGANIC, '--body', bodyOf(1), '--wait', '5'], {
    env: e,
    fetch,
    ...clock(),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(paths(calls).slice(1), [
    '/v3/serp/google/organic/tasks_ready',
    '/v3/serp/google/organic/task_get/advanced/t1',
  ]);
});

test('on_page collects through summary/{id} and stays pending until crawl_progress is finished', async () => {
  const e = env();
  let polls = 0;
  const { fetch, calls } = api({ crawl: () => (++polls < 2 ? 'in_progress' : 'finished') });
  const body = JSON.stringify({ target: 'example.com', max_crawl_pages: 10 });
  const r = await dfs(['on_page', '+run', '--body', body], { env: e, fetch, ...clock() });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(paths(calls), [
    '/v3/on_page/task_post',
    '/v3/on_page/tasks_ready',
    '/v3/on_page/summary/t1',
    '/v3/on_page/tasks_ready',
    '/v3/on_page/summary/t1',
  ]);
  const [t] = tasks(e);
  assert.equal(t.state, 'collected');
  assert.equal(t.variant, null);
  assert.match(r.stdout, /"crawl_progress":"finished"/);
});

test('on_page with the crawl unfinished at timeout stays pending, exit 6', async () => {
  const e = env();
  const { fetch } = api({ crawl: () => 'in_progress' });
  const body = JSON.stringify({ target: 'example.com', max_crawl_pages: 10 });
  const r = await dfs(['on_page', '+run', '--body', body, '--wait', '5'], {
    env: e,
    fetch,
    ...clock(),
  });
  assert.equal(r.code, 6, r.stderr);
  assert.equal(tasks(e)[0].state, 'pending');
  assert.match(r.stderr, /dfs: task t1 pending 20000\n/);
});

test('exit 6 with 100 pending tasks of real id length prints every id within 9,000 characters', async () => {
  const { fetch } = api();
  const real = async (url: string, init?: RequestInit) => {
    const res = await fetch(url, init);
    if (!url.endsWith('/task_post')) return res;
    const b = await res.json();
    for (const t of b.tasks) t.id = `11071200-1535-0066-0000-${t.id.padStart(12, '0')}`;
    return json(b);
  };
  const r = await dfs([...ORGANIC, '--body', bodyOf(100), '--wait', '0'], {
    env: env(),
    fetch: real,
    ...clock(),
  });
  assert.equal(r.code, 6, r.stderr);
  assert.ok(r.stdout.length + r.stderr.length <= 9000);
  assert.equal((r.stderr.match(/^dfs: task \S+ pending 20100$/gm) ?? []).length, 100);
});

test('exit 6 task lines beyond the budget become a task +<n> more line', async () => {
  const e = env();
  const { fetch } = api();
  // Long ids: 100 task lines pass the budget.
  const long = async (url: string, init?: RequestInit) => {
    const res = await fetch(url, init);
    if (!url.endsWith('/task_post')) return res;
    const b = await res.json();
    for (const t of b.tasks)
      t.id = `11071200-1535-0066-0000-${t.id.padStart(12, '0')}-pending-${'x'.repeat(40)}`;
    return json(b);
  };
  const r = await dfs([...ORGANIC, '--body', bodyOf(100), '--wait', '0'], {
    env: e,
    fetch: long,
    ...clock(),
  });
  assert.equal(r.code, 6, r.stderr);
  assert.ok(r.stdout.length + r.stderr.length <= 9000, String(r.stderr.length));
  const more = /dfs: task \+(\d+) more — states in the Store table task\n/.exec(r.stderr);
  assert.ok(more, r.stderr.slice(-300));
  const lines = r.stderr.match(/^dfs: task \S+ pending 20100$/gm) ?? [];
  assert.equal(lines.length + Number(more[1]), 100);
  assert.match(
    r.stderr,
    /dfs: 6 100 tasks pending after 0 s — collect them later: dfs \+collect\n$/,
  );
});

test('+run exists only at levels with task_post and a collect call; variant optional with one path', async () => {
  const e = env();
  const no = await dfs(['serp', 'google', '+run', '--body', '{}'], { env: e });
  assert.equal(no.code, 3);
  assert.match(
    no.stderr,
    /^dfs: dfs serp google has no \+run: it needs task_post and a collect call\n$/,
  );
  const need = await dfs(['serp', 'google', 'organic', '+run', '--body', '{}'], { env: e });
  assert.equal(need.code, 3);
  assert.match(need.stderr, /\+run needs a variant: regular, advanced, html\n$/);
  const bad = await dfs(['serp', 'google', 'organic', '+run', 'json', '--body', '{}'], { env: e });
  assert.match(bad.stderr, /unknown \+run variant 'json'; want one of: regular, advanced, html\n$/);
  // One collect path with no variant word: keywords_data bare task_get/{id}.
  const { fetch, calls } = api();
  const kw = await dfs(
    [
      'keywords_data',
      'google_ads',
      'search_volume',
      '+run',
      '--body',
      '{"keywords":["pizza"]}',
      '--wait',
      '0',
      '--max-cost',
      '1',
    ],
    { env: e, fetch, ...clock() },
  );
  assert.equal(kw.code, 6, kw.stderr);
  assert.deepEqual(paths(calls), ['/v3/keywords_data/google_ads/search_volume/task_post']);
  // One variant word: optional.
  const maps = await dfs(
    [
      'serp',
      'google',
      'maps',
      '+run',
      '--body',
      '{"keyword":"pizza"}',
      '--wait',
      '0',
      '--max-cost',
      '1',
    ],
    { env: e, fetch, ...clock() },
  );
  assert.equal(maps.code, 6, maps.stderr);
  assert.equal(tasks(e).at(-1)?.variant, 'advanced');
});

test('+run --help prints its usage; the level help lists +run', async () => {
  const h = await dfs(['serp', 'google', 'organic', '+run', '--help']);
  assert.equal(h.code, 0);
  assert.equal(
    h.stdout,
    'usage: dfs serp google organic +run <regular|advanced|html> --body <json|@file|-> [--wait <s>] [--full] [--sandbox] [--max-cost <usd>] [--fresh] [--no-validate]\n',
  );
  const level = await dfs(['serp', 'google', 'organic', '--help']);
  assert.match(
    level.stdout,
    /\n {2}\+run {2}post, wait and collect tasks: dfs serp google organic \+run --help\n/,
  );
  const root = await dfs([]);
  assert.match(root.stdout, /<level> \+run/);
});

test('a repeated +run in the reuse window posts nothing and prints the stored collect', async () => {
  const e = env();
  const { fetch, calls } = api();
  const first = await dfs([...ORGANIC, '--body', bodyOf(1)], { env: e, fetch, ...clock() });
  assert.equal(first.code, 0, first.stderr);
  const n = calls.length;
  const again = await dfs([...ORGANIC, '--body', bodyOf(1)], { env: e, fetch, ...clock() });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(calls.length, n);
  assert.match(
    again.stderr,
    /^dfs: 20000 \/v3\/serp\/google\/organic\/task_post tasks=1 cost=\$0 est=\$0 reused=r_\w+ age=0s\n$/,
  );
  assert.equal(again.stdout, first.stdout);
});

test('a replayed +run post inserts its missing task rows and keeps the stored ones', async () => {
  const e = env();
  const { fetch, calls } = api();
  const first = await dfs([...ORGANIC, '--body', bodyOf(2)], { env: e, fetch, ...clock() });
  assert.equal(first.code, 0, first.stderr);
  // t2's row is lost (a refused task row write): the replay writes it again, pending.
  const db = new DatabaseSync(join(e.DFS_CONFIG_DIR as string, 'store.db'));
  db.exec("DELETE FROM task WHERE id = 't2'");
  db.close();
  const n = calls.length;
  const argv = [...ORGANIC, '--body', bodyOf(2), '--wait', '0'];
  const again = await dfs(argv, { env: e, fetch, ...clock() });
  assert.equal(again.code, 6, again.stderr);
  assert.equal(calls.length, n);
  assert.match(again.stderr, /\ndfs: task t2 pending 20100\n/);
  assert.deepEqual(
    tasks(e).map((t) => ({ id: t.id, state: t.state })),
    [
      { id: 't1', state: 'collected' },
      { id: 't2', state: 'pending' },
    ],
  );
});

// Epic #32 D10: a +run post warns as a plain call does, after its status line.
test('a +run post above its estimate warns after its status line', async () => {
  const task = { id: 't1', status_code: 20100, status_message: 'Task Created.', cost: 0.002 };
  const { fetch } = api({ post: envelope([{ ...task, result: null }], 0.002) });
  const argv = [...ORGANIC, '--body', bodyOf(1), '--wait', '0'];
  const r = await dfs(argv, { env: env(), fetch, ...clock() });
  assert.equal(r.code, 6, r.stderr);
  assert.match(
    r.stderr,
    /^dfs: 20000 \/v3\/serp\/google\/organic\/task_post tasks=1 cost=\$0\.002 est=\$0\.0006 saved=r_\w+\ndfs: warning: real cost \$0\.002 above estimate \$0\.0006 for \/v3\/serp\/google\/organic\/task_post — the price rule may be out of date\n/,
  );
});

test('a +run post prints its status line before its save warning', async () => {
  const e = env();
  const { fetch } = api();
  const argv = (n: number) => [...ORGANIC, '--body', bodyOf(n), '--wait', '0'];
  assert.equal((await dfs(argv(1), { env: e, fetch, ...clock() })).code, 6);
  // Every response insert fails: the post response falls back to unsaved/.
  const db = new DatabaseSync(join(e.DFS_CONFIG_DIR as string, 'store.db'));
  db.exec(
    "CREATE TRIGGER refuse BEFORE INSERT ON response BEGIN SELECT RAISE(ABORT, 'refused'); END",
  );
  db.close();
  const r = await dfs(argv(2), { env: e, fetch, ...clock() });
  assert.equal(r.code, 6, r.stderr);
  assert.match(
    r.stderr,
    /^dfs: 20000 \/v3\/serp\/google\/organic\/task_post tasks=2 cost=\$0\.0012 est=\$0\.0012 saved=(r_\w+)\ndfs: warning: Store write failed \(refused\); response kept in \S+\/unsaved\/\1\.json, imported on the next run\n/,
  );
});

test('collect codes: 20100 and 40602 stay pending, 40403 expires, other codes fail; exit 6', async () => {
  const e = env();
  const codes: Record<string, { status_code: number; status_message: string }> = {
    t1: { status_code: 20100, status_message: 'Task Created.' },
    t2: { status_code: 40602, status_message: 'Task In Queue.' },
    t3: { status_code: 40403, status_message: 'Results Expired.' },
    t4: { status_code: 40501, status_message: 'Invalid Field.' },
  };
  const { fetch } = api({ get: (id) => codes[id] });
  const r = await dfs([...ORGANIC, '--body', bodyOf(5), '--wait', '5'], {
    env: e,
    fetch,
    ...clock(),
  });
  assert.equal(r.code, 6, r.stderr);
  assert.deepEqual(
    tasks(e).map((t) => [t.id, t.state, t.status_code]),
    [
      ['t1', 'pending', 20100],
      ['t2', 'pending', 40602],
      ['t3', 'expired', 40403],
      ['t4', 'failed', 40501],
      ['t5', 'collected', 20000],
    ],
  );
  assert.match(
    r.stderr,
    /\ndfs: task t1 pending 20100\ndfs: task t2 pending 40602\ndfs: task t3 expired 40403\ndfs: task t4 failed 40501 Invalid Field\.\ndfs: 6 2 tasks pending after 5 s/,
  );
  assert.match(r.stdout, /"id":"t5"/);
});

test('every task failed at collect: exit 1', async () => {
  const { fetch } = api({ get: () => ({ status_code: 40501, status_message: 'Invalid Field.' }) });
  const r = await dfs([...ORGANIC, '--body', bodyOf(2), '--wait', '5'], {
    env: env(),
    fetch,
    ...clock(),
  });
  assert.equal(r.code, 1, r.stderr);
});

test('a failed post prints its error, sends no later post, waits for nothing; exit 2 on account codes', async () => {
  const post = {
    status_code: 40200,
    status_message: 'Payment Required.',
    cost: 0,
    tasks_count: 0,
    tasks: [],
  };
  const { fetch, calls } = api({ post });
  const r = await dfs([...ORGANIC, '--body', bodyOf(150)], { env: env(), fetch, ...clock() });
  assert.equal(r.code, 2, r.stderr);
  assert.deepEqual(paths(calls), ['/v3/serp/google/organic/task_post']);
  assert.match(r.stderr, /\ndfs: 40200 Payment Required\. — the account owner must act/);
});

const NOT_COLLECTED = (id: string) =>
  `dfs: task ${id} not collected: network error: fetch failed — check the network; see: dfs store list\n`;

test('a collect that fails after its retries keeps the task pending, and the report prints; exit 1', async () => {
  const { fetch, calls } = api({ down: (path) => path.endsWith('/t2') });
  const r = await dfs([...ORGANIC, '--body', bodyOf(3), '--wait', '5'], {
    env: env(),
    fetch,
    ...clock(),
  });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stdout, /t1\.example[\s\S]*t3\.example/);
  assert.ok(
    r.stderr.endsWith(
      `${NOT_COLLECTED('t2')}dfs: 6 1 tasks pending after 5 s — collect them later: dfs +collect\n`,
    ),
    r.stderr,
  );
  assert.equal(
    paths(calls).filter((p) => p.endsWith('/t2')).length,
    5,
    'Transport retries 4 times',
  );
});

test('a collect that fails, then succeeds on a later poll: exit 0', async () => {
  let n = 0;
  const { fetch } = api({ down: (path) => path.endsWith('/t2') && ++n <= 5 });
  const r = await dfs([...ORGANIC, '--body', bodyOf(2)], { env: env(), fetch, ...clock() });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(n, 6);
  assert.match(r.stdout, /t2\.example/);
  assert.doesNotMatch(r.stderr, /not collected/);
});

test('a failed tasks_ready warns, and polling continues', async () => {
  let n = 0;
  // Two polls fail (5 attempts each); one warning per text keeps the budget.
  const { fetch, calls } = api({ down: (path) => path.endsWith('/tasks_ready') && ++n <= 10 });
  const r = await dfs([...ORGANIC, '--body', bodyOf(1)], { env: env(), fetch, ...clock() });
  assert.equal(r.code, 0, r.stderr);
  const warning =
    'dfs: warning: tasks_ready failed: network error: fetch failed — check the network; see: dfs store list\n';
  assert.equal(r.stderr.split(warning).length, 2, r.stderr);
  assert.deepEqual(paths(calls).slice(-2), [
    '/v3/serp/google/organic/tasks_ready',
    '/v3/serp/google/organic/task_get/advanced/t1',
  ]);
});

test('a post that loses its connection: no later post, no poll, then the report; exit 1', async () => {
  let n = 0;
  const { fetch, calls } = api({ down: (path) => path.endsWith('/task_post') && ++n === 2 });
  const r = await dfs([...ORGANIC, '--body', bodyOf(250)], { env: env(), fetch, ...clock() });
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(paths(calls), Array(2).fill('/v3/serp/google/organic/task_post'));
  assert.match(
    r.stderr,
    /\ndfs: connection lost after send: fetch failed — money may be spent; dfs \+collect recovers it\ndfs: task t1 pending 20100\n/,
  );
  assert.ok(
    r.stderr.endsWith(
      'dfs: task t100 pending 20100\ndfs: 6 100 tasks pending — collect them later: dfs +collect\n',
    ),
    r.stderr,
  );
});

// Deadline (transport.md): no retry starts after it.
test('a free request of +run starts no retry after the --wait deadline', async () => {
  let n = 0;
  const { fetch, calls } = api({ down: (path) => path.endsWith('/tasks_ready') && ++n === 1 });
  const c = clock();
  const r = await dfs([...ORGANIC, '--body', bodyOf(1), '--wait', '6'], {
    env: env(),
    fetch,
    ...c,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(c.sleeps, [5000, 1000], 'the 1 s left is too short for a retry');
  assert.match(r.stderr, /dfs: warning: tasks_ready failed: network error: fetch failed/);
  assert.equal(paths(calls).filter((p) => p.endsWith('/tasks_ready')).length, 2);
});

// Never answers until the timeout aborts it; a request with no timeout fails at once.
function stall(init?: RequestInit): Promise<Response> {
  const signal = init?.signal;
  if (!signal) return Promise.reject(new Error('no timeout on this request'));
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
}
const tick = () => new Promise((r) => setImmediate(r));

test('free requests of +run end at the --wait deadline; the last poll gets one 130 s timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-07T12:00:00Z') });
  // One clock: sleeps and request timers both move mock time.
  const time = { now: () => Date.now(), sleep: async (ms: number) => t.mock.timers.tick(ms) };
  const cases = [
    // The 5 s poll of --wait 20 has 15 s left; it ends at the deadline, so its collect is direct.
    {
      wait: '20',
      stalled: '/tasks_ready',
      listed: true,
      limit: 15_000,
      code: 0,
      line: 'dfs: warning: tasks_ready failed: network error: no answer before the deadline — ',
    },
    // Outcome left to the last-poll rule (B4).
    { wait: '20', stalled: '/task_get/', listed: true, limit: 15_000 },
    // The last poll starts at the deadline: one Transport timeout from then.
    {
      wait: '5',
      stalled: '/task_get/',
      listed: false,
      limit: 130_000,
      code: 1,
      line: 'dfs: task t1 not collected: network error: no answer in 130 s — ',
    },
  ];
  for (const { wait, stalled, listed, limit, code, line } of cases) {
    const name = `--wait ${wait} ${stalled}`;
    const t0 = Date.now();
    const inner = api({ ready: listed ? undefined : () => [] });
    let first = true; // only the first request to `stalled` stalls
    const { fetch, calls } = fakeFetch((url, init) => {
      if (!first || !url.includes(stalled)) return inner.fetch(url, init);
      first = false;
      return stall(init);
    });
    const run = dfs([...ORGANIC, '--body', bodyOf(1), '--wait', wait], {
      env: env(),
      fetch,
      ...time,
    });
    while (first) await tick();
    const signal = calls.find((c) => c.url.includes(stalled))?.init?.signal;
    t.mock.timers.tick(limit - 1);
    await tick();
    assert.equal(signal?.aborted, false, name);
    t.mock.timers.tick(1);
    await tick();
    assert.equal(signal?.aborted, true, name);
    const r = await run;
    if (code === undefined) continue;
    assert.equal(r.code, code, r.stderr);
    assert.ok(r.stderr.includes(line), r.stderr);
    assert.equal(calls.filter((c) => c.url.includes(stalled)).length, 1, `${name}: no retry`);
    assert.equal(Date.now() - t0, 5000 + limit, name);
  }
});

test('--wait takes a finite number of seconds, 0 or more', async () => {
  for (const w of ['-1', 'soon', 'Infinity', '']) {
    const r = await dfs([...ORGANIC, '--body', bodyOf(1), `--wait=${w}`], { env: env() });
    assert.equal(r.code, 3, w);
    assert.match(r.stderr, /want a number of seconds, 0 or more/);
  }
});

// B4: the t1 collect of the 5 s poll answers past the --wait 20 deadline; t2 is never listed
// (a postback_url task). `readyDown`: the last tasks_ready fails.
async function pastDeadline(readyDown: boolean) {
  const c = clock();
  const inner = api({ ready: () => ['t1'] });
  let readies = 0;
  let late = true;
  const { fetch, calls } = fakeFetch((url, init) => {
    if (url.endsWith('/tasks_ready') && ++readies > 1 && readyDown) {
      throw new TypeError('fetch failed');
    }
    if (late && url.endsWith('/t1')) {
      late = false;
      c.advance(20_000);
    }
    return inner.fetch(url, init);
  });
  const r = await dfs([...ORGANIC, '--body', bodyOf(2), '--wait', '20'], {
    env: env(),
    fetch,
    ...c,
  });
  return { r, paths: paths(calls).slice(1), sleeps: c.sleeps };
}

const READY = '/v3/serp/google/organic/tasks_ready';
const GET = (id: string) => `/v3/serp/google/organic/task_get/advanced/${id}`;

test('collects that pass the --wait deadline: the last poll still collects the unlisted own task', async () => {
  const { r, paths, sleeps } = await pastDeadline(false);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(sleeps, [5000]);
  assert.deepEqual(paths, [READY, GET('t1'), READY, GET('t2')]);
  assert.match(r.stdout, /t1\.example[\s\S]*t2\.example/);
});

test('a failed last tasks_ready still runs the direct collects', async () => {
  const { r, paths } = await pastDeadline(true);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(paths, [READY, GET('t1'), ...Array(5).fill(READY), GET('t2')]);
  assert.match(r.stderr, /dfs: warning: tasks_ready failed: network error: fetch failed/);
  assert.match(r.stdout, /t2\.example/);
});

const UNAUTHORIZED = {
  status_code: 40100,
  status_message: 'You are not authorized to access this resource.',
  cost: 0,
  tasks_count: 0,
  tasks: null,
};
const OWNER = 'the account owner must act: check credentials, balance and limits';
const notFound = () =>
  json(
    { status_code: 40400, status_message: 'Not Found.', cost: 0, tasks_count: 0, tasks: [] },
    404,
  );

// B5: account class at once, no further poll and no last poll.
test('a collect envelope 40100 exits 2: no further poll, no last poll', async () => {
  const c = clock();
  const inner = api();
  const { fetch, calls } = fakeFetch((url, init) =>
    url.endsWith('/t1') ? json(UNAUTHORIZED) : inner.fetch(url, init),
  );
  const e = env();
  const r = await dfs([...ORGANIC, '--body', bodyOf(2), '--wait', '20'], { env: e, fetch, ...c });
  assert.equal(r.code, 2, r.stderr);
  assert.deepEqual(c.sleeps, [5000]);
  assert.deepEqual(paths(calls).slice(1).toSorted(), [READY, GET('t1'), GET('t2')].toSorted());
  assert.equal(r.stderr.split(`dfs: 40100 ${UNAUTHORIZED.status_message} — ${OWNER}\n`).length, 2);
  assert.ok(
    r.stderr.endsWith(
      'dfs: task t1 pending 20100\ndfs: 6 1 tasks pending — collect them later: dfs +collect\n',
    ),
    r.stderr,
  );
  assert.match(r.stdout, /t2\.example/);
  assert.deepEqual(
    tasks(e).map((t) => [t.id, t.state]),
    [
      ['t1', 'pending'],
      ['t2', 'collected'],
    ],
  );
});

test('tasks_ready: a 401 sends no further poll and exits 2; another envelope failure warns, polling goes on', async () => {
  const c = clock();
  const inner = api();
  const { fetch, calls } = fakeFetch((url, init) =>
    url.endsWith('/tasks_ready')
      ? new Response('Unauthorized', { status: 401 })
      : inner.fetch(url, init),
  );
  const r = await dfs([...ORGANIC, '--body', bodyOf(1)], { env: env(), fetch, ...c });
  assert.equal(r.code, 2, r.stderr);
  assert.deepEqual(c.sleeps, [5000]);
  assert.deepEqual(paths(calls).slice(1), [READY]);
  assert.ok(
    r.stderr.endsWith(
      `dfs: HTTP 401 — ${OWNER}\ndfs: task t1 pending 20100\ndfs: 6 1 tasks pending — collect them later: dfs +collect\n`,
    ),
    r.stderr,
  );

  // Not account: one warning per text, then the next poll lists t1.
  let n = 0;
  const other = api();
  const flaky = fakeFetch((url, init) =>
    url.endsWith('/tasks_ready') && ++n <= 2 ? notFound() : other.fetch(url, init),
  );
  const ok = await dfs([...ORGANIC, '--body', bodyOf(1)], {
    env: env(),
    fetch: flaky.fetch,
    ...clock(),
  });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(
    ok.stderr.match(
      /dfs: warning: tasks_ready failed: 40400 Not Found\. — full response: dfs store show r_\w+ --full\n/g,
    )?.length,
    1,
    ok.stderr,
  );
  assert.deepEqual(paths(flaky.calls).slice(1), [READY, READY, READY, GET('t1')]);
});

test('a collect envelope failure, not account, keeps the task pending: exit 1', async () => {
  const inner = api();
  const { fetch } = fakeFetch((url, init) =>
    url.endsWith('/t2') ? notFound() : inner.fetch(url, init),
  );
  const e = env();
  const r = await dfs([...ORGANIC, '--body', bodyOf(2), '--wait', '5'], {
    env: e,
    fetch,
    ...clock(),
  });
  assert.equal(r.code, 1, r.stderr);
  assert.match(
    r.stderr,
    /\ndfs: task t2 not collected: 40400 Not Found\. — full response: dfs store show r_\w+ --full\ndfs: 6 1 tasks pending after 5 s — collect them later: dfs \+collect\n$/,
  );
  assert.match(r.stdout, /t1\.example/);
  assert.deepEqual(
    tasks(e).map((t) => [t.id, t.state, t.status_code]),
    [
      ['t1', 'collected', 20000],
      ['t2', 'pending', 20100],
    ],
  );
});

test('a collect envelope failure, then a success on a later poll: exit 0', async () => {
  let n = 0;
  const inner = api();
  const { fetch } = fakeFetch((url, init) =>
    url.endsWith('/t2') && ++n === 1 ? notFound() : inner.fetch(url, init),
  );
  const r = await dfs([...ORGANIC, '--body', bodyOf(2)], { env: env(), fetch, ...clock() });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(n, 2);
  assert.match(r.stdout, /t2\.example/);
  assert.doesNotMatch(r.stderr, /not collected/);
});
