import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openCatalog, readSnapshot } from '../src/catalog.ts';
import { dfs } from './helpers/io.ts';

const MODULES = [
  'ai_optimization',
  'app_data',
  'appendix',
  'backlinks',
  'business_data',
  'content_analysis',
  'dataforseo_labs',
  'domain_analytics',
  'keywords_data',
  'merchant',
  'on_page',
  'serp',
];

test('--version shows the dfs version and the snapshot SHA and date', async () => {
  const { sha, date } = readSnapshot();
  assert.equal(`${sha.slice(0, 7)} ${date.slice(0, 10)}`, '55a4ed0 2026-10-26');
  const { code, stdout, stderr } = await dfs(['--version']);
  assert.equal(code, 0);
  assert.match(stdout, /^dfs \d+\.\d+\.\d+ \(spec 55a4ed0, 2026-10-26\)\n$/);
  assert.equal(stderr, '');
});

test('root --help lists the 12 modules and the hand commands', async () => {
  for (const argv of [['--help'], []]) {
    const { code, stdout } = await dfs(argv);
    assert.equal(code, 0);
    const modules = stdout.split('modules:\n')[1].split('\n\n')[0].trim().split(/\s+/);
    assert.deepEqual(modules, MODULES);
    for (const c of ['schema', 'search', 'store show', 'store list', 'store path'])
      assert.match(stdout, new RegExp(`^  ${c} `, 'm'));
  }
});

test('a level lists its children, with or without --help', async () => {
  for (const argv of [['serp', '--help'], ['serp']]) {
    const { code, stdout } = await dfs(argv);
    assert.equal(code, 0);
    assert.match(stdout, /^dfs serp\n\nchildren:\n/);
    assert.match(stdout, /^ {2}google {2}has children$/m);
  }
});

test('an endpoint that is also a level shows the endpoint and its children', async () => {
  const { code, stdout } = await dfs(['on_page', 'content_parsing', '--help']);
  assert.equal(code, 0);
  assert.match(stdout, /^POST https:\/\/api\.dataforseo\.com\/v3\/on_page\/content_parsing$/m);
  assert.match(stdout, /^request fields: dfs schema on_page content_parsing$/m);
  assert.match(stdout, /\nchildren:\n {2}live {2}POST\n$/);
});

test('a path-parameter slot takes a word that is not a child word', async () => {
  const level = await dfs(['serp', 'google', 'locations', '--help']);
  assert.equal(level.code, 0);
  assert.match(level.stdout, /^GET https:\/\/api\.dataforseo\.com\/v3\/serp\/google\/locations$/m);
  assert.match(level.stdout, /^ {2}<country> {2}GET$/m);
  const filled = await dfs(['serp', 'google', 'locations', 'us', '--help']);
  assert.equal(filled.code, 0);
  assert.match(filled.stdout, /^dfs serp google locations <country>\n/);
  assert.match(
    filled.stdout,
    /^GET https:\/\/api\.dataforseo\.com\/v3\/serp\/google\/locations\/us$/m,
  );
});

test('an unknown word or flag exits 3 with nothing on stdout', async () => {
  for (const argv of [['serp', 'nope'], ['serp', '--nope'], ['nope']]) {
    const { code, stdout, stderr } = await dfs(argv);
    assert.equal(code, 3, argv.join(' '));
    assert.equal(stdout, '');
    assert.match(stderr, /^dfs: /);
  }
  const { stderr } = await dfs(['serp', 'nope']);
  assert.equal(stderr, "dfs: unknown command word 'nope' after 'dfs serp'; see: dfs serp --help\n");
});

test('store --help and the root help list every store command', async () => {
  const help = await dfs(['store', '--help']);
  const root = await dfs([]);
  for (const sub of ['show', 'list', 'search', 'spend', 'sql', 'backup', 'path']) {
    assert.match(help.stdout, new RegExp(`dfs store ${sub}\\b`), sub);
    assert.match(root.stdout, new RegExp(`^ {2}store ${sub}\\b`, 'm'), sub);
  }
});

