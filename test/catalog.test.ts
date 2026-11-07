import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSpec, openCatalog, readOverlay, readSnapshot, type Spec } from '../src/catalog.ts';
import { applyOverlay } from '../src/overlay.ts';
import { faults } from '../src/schema.ts';

// Name and type faults of every spec request example (scripts/check-vendor-spec.py `examples`).
function exampleFaults(spec: Spec) {
  const count = { examples: 0, name: 0, type: 0, null: 0 };
  for (const item of Object.values(spec.paths)) {
    const body = item.post?.requestBody?.content?.['application/json']?.schema;
    if (body?.example === undefined) continue;
    count.examples += 1;
    for (const task of Array.isArray(body.example) ? body.example : [body.example]) {
      for (const f of faults(task, body.items, spec.components.schemas)) count[f.kind] += 1;
    }
  }
  return count;
}

test('the 272 request examples validate on the overlaid spec only', () => {
  const vendor = readSnapshot().spec;
  assert.deepEqual(exampleFaults(vendor), { examples: 272, name: 5, type: 86, null: 0 });
  const overlaid = readSnapshot().spec;
  assert.deepEqual(applyOverlay(overlaid, readOverlay()), []);
  assert.deepEqual(exampleFaults(overlaid), { examples: 272, name: 0, type: 0, null: 0 });
});

test('every spec path resolves from its own command words', () => {
  const catalog = openCatalog();
  assert.equal(catalog.endpoints.length, 565);
  for (const ep of catalog.endpoints) {
    const words = ep.words.map((w) => (w.startsWith('<') ? 'x1' : w));
    assert.equal(catalog.resolve(words).node.endpoint?.path, ep.path);
  }
});

test('the overlaid snapshot passes the structural check', () => {
  const { spec } = readSnapshot();
  applyOverlay(spec, readOverlay());
  assert.deepEqual(checkSpec(spec, 565), []);
});

const tiny = () => ({
  paths: {},
  components: {
    schemas: {
      A: {
        type: 'object',
        properties: { f: { type: 'array', items: { type: 'object' } }, s: { type: 'string' } },
      },
    },
  },
});
const overlay = (actions: unknown[]) => ({ overlay: '1.0.0', info: {}, actions });

test('an overlay target that is not a normalized path fails the load', () => {
  for (const target of [
    '$.components.schemas.A',
    '$[\'components\']["schemas"]',
    "$['components']x",
    '$',
    "components['A']",
  ]) {
    assert.throws(
      () => applyOverlay(tiny(), overlay([{ target, remove: true }])),
      /not a normalized path/,
      target,
    );
  }
});

test('an overlay target that selects a scalar fails the load', () => {
  const target = "$['components']['schemas']['A']['properties']['s']['type']";
  assert.throws(
    () => applyOverlay(tiny(), overlay([{ target, remove: true }])),
    /no object or array/,
  );
});

test('overlay remove and update apply; an action with no effect is reported', () => {
  const doc = tiny();
  const props = "$['components']['schemas']['A']['properties']";
  const noEffect = applyOverlay(
    doc,
    overlay([
      { target: `${props}['f']['items']`, remove: true },
      { target: props, update: { n: { type: 'integer' } } },
      { target: props, update: { s: { type: 'string' } } }, // already so
      { target: "$['components']['schemas']['Gone']", remove: true },
    ]),
  );
  assert.deepEqual(doc.components.schemas.A.properties, {
    f: { type: 'array' },
    s: { type: 'string' },
    n: { type: 'integer' },
  });
  assert.deepEqual(noEffect, [props, "$['components']['schemas']['Gone']"]);
});

test('the structural check names each fault', () => {
  const post = (type: string) => ({
    post: { requestBody: { content: { 'application/json': { schema: { type, items: {} } } } } },
  });
  const doc = {
    components: { schemas: {} },
    paths: {
      '/v3/a/live': post('array'),
      '/v3/a/bad': post('object'),
      '/v3/a/two': { get: {}, ...post('array') },
      '/v3/a/q': { get: { parameters: [{ name: 'x', in: 'query' }] } },
      '/v3/search/x': { get: {} },
      '/v3/a/+collect': { get: {} },
      '/v3/a/{id}': { get: {} },
      '/v3/a/{country}/y': { get: {} },
      '/v3/a/{x}': { get: {} },
    },
  };
  assert.deepEqual(checkSpec(doc, 11), [
    '/v3/a/bad: POST body is not an array of tasks',
    '/v3/a/two: 2 methods, want 1',
    '/v3/a/q: a parameter not in the path',
    '/v3/search/x: a command word clashes with a dfs command',
    '/v3/a/+collect: a command word clashes with a dfs command',
    '/v3/a/{country}/y: {country} and {id} share one slot',
    '/v3/a/{x}: same command words as /v3/a/{id}',
    '/v3/a/{x}: {x} and {country} share one slot',
    'path count fell from 11 to 9, more than 10 %',
  ]);
  assert.deepEqual(checkSpec({ paths: [] }), ['not an OpenAPI document with paths and components']);
});
