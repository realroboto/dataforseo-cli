import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { report, specProblems } from '../scripts/spec-check.ts';
import { readOverlay, readSnapshot, type Spec } from '../src/catalog.ts';
import { RULES } from '../src/pricing.ts';

// `pnpm spec:check` is a script, not a dfs command: the check function is its seam (no network).
const conditions = (change: (spec: Spec) => void, overlay = readOverlay()) => {
  const { spec } = readSnapshot();
  change(spec);
  return [...new Set(specProblems(spec, overlay).map((p) => p.condition))];
};
const copy = (spec: Spec, from: string, to: string) => {
  spec.paths[to] = structuredClone(spec.paths[from]);
};
const exampleOf = (spec: Spec, path: string) =>
  spec.paths[path].post.requestBody?.content?.['application/json']?.schema?.example as Record<
    string,
    unknown
  >[];

test('spec 55a4ed0 with the committed overlay passes conditions 1-7', () => {
  const { sha, spec } = readSnapshot();
  assert.equal(sha.slice(0, 7), '55a4ed0');
  assert.deepEqual(specProblems(spec, readOverlay()), []);
});

test('condition 1: a spec that fails the structural check', () => {
  assert.deepEqual(
    conditions((s) => copy(s, '/v3/appendix/status', '/v4/appendix/status')),
    [1],
  );
});

test('condition 2: a paid path with no price rule and not on the free list', () => {
  assert.deepEqual(
    conditions((s) => copy(s, '/v3/serp/google/organic/live/advanced', '/v3/serp/google/new/live')),
    [2],
  );
});

test('condition 3: a price rule or a free-list path absent from the spec', () => {
  assert.deepEqual(
    conditions((s) => {
      delete s.paths[RULES[0].path];
    }),
    [3],
  );
  assert.deepEqual(
    conditions((s) => {
      delete s.paths['/v3/domain_analytics/technologies/technologies'];
    }),
    [3],
  );
});

test('condition 4: a request example that fails dfs validation', () => {
  const path = '/v3/backlinks/anchors/live';
  assert.deepEqual(
    conditions((s) => {
      exampleOf(s, path)[0].no_such_field = 1;
    }),
    [4],
  );
});

test('condition 4: an overlay action with no target or no effect', () => {
  const absent = readOverlay() as { actions: unknown[] };
  absent.actions.push({ target: "$['components']['schemas']['NoSuchSchema']", remove: true });
  assert.deepEqual(
    conditions(() => {}, absent),
    [4],
  );
  // The vendor fixed the fault: the overlay action now changes nothing.
  const fixed = readOverlay() as { actions: { target: string; update?: unknown }[] };
  const update = fixed.actions.find((a) => a.update !== undefined);
  assert.ok(update);
  assert.deepEqual(
    conditions((s) => {
      const keys = [...update.target.matchAll(/\['([^']*)'\]/g)].map((m) => m[1]);
      const node = keys.reduce<Record<string, unknown>>(
        (n, k) => n[k] as Record<string, unknown>,
        s as unknown as Record<string, unknown>,
      );
      for (const [k, v] of Object.entries(update.update as object)) {
        node[k] = structuredClone(v);
      }
    }, fixed),
    [4],
  );
});

test('condition 5: a task_post level with no collect call', () => {
  assert.deepEqual(
    conditions((s) => {
      for (const p of Object.keys(s.paths)) {
        if (p.startsWith('/v3/keywords_data/google_ads/search_volume/task_get')) delete s.paths[p];
      }
    }),
    [5],
  );
});

test('condition 6: the spec has the id_list hand path', () => {
  assert.deepEqual(
    conditions((s) => copy(s, '/v3/serp/id_list', '/v3/ai_optimization/id_list')),
    [6],
  );
});

test('condition 7: a *_filters request field with a typed items schema', () => {
  assert.deepEqual(
    conditions((s) => {
      const info = s.components.schemas.BacklinksAnchorsLiveRequestInfo;
      info.properties = {
        ...info.properties,
        extra_filters: { type: 'array', items: { type: 'string' } },
      };
    }),
    [7],
  );
});

test('spec.yml: weekly and on dispatch, no secrets, no third-party action, self re-enable, forced failure', () => {
  const text = readFileSync(join(import.meta.dirname, '..', '.github/workflows/spec.yml'), 'utf8');
  const wf = parse(text);
  assert.deepEqual(wf.on, { schedule: [{ cron: '17 6 * * 1' }], workflow_dispatch: null });
  assert.equal(wf.permissions.actions, 'write');
  assert.doesNotMatch(text, /secrets\./);
  const steps: { uses?: string; run?: string; if?: string }[] = wf.jobs.spec.steps;
  for (const s of steps) if (s.uses) assert.match(s.uses, /^actions\//);
  const enable = steps.findIndex((s) =>
    /^gh api -X PUT "repos\/\$\{\{ github\.repository \}\}\/actions\/workflows\/spec\.yml\/enable"$/.test(
      s.run ?? '',
    ),
  );
  const check = steps.findIndex((s) => s.run === 'pnpm spec:check');
  const force = steps.findIndex((s) => s.if === "vars.SPEC_CHECK_FORCE_FAIL == '1'");
  assert.ok(enable >= 0 && check > enable && force > enable, 'enable, check, forced failure');
  assert.match(steps[force].run ?? '', /exit 1/);
});

test('without the overlay: 85 typed filter fields (condition 7) and failing examples (condition 4)', () => {
  const found = specProblems(readSnapshot().spec, { overlay: '1.0.0', actions: [] });
  assert.equal(found.filter((p) => p.condition === 7).length, 85);
  assert.ok(found.some((p) => p.condition === 4));
  assert.deepEqual([...new Set(found.map((p) => p.condition))], [4, 7]);
});

test('job summary lists paths added and removed against the snapshot, and the problems', () => {
  const { spec } = readSnapshot();
  copy(spec, '/v3/serp/google/organic/live/advanced', '/v3/serp/google/new/live');
  delete spec.paths['/v3/appendix/status'];
  const { text, failed } = report(spec, 'abcdef0123', '2026-11-09T00:00:00Z');
  assert.equal(failed, true);
  assert.match(text, /## spec:check abcdef0 \(2026-11-09T00:00:00Z\) against snapshot 55a4ed0/);
  assert.match(text, /### Paths added \(1\)\n\n- `\/v3\/serp\/google\/new\/live`/);
  assert.match(text, /### Paths removed \(1\)\n\n- `\/v3\/appendix\/status`/);
  assert.match(text, /- `2: \/v3\/serp\/google\/new\/live: no price rule, not free`/);
  assert.equal(report(readSnapshot().spec, 'x', 'y').failed, false);
});