test('an endpoint --help shows how to call it', async () => {
  const post = await dfs(['on_page', 'content_parsing', '--help']);
  assert.match(
    post.stdout,
    /^call: dfs on_page content_parsing --body <json\|@file\|-> \[--full\] \[--sandbox\] \[--max-cost <usd>\] \[--fresh\] \[--dry-run\] \[--no-validate\]$/m,
  );
  const get = await dfs(['appendix', 'user_data', '--help']);
  assert.match(get.stdout, /^call: dfs appendix user_data \[--full\]/m);
});

test('every spec path (565) has a command whose --help exits 0 and shows its call line', async () => {
  const endpoints = openCatalog().endpoints;
  assert.equal(endpoints.length, 565);
  for (const ep of endpoints) {
    const words = ep.words.map((w) => (w.startsWith('<') ? 'x1' : w));
    const r = await dfs([...words, '--help']);
    assert.equal(r.code, 0, `${ep.path}: ${r.stderr}`);
    assert.match(r.stdout, /^call: dfs /m, ep.path);
  }
});

test('schema lists request fields, nested ones included', async () => {
  const { code, stdout } = await dfs(['schema', 'serp', 'google', 'organic', 'live', 'advanced']);
  assert.equal(code, 0);
  assert.match(stdout, /^POST \/v3\/serp\/google\/organic\/live\/advanced$/m);
  assert.match(stdout, /^body: array of tasks; task fields:$/m);
  assert.match(stdout, /^ {2}keyword {2}string {2}keyword; required field;/m);
  assert.match(stdout, /^ {2}location_code {2}integer /m);
  // Fields only under discriminator.mapping (Planner, Schema resolution).
  const llm = await dfs(['schema', 'ai_optimization', 'llm_mentions', 'search_mentions', 'live']);
  assert.match(llm.stdout, /^ {2}target\[\]\.domain {2}string/m);
  assert.match(llm.stdout, /^ {2}target\[\]\.keyword {2}string/m);
});

test('schema of an id slot names its GET endpoint; of a level exits 3', async () => {
  const get = await dfs(['schema', 'serp', 'google', 'organic', 'task_get', 'advanced']);
  assert.equal(get.code, 0);
  assert.match(get.stdout, /^GET \/v3\/serp\/google\/organic\/task_get\/advanced\/\{id\}$/m);
  assert.match(get.stdout, /^path parameters: <id>\nbody: none\n$/m);
  const level = await dfs(['schema', 'serp', 'google']);
  assert.equal(level.code, 3);
  assert.equal(level.stderr, 'dfs: dfs serp google is a level, not an endpoint\n');
  assert.equal((await dfs(['schema'])).code, 3);
});

test('search finds the AI Mode paths, case and diacritics folded', async () => {
  const plain = await dfs(['search', 'ai mode']);
  assert.equal(plain.code, 0);
  const lines = plain.stdout.trimEnd().split('\n');
  assert.ok(
    lines.slice(0, 8).every((l) => l.startsWith('dfs serp google ai_mode ')),
    plain.stdout,
  );
  assert.ok(lines.some((l) => l.startsWith('dfs serp google ai_mode live advanced  POST')));
  const folded = await dfs(['search', 'ÁI', 'MÓDE']);
  assert.equal(folded.stdout, plain.stdout);
});

test('search with no word exits 3; no hit warns on stderr', async () => {
  const empty = await dfs(['search', '!!']);
  assert.equal(empty.code, 3);
  assert.equal(empty.stderr, 'dfs: usage: dfs search "<words>"\n');
  const none = await dfs(['search', 'zzqqxx']);
  assert.equal(none.code, 0);
  assert.equal(none.stdout, '');
  assert.equal(none.stderr, 'dfs: no match\n');
});
