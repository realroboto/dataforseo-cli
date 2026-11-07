import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fakeFetch } from './helpers/fetch.ts';
import { dfs } from './helpers/io.ts';

const LOGIN = { DATAFORSEO_LOGIN: 'me@example.com', DATAFORSEO_PASSWORD: 's3cret' };
const env = () => ({ DFS_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dfs-reuse-')), ...LOGIN });
const at = (iso: string) => () => Date.parse(iso);
const NOON = '2026-11-07T12:00:00.000Z';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const leaf = [{ cost_type: 'per_request', cost: 0.002 }];
const USER_DATA = {
  status_code: 20000,
  cost: 0,
  tasks_count: 1,
  tasks: [
    {
      id: 'u1',
      status_code: 20000,
      cost: 0,
      result: [{ price: { serp: { live: { advanced: { priority_normal: leaf } } } } }],
    },
  ],
};
const task = (id: string, status_code = 20000) => ({
  id,
  status_code,
  status_message: status_code === 20000 ? 'Ok.' : 'Invalid Field.',
  cost: status_code === 20000 ? 0.002 : 0,
  result: status_code === 20000 ? [{ keyword: 'pizza', items: [{ rank_group: 1 }] }] : null,
});
const live = (tasks: unknown[] = [task('t1')]) => ({
  status_code: 20000,
  status_message: 'Ok.',
  cost: 0.002,
  tasks_count: tasks.length,
  tasks,
});

const LIVE = ['serp', 'google', 'organic', 'live', 'advanced'];
// Answers user_data with the price tree and the serp call with `serp`.
async function call(
  e: NodeJS.ProcessEnv,
  iso: string,
  body: unknown,
  flags: string[] = [],
  serp: unknown = live(),
  argv = LIVE,
) {
  const { fetch, calls } = fakeFetch((url) => json(url.includes('user_data') ? USER_DATA : serp));
  const r = await dfs([...argv, '--body', JSON.stringify(body), ...flags], {
    env: e,
    fetch,
    now: at(iso),
  });
  return { ...r, calls: calls.filter((c) => !c.url.includes('user_data')).length };
}
const rows = (e: NodeJS.ProcessEnv) => {
  const db = new DatabaseSync(join(e.DFS_CONFIG_DIR as string, 'store.db'), { readOnly: true });
  try {
    return db
      .prepare('SELECT id, spec_path, cost, reused_from, body IS NULL AS no_body FROM response')
      .all()
      .filter((r) => r.spec_path !== '/v3/appendix/user_data');
  } finally {
    db.close();
  }
};

test('the same paid request within 12 h returns the stored response at $0, no call', async () => {
  const e = env();
  const first = await call(e, NOON, { keyword: 'pizza', language_code: 'en' });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.calls, 1);
  const id = first.stderr.match(/saved=(r_\w+)/)?.[1];

  const { fetch, calls } = fakeFetch(() => json({}));
  const again = await dfs(
    [...LIVE, '--body', JSON.stringify({ language_code: 'en', keyword: 'pizza' })],
    { env: e, fetch, now: at('2026-11-07T15:04:05Z') },
  );
  assert.equal(again.code, 0, again.stderr);
  assert.equal(calls.length, 0);
  assert.equal(
    again.stderr,
    `dfs: 20000 /v3/serp/google/organic/live/advanced tasks=1 cost=$0 est=$0 reused=${id} age=3h04m\n`,
  );
  assert.equal(again.stdout, first.stdout);
  const [paid, reuse] = rows(e);
  assert.equal(paid.id, id);
  assert.deepEqual(
    { ...reuse, id: undefined },
    {
      id: undefined,
      spec_path: '/v3/serp/google/organic/live/advanced',
      cost: 0,
      reused_from: id,
      no_body: 1,
    },
  );
});

test('at 12 h the stored response is reused; at 12 h + 1 s and with --fresh the call is sent', async () => {
  const e = env();
  const body = { keyword: 'pizza' };
  await call(e, NOON, body);
  assert.match((await call(e, '2026-11-08T00:00:00Z', body)).stderr, / reused=r_\w+ age=12h00m\n$/);
  const late = await call(e, '2026-11-08T00:00:01Z', body);
  assert.equal(late.calls, 1);
  assert.match(late.stderr, / saved=r_/);
  const fresh = await call(e, '2026-11-08T00:00:02Z', body, ['--fresh']);
  assert.equal(fresh.calls, 1);
  assert.match(fresh.stderr, / saved=r_/);
  // The newest send is the one reused.
  const id = fresh.stderr.match(/saved=(r_\w+)/)?.[1];
  assert.match(
    (await call(e, '2026-11-08T00:00:03Z', body)).stderr,
    new RegExp(`reused=${id} age=1s`),
  );
});

test('reuse key: nested key order does not count; values, path and the sandbox flag do', async () => {
  const e = env();
  const body = { keyword: 'pizza', search_param: 'a', depth: 10 };
  await call(e, NOON, { depth: 10, keyword: 'pizza', search_param: 'a' });
  assert.equal((await call(e, NOON, body)).calls, 0);
  assert.equal((await call(e, NOON, { ...body, depth: 20 })).calls, 1);
  const sandbox = await call(e, NOON, body, ['--sandbox']);
  assert.equal(sandbox.calls, 1);
  assert.equal((await call(e, NOON, body, ['--sandbox'])).calls, 0);
  const regular = ['serp', 'google', 'organic', 'live', 'regular'];
  assert.equal((await call(e, NOON, body, ['--max-cost', '1'], live(), regular)).calls, 1);
});

test('a response with any failed task is never reused', async () => {
  const e = env();
  const partial = live([task('t1'), task('t2', 40501)]);
  assert.equal((await call(e, NOON, { keyword: 'pizza' }, [], partial)).code, 6);
  const again = await call(e, NOON, { keyword: 'pizza' });
  assert.equal(again.calls, 1);
  assert.equal(again.code, 0);
});

test('free paths always go to the API', async () => {
  const e = env();
  const { fetch, calls } = fakeFetch(() => json(USER_DATA));
  for (const _ of [1, 2]) {
    assert.equal((await dfs(['appendix', 'user_data'], { env: e, fetch, now: at(NOON) })).code, 0);
  }
  assert.equal(calls.length, 2);
});

test('--dry-run shows the reusable id, or null', async () => {
  const e = env();
  const plan = async (...flags: string[]) => {
    const r = await dfs([...LIVE, '--body', '{"keyword":"pizza"}', '--dry-run', ...flags], {
      env: e,
      now: at(NOON),
    });
    return JSON.parse(r.stdout).reuse;
  };
  assert.equal(await plan(), null);
  const id = (await call(e, NOON, { keyword: 'pizza' })).stderr.match(/saved=(r_\w+)/)?.[1];
  assert.equal(await plan(), id);
  assert.equal(await plan('--fresh'), null);
});

test('a repeated task_post in the window posts nothing and returns the posted tasks', async () => {
  const e = env();
  const argv = ['serp', 'google', 'organic', 'task_post'];
  const posted = { ...live([{ ...task('t9'), status_code: 20100, result: null }]) };
  const first = await call(e, NOON, { keyword: 'pizza' }, ['--max-cost', '1'], posted, argv);
  assert.equal(first.calls, 1);
  const again = await call(e, NOON, { keyword: 'pizza' }, ['--max-cost', '1'], posted, argv);
  assert.equal(again.calls, 0);
  assert.match(again.stderr, / reused=r_\w+ age=0s\n$/);
  assert.match(again.stdout, /"id":"t9"/);
});

test('a failed envelope is never reused', async () => {
  const e = env();
  const failed = { ...live(), status_code: 50000, status_message: 'Internal Error.' };
  assert.equal((await call(e, NOON, { keyword: 'pizza' }, [], failed)).code, 1);
  assert.equal((await call(e, NOON, { keyword: 'pizza' })).calls, 1);
});

test('--full on a reuse prints the stored response; --dry-run needs no credentials', async () => {
  const e = env();
  await call(e, NOON, { keyword: 'pizza' });
  const full = await call(e, NOON, { keyword: 'pizza' }, ['--full']);
  assert.equal(full.calls, 0);
  assert.deepEqual(JSON.parse(full.stdout), live());
  const id = full.stderr.match(/reused=(r_\w+)/)?.[1];
  const anonymous = { DFS_CONFIG_DIR: e.DFS_CONFIG_DIR };
  const r = await dfs([...LIVE, '--body', '{"keyword":"pizza"}', '--dry-run'], { env: anonymous });
  assert.equal(JSON.parse(r.stdout).reuse, id);
});
