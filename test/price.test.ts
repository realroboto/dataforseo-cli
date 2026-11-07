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

// Cut from a real user_data price tree (2026-11-07): money and rates dropped.
const leaf = (cost: number) => [{ cost_type: 'per_request', cost }];
const allPriorities = (l: unknown) => ({ priority_low: l, priority_normal: l, priority_high: l });
const item = (task: number, result: number) =>
  allPriorities([
    { cost_type: 'per_result', cost: result },
    { cost_type: 'per_request', cost: task },
  ]);
const PRICE = {
  dataforseo_labs: {
    ranked_keywords: { live: item(0.012, 0.00012) },
    keyword_ideas: { live: item(0.012, 0.00012) },
    top_searches: { live: item(0.012, 0.00012) },
    historical_serps: { live: item(0, 0.00012) },
    bulk_keyword_difficulty: { live: item(0.012, 0.00012) },
    historical_keyword_data: { live: item(0.012, 0.00012) },
    historical_rank_overview: { live: item(0.12, 0.0012) },
  },
  backlinks: {
    summary: { live: item(0.024, 0.000036) },
    anchors: { live: item(0.024, 0.000036) },
    history: { live: item(0.024, 0.000036) },
    timeseries_summary: { live: item(0.024, 0.000036) },
  },
  domain_analytics: {
    technologies: { domain_technologies: { live: allPriorities(leaf(0.012)) } },
    whois: { overview: { live: item(0.12, 0.0012) } },
  },
  keywords_data: {
    search_volume: { task_post: allPriorities(leaf(0.06)) },
    google_ads: { search_volume: { live: allPriorities(leaf(0.09)) } },
    clickstream_data: {
      bulk_search_volume: {
        live: allPriorities([
          { cost_type: 'per_result', cost: 0.00012 },
          { cost_type: 'per_request', cost: 0.012 },
        ]),
      },
    },
  },
  serp: {
    screenshot: allPriorities([{ cost_type: 'per_result', cost: 0.004 }]),
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
  const search = ['content_analysis', 'search', 'live', '--body', '{"keyword":"seo"}'];
  const e = env({ DFS_MAX_COST: '5' });
  const r = await dfs(search, { env: e, fetch });
  assert.equal(r.code, 4);
  assert.equal(
    r.stderr,
    'dfs: price of /v3/content_analysis/search/live unknown — pass --max-cost <usd> to send, or --sandbox\n',
  );
  assert.equal(calls.length, 0);
  const sent = await dfs([...search, '--max-cost', '0.01'], { env: e, fetch });
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
    /^dfs: warning: price rule \/v3\/serp\/google\/organic\/live\/advanced: no price at serp\.live\.advanced\.priority_normal in the price tree\n/,
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
    ['backlinks', 'index'],
    ['backlinks', 'available_filters'],
    ['dataforseo_labs', 'google', 'available_history'],
    ['domain_analytics', 'technologies', 'technologies'],
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
// ticket 07 adds the first unbounded rule (tickets 05–06 modules have none).
test('an unbounded rule is refused like an unknown price unless --max-cost is explicit', () => {
  const est = estimate({ path: '/v3/x/live', node: ['x'], unbounded: true }, [{}], PRICE, 0);
  assert.deepEqual(est, { usd: null, basis: 'unbounded' });
  assert.equal(
    guard('/v3/x/live', est, 1, false),
    'price of /v3/x/live has no upper bound — pass --max-cost <usd> to send, or --sandbox',
  );
  assert.equal(guard('/v3/x/live', est, 1, true), undefined);
});

// Estimate of one task on the stored tree, read through --dry-run.
const usd = async (e: NodeJS.ProcessEnv, words: string, task: Record<string, unknown>) => {
  const argv = [...words.split(' '), '--body', JSON.stringify(task), '--dry-run'];
  const r = await dfs(argv, { env: e, now: at(NOON) });
  assert.equal(r.code, 0, `${words}: ${r.stderr}`);
  return JSON.parse(r.stdout).estimate.usd;
};
const US = { location_code: 2840, language_code: 'en' };

test('per_request: a keywords_data task costs the same for 1 or 1000 keywords', async () => {
  const e = env();
  await loadPrices(e);
  const one = { ...US, keywords: ['pizza'] };
  const many = { ...US, keywords: Array.from({ length: 1000 }, (_, i) => `kw ${i}`) };
  assert.equal(await usd(e, 'keywords_data google_ads search_volume live', one), 0.09);
  assert.equal(await usd(e, 'keywords_data google_ads search_volume live', many), 0.09);
  // Bing search_volume_history has no node of its own; its list price equals search_volume.
  assert.equal(await usd(e, 'keywords_data bing search_volume_history task_post', one), 0.06);
});

test('per_result: bulk_search_volume adds the item price per keyword; screenshot bills one', async () => {
  const e = env();
  await loadPrices(e);
  const bulk = { location_code: 2840, keywords: ['a', 'b', 'c'] };
  // 0.012 + 3 × 0.00012
  assert.equal(
    await usd(e, 'keywords_data clickstream_data bulk_search_volume live', bulk),
    0.01236,
  );
  const shot = { task_id: '11071200-1535-0216-0000-5b8c1e2a7f10' };
  assert.equal(await usd(e, 'serp screenshot', shot), 0.004);
});

test('depth multipliers: non-organic pages bill full price, organic later pages 25% lower', async () => {
  const e = env();
  await loadPrices(e);
  const pizza = { ...US, keyword: 'pizza' };
  // Maps: SERPs of 100 results, 250 → 3 × 0.0006.
  assert.equal(await usd(e, 'serp google maps task_post', { ...pizza, depth: 250 }), 0.0018);
  // help-center/using-the-stop_crawl_on_match-parameter-in-serp-api: Bing Live depth 100 = $0.0155.
  assert.equal(await usd(e, 'serp bing organic live advanced', { ...pizza, depth: 100 }), 0.0155);
  const video = { ...US, video_id: 'dQw4w9WgXcQ' };
  assert.equal(
    await usd(e, 'serp youtube video_comments live advanced', { ...video, depth: 40 }),
    0.004,
  );
  // Factors against the shared node: AI Mode 2×, YouTube video_info 3×.
  assert.equal(await usd(e, 'serp google ai_mode live advanced', pizza), 0.004);
  assert.equal(await usd(e, 'serp youtube video_info live advanced', video), 0.006);
});

test('priority 2 and paid parameters raise the estimate', async () => {
  const e = env();
  await loadPrices(e);
  const pizza = { ...US, keyword: 'pizza' };
  assert.equal(await usd(e, 'serp google maps task_post', { ...pizza, priority: 2 }), 0.0012);
  // help-center/serp-api-cost-explained: a search operator in "keyword" → base price × 5.
  const site = { ...US, keyword: 'site:example.com pizza' };
  assert.equal(await usd(e, 'serp google organic task_post', site), 0.003);
  assert.equal(await usd(e, 'serp google organic task_post', { ...site, priority: 2 }), 0.006);
  const minus = { ...US, keyword: 'pizza -site:example.com' };
  assert.equal(await usd(e, 'serp google organic task_post', minus), 0.003);
  // load_async_ai_overview: +1 base price; AI Mode calculate_rectangles: × 2 on its 2× factor.
  const async = { ...pizza, load_async_ai_overview: true };
  assert.equal(await usd(e, 'serp google organic live advanced', async), 0.004);
  const rect2 = { ...pizza, calculate_rectangles: true };
  assert.equal(await usd(e, 'serp google ai_mode task_post', rect2), 0.0024);
  // 0.0012 × 1.75 (depth 15) + 0.0012 (calculate_rectangles)
  const rect = { ...pizza, priority: 2, depth: 15, calculate_rectangles: true };
  assert.equal(await usd(e, 'serp google organic task_post', rect), 0.0033);
  // 0.002 + 4 clicks × 0.00015
  const paa = { ...pizza, people_also_ask_click_depth: 4 };
  assert.equal(await usd(e, 'serp google organic live advanced', paa), 0.0026);
  assert.equal(
    await usd(e, 'serp baidu organic task_post', { ...pizza, get_website_url: true }),
    0.006,
  );
  const quote = { ...US, keyword: 'NASDAQ:GOOGL' };
  assert.equal(
    await usd(e, 'serp google finance_quote task_post', { ...quote, window: '1M' }),
    0.0012,
  );
  assert.equal(
    await usd(e, 'serp google finance_quote task_post', { ...quote, window: '1D' }),
    0.0006,
  );
  const news = { ...US, news_type: 'world_markets' };
  assert.equal(await usd(e, 'serp google finance_explore task_post', news), 0.0012);
});

// Labs and Backlinks bill per task plus per item (row) returned; Live only, so no priority.
test('per_result: limit, input arrays and date spans count the billed items', async () => {
  const e = env();
  await loadPrices(e);
  const rk = 'dataforseo_labs google ranked_keywords live';
  const site = { ...US, target: 'example.com' };
  // Absent limit → API default 100: 0.012 + 100 × 0.00012.
  assert.equal(await usd(e, rk, site), 0.024);
  assert.equal(await usd(e, rk, { ...site, limit: 1000 }), 0.132);
  assert.equal(await usd(e, rk, { ...site, limit: 5 }), 0.0126);
  assert.equal(await usd(e, rk, { ...site, limit: 5000 }), 0.132, 'limit above max 1000');
  // top_searches: default limit 1000.
  assert.equal(await usd(e, 'dataforseo_labs google top_searches live', US), 0.132);
  // keyword_ideas: default limit 700.
  const ideas = { ...US, keywords: ['pizza'] };
  assert.equal(await usd(e, 'dataforseo_labs google keyword_ideas live', ideas), 0.096);
  // One item per input keyword.
  const kd = { ...US, keywords: ['a', 'b', 'c'] };
  assert.equal(await usd(e, 'dataforseo_labs google bulk_keyword_difficulty live', kd), 0.01236);
  // historical_search_volume has no node of its own; Labs general rate, as historical_keyword_data.
  assert.equal(await usd(e, 'dataforseo_labs google historical_search_volume live', kd), 0.01236);
  // pricing/backlinks/backlinks: "0.024 + 0.000036 × 1,000 = $0.06"; summary is one row.
  const forbes = { target: 'forbes.com' };
  assert.equal(await usd(e, 'backlinks anchors live', { ...forbes, limit: 1000 }), 0.06);
  assert.equal(await usd(e, 'backlinks summary live', forbes), 0.024036);
  // Whois: $0.12 + $0.0012 per domain, 100 by default.
  assert.equal(await usd(e, 'domain_analytics whois overview live', {}), 0.24);
});

test('date spans: one item per month or per group_range period up to today', async () => {
  const e = env();
  await loadPrices(e);
  // NOON = 2026-11-07. 2026-01 … 2026-11 = 11 months.
  const forbes = { target: 'forbes.com' };
  assert.equal(
    await usd(e, 'backlinks history live', { ...forbes, date_from: '2026-01-15' }),
    0.024396,
  );
  const days = { ...forbes, date_from: '2026-11-01', date_to: '2026-11-07', group_range: 'day' };
  assert.equal(await usd(e, 'backlinks timeseries_summary live', days), 0.024252);
  // historical_serps: no task price, at most 13 monthly snapshots: 13 × 0.00012.
  const serps = { ...US, keyword: 'pizza' };
  assert.equal(await usd(e, 'dataforseo_labs google historical_serps live', serps), 0.00156);
  // No date_from: worst case from the earliest date, 2020-10 … 2026-11 = 74 months.
  const hro = { ...US, target: 'example.com' };
  assert.equal(await usd(e, 'dataforseo_labs google historical_rank_overview live', hro), 0.2088);
});

test('per_request and paid flags: domain_technologies is flat; include_clickstream_data doubles', async () => {
  const e = env();
  await loadPrices(e);
  const tech = { target: 'example.com' };
  assert.equal(await usd(e, 'domain_analytics technologies domain_technologies live', tech), 0.012);
  // Labs docs: "with this parameter enabled, you will be charged double the price for the request".
  const site = { ...US, target: 'example.com', include_clickstream_data: true };
  assert.equal(await usd(e, 'dataforseo_labs google ranked_keywords live', site), 0.048);
});
