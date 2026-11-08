import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { prune } from '../scripts/fixtures-record.ts';
import { newUncovered, sandboxRun } from '../scripts/sandbox.ts';
import { openCatalog } from '../src/catalog.ts';
import { fakeFetch } from './helpers/fetch.ts';
import { dfs } from './helpers/io.ts';

// `pnpm test:sandbox` is a script: `sandboxRun` is its seam, driving `run()` with a fake fetch.
const root = join(import.meta.dirname, '..');
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8'));
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const taskCode = (status_code: number, status_message = 'x') => ({
  status_code: 20000,
  cost: 0,
  tasks_count: 1,
  tasks_error: 1,
  tasks: [{ id: 't1', status_code, status_message, cost: 0, result: null }],
});
const env = { DATAFORSEO_LOGIN: 'l', DATAFORSEO_PASSWORD: 'p' };
const NOW = () => Date.parse('2026-11-07T12:00:00Z');

test('sandbox run: examples and collects go to the sandbox; 40404 is coverage, other codes fail', async () => {
  const paths = new Set([
    '/v3/backlinks/anchors/live',
    '/v3/serp/google/organic/task_post',
    '/v3/ai_optimization/claude/llm_responses/live',
    '/v3/dataforseo_labs/google/historical_serps/live', // overlay adds datetime_from
    '/v3/ai_optimization/id_list',
  ]);
  const post = fixture('serp-google-organic-task-post');
  const id = post.tasks[0].id;
  const { fetch, calls } = fakeFetch((url) => {
    const path = new URL(url).pathname;
    if (path === '/v3/backlinks/anchors/live') return json(fixture('backlinks-anchors-live'));
    if (path === '/v3/serp/google/organic/task_post') return json(post);
    if (path.includes('/task_get/')) return json(fixture('serp-google-organic-task-get-advanced'));
    if (path.includes('llm_responses')) return json(taskCode(40404));
    if (path.includes('historical_serps'))
      return json(taskCode(40501, "Invalid Field: 'datetime_from'."));
    if (path === '/v3/ai_optimization/id_list') return json(taskCode(40404));
    throw new Error(`unexpected ${url}`);
  });
  const { uncovered, failures } = await sandboxRun(
    { env, fetch, now: NOW, sleep: async () => {} },
    (p) => paths.has(p),
  );
  assert.deepEqual(uncovered, [
    '/v3/ai_optimization/claude/llm_responses/live',
    '/v3/ai_optimization/id_list',
  ]);
  assert.equal(failures.length, 1);
  assert.match(
    failures[0],
    /^\/v3\/dataforseo_labs\/google\/historical_serps\/live: exit 1 \[40501\] .*datetime_from/,
  );
  for (const c of calls) assert.equal(new URL(c.url).host, 'sandbox.dataforseo.com');
  const sent = calls.map((c) => new URL(c.url).pathname);
  // Each collect call of the level, with the posted id.
  for (const v of ['advanced', 'regular', 'html']) {
    assert.ok(sent.includes(`/v3/serp/google/organic/task_get/${v}/${id}`), v);
  }
  // Request examples go unmodified.
  const anchors = calls.find((c) => c.url.endsWith('/v3/backlinks/anchors/live'));
  const { spec } = JSON.parse(readFileSync(join(root, 'spec/snapshot.json'), 'utf8'));
  assert.deepEqual(
    JSON.parse(String(anchors?.init?.body)),
    spec.paths['/v3/backlinks/anchors/live'].post.requestBody.content['application/json'].schema
      .example,
  );
  // The hand path carries the body of the serp/id_list example, dates moved into the window.
  const hand = calls.find((c) => c.url.endsWith('/v3/ai_optimization/id_list'));
  const { datetime_from, datetime_to, ...rest } = JSON.parse(String(hand?.init?.body))[0];
  const ex =
    spec.paths['/v3/serp/id_list'].post.requestBody.content['application/json'].schema.example[0];
  assert.deepEqual(rest, { limit: ex.limit, include_metadata: ex.include_metadata });
  assert.notEqual(datetime_to, ex.datetime_to);
});

// Vendor rules from the spec field docs; a body outside them gets the sandbox's 40501.
const at = (v: string) => Date.parse(`${v.replace(' ', 'T')}Z`);
function vendorWindow(path: string, task: Record<string, string>): string | undefined {
  const now = NOW();
  if (path.endsWith('/id_list')) {
    if (at(task.datetime_from) < now - 30 * 864e5) return "Invalid Field: 'datetime_from'.";
    if (at(task.datetime_to) >= now) return "Invalid Field: 'datetime_to'.";
  } else if (at(task.check_in) < now - (now % 864e5)) {
    return "Invalid Field: 'check_in - must not be earlier than present date'.";
  }
}

