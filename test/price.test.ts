import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
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
const perResult = (cost: number) => allPriorities([{ cost_type: 'per_result', cost }]);
const queuePrices = (normal: number, high: number) => ({
  priority_low: leaf(normal),
  priority_normal: leaf(normal),
  priority_high: leaf(high),
});
const PRICE = {
  on_page: {
    task_post: perResult(0.00015),
    instant_pages: perResult(0.00015),
    lighthouse: { live: allPriorities(leaf(0.005)) },
  },
  content_analysis: {
    search: { live: item(0.024, 0.000036) },
    phrase_trends: { live: item(0.024, 0.000036) },
    category_trends: { live: item(0.024, 0.000036) },
  },
  merchant: {
    amazon: { products: { task_post: queuePrices(0.0015, 0.003) } },
    google: { sellers: { task_post: queuePrices(0.001, 0.002) } },
  },
  app_data: {
    app_reviews: { task_post: queuePrices(0.00075, 0.0015) },
    app_listings: { search: { live: item(0.1, 0.001) } },
  },
  business_data: {
    google: {
      my_business_updates: { task_post: queuePrices(0.00225, 0.0045) },
      extended_reviews: { task_post: queuePrices(0.00075, 0.0015) },
    },
    tripadvisor: { reviews: { task_post: queuePrices(0.00075, 0.0015) } },
  },
  ai_optimization: {
    llm_responses: { live: allPriorities(leaf(0.0006)) },
    llm_scraper: { live: { advanced: allPriorities(leaf(0.004)) } },
    llm_mentions: {
      search_mentions: { live: item(0.1, 0.001) },
      multi_target_metrics: { live: item(0.1, 0.001) },
      historical: { live: item(0.1, 0.001) },
    },
    ai_keyword_data: { keywords_search_volume: { live: item(0.01, 0.0001) } },
  },
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
  // --fresh: the first send would be reused.
  assert.equal((await dfs([...live, '--fresh'], { env: e, fetch, now: at(NOON) })).code, 0);
  assert.equal(calls.length, 2);
  const plan = await dry(low, { keyword: 'pizza' });
  assert.equal(plan.ceiling, 0.001);
  assert.equal(plan.guard, 'refuse');
  const bad = await dfs(live, { env: { ...e, DFS_MAX_COST: 'lots' }, fetch, now: at(NOON) });
  assert.equal(bad.code, 3);
  assert.match(bad.stderr, /^dfs: DFS_MAX_COST lots: want a number of USD/);
});

