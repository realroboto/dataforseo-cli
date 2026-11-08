import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openCatalog, pathWords } from '../src/catalog.ts';
import { fakeFetch } from './helpers/fetch.ts';
import { dfs } from './helpers/io.ts';

const ANCHORS = ['backlinks', 'anchors', 'live'];
const TASK = { target: 'forbes.com', limit: 4, filters: ['anchor', 'like', '%news%'] };

test('--dry-run prints the plan JSON, sends nothing, needs no credentials', async () => {
  const { fetch, calls } = fakeFetch(() => new Response('{}'));
  const body = JSON.stringify(TASK);
  const { code, stdout, stderr } = await dfs([...ANCHORS, '--body', body, '--dry-run'], { fetch });
  assert.equal(code, 0, stderr);
  assert.equal(calls.length, 0);
  assert.equal(stderr, '');
  assert.ok(stdout.endsWith('}\n') && stdout.split('\n').length === 2, stdout);
  const plan = JSON.parse(stdout);
  assert.deepEqual(Object.keys(plan), [
    'method',
    'url',
    'body',
    'tasks',
    'estimate',
    'ceiling',
    'guard',
    'reuse',
    'spec',
  ]);
  assert.equal(plan.method, 'POST');
  assert.equal(plan.url, 'https://api.dataforseo.com/v3/backlinks/anchors/live');
  assert.deepEqual(plan.body, [TASK]);
  assert.equal(plan.tasks, 1);
  assert.deepEqual(plan.estimate, { usd: null, basis: 'unknown', price_at: null });
  assert.equal(plan.ceiling, 1, '$1 default ceiling');
  assert.equal(plan.guard, 'refuse');
  assert.equal(plan.reuse, null);
  assert.match(plan.spec, /^[0-9a-f]{40}$/);
  assert.ok(!/authorization|basic/i.test(stdout));
});

const LOGIN = { DATAFORSEO_LOGIN: 'me@example.com', DATAFORSEO_PASSWORD: 's3cret' };
// Calls to the endpoint itself; a paid path may first refresh the price tree (user_data).
const toAnchors = <C extends { url: string }>(calls: C[]) =>
  calls.filter((c) => c.url.endsWith('/anchors/live'));
// Runs a call that would send (credentials, --max-cost); the fake fetch counts any send.
const send = async (words: string[], body: unknown, ...flags: string[]) => {
  const { fetch, calls } = fakeFetch(() => new Response('{"status_code":20000}'));
  const env = { DFS_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dfs-plan-')), ...LOGIN };
  const argv = [...words, '--body', JSON.stringify(body), '--max-cost', '1', ...flags];
  return { ...(await dfs(argv, { env, fetch })), calls };
};

test('unknown field and wrong type exit 3 naming the field path and remedy; nothing sent', async () => {
  const unknown = await send(ANCHORS, { ...TASK, colour: 'red' });
  assert.equal(unknown.code, 3);
  assert.equal(unknown.calls.length, 0);
  assert.equal(unknown.stdout, '');
  assert.match(unknown.stderr, /body\[0\]\.colour: unknown field/);
  assert.match(unknown.stderr, /dfs schema backlinks anchors live/);
  assert.match(unknown.stderr, /--no-validate/);

  const wrong = await send(ANCHORS, { ...TASK, limit: '4' });
  assert.equal(wrong.code, 3);
  assert.equal(wrong.calls.length, 0);
  assert.match(wrong.stderr, /body\[0\]\.limit: want integer, got string/);
  assert.match(wrong.stderr, /--no-validate/);
});

test('null passes on a nullable field and exits 3 on a typed field without nullable', async () => {
  const { fetch, calls } = fakeFetch(() => new Response('{}'));
  const ok = await dfs(
    [...ANCHORS, '--body', JSON.stringify({ ...TASK, limit: null }), '--dry-run'],
    {
      fetch,
    },
  );
  assert.equal(ok.code, 0, ok.stderr);
  const bad = await send(ANCHORS, { ...TASK, target: null });
  assert.equal(bad.code, 3);
  assert.equal(bad.calls.length + calls.length, 0);
  assert.match(bad.stderr, /body\[0\]\.target: null, but the field is not nullable/);
});

const many = (n: number, task: unknown) => Array.from({ length: n }, () => task);
const dry = (words: string[], body: unknown, ...flags: string[]) =>
  dfs([...words, '--body', JSON.stringify(body), '--dry-run', ...flags]);

test('limits: 100 tasks per POST, 1 on live, 20 on instant_pages (5 per domain); exit 3 with nothing sent', async () => {
  const post = ['serp', 'google', 'organic', 'task_post'];
  assert.equal((await dry(post, many(100, { keyword: 'a' }))).code, 0);
  const over = await send(post, many(101, { keyword: 'a' }));
  assert.equal(over.code, 3);
  assert.equal(over.calls.length, 0);
  assert.match(over.stderr, /101 tasks, at most 100/);

  const live = await send(ANCHORS, many(2, TASK));
  assert.equal(live.code, 3);
  assert.equal(live.calls.length, 0);
  assert.match(live.stderr, /2 tasks, at most 1/);

  const instant = ['on_page', 'instant_pages'];
  const pages = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ url: `https://www.example${i % 4}.com/${i}` }));
  assert.equal((await dry(instant, pages(20))).code, 0);
  const r = await send(instant, pages(21));
  assert.equal(r.code, 3);
  assert.equal(r.calls.length, 0);
  assert.match(r.stderr, /21 tasks, at most 20/);
  // Vendor docs: at most 5 identical domains in one request.
  const six = await send(instant, many(6, { url: 'https://example.com/' }));
  assert.equal(six.code, 3);
  assert.equal(six.calls.length, 0);
  assert.match(six.stderr, /6 tasks on example\.com, at most 5/);

  // content_parsing/live docs: "each Live API call can contain only one task".
  const parse = await send(
    ['on_page', 'content_parsing', 'live'],
    many(2, { url: 'https://example.com/' }),
  );
  assert.equal(parse.code, 3);
  assert.match(parse.stderr, /2 tasks, at most 1/);
});

