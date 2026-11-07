import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fakeFetch } from './helpers/fetch.ts';
import { dfs } from './helpers/io.ts';

const LOGIN = { DATAFORSEO_LOGIN: 'me@example.com', DATAFORSEO_PASSWORD: 's3cret' };
const env = () => ({ DFS_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dfs-transport-')), ...LOGIN });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const envelope = (status_code: number, cost = 0, tasks: unknown[] = []) => ({
  status_code,
  status_message: status_code === 20000 ? 'Ok.' : 'Fault.',
  cost,
  tasks_count: tasks.length,
  tasks,
});
const ok = () => json(envelope(20000, 0, [{ id: 't1', status_code: 20000, cost: 0, result: [] }]));

const tick = () => new Promise((r) => setImmediate(r));

// Records each wait; the first `n` answers come from `fault`, the rest are 20000.
function flaky(n: number, fault: () => Response | Promise<Response>) {
  const waits: number[] = [];
  const f = fakeFetch(() => (f.calls.length <= n ? fault() : ok()));
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  return { ...f, waits, sleep };
}

// Backoff 1, 2, 4, 8 s plus 0–1 s jitter.
function assertBackoff(waits: number[], n: number) {
  assert.equal(waits.length, n, `waits: ${waits}`);
  for (const [i, ms] of waits.entries()) {
    const base = 1000 * 2 ** i;
    assert.ok(ms >= base && ms < base + 1000, `wait ${i}: ${ms}`);
  }
}

test('free call: transient faults retry 4 times with backoff 1, 2, 4, 8 s', async () => {
  const faults: [string, () => Response | Promise<Response>][] = [
    ['40202', () => json(envelope(40202))],
    ['40209', () => json(envelope(40209))],
    ['50000', () => json(envelope(50000))],
    ['50301', () => json(envelope(50301))],
    ['50303', () => json(envelope(50303))],
    ['task 50000', () => json(envelope(20000, 0, [{ id: 't1', status_code: 50000 }]))],
    ['HTTP 500', () => new Response('<html>oops</html>', { status: 500 })],
    ['network error', () => Promise.reject(new TypeError('fetch failed'))],
  ];
  for (const [name, fault] of faults) {
    const healed = flaky(4, fault);
    const r = await dfs(['appendix', 'user_data'], { env: env(), ...healed });
    assert.equal(r.code, 0, `${name}: ${r.stderr}`);
    assert.equal(healed.calls.length, 5, name);
    assertBackoff(healed.waits, 4);

    const lasting = flaky(9, fault);
    const failed = await dfs(['appendix', 'user_data'], { env: env(), ...lasting });
    assert.equal(failed.code, 1, `${name}: ${failed.stderr}`);
    assert.equal(lasting.calls.length, 5, name);
  }
});

test('free call: other codes never retry', async () => {
  for (const status_code of [40501, 40103, 40401]) {
    const f = flaky(9, () => json(envelope(status_code)));
    await dfs(['appendix', 'user_data'], { env: env(), ...f });
    assert.equal(f.calls.length, 1, String(status_code));
    assert.deepEqual(f.waits, []);
  }
});

const leaf = [{ cost_type: 'per_request', cost: 0.002 }];
const USER_DATA = envelope(20000, 0, [
  {
    id: 'u1',
    status_code: 20000,
    cost: 0,
    result: [{ price: { serp: { live: { advanced: { priority_normal: leaf } } } } }],
  },
]);
const LIVE = ['serp', 'google', 'organic', 'live', 'advanced', '--body', '{"keyword":"pizza"}'];
// A paid Live call; user_data answers the price tree and is not counted.
async function paid(n: number, fault: () => Response | Promise<Response>) {
  const f = flaky(n, fault);
  const fetch = (url: string, init?: RequestInit) =>
    url.endsWith('/user_data') ? Promise.resolve(json(USER_DATA)) : f.fetch(url, init);
  const r = await dfs(LIVE, { env: env(), fetch, sleep: f.sleep });
  return { ...r, calls: f.calls.length, waits: f.waits };
}

