import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSnapshot } from '../src/catalog.ts';
import { FREE, isFree, RULES, ruleFor } from '../src/pricing.ts';

const PATHS = Object.keys(readSnapshot().spec.paths);
// The table itself is the subject here (issue: a local test with spec:check logic), not run().
// shortcut: only the modules of tickets 05–06 are checked; widen DONE as ticket 07 adds rules.
const DONE = /^\/v3\/(serp|keywords_data|dataforseo_labs|backlinks|domain_analytics)\//;

test('every path of a priced module has a price rule or sits on the free list (spec:check 2)', () => {
  const bare = PATHS.filter((p) => DONE.test(p) && !isFree(p) && !ruleFor(p));
  assert.deepEqual(bare, []);
});

test('no price rule names a path absent from the spec (spec:check 3)', () => {
  const known = new Set(PATHS);
  assert.deepEqual(
    RULES.map((r) => r.path).filter((p) => !known.has(p)),
    [],
  );
});

test('every free-list word or path names a spec path (spec:check 3)', () => {
  const words = new Set([...PATHS, ...PATHS.flatMap((p) => p.split('/'))]);
  assert.deepEqual(
    [...FREE].filter((w) => !words.has(w)),
    [],
  );
});
