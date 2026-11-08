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
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
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
  } = {},
) {
  const posted: string[] = [];
  let n = 0;
  const { fetch, calls } = fakeFetch(async (url, init) => {
    const path = new URL(url).pathname;
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
  const { fetch, calls } = api({ ready: () => [] });
  const c = clock();
  const r = await dfs([...ORGANIC, '--body', bodyOf(1)], { env: e, fetch, ...c });
  assert.equal(r.code, 6, r.stderr);
  assert.deepEqual(c.sleeps, [5000, 10_000, 20_000, 30_000, 25_000]);
  assert.equal(paths(calls).filter((p) => p.endsWith('/tasks_ready')).length, 5);
  assert.match(
    r.stderr,
    /dfs: task t1 pending 20100\ndfs: 6 1 tasks pending after 90 s — collect them later: dfs \+collect\n$/,
  );
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

test('--wait takes a finite number of seconds, 0 or more', async () => {
  for (const w of ['-1', 'soon', 'Infinity', '']) {
    const r = await dfs([...ORGANIC, '--body', bodyOf(1), `--wait=${w}`], { env: env() });
    assert.equal(r.code, 3, w);
    assert.match(r.stderr, /want a number of seconds, 0 or more/);
  }
});
