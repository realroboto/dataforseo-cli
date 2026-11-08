import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fakeFetch } from './helpers/fetch.ts';
import { dfs } from './helpers/io.ts';

const env = () => ({
  DFS_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dfs-pages-')),
  DATAFORSEO_LOGIN: 'me@example.com',
  DATAFORSEO_PASSWORD: 's3cret',
});
const item = (task: number, result: number) => {
  const l = [
    { cost_type: 'per_result', cost: result },
    { cost_type: 'per_request', cost: task },
  ];
  return { priority_low: l, priority_normal: l, priority_high: l };
};
const PRICE = {
  dataforseo_labs: { keyword_ideas: { live: item(0.012, 0.00012) } },
  backlinks: { backlinks: { live: item(0.024, 0.000036) } },
};
const USER_DATA = {
  status_code: 20000,
  cost: 0,
  tasks_count: 1,
  tasks: [{ id: 't0', status_code: 20000, cost: 0, result: [{ price: PRICE }] }],
};
const json = (body: unknown, space?: number) =>
  new Response(JSON.stringify(body, null, space), {
    headers: { 'content-type': 'application/json' },
  });

// One page of `n` items; the token names the page number, so a test can follow the chain.
const page = (n: number, from: number, total: number, token: string, cost: number) => ({
  status_code: 20000,
  status_message: 'Ok.',
  cost,
  tasks_count: 1,
  tasks: [
    {
      id: `p${from}`,
      status_code: 20000,
      status_message: 'Ok.',
      cost,
      result: [
        {
          total_count: total,
          items_count: n,
          [token]: `tok-after-${from + n}`,
          items: Array.from({ length: n }, (_, i) => ({ keyword: `k${from + i}` })),
        },
      ],
    },
  ],
});

// A fake API over `total` results: answers by offset or by token, records each page body.
function api(total: number, token: string, cost: number, space?: number) {
  const bodies: Record<string, unknown>[] = [];
  const f = fakeFetch((url, init) => {
    if (url.endsWith('/v3/appendix/user_data')) return json(USER_DATA);
    const [task] = JSON.parse(String(init?.body));
    bodies.push(task);
    const limit = Number(task.limit);
    const at = task[token] ? Number(String(task[token]).slice(10)) : Number(task.offset ?? 0);
    return json(page(Math.max(0, Math.min(limit, total - at)), at, total, token, cost), space);
  });
  return { ...f, bodies };
}

const IDEAS = ['dataforseo_labs', 'google', 'keyword_ideas', 'live'];
const TASK = { keywords: ['pizza'], location_code: 2840, language_code: 'en', limit: 1000 };
const rows = (e: { DFS_CONFIG_DIR: string }, path: string) => {
  const db = new DatabaseSync(join(e.DFS_CONFIG_DIR, 'store.db'), { readOnly: true });
  try {
    return db
      .prepare('SELECT id, request, cost, reused_from FROM response WHERE spec_path = ?')
      .all(path) as { id: string; request: string; cost: number; reused_from: string | null }[];
  } finally {
    db.close();
  }
};

test('--page-all: offset to 10,000, then offset_token; one budget shared by all pages', async () => {
  const e = env();
  const a = api(12_000, 'offset_token', 0.132);
  const r = await dfs([...IDEAS, '--body', JSON.stringify(TASK), '--page-all', '--max-cost', '2'], {
    env: e,
    fetch: a.fetch,
  });
  assert.equal(r.code, 0, r.stderr);
  // Page 1 is the task as given; pages 2–10 add offset; pages 11–12 carry the token instead.
  assert.deepEqual(a.bodies, [
    TASK,
    ...Array.from({ length: 9 }, (_, i) => ({ ...TASK, offset: 1000 * (i + 1) })),
    { ...TASK, offset_token: 'tok-after-10000' },
    { ...TASK, offset_token: 'tok-after-11000' },
  ]);
  assert.equal(rows(e, '/v3/dataforseo_labs/google/keyword_ideas/live').length, 12);
  assert.ok(r.stdout.length + r.stderr.length <= 9000, `${r.stdout.length + r.stderr.length}`);
  const cut = JSON.parse(r.stdout.trimEnd().split('\n').at(-1) as string);
  assert.equal(cut.dfs, 'cut');
  assert.match(cut.more, /^dfs store show r_[0-9a-f]{10} --from \d+$/);
  assert.match(r.stderr, /^dfs: 20000 \/v3\/dataforseo_labs\/google\/keyword_ideas\/live tasks=1/);
  assert.match(r.stderr, /dfs: \+\d+ more lines — all pages: dfs store list\n$/);
});

