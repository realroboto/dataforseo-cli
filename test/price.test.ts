import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { estimate, guard } from '../src/pricing.ts';
import { fakeFetch } from './helpers/fetch.ts';
import { dfs } from './helpers/io.ts';

const LOGIN = { DATAFORSEO_LOGIN: 'me@example.com', DATAFORSEO_PASSWORD: 's3cret' };
const env = (extra: Record<string, string> = {}) => ({
  DFS_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dfs-price-')),
  ...LOGIN,
  ...extra,
});
const at = (iso: string) => () => Date.parse(iso);
const NOON = '2026-11-07T12:00:00.000Z';

// Cut from a real user_data price tree (2026-11-07): serp only, money and rates dropped.
const leaf = (cost: number) => [{ cost_type: 'per_request', cost }];
const PRICE = {
  serp: {
    live: {
      advanced: {
        priority_low: leaf(0.002),
        priority_normal: leaf(0.002),
        priority_high: leaf(0.002),
      },
    },
    task_post: {
      priority_low: leaf(0.0006),
      priority_normal: leaf(0.0006),
      priority_high: leaf(0.0012),
    },
  },
};
const userData = (price: unknown = PRICE, status_code = 20000) => ({
  status_code,
  status_message: status_code === 20000 ? 'Ok.' : 'Internal Error.',
  cost: 0,
  tasks_count: 1,
  tasks: [
    {
      id: '11071200-1535-0216-0000-5b8c1e2a7f10',
      status_code,
      status_message: 'Ok.',
      cost: 0,
      result: [{ login: 'me@example.com', money: { balance: 42.5 }, price }],
    },
  ],
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Loads the price tree the way a user does: one user_data call.
async function loadPrices(e: NodeJS.ProcessEnv, body: unknown = userData(), flags: string[] = []) {
  const { fetch } = fakeFetch(() => json(body));
  return dfs(['appendix', 'user_data', ...flags], { env: e, fetch, now: at(NOON) });
}

const LIVE = ['serp', 'google', 'organic', 'live', 'advanced'];
const dry = async (e: NodeJS.ProcessEnv, task: unknown, ...flags: string[]) => {
  const r = await dfs([...LIVE, '--body', JSON.stringify(task), '--dry-run', ...flags], {
    env: e,
    now: at(NOON),
  });
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('only a non-sandbox user_data with envelope 20000 and a price node writes the price tree', async () => {
  const good = env();
  assert.equal((await loadPrices(good)).code, 0);
  assert.deepEqual((await dry(good, { keyword: 'pizza' })).estimate, {
    usd: 0.002,
    basis: 'rule',
    price_at: NOON,
  });

  for (const [why, body, flags] of [
    ['sandbox', userData(), ['--sandbox']],
    ['failed envelope', userData(PRICE, 50000), []],
    ['no price node', userData(null), []],
  ] as const) {
    const e = env();
    await loadPrices(e, body, [...flags]);
    const plan = await dry(e, { keyword: 'pizza' });
    assert.deepEqual(plan.estimate, { usd: null, basis: 'unknown', price_at: null }, why);
  }

  // A later sandbox user_data changes neither the tree nor its fetch time.
  const dummy = { serp: { live: { advanced: { priority_normal: leaf(9) } } } };
  const { fetch } = fakeFetch(() => json(userData(dummy)));
  await dfs(['appendix', 'user_data', '--sandbox'], {
    env: good,
    fetch,
    now: at('2026-11-07T13:00:00Z'),
  });
  assert.deepEqual((await dry(good, { keyword: 'pizza' })).estimate, {
    usd: 0.002,
    basis: 'rule',
    price_at: NOON,
  });
});

test('depth 15 bills two SERPs, the second 25% lower; priority 2 reads the high price', async () => {
  const e = env();
  await loadPrices(e);
  // 0.002 + 0.75 × 0.002
  assert.equal((await dry(e, { keyword: 'pizza', depth: 15 })).estimate.usd, 0.0035);
  assert.equal((await dry(e, { keyword: 'pizza', depth: 20 })).estimate.usd, 0.0035);
  assert.equal((await dry(e, { keyword: 'pizza', depth: 10 })).estimate.usd, 0.002);
  const post = async (body: unknown) => {
    const argv = ['serp', 'google', 'organic', 'task_post', '--body', JSON.stringify(body)];
    const r = await dfs([...argv, '--dry-run'], { env: e, now: at(NOON) });
    return JSON.parse(r.stdout).estimate.usd;
  };
  assert.equal(await post({ keyword: 'a', priority: 2 }), 0.0012);
  // tasks add up: 0.0006 + 0.0012 × 1.75
  assert.equal(await post([{ keyword: 'a' }, { keyword: 'b', priority: 2, depth: 15 }]), 0.0027);
});

test('estimate above the ceiling exits 4 and sends nothing; --max-cost, DFS_MAX_COST, $1 default', async () => {
  const e = env();
  await loadPrices(e);
  const { fetch, calls } = fakeFetch(() => json({ status_code: 20000, cost: 0.002, tasks: [] }));
  const live = [...LIVE, '--body', '{"keyword":"pizza","depth":15}'];
  const r = await dfs([...live, '--max-cost', '0.003'], { env: e, fetch, now: at(NOON) });
  assert.equal(r.code, 4);
  assert.equal(r.stdout, '');
  assert.equal(
    r.stderr,
    'dfs: estimate $0.0035 above ceiling $0.003 for /v3/serp/google/organic/live/advanced — raise --max-cost <usd> or DFS_MAX_COST, or --sandbox\n',
  );
  const low = { ...e, DFS_MAX_COST: '0.001' };
  assert.equal((await dfs(live, { env: low, fetch, now: at(NOON) })).code, 4);
  assert.equal(calls.length, 0);
  // --max-cost wins over DFS_MAX_COST; the $1 default sends.
  assert.equal(
    (await dfs([...live, '--max-cost', '1'], { env: low, fetch, now: at(NOON) })).code,
    0,
  );
  assert.equal((await dfs(live, { env: e, fetch, now: at(NOON) })).code, 0);
  assert.equal(calls.length, 2);
  const plan = await dry(low, { keyword: 'pizza' });
  assert.equal(plan.ceiling, 0.001);
  assert.equal(plan.guard, 'refuse');
  const bad = await dfs(live, { env: { ...e, DFS_MAX_COST: 'lots' }, fetch, now: at(NOON) });
  assert.equal(bad.code, 3);
  assert.match(bad.stderr, /^dfs: DFS_MAX_COST lots: want a number of USD/);
});

test('unknown price exits 4 unless --max-cost is explicit; DFS_MAX_COST does not unlock it', async () => {
  const { fetch, calls } = fakeFetch(() => json({ status_code: 20000, cost: 0.02, tasks: [] }));
  const anchors = ['backlinks', 'anchors', 'live', '--body', '{"target":"forbes.com"}'];
  const e = env({ DFS_MAX_COST: '5' });
  const r = await dfs(anchors, { env: e, fetch });
  assert.equal(r.code, 4);
  assert.equal(
    r.stderr,
    'dfs: price of /v3/backlinks/anchors/live unknown — pass --max-cost <usd> to send, or --sandbox\n',
  );
  assert.equal(calls.length, 0);
  const sent = await dfs([...anchors, '--max-cost', '0.01'], { env: e, fetch });
  assert.equal(sent.code, 0, sent.stderr);
  assert.match(sent.stderr, / est=\$\? saved=r_/);
  assert.doesNotMatch(sent.stderr, /warning/, 'no estimate: no real-cost comparison');
});

test('a rule node missing from the price tree: unknown price and a warning naming the rule', async () => {
  const e = env();
  await loadPrices(e, userData({ serp: {} }));
  const r = await dfs([...LIVE, '--body', '{"keyword":"pizza"}'], { env: e, now: at(NOON) });
  assert.equal(r.code, 4);
  assert.match(
    r.stderr,
    /^dfs: warning: price rule \/v3\/serp\/google\/organic\/live\/advanced: no per_request price at serp\.live\.advanced\.priority_normal in the price tree\n/,
  );
});

test('a tree older than 24 h is refreshed first; a failed refresh warns and uses the old tree', async () => {
  const e = env();
  await loadPrices(e); // at NOON
  const live = [...LIVE, '--body', '{"keyword":"pizza"}'];
  const paid = () => json({ status_code: 20000, cost: 0.002, tasks: [] });
  const dearer = structuredClone(PRICE);
  dearer.serp.live.advanced.priority_normal = leaf(0.004);

  // Within 24 h: no refresh.
  let f = fakeFetch(paid);
  await dfs(live, { env: e, fetch: f.fetch, now: at('2026-11-08T11:00:00Z') });
  assert.deepEqual(
    f.calls.map((c) => new URL(c.url).pathname),
    ['/v3/serp/google/organic/live/advanced'],
  );

  // Older: user_data first, then the call at the new price.
  f = fakeFetch((url) => (url.endsWith('/user_data') ? json(userData(dearer)) : paid()));
  const later = at('2026-11-08T13:00:00Z');
  const r = await dfs(live, { env: e, fetch: f.fetch, now: later });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(
    f.calls.map((c) => new URL(c.url).pathname),
    ['/v3/appendix/user_data', '/v3/serp/google/organic/live/advanced'],
  );
  assert.match(r.stderr, / est=\$0\.004 saved=/);
  const list = await dfs(['store', 'list'], { env: e });
  assert.equal(
    list.stdout.split('\n').filter((l) => l.includes('/v3/appendix/user_data')).length,
    2,
  );

  // Refresh fails: warning, old tree (fetched 2026-11-08T13:00) still prices the call.
  f = fakeFetch((url) => (url.endsWith('/user_data') ? json(userData(PRICE, 50000), 500) : paid()));
  const failed = await dfs(live, { env: e, fetch: f.fetch, now: at('2026-11-10T00:00:00Z') });
  assert.equal(failed.code, 0, failed.stderr);
  assert.match(
    failed.stderr,
    /^dfs: warning: price tree refresh failed \(50000, see: dfs store show r_\w+\); using the tree from 2026-11-08T13:00:00\.000Z\n/,
  );
  assert.match(failed.stderr, / est=\$0\.004 saved=/);

  // No tree and no network: warning, unknown price, exit 4.
  const fresh = env();
  f = fakeFetch((url) =>
    url.endsWith('/user_data') ? Promise.reject(new Error('net down')) : paid(),
  );
  const none = await dfs(live, { env: fresh, fetch: f.fetch });
  assert.equal(none.code, 4);
  assert.match(none.stderr, /^dfs: warning: price tree refresh failed \(network error: net down/);
  assert.match(none.stderr, /; no price tree\n/);
  assert.equal(f.calls.length, 1);

  // --dry-run never refreshes.
  f = fakeFetch(paid);
  const plan = await dfs([...live, '--dry-run'], {
    env: e,
    fetch: f.fetch,
    now: at('2026-12-01T00:00:00Z'),
  });
  assert.equal(JSON.parse(plan.stdout).estimate.price_at, '2026-11-08T13:00:00.000Z');
  assert.equal(f.calls.length, 0);
});

test('--sandbox: estimate 0, guard not applied, no price refresh', async () => {
  const { fetch, calls } = fakeFetch(() => json({ status_code: 20000, cost: 0.002, tasks: [] }));
  const body = '{"keyword":"pizza","depth":200}';
  const r = await dfs([...LIVE, '--body', body, '--sandbox', '--max-cost', '0'], {
    env: env(),
    fetch,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/sandbox\./);
  assert.match(r.stderr, / est=\$0 saved=/);
  assert.doesNotMatch(r.stderr, /real cost/, 'sandbox costs are dummy data');
  const plan = await dry(env(), JSON.parse(body), '--sandbox');
  assert.deepEqual(plan.estimate, { usd: 0, basis: 'rule', price_at: null });
  assert.equal(plan.guard, 'send');
});

test('real cost above the estimate warns on stderr; the Store keeps both', async () => {
  const e = env();
  await loadPrices(e);
  const { fetch } = fakeFetch(() => json({ status_code: 20000, cost: 0.005, tasks: [] }));
  const r = await dfs([...LIVE, '--body', '{"keyword":"pizza"}'], { env: e, fetch, now: at(NOON) });
  assert.equal(r.code, 0);
  const id = r.stderr.match(/saved=(r_\w+)/)?.[1] ?? '';
  assert.match(
    r.stderr,
    /^dfs: warning: real cost \$0\.005 above estimate \$0\.002 for \/v3\/serp\/google\/organic\/live\/advanced — the price rule may be out of date$/m,
  );
  const row = JSON.parse((await dfs(['store', 'list'], { env: e })).stdout.split('\n')[0]);
  assert.equal(row.id, id);
  const db = new DatabaseSync(join(e.DFS_CONFIG_DIR, 'store.db'), { readOnly: true });
  try {
    assert.deepEqual(
      { ...db.prepare('SELECT cost, estimate FROM response WHERE id = ?').get(id) },
      {
        cost: 0.005,
        estimate: 0.002,
      },
    );
  } finally {
    db.close();
  }
});

test('free list paths never hit the guard, even with a $0 ceiling', async () => {
  const words = [
    ['serp', 'google', 'organic', 'tasks_ready'],
    ['serp', 'google', 'organic', 'task_get', 'advanced', '11071200-0000-0000-0000-000000000001'],
    ['serp', 'id_list', '--body', '{}', '--no-validate'],
    ['serp', 'errors', '--body', '{}', '--no-validate'],
    ['serp', 'google', 'locations'],
    ['serp', 'google', 'languages'],
    ['appendix', 'user_data'],
    ['appendix', 'webhook_resend', '--body', '{}', '--no-validate'],
    ['serp', 'google', 'organic', 'tasks_fixed'],
  ];
  for (const w of words) {
    const { fetch, calls } = fakeFetch(() => json({ status_code: 20000, cost: 0, tasks: [] }));
    const r = await dfs([...w, '--dry-run'], { env: env({ DFS_MAX_COST: '0' }), fetch });
    assert.equal(r.code, 0, `${w.join(' ')}: ${r.stderr}`);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.guard, 'send', w.join(' '));
    assert.equal(plan.estimate.usd, 0, w.join(' '));
    assert.equal(calls.length, 0);
  }
  const { fetch, calls } = fakeFetch(() => json({ status_code: 20000, cost: 0, tasks: [] }));
  const sent = await dfs(words[0], { env: env({ DFS_MAX_COST: '0' }), fetch });
  assert.equal(sent.code, 0, sent.stderr);
  assert.equal(calls.length, 1, 'a free path sends no user_data refresh first');
});

// shortcut: no shipped rule is unbounded, so this checks guard() directly; move it to run() when
// tickets 05–07 add the first unbounded rule.
test('an unbounded rule is refused like an unknown price unless --max-cost is explicit', () => {
  const est = estimate({ path: '/v3/x/live', node: ['x'], unbounded: true }, [{}], PRICE);
  assert.deepEqual(est, { usd: null, basis: 'unbounded' });
  assert.equal(
    guard('/v3/x/live', est, 1, false),
    'price of /v3/x/live has no upper bound — pass --max-cost <usd> to send, or --sandbox',
  );
  assert.equal(guard('/v3/x/live', est, 1, true), undefined);
});
