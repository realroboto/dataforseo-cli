import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSnapshot } from '../src/catalog.ts';
import { fakeFetch } from './helpers/fetch.ts';
import { dfs } from './helpers/io.ts';

const T0 = Date.parse('2026-11-07T12:00:00Z');
const HOUR = 3_600_000;
const COMMITS =
  'https://api.github.com/repos/dataforseo/OpenApiDocumentation/commits?path=openapi_specification.yaml&sha=master&per_page=1';
const NEW_SHA = 'abc1234def5678901234567890123456789abcde';
const RAW = `https://raw.githubusercontent.com/dataforseo/OpenApiDocumentation/${NEW_SHA}/openapi_specification.yaml`;
const SNAPSHOT_SHA = readSnapshot().sha;

const commits = (sha: string, etag: string) =>
  new Response(JSON.stringify([{ sha, commit: { committer: { date: '2026-11-05T08:00:00Z' } } }]), {
    headers: { etag },
  });
// The snapshot spec plus one GET path, as JSON text (JSON is YAML).
function newSpec(change: (spec: ReturnType<typeof readSnapshot>['spec']) => void = () => {}) {
  const { spec } = readSnapshot();
  spec.paths['/v3/appendix/new_thing'] = spec.paths['/v3/appendix/status'];
  change(spec);
  return JSON.stringify(spec);
}
const dir = () => mkdtempSync(join(tmpdir(), 'dfs-spec-'));
const header = (init: RequestInit | undefined, name: string) =>
  new Headers(init?.headers).get(name);
const at = (ms: number) => () => ms;
const none = () => Promise.reject(new Error('unexpected network call'));

test('within 24 h no fetch; after 24 h an ETag 304 skips the raw fetch', async () => {
  const env = { DFS_CONFIG_DIR: dir() };
  const first = fakeFetch(() => commits(SNAPSHOT_SHA, '"e1"'));
  let r = await dfs(['--help'], { env, fetch: first.fetch, now: at(T0) }, { specCheck: true });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  assert.deepEqual(
    first.calls.map((c) => c.url),
    [COMMITS],
  );
  assert.equal(header(first.calls[0].init, 'if-none-match'), null);
  assert.match(header(first.calls[0].init, 'user-agent') ?? '', /^dfs\/\d+\.\d+\.\d+$/);

  r = await dfs(['--help'], { env, fetch: none, now: at(T0 + 23 * HOUR) }, { specCheck: true });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');

  const later = fakeFetch(() => new Response(null, { status: 304 }));
  r = await dfs(
    ['--help'],
    { env, fetch: later.fetch, now: at(T0 + 25 * HOUR) },
    { specCheck: true },
  );
  assert.equal(r.stderr, '');
  assert.deepEqual(
    later.calls.map((c) => c.url),
    [COMMITS],
  );
  assert.equal(header(later.calls[0].init, 'if-none-match'), '"e1"');
});

test('a new SHA: raw fetch by SHA, check, atomic cache; --version shows the cache', async () => {
  const env = { DFS_CONFIG_DIR: dir() };
  const { fetch, calls } = fakeFetch((url) =>
    url === COMMITS ? commits(NEW_SHA, '"e2"') : new Response(newSpec()),
  );
  const r = await dfs(['appendix', 'new_thing', '--help'], { env, fetch }, { specCheck: true });
  assert.equal(r.stderr, '');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /GET https:\/\/api\.dataforseo\.com\/v3\/appendix\/new_thing/);
  assert.deepEqual(
    calls.map((c) => c.url),
    [COMMITS, RAW],
  );
  assert.equal(statSync(env.DFS_CONFIG_DIR).mode & 0o777, 0o700);
  const cache = join(env.DFS_CONFIG_DIR, 'spec.json');
  assert.equal(statSync(cache).mode & 0o777, 0o600);
  const cached = JSON.parse(readFileSync(cache, 'utf8'));
  assert.equal(cached.sha, NEW_SHA);
  // The cache keeps the vendor spec: no overlay applied.
  assert.deepEqual(cached.spec, JSON.parse(newSpec()));

  const v = await dfs(['--version'], { env });
  assert.match(v.stdout, /^dfs \d+\.\d+\.\d+ \(spec abc1234, 2026-11-05\)\n$/);
  // The same SHA again: no raw fetch.
  const again = fakeFetch(() => commits(NEW_SHA, '"e3"'));
  await dfs(['--help'], { env, fetch: again.fetch, now: at(T0 + 25 * HOUR) }, { specCheck: true });
  assert.deepEqual(
    again.calls.map((c) => c.url),
    [COMMITS],
  );
});