test('sandbox run: time-bound example dates move into the vendor window, span and values kept', async () => {
  const paths = new Set([
    '/v3/serp/id_list',
    '/v3/business_data/id_list',
    '/v3/ai_optimization/id_list',
    '/v3/business_data/google/hotel_searches/live',
    '/v3/business_data/google/hotel_searches/task_post',
  ]);
  const { fetch, calls } = fakeFetch((url, init) => {
    const path = new URL(url).pathname;
    if (path.includes('/task_get/')) return json(taskCode(40404));
    const fault = vendorWindow(path, JSON.parse(String(init?.body))[0]);
    return json(taskCode(fault ? 40501 : 40404, fault));
  });
  const { uncovered, failures } = await sandboxRun(
    { env, fetch, now: NOW, sleep: async () => {} },
    (p) => paths.has(p),
  );
  assert.deepEqual(failures, []);
  assert.deepEqual(uncovered, [...paths].sort());
  const { spec } = JSON.parse(readFileSync(join(root, 'spec/snapshot.json'), 'utf8'));
  const span = (t: Record<string, string>, a: string, b: string) => at(t[b]) - at(t[a]);
  for (const [path, a, b] of [
    ['/v3/serp/id_list', 'datetime_from', 'datetime_to'],
    ['/v3/business_data/google/hotel_searches/live', 'check_in', 'check_out'],
  ]) {
    const ex = spec.paths[path].post.requestBody.content['application/json'].schema.example[0];
    const sent = JSON.parse(String(calls.find((c) => c.url.endsWith(path))?.init?.body))[0];
    assert.equal(span(sent, a, b), span(ex, a, b), `${path} span`);
    assert.match(sent[a], ex[a].length === 10 ? /^\d{4}-\d\d-\d\d$/ : /^\S+ \d\d:\d\d:\d\d$/);
    assert.deepEqual(
      { ...sent, [a]: 0, [b]: 0 },
      { ...ex, [a]: 0, [b]: 0 },
      `${path} other values`,
    );
  }
});

test('overlay: merchant/amazon/sellers example carries an Amazon language_code', () => {
  const ep = openCatalog().endpoints.find(
    (e) => e.path === '/v3/merchant/amazon/sellers/task_post',
  );
  assert.deepEqual(ep?.op.requestBody?.content?.['application/json']?.schema?.example, [
    { language_code: 'en_US', location_code: 2840, asin: 'B085RFFC9Q' },
  ]);
});

test('sandbox run: an exit with no API answer (missing login) fails', async () => {
  const { failures } = await sandboxRun(
    { env: {}, fetch: () => Promise.reject(new Error('no call')), now: NOW },
    (p) => p === '/v3/backlinks/anchors/live',
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /exit 2 \[\] dfs: DATAFORSEO_LOGIN is not set/);
});

test('a 40404 not in the committed file is new; no committed file is a first run', () => {
  const committed = { sha: 's', date: 'd', paths: ['/v3/a'] };
  assert.deepEqual(newUncovered(['/v3/a', '/v3/b'], committed), ['/v3/b']);
  assert.deepEqual(newUncovered(['/v3/a'], committed), []);
  assert.deepEqual(newUncovered(['/v3/a'], undefined), []);
});

test('fixtures: prune keeps 3 entries per array; a recorded Live fixture renders', async () => {
  const deep = { path: ['v3', 'a', 'b', 'live'], tasks: [{ result: [{ items: [1, 2, 3, 4] }] }] };
  assert.deepEqual(prune(deep), {
    path: ['v3', 'a', 'b', 'live'],
    tasks: [{ result: [{ items: [1, 2, 3] }] }],
  });
  const { fetch } = fakeFetch(() => json(fixture('backlinks-anchors-live')));
  const body = JSON.stringify({ target: 'forbes.com', limit: 3 });
  const r = await dfs(['backlinks', 'anchors', 'live', '--sandbox', '--body', body], {
    fetch,
    env: { ...env, DFS_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dfs-fx-')) },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').length >= 2, true);
});

test('publish.yml: tag v*, OIDC, staged publish with provenance, no npm token', () => {
  const text = readFileSync(join(root, '.github/workflows/publish.yml'), 'utf8');
  const wf = parse(text);
  assert.deepEqual(wf.on, { push: { tags: ['v*'] } });
  assert.equal(wf.permissions['id-token'], 'write');
  assert.doesNotMatch(text, /secrets\.|NPM_TOKEN|NODE_AUTH_TOKEN/);
  const steps: { uses?: string; run?: string }[] = wf.jobs.publish.steps;
  for (const s of steps) if (s.uses) assert.match(s.uses, /^actions\//);
  const runs = steps.map((s) => s.run ?? '');
  assert.ok(runs.includes('npm stage publish --provenance'));
  assert.ok(!runs.some((r) => /npm publish/.test(r)), 'no direct publish');
});

test('prepublishOnly gate: typecheck, lint, test, spec:check, build, pack check', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts.prepublishOnly,
    'pnpm typecheck && pnpm lint && pnpm test && pnpm spec:check && pnpm build && pnpm pack:check',
  );
});
