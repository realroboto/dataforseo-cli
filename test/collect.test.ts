import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Io } from '../src/run.ts';
import { fakeFetch } from './helpers/fetch.ts';
import { dfs } from './helpers/io.ts';

const LOGIN = { DATAFORSEO_LOGIN: 'me@example.com', DATAFORSEO_PASSWORD: 's3cret' };
const env = () => ({ DFS_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dfs-collect-')), ...LOGIN });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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
        {
          price: {
            serp: { task_post: { priority_normal: [{ cost_type: 'per_request', cost: 0.0006 }] } },
          },
        },
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
type Lost = { id: string; url: string; cost?: number; datetime_posted?: string };

// A fake DataForSEO: task_post creates t1, t2, …; id_list answers `lost[module]`; a collect call
// answers 20000 unless `get` names a code.
function api(
  opts: {
    lost?: Record<string, Lost[]>;
    idList?: (module: string) => Response | undefined;
    get?: (id: string) => number | undefined;
    cost?: number; // cost of a task in collect answers
  } = {},
) {
  let n = 0;
  const { fetch, calls } = fakeFetch(async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/user_data')) return json(USER_DATA);
    if (path.endsWith('/task_post')) {
      const body = JSON.parse(init?.body as string) as unknown[];
      const tasks = body.map((data) => ({
        id: `t${++n}`,
        status_code: 20100,
        status_message: 'Task Created.',
        cost: 0.0006,
        data,
        result: null,
      }));
      return json(envelope(tasks, 0.0006 * tasks.length));
    }
    if (path.endsWith('/id_list')) {
      const module = path.split('/')[2];
      const own = opts.idList?.(module);
      if (own) return own;
      const result = (opts.lost?.[module] ?? []).map((l) => ({
        datetime_posted: '2026-11-07 11:00:00 +00:00',
        datetime_done: '2026-11-07 11:00:05 +00:00',
        status: 'Ok.',
        cost: 0.0006,
        metadata: null,
        ...l,
      }));
      return json(envelope([{ id: 'l', status_code: 20000, cost: 0, result }]));
    }
    const id = path.split('/').at(-1) as string;
    const code = opts.get?.(id) ?? 20000;
    const result =
      code === 20000
        ? [{ keyword: id, crawl_progress: 'finished', items: [{ rank_group: 1 }] }]
        : null;
    return json(
      envelope([
        { id, status_code: code, status_message: `code ${code}`, cost: opts.cost ?? 0, result },
      ]),
    );
  });
  return { fetch, calls };
}

const now = () => Date.parse('2026-11-07T12:00:00Z');
const paths = (calls: { url: string }[]) =>
  calls.map((c) => new URL(c.url).pathname).filter((p) => !p.endsWith('/user_data'));

function query(e: NodeJS.ProcessEnv, sql: string) {
  const db = new DatabaseSync(join(e.DFS_CONFIG_DIR as string, 'store.db'), { readOnly: true });
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

const post = (e: NodeJS.ProcessEnv, fetch: Io['fetch'], variant = 'regular') =>
  dfs(['serp', 'google', 'organic', '+run', variant, '--body', '{"keyword":"k"}', '--wait', '0'], {
    env: e,
    fetch,
    now,
  });

test('+collect collects a pending task through its stored variant and never re-posts', async () => {
  const e = env();
  const { fetch, calls } = api();
  assert.equal((await post(e, fetch)).code, 6);
  const n = calls.length;
  const r = await dfs(['+collect'], { env: e, fetch, now });
  assert.equal(r.code, 0, r.stderr);
  const sent = paths(calls.slice(n));
  assert.ok(sent.includes('/v3/serp/google/organic/task_get/regular/t1'), sent.join('\n'));
  assert.ok(!sent.some((p) => p.endsWith('/task_post')));
  assert.match(r.stdout, /"id":"t1"/);
  const [t] = query(e, 'SELECT state, collect_response FROM task');
  assert.equal(t.state, 'collected');
  assert.match(String(t.collect_response), /^r_/);
  // One sync row per module with an id_list, at the pass time.
  const sync = query(e, 'SELECT module, last_pass FROM sync ORDER BY module');
  assert.deepEqual(
    sync.map((s) => s.module),
    [
      'ai_optimization',
      'app_data',
      'backlinks',
      'business_data',
      'content_analysis',
      'dataforseo_labs',
      'domain_analytics',
      'keywords_data',
      'merchant',
      'on_page',
      'serp',
    ],
  );
  assert.ok(sync.every((s) => s.last_pass === '2026-11-07T12:00:00.000Z'));
});

const earlier = () => Date.parse('2026-11-07T10:00:00Z');
const idListBodies = (calls: { url: string; init?: RequestInit }[], module: string) =>
  calls
    .filter((c) => c.url.endsWith(`/v3/${module}/id_list`))
    .map((c) => JSON.parse(c.init?.body as string)[0]);

test('lost ids map to the longest level of their url; first pass starts at Store creation', async () => {
  const e = env();
  const { fetch, calls } = api({
    lost: {
      keywords_data: [
        {
          id: 'kw1',
          url: 'https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/task_post',
        },
      ],
      on_page: [
        { id: 'op1', url: 'https://api.dataforseo.com/v3/on_page/task_post' },
        { id: 'lh1', url: 'https://api.dataforseo.com/v3/on_page/lighthouse/task_post' },
      ],
      serp: [
        { id: 'sp1', url: 'https://api.dataforseo.com/v3/serp/google/organic/task_post' },
        { id: 'zz1', url: 'https://api.dataforseo.com/v3/serp/nowhere/task_post' },
      ],
    },
  });
  // The Store is created at 10:00 by its first response.
  assert.equal(
    (
      await dfs(
        [
          'serp',
          'google',
          'organic',
          '+run',
          'advanced',
          '--body',
          '{"keyword":"k"}',
          '--wait',
          '0',
        ],
        { env: e, fetch, now: earlier },
      )
    ).code,
    6,
  );
  const n = calls.length;
  const r = await dfs(['+collect'], { env: e, fetch, now });
  assert.equal(r.code, 0, r.stderr); // zz1 only warns
  const sent = paths(calls.slice(n)).filter((p) => !p.endsWith('/id_list'));
  assert.deepEqual(sent.toSorted(), [
    '/v3/keywords_data/google_ads/search_volume/task_get/kw1',
    '/v3/on_page/lighthouse/task_get/json/lh1',
    '/v3/on_page/summary/op1',
    '/v3/serp/google/organic/task_get/advanced/sp1',
    '/v3/serp/google/organic/task_get/advanced/t1',
  ]);
  assert.match(
    r.stderr,
    /dfs: warning: task zz1: https:\/\/api\.dataforseo\.com\/v3\/serp\/nowhere\/task_post maps to no collect call — not collected\n/,
  );
  const serp = idListBodies(calls, 'serp');
  assert.deepEqual(serp, [
    {
      datetime_from: '2026-11-07 10:00:00 +00:00',
      datetime_to: '2026-11-07 12:00:00 +00:00',
      limit: 1000,
      offset: 0,
      sort: 'asc',
    },
  ]);
  const rows = query(e, 'SELECT id, path, variant, state, cost FROM task ORDER BY id');
  assert.deepEqual(
    rows.map((t) => ({ ...t })),
    [
      {
        id: 'kw1',
        path: '/v3/keywords_data/google_ads/search_volume/task_post',
        variant: null,
        state: 'collected',
        cost: 0.0006,
      },
      {
        id: 'lh1',
        path: '/v3/on_page/lighthouse/task_post',
        variant: 'json',
        state: 'collected',
        cost: 0.0006,
      },
      { id: 'op1', path: '/v3/on_page/task_post', variant: null, state: 'collected', cost: 0.0006 },
      {
        id: 'sp1',
        path: '/v3/serp/google/organic/task_post',
        variant: 'advanced',
        state: 'collected',
        cost: 0.0006,
      },
      {
        id: 't1',
        path: '/v3/serp/google/organic/task_post',
        variant: 'advanced',
        state: 'collected',
        cost: 0.0006,
      },
      {
        id: 'zz1',
        path: '/v3/serp/nowhere/task_post',
        variant: null,
        state: 'failed',
        cost: 0.0006,
      },
    ],
  );
});

const store10 = async (e: NodeJS.ProcessEnv, fetch: Io['fetch']) =>
  // A Store created at 10:00: its first response.
  dfs(['appendix', 'user_data'], { env: e, fetch, now: earlier });

test('ai_optimization lost id recovers through the id_list hand path', async () => {
  const e = env();
  const url = 'https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_responses/task_post';
  const { fetch, calls } = api({ lost: { ai_optimization: [{ id: 'ai1', url }] } });
  await store10(e, fetch);
  const r = await dfs(['ai_optimization', '+collect'], { env: e, fetch, now });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(paths(calls), [
    '/v3/ai_optimization/id_list',
    '/v3/ai_optimization/chat_gpt/llm_responses/task_get/ai1',
  ]);
  assert.deepEqual(
    query(e, 'SELECT module FROM sync').map((s) => s.module),
    ['ai_optimization'],
  );
});

for (const [name, answer] of [
  ['HTTP 404', () => new Response('Not Found', { status: 404 })],
  [
    '40400',
    () =>
      json(
        { status_code: 40400, status_message: 'Not Found.', cost: 0, tasks_count: 0, tasks: [] },
        404,
      ),
  ],
  [
    '40402',
    () =>
      json(
        envelope([
          { id: 'l', status_code: 40402, status_message: 'Invalid Path.', cost: 0, result: null },
        ]),
      ),
  ],
] as const) {
  test(`ai_optimization id_list ${name}: warning, no exit 1, the pass goes on`, async () => {
    const e = env();
    const { fetch, calls } = api({
      idList: (m) => (m === 'ai_optimization' ? answer() : undefined),
      lost: {
        serp: [{ id: 'sp1', url: 'https://api.dataforseo.com/v3/serp/google/organic/task_post' }],
      },
    });
    await store10(e, fetch);
    const r = await dfs(['+collect'], { env: e, fetch, now });
    assert.equal(r.code, 0, r.stderr);
    assert.match(
      r.stderr,
      /^dfs: warning: ai_optimization id_list not served — lost ids not recoverable\n/,
    );
    assert.ok(paths(calls).includes('/v3/serp/google/organic/task_get/advanced/sp1'));
    const sync = query(e, 'SELECT module FROM sync').map((s) => s.module);
    assert.ok(!sync.includes('ai_optimization') && sync.includes('serp'));
  });
}

test('a task past 30 days answers 40403: state expired, reported', async () => {
  const e = env();
  const { fetch } = api({ get: (id) => (id === 't1' ? 40403 : undefined) });
  await post(e, fetch);
  const r = await dfs(['serp', '+collect'], { env: e, fetch, now });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /^dfs: task t1 expired 40403\n$/);
  assert.equal(query(e, 'SELECT state FROM task')[0].state, 'expired');
});

test('task.cost: post 0.0006, task_get 0, id_list 0.0006 stays 0.0006; a later different non-zero value replaces it', async () => {
  const e = env();
  let listed = 0.0006;
  const { fetch } = api({
    idList: () =>
      json(
        envelope([
          {
            id: 'l',
            status_code: 20000,
            cost: 0,
            result: [
              {
                id: 't1',
                url: 'https://api.dataforseo.com/v3/serp/google/organic/task_post',
                cost: listed,
              },
            ],
          },
        ]),
      ),
  });
  await dfs(
    ['serp', 'google', 'organic', '+run', 'advanced', '--body', '{"keyword":"k"}', '--wait', '0'],
    { env: e, fetch, now: earlier },
  );
  const cost = () => query(e, 'SELECT cost FROM task')[0].cost;
  assert.equal((await dfs(['serp', '+collect'], { env: e, fetch, now })).code, 0);
  assert.equal(cost(), 0.0006);
  listed = 0.0011; // LLM Responses settles after completion
  const later = () => Date.parse('2026-11-07T13:00:00Z');
  assert.equal((await dfs(['serp', '+collect'], { env: e, fetch, now: later })).code, 0);
  assert.equal(cost(), 0.0011);
});

test('the next pass starts at the last pass; 1,000 ids page on with offset', async () => {
  const e = env();
  const page = Array.from({ length: 1000 }, (_, i) => ({
    id: `x${i}`,
    url: 'https://api.dataforseo.com/v3/serp/google/organic/task_post',
  }));
  let call = 0;
  const { fetch, calls } = api({
    idList: (m) =>
      m !== 'serp'
        ? undefined
        : json(
            envelope([{ id: 'l', status_code: 20000, cost: 0, result: call++ === 0 ? page : [] }]),
          ),
  });
  await store10(e, fetch);
  const first = await dfs(['serp', '+collect'], { env: e, fetch, now });
  assert.equal(first.code, 0, first.stderr.slice(0, 300));
  assert.deepEqual(
    idListBodies(calls, 'serp').map((b) => [b.datetime_from, b.offset]),
    [
      ['2026-11-07 10:00:00 +00:00', 0],
      ['2026-11-07 10:00:00 +00:00', 1000],
    ],
  );
  const n = calls.length;
  const later = () => Date.parse('2026-11-07T13:00:00Z');
  assert.equal((await dfs(['serp', '+collect'], { env: e, fetch, now: later })).code, 0);
  assert.deepEqual(
    idListBodies(calls.slice(n), 'serp').map((b) => [b.datetime_from, b.datetime_to]),
    [['2026-11-07 12:00:00 +00:00', '2026-11-07 13:00:00 +00:00']],
  );
});

test('lost Live ids: cost recorded; task_get where the level has one, else a warning', async () => {
  const e = env();
  const { fetch, calls } = api({
    lost: {
      serp: [
        {
          id: 'lv1',
          url: 'https://api.dataforseo.com/v3/serp/google/organic/live/advanced',
          cost: 0.002,
        },
      ],
      backlinks: [
        { id: 'lv2', url: 'https://api.dataforseo.com/v3/backlinks/summary/live', cost: 0.02 },
      ],
    },
  });
  await store10(e, fetch);
  const r = await dfs(['+collect'], { env: e, fetch, now });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(
    paths(calls).filter((p) => !p.endsWith('/id_list')),
    ['/v3/serp/google/organic/task_get/advanced/lv1'],
  );
  assert.match(
    r.stderr,
    /dfs: warning: task lv2: \S+\/v3\/backlinks\/summary\/live maps to no collect call — not collected\n/,
  );
  assert.deepEqual(
    query(e, 'SELECT id, state, cost FROM task ORDER BY id').map((t) => ({ ...t })),
    [
      { id: 'lv1', state: 'collected', cost: 0.002 },
      { id: 'lv2', state: 'failed', cost: 0.02 },
    ],
  );
});

test('+collect --help and usage errors', async () => {
  const h = await dfs(['+collect', '--help']);
  assert.equal(h.stdout, 'usage: dfs [<module>] +collect [--full]\n');
  for (const argv of [
    ['serp', 'google', '+collect'],
    ['nope', '+collect'],
    ['+collect', 'x'],
  ]) {
    const r = await dfs(argv);
    assert.equal(r.code, 3, argv.join(' '));
    assert.match(r.stderr, /\+collect runs at the root or one module/);
  }
  const root = await dfs([]);
  assert.match(root.stdout, /dfs \[<module>\] \+collect/);
});

test('a url outside a task_post or Live path maps to no level: on_page instant_pages warns, no call', async () => {
  const e = env();
  const { fetch, calls } = api({
    lost: { on_page: [{ id: 'ip1', url: 'https://api.dataforseo.com/v3/on_page/instant_pages' }] },
  });
  await store10(e, fetch);
  const r = await dfs(['on_page', '+collect'], { env: e, fetch, now });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(paths(calls), ['/v3/on_page/id_list']);
  assert.match(r.stderr, /task ip1: \S+ maps to no collect call — not collected\n/);
});

test('an id_list failure prints its error, keeps the sync row, and the pass goes on; exit 1', async () => {
  const e = env();
  const { fetch, calls } = api({
    idList: (m) =>
      m === 'backlinks'
        ? json({
            status_code: 40501,
            status_message: 'Invalid Field.',
            cost: 0,
            tasks_count: 0,
            tasks: [],
          })
        : undefined,
  });
  await post(e, fetch);
  const r = await dfs(['+collect'], { env: e, fetch, now: () => now() + 60_000 });
  assert.equal(r.code, 1, r.stderr);
  assert.match(
    r.stderr,
    /^dfs: 40501 Invalid Field\. — full response: dfs store show r_\w+ --full\n/,
  );
  assert.ok(paths(calls).includes('/v3/serp/google/organic/task_get/regular/t1'));
  const sync = query(e, 'SELECT module FROM sync').map((s) => s.module);
  assert.ok(!sync.includes('backlinks') && sync.includes('serp'));
});

test('id_list reaches at most 180 days back', async () => {
  const e = env();
  const { fetch, calls } = api();
  await dfs(['appendix', 'user_data'], {
    env: e,
    fetch,
    now: () => Date.parse('2026-01-01T00:00:00Z'),
  });
  assert.equal((await dfs(['serp', '+collect'], { env: e, fetch, now })).code, 0);
  assert.equal(idListBodies(calls, 'serp')[0].datetime_from, '2026-05-11 12:00:00 +00:00');
});