// Every path has a rule now, so an unknown price comes from a missing tree: no tree, failed refresh.
test('unknown price exits 4 unless --max-cost is explicit; DFS_MAX_COST does not unlock it', async () => {
  const { fetch, calls } = fakeFetch(() => json({ status_code: 20000, cost: 0.02, tasks: [] }));
  const search = ['content_analysis', 'search', 'live', '--body', '{"keyword":"seo"}'];
  const e = env({ DFS_MAX_COST: '5' });
  const r = await dfs(search, { env: e, fetch });
  assert.equal(r.code, 4);
  assert.match(
    r.stderr,
    /^dfs: warning: price tree refresh failed \(20000, see: dfs store show r_\w+\); no price tree\ndfs: price of \/v3\/content_analysis\/search\/live unknown — pass --max-cost <usd> to send, or --sandbox\n$/,
  );
  assert.deepEqual(
    calls.map((c) => c.url),
    ['https://api.dataforseo.com/v3/appendix/user_data'],
    'only the refresh, never the call',
  );
  const sent = await dfs([...search, '--max-cost', '0.01'], { env: e, fetch });
  assert.equal(sent.code, 0, sent.stderr);
  assert.match(sent.stderr, / est=\$\? saved=r_/);
  assert.doesNotMatch(sent.stderr, /real cost/, 'no estimate: no real-cost comparison');
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
  const r = await dfs([...live, '--fresh'], { env: e, fetch: f.fetch, now: later });
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
  assert.equal(f.calls.length, 5, 'user_data is free: 4 retries, then the paid call is refused');

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
    ['on_page', 'pages', '--body', '{"id":"11071200-0000-0000-0000-000000000001"}'],
    ['ai_optimization', 'claude', 'llm_responses', 'models'],
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

test('an unbounded rule is refused like an unknown price unless --max-cost is explicit', async () => {
  const e = env();
  await loadPrices(e);
  const { fetch, calls } = fakeFetch(() => json({ status_code: 20000, cost: 0.01, tasks: [] }));
  const chat = ['ai_optimization', 'chat_gpt', 'llm_responses', 'live', '--body'];
  const body = JSON.stringify({ user_prompt: 'pizza?', model_name: 'gpt-4o' });
  const r = await dfs([...chat, body], { env: e, fetch, now: at(NOON) });
  assert.equal(r.code, 4);
  assert.equal(
    r.stderr,
    'dfs: price of /v3/ai_optimization/chat_gpt/llm_responses/live has no upper bound — pass --max-cost <usd> to send, or --sandbox\n',
  );
  assert.equal(calls.length, 0);
  const sent = await dfs([...chat, body, '--max-cost', '0.05'], { env: e, fetch, now: at(NOON) });
  assert.equal(sent.code, 0, sent.stderr);
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

// pricing/on-page/onpage-api and help-center/cost-of-onpage-api-parameters: per crawled page,
// each paid flag adds coefficient × base; browser rendering (33) includes load_resources and
// enable_javascript.
test('per_result and paid flags: On-Page bills max_crawl_pages, flags add base-price multiples', async () => {
  const e = env();
  await loadPrices(e);
  const site = { target: 'example.com', max_crawl_pages: 100 };
  assert.equal(await usd(e, 'on_page task_post', site), 0.015);
  assert.equal(await usd(e, 'on_page task_post', { ...site, load_resources: true }), 0.045);
  const all = {
    ...site,
    load_resources: true,
    enable_javascript: true,
    enable_browser_rendering: true,
    enable_content_parsing: true,
    calculate_keyword_density: true,
  };
  assert.equal(await usd(e, 'on_page task_post', all), 0.54, 'help-center: $0.0054 per page');
  const page = { url: 'https://example.com', enable_browser_rendering: true };
  assert.equal(await usd(e, 'on_page instant_pages', page), 0.0051);
  assert.equal(await usd(e, 'on_page lighthouse live json', { url: page.url }), 0.005);
});

test('per_result: Content Analysis rows by limit or by date_group bucket', async () => {
  const e = env();
  await loadPrices(e);
  const ca = 'content_analysis search live';
  assert.equal(await usd(e, ca, { keyword: 'seo' }), 0.0276);
  assert.equal(await usd(e, ca, { keyword: 'seo', limit: 1000 }), 0.06);
  // NOON = 2026-11-07: 2026-09 … 2026-11 = 3 monthly rows (date_group default month).
  const pizza = { keyword: 'pizza', date_from: '2026-09-01' };
  assert.equal(await usd(e, 'content_analysis phrase_trends live', pizza), 0.024108);
  const days = { category_code: 10994, date_from: '2026-11-01', date_group: 'day' };
  assert.equal(await usd(e, 'content_analysis category_trends live', days), 0.024252);
});

test('depth multipliers and priority: Merchant, App Data and Business Data bill per block', async () => {
  const e = env();
  await loadPrices(e);
  // Amazon products: blocks of 100, 250 → 3 × 0.0015; priority 2 reads the high price.
  const shoes = { ...US, keyword: 'shoes', depth: 250 };
  assert.equal(await usd(e, 'merchant amazon products task_post', shoes), 0.0045);
  assert.equal(
    await usd(e, 'merchant amazon products task_post', { ...shoes, priority: 2 }),
    0.009,
  );
  // Google Shopping sellers: get_shops_on_google doubles the task price.
  const seller = { ...US, product_id: '1113158713975221117', get_shops_on_google: true };
  assert.equal(await usd(e, 'merchant google sellers task_post', seller), 0.002);
  // Same node, engine-specific blocks: Google Play 150 reviews, App Store 25.
  const app = { app_id: 'org.telegram.messenger', ...US, depth: 300 };
  assert.equal(await usd(e, 'app_data google app_reviews task_post', app), 0.0015);
  assert.equal(await usd(e, 'app_data apple app_reviews task_post', app), 0.009);
  // 0.1 + 100 (default limit) × 0.001
  const listing = { categories: ['Games'] };
  assert.equal(await usd(e, 'app_data google app_listings search live', listing), 0.2);
  // My Business Updates: task fee + 0.00075 per 10 updates; leaf 0.00225 holds the first block.
  const gmb = { ...US, keyword: 'pizza hut', depth: 30 };
  assert.equal(await usd(e, 'business_data google my_business_updates task_post', gmb), 0.00375);
  // Extended reviews: blocks of 20; docs: a keyword identifier multiplies the price by 3.
  const ext = { ...US, keyword: 'pizza hut', depth: 40 };
  assert.equal(await usd(e, 'business_data google extended_reviews task_post', ext), 0.0045);
  // pricing page: "(2 × $0.00075) + $0.00075 = $0.00225" for a language and depth 20.
  const trip = { url_path: 'Hotel_Review-g60763-d93450', language_code: 'en', depth: 20 };
  assert.equal(await usd(e, 'business_data tripadvisor reviews task_post', trip), 0.00225);
  assert.equal(
    await usd(e, 'business_data tripadvisor reviews task_post', {
      ...trip,
      language_name: 'English',
    }),
    0.00225,
    'one language surcharge, not two',
  );
  const cid = { ...US, cid: '194604053573767737', depth: 20 };
  assert.equal(await usd(e, 'business_data google extended_reviews task_post', cid), 0.0015);
});

test('per_request and per_result: AI Optimization scraper, mentions and keyword volume', async () => {
  const e = env();
  await loadPrices(e);
  const ask = { ...US, keyword: 'best pizza' };
  assert.equal(await usd(e, 'ai_optimization chat_gpt llm_scraper live advanced', ask), 0.004);
  const target = { target: [{ keyword: 'pizza' }] };
  // 0.1 + 100 (default limit) × 0.001
  assert.equal(await usd(e, 'ai_optimization llm_mentions search_mentions live', target), 0.2);
  // One item per target set.
  const sets = {
    targets: [1, 2, 3].map((i) => ({ key: `t${i}`, target: [{ domain: `${i}.com` }] })),
  };
  assert.equal(await usd(e, 'ai_optimization llm_mentions multi_target_metrics live', sets), 0.103);
  // No date_from: from 2025-08 (the earliest) to 2026-11 = 16 months.
  assert.equal(await usd(e, 'ai_optimization llm_mentions historical live', target), 0.116);
  const kws = { ...US, keywords: ['a', 'b', 'c'] };
  assert.equal(
    await usd(e, 'ai_optimization ai_keyword_data keywords_search_volume live', kws),
    0.0103,
  );
});