test('paid call: retries only a listed code that proves cost 0', async () => {
  for (const code of [40202, 40209, 50000, 50301, 50303, 50401]) {
    const r = await paid(4, () => json(envelope(code, 0)));
    assert.equal(r.code, 0, `${code}: ${r.stderr}`);
    assert.equal(r.calls, 5, String(code));
    assertBackoff(r.waits, 4);
  }
  const never: [string, () => Response][] = [
    ['50000 at a cost', () => json(envelope(50000, 0.002))],
    ['50000 with no cost', () => json({ status_code: 50000, status_message: 'Fault.' })],
    ['HTTP 500', () => new Response('<html>oops</html>', { status: 500 })],
    ['40501 at 0', () => json(envelope(40501, 0))],
  ];
  for (const [name, fault] of never) {
    const r = await paid(9, fault);
    assert.equal(r.code, 1, `${name}: ${r.stderr}`);
    assert.equal(r.calls, 1, name);
    assert.deepEqual(r.waits, [], name);
  }
});

test('paid call: a lost connection exits 1 with the +collect remedy; no retry', async () => {
  const r = await paid(9, () => Promise.reject(new TypeError('fetch failed')));
  assert.equal(r.code, 1);
  assert.equal(r.calls, 1);
  assert.match(r.stderr, /money may be spent; dfs \+collect recovers it\n$/);
});

test('40103: no retry; the task fails and the remedy names --fresh', async () => {
  const r = await paid(9, () =>
    json(envelope(20000, 0, [{ id: 't1', status_code: 40103, status_message: 'Fault.' }])),
  );
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.calls, 1);
  assert.match(r.stderr, /^dfs: task t1 failed 40103 Fault\. — .*--fresh/m);
});

test('X-RateLimit-Remaining 0: the next request of the process waits to the next minute', async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  const { fetch, calls } = fakeFetch(() =>
    json(envelope(20000), 200, { 'X-RateLimit-Remaining': calls.length === 1 ? '0' : '5' }),
  );
  let now = Date.parse('2026-11-07T12:00:20Z');
  const io = { fetch, sleep, now: () => now };
  assert.equal((await dfs(['appendix', 'user_data'], { env: env(), ...io })).code, 0);
  assert.deepEqual(waits, []);
  assert.equal((await dfs(['appendix', 'user_data'], { env: env(), ...io })).code, 0);
  assert.deepEqual(waits, [40_000]);
  now = Date.parse('2026-11-07T12:01:00Z');
  assert.equal((await dfs(['appendix', 'user_data'], { env: env(), ...io })).code, 0);
  assert.deepEqual(waits, [40_000], 'remaining 5: no wait');
});

test('at most 10 requests in flight per process; a queued request obeys the rate limit', async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  const now = () => Date.parse('2026-11-07T12:00:20Z');
  let open = 0;
  let peak = 0;
  const gate = Promise.withResolvers<void>();
  const { fetch, calls } = fakeFetch(async () => {
    peak = Math.max(peak, ++open);
    await gate.promise;
    open--;
    return json(envelope(20000), 200, { 'X-RateLimit-Remaining': '0' });
  });
  const runs = Array.from({ length: 12 }, () =>
    dfs(['appendix', 'user_data'], { env: env(), fetch, sleep, now }),
  );
  while (calls.length < 10) await tick();
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(calls.length, 10);
  gate.resolve();
  const codes = (await Promise.all(runs)).map((r) => r.code);
  assert.deepEqual(codes, Array(12).fill(0));
  assert.equal(calls.length, 12);
  assert.equal(peak, 10);
  assert.deepEqual(waits, [40_000, 40_000], 'only the 2 queued requests wait');
});

test('Live: the client gives up after 130 s; other calls have no timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetch = (url: string, init?: RequestInit) => {
    signals.push(init?.signal);
    if (url.endsWith('/user_data')) return Promise.resolve(json(USER_DATA));
    return new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
    );
  };
  const pending = dfs(LIVE, { env: env(), fetch });
  while (signals.length < 2) await tick();
  t.mock.timers.tick(129_999);
  await tick();
  assert.equal(signals[1]?.aborted, false);
  t.mock.timers.tick(1);
  const r = await pending;
  assert.equal(signals[0], undefined, 'user_data is not Live');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no answer in 130 s — money may be spent; dfs \+collect recovers it\n$/);
});
