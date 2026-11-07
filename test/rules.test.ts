import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSnapshot } from '../src/catalog.ts';
import { FREE, isFree, RULES, ruleFor } from '../src/pricing.ts';

const PATHS = Object.keys(readSnapshot().spec.paths);
// The table itself is the subject here (issue: a local test with spec:check logic), not run().
// shortcut: only serp and keywords_data paths are checked; widen DONE as tickets 06–07 add rules.
const DONE = /^\/v3\/(serp|keywords_data)\//;

test('every serp and keywords_data path has a price rule or sits on the free list (spec:check 2)', () => {
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

test('every free-list word names a spec path (spec:check 3)', () => {
  const words = new Set(PATHS.flatMap((p) => p.split('/')));
  assert.deepEqual(
    [...FREE].filter((w) => !words.has(w)),
    [],
  );
});