test('--page-all: search_after_token after offset 10,000, from the offset the task gives', async () => {
  const a = api(10_015, 'search_after_token', 0.0246);
  const task = { target: 'example.com', offset: 9990, limit: 10 };
  const r = await dfs(
    ['backlinks', 'backlinks', 'live', '--body', JSON.stringify(task), '--page-all'],
    { env: env(), fetch: a.fetch },
  );
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(a.bodies, [
    task,
    { ...task, search_after_token: 'tok-after-10000' },
    { ...task, search_after_token: 'tok-after-10010' },
  ]);
  assert.equal(r.stdout.split('\n').filter((l) => l.includes('"keyword"')).length, 25);
});

test('--page-all: stops before the page that passes the ceiling; paid pages kept; rerun reuses them', async () => {
  const e = env();
  const a = api(12_000, 'offset_token', 0.132);
  const argv = [...IDEAS, '--body', JSON.stringify(TASK), '--page-all'];
  const r = await dfs([...argv, '--max-cost', '0.3'], { env: e, fetch: a.fetch });
  assert.equal(r.code, 4);
  assert.equal(a.bodies.length, 2);
  assert.equal(rows(e, '/v3/dataforseo_labs/google/keyword_ideas/live').length, 2);
  const stop = r.stderr.trimEnd().split('\n').at(-1);
  assert.equal(
    stop,
    `dfs: --page-all stopped before page 3: cost so far $0.264 + page estimate $0.132 above ceiling $0.3; pages 1-2 saved — rerun: dfs dataforseo_labs google keyword_ideas live --body '${JSON.stringify(TASK)}' --page-all --max-cost 0.396`,
  );
  assert.ok(r.stdout.length + r.stderr.length <= 9000);
  // The rerun pays only new pages: pages 1–2 come from the Store at $0.
  const again = await dfs([...argv, '--max-cost', '0.396'], { env: e, fetch: a.fetch });
  assert.equal(again.code, 4);
  assert.match(again.stderr, /^dfs: 20000 \S+ tasks=1 cost=\$0 est=\$0 reused=r_/);
  const all = rows(e, '/v3/dataforseo_labs/google/keyword_ideas/live');
  assert.equal(all.filter((x) => x.reused_from !== null).length, 2);
  assert.equal(a.bodies.length, 5); // pages 3, 4, 5 sent; page 6 would pass $0.396
});

test('--page-all --full: one line per page, each the exact response', async () => {
  const a = api(5, 'offset_token', 0.01224, 2); // multi-line API text
  const r = await dfs(
    [...IDEAS, '--body', JSON.stringify({ ...TASK, limit: 2 }), '--page-all', '--full'],
    { env: env(), fetch: a.fetch },
  );
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((l) => JSON.parse(l).tasks[0].result[0].items.length),
    [2, 2, 1],
  );
});

test('--page-all input errors exit 3 with nothing sent', async () => {
  const { fetch, calls } = fakeFetch(() => json(USER_DATA));
  const cases: [string[], RegExp][] = [
    [
      ['serp', 'google', 'organic', 'live', 'advanced', '--body', '{"keyword":"a"}'],
      /has no offset field/,
    ],
    [[...IDEAS, '--body', JSON.stringify([TASK, TASK])], /takes one task/],
    [['serp', 'google', 'organic', '+run', '--body', '{"keyword":"a"}'], /endpoint calls only/],
    [['appendix', 'user_data'], /has no offset field/],
  ];
  for (const [argv, want] of cases) {
    const r = await dfs([...argv, '--page-all'], { env: env(), fetch });
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stderr, want);
  }
  // --dry-run plans the first page only.
  const dry = await dfs([...IDEAS, '--body', JSON.stringify(TASK), '--page-all', '--dry-run'], {
    env: env(),
    fetch,
  });
  assert.equal(dry.code, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout).body, [TASK]);
  assert.equal(calls.length, 0);
  const help = await dfs([...IDEAS, '--help'], { env: env() });
  assert.match(help.stdout, /\[--fresh\] \[--page-all\] \[--dry-run\]/);
  const plain = await dfs(['serp', 'google', 'organic', 'live', 'advanced', '--help'], {
    env: env(),
  });
  assert.doesNotMatch(plain.stdout, /--page-all/);
});