test('filters: 9 top-level conditions exit 3 on an "8 filters maximum" field only', async () => {
  const nine = many(9, ['anchor', 'like', '%a%']).flatMap((c, i) => (i ? ['and', c] : [c]));
  const r = await send(ANCHORS, { ...TASK, filters: nine });
  assert.equal(r.code, 3);
  assert.equal(r.calls.length, 0);
  assert.match(r.stderr, /body\[0\]\.filters: 9 filter conditions, at most 8/);
  const eight = await dry(ANCHORS, { ...TASK, filters: nine.slice(0, 15) });
  assert.equal(eight.code, 0, eight.stderr);
  const nested = await dry(ANCHORS, {
    ...TASK,
    filters: [nine.slice(0, 5), 'or', ...nine.slice(6)],
  });
  assert.equal(nested.code, 0, nested.stderr);
  const backlinks = await dry(ANCHORS, { ...TASK, backlinks_filters: nine });
  assert.equal(backlinks.code, 0, backlinks.stderr);
});

test('--no-validate: an unknown field warns on stderr and is sent; task limits still exit 3', async () => {
  const r = await send(ANCHORS, { ...TASK, colour: 'red' }, '--no-validate');
  const sent = toAnchors(r.calls);
  assert.equal(sent.length, 1, r.stderr);
  assert.deepEqual(JSON.parse(String(sent[0].init?.body)), [{ ...TASK, colour: 'red' }]);
  assert.match(r.stderr, /^dfs: warning: body\[0\]\.colour: unknown field/m);

  const over = await send(ANCHORS, many(2, TASK), '--no-validate');
  assert.equal(over.code, 3);
  assert.equal(over.calls.length, 0);

  const { fetch, calls } = fakeFetch(() => new Response('{}'));
  const body = JSON.stringify({ ...TASK, colour: 'red' });
  const guarded = await dfs([...ANCHORS, '--body', body, '--no-validate'], {
    env: { DFS_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dfs-plan-')), ...LOGIN },
    fetch,
  });
  assert.equal(guarded.code, 4, 'unknown price, no --max-cost: the Cost guard still refuses');
  assert.equal(toAnchors(calls).length, 0);

  const down = await dfs([...ANCHORS, '--body', body, '--no-validate', '--max-cost', '1'], {
    env: { DFS_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dfs-plan-')), ...LOGIN },
    fetch: () => Promise.reject(new Error('net down')),
  });
  assert.equal(down.code, 1);
  assert.match(down.stderr, /^dfs: warning: body\[0\]\.colour: unknown field/m);
});

test('the 272 vendor request examples pass --dry-run unmodified', async () => {
  const { spec } = openCatalog();
  let n = 0;
  for (const [path, item] of Object.entries(spec.paths)) {
    const example = item.post?.requestBody?.content?.['application/json']?.schema?.example;
    if (example === undefined) continue;
    n += 1;
    const r = await dry(pathWords(path), example);
    assert.equal(r.code, 0, `${path}: ${r.stderr}`);
    assert.equal(r.stderr, '', path);
  }
  assert.equal(n, 272);
});

test('--dry-run of a GET: no body, 0 tasks; free path estimate 0 and guard send', async () => {
  const { code, stdout } = await dfs(['appendix', 'user_data', '--dry-run']);
  assert.equal(code, 0);
  const plan = JSON.parse(stdout);
  assert.equal(plan.method, 'GET');
  assert.equal(plan.body, null);
  assert.equal(plan.tasks, 0);
  assert.deepEqual(plan.estimate, { usd: 0, basis: 'rule', price_at: null });
  assert.equal(plan.guard, 'send');
  const sandbox = JSON.parse((await dry(ANCHORS, TASK, '--sandbox', '--max-cost', '0.5')).stdout);
  assert.equal(sandbox.url, 'https://sandbox.dataforseo.com/v3/backlinks/anchors/live');
  assert.equal(sandbox.ceiling, 0.5);
  assert.equal(sandbox.guard, 'send');
});

// Vendor docs and sandbox, 2026-11-07: codes go as integers or numeric strings; technology
// paths only as {path, name} objects.
test('overlay: integer and string codes pass; technology_paths takes objects, not strings', async () => {
  const tech = ['domain_analytics', 'technologies', 'domains_by_technology', 'live'];
  const cases: [string[], unknown, number][] = [
    [
      ['keywords_data', 'bing', 'audience_estimation', 'live'],
      { industry: [806303407], job_function: ['806298607'] },
      0,
    ],
    [
      ['dataforseo_labs', 'google', 'keywords_for_categories', 'live'],
      { category_codes: [12191, '12193'] },
      0,
    ],
    [
      ['dataforseo_labs', 'google', 'domain_metrics_by_categories', 'live'],
      { category_codes: [13418] },
      0,
    ],
    [tech, { technology_paths: [{ path: 'content.cms', name: 'wordpress' }] }, 0],
    [tech, { technology_paths: ['content.cms.wordpress'] }, 3],
  ];
  for (const [words, body, code] of cases) {
    const r = await dry(words, body);
    assert.equal(r.code, code, `${words.join(' ')} ${JSON.stringify(body)}: ${r.stderr}`);
  }
});