test('a cache older than the snapshot is not used', async () => {
  const env = { DFS_CONFIG_DIR: dir() };
  const { fetch } = fakeFetch((url) =>
    url === COMMITS
      ? new Response(
          JSON.stringify([
            { sha: NEW_SHA, commit: { committer: { date: '2026-01-01T00:00:00Z' } } },
          ]),
        )
      : new Response(newSpec()),
  );
  await dfs(['--help'], { env, fetch }, { specCheck: true });
  const v = await dfs(['--version'], { env });
  assert.match(v.stdout, /\(spec 55a4ed0, 2026-10-26\)/);
});

const failures: [string, (url: string) => Response | Promise<Response>, RegExp][] = [
  ['network down', () => Promise.reject(new Error('getaddrinfo ENOTFOUND')), /ENOTFOUND/],
  ['commits API 403', () => new Response('rate limited', { status: 403 }), /HTTP 403/],
  [
    'raw fetch 500',
    (url) => (url === COMMITS ? commits(NEW_SHA, '"e4"') : new Response('', { status: 500 })),
    /HTTP 500/,
  ],
  [
    'two methods on a path',
    (url) =>
      url === COMMITS
        ? commits(NEW_SHA, '"e4"')
        : new Response(
            newSpec((s) => {
              s.paths['/v3/appendix/new_thing'] = { ...s.paths['/v3/appendix/status'], post: {} };
            }),
          ),
    /structural check.*2 methods, want 1/,
  ],
  [
    'more than 10 % of paths dropped',
    (url) =>
      url === COMMITS
        ? commits(NEW_SHA, '"e4"')
        : new Response(
            newSpec((s) => {
              for (const p of Object.keys(s.paths).slice(0, 100)) delete s.paths[p];
            }),
          ),
    /path count fell from 565 to 466/,
  ],
  [
    'not YAML',
    (url) => (url === COMMITS ? commits(NEW_SHA, '"e4"') : new Response('a: [')),
    /at line 1/,
  ],
];

for (const [name, respond, reason] of failures) {
  test(`failed check (${name}): spec kept, one warning, retry after 1 h`, async () => {
    const env = { DFS_CONFIG_DIR: dir() };
    const { fetch, calls } = fakeFetch(respond);
    const r = await dfs(['--help'], { env, fetch }, { specCheck: true });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /\(spec 55a4ed0, 2026-10-26\)/);
    const lines = r.stderr.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^dfs: warning: spec check failed, keeping spec 55a4ed0: /);
    assert.match(lines[0], reason);
    assert.match(lines[0], /next try in 1 h$/);

    // Within 1 h: no fetch and no warning.
    const quiet = await dfs(
      ['--help'],
      { env, fetch: none, now: at(T0 + 59 * 60_000) },
      { specCheck: true },
    );
    assert.equal(quiet.stderr, '');
    // After 1 h: tried again, with no ETag of the failed answer.
    const retry = fakeFetch(() => commits(SNAPSHOT_SHA, '"e5"'));
    const again = await dfs(
      ['--help'],
      { env, fetch: retry.fetch, now: at(T0 + 61 * 60_000) },
      { specCheck: true },
    );
    assert.equal(again.stderr, '');
    assert.deepEqual(
      retry.calls.map((c) => c.url),
      [COMMITS],
    );
    assert.equal(header(retry.calls[0].init, 'if-none-match'), null);
    assert.ok(calls.length >= 1);
  });
}

test('--version and store commands never check the spec', async () => {
  const env = { DFS_CONFIG_DIR: dir() };
  for (const argv of [['--version'], ['store', 'path']]) {
    const r = await dfs(argv, { env, fetch: none }, { specCheck: true });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
  }
});
