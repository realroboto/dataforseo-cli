// pnpm spec:check: drift check of the newest master vendor spec, conditions 1-7
// (docs/spec/workflows-release.md). Network script; spec.yml runs it weekly, never ci.yml.
import { appendFileSync } from 'node:fs';
import { parse } from 'yaml';
import { USER_DATA } from '../src/call.ts';
import {
  COMMITS_URL,
  catalogOf,
  checkSpec,
  collectPaths,
  newestCommit,
  rawUrl,
  readOverlay,
  readSnapshot,
  type Spec,
} from '../src/catalog.ts';
import { DfsError, messageOf } from '../src/errors.ts';
import { isRecord } from '../src/json.ts';
import { HAND_ID_LIST } from '../src/lifecycle.ts';
import { applyOverlay } from '../src/overlay.ts';
import { plan, TWENTY_TASK_PATHS } from '../src/planner.ts';
import { FREE, isFree, RULES, ruleFor } from '../src/pricing.ts';
import { deref, fields } from '../src/schema.ts';

export type Problem = { condition: number; detail: string };
const FILTERS = /^(.+_)?filters$/;

// Conditions 1-7 on a vendor spec and an overlay; [] when the spec passes. `spec` stays unchanged.
export function specProblems(spec: unknown, overlay: unknown): Problem[] {
  const out: Problem[] = [];
  const add = (condition: number, detail: string) => out.push({ condition, detail });
  const overlaid = structuredClone(spec);
  for (const t of applyOverlay(overlaid, overlay)) add(4, `overlay action has no effect: ${t}`);
  const previous = Object.keys(readSnapshot().spec.paths).length;
  for (const p of checkSpec(overlaid, previous)) add(1, p);
  const s = overlaid as Spec;
  // Not an OpenAPI document: conditions 2-7 have nothing to read.
  if (!isRecord(s) || !isRecord(s.paths) || !isRecord(s.components?.schemas)) return out;
  const catalog = catalogOf({ sha: '', date: '', spec: s });
  const paths = Object.keys(s.paths);
  const known = new Set(paths);

  for (const p of paths) if (!isFree(p) && !ruleFor(p)) add(2, `${p}: no price rule, not free`);

  // Free-list words name a path word; whole paths, rules and helper paths name a spec path.
  const words = new Set(paths.flatMap((p) => p.split('/')));
  for (const w of FREE) {
    if (!(w.startsWith('/') ? known.has(w) : words.has(w))) add(3, `free list: ${w} not in spec`);
  }
  const named = [...RULES.map((r) => r.path), ...TWENTY_TASK_PATHS, USER_DATA];
  for (const p of named) if (!known.has(p)) add(3, `${p}: named in dfs, not in spec`);

  for (const ep of catalog.endpoints) {
    const schema = ep.op.requestBody?.content?.['application/json']?.schema;
    if (ep.method === 'post' && schema?.example !== undefined) {
      const tasks = Array.isArray(schema.example) ? schema.example : [schema.example];
      try {
        plan(catalog, ep, {}, tasks, { sandbox: false, validate: true });
      } catch (e) {
        if (!(e instanceof DfsError)) throw e;
        add(4, `${ep.path} example: ${e.message}`);
      }
    }
    const schemas = s.components.schemas;
    for (const [name, f] of fields(deref(schema?.items, schemas), schemas)) {
      const items = deref(deref(f, schemas)?.items, schemas);
      if (FILTERS.test(name) && items?.type !== undefined) {
        add(7, `${ep.path} ${name}: typed items (${items.type}); filter syntax needs untyped`);
      }
    }
    if (ep.path.endsWith('/task_post')) {
      const level = catalog.resolve(ep.words.slice(0, -1)).node;
      if (collectPaths(level).size === 0) add(5, `${ep.path}: no collect call`);
    }
  }

  if (known.has(HAND_ID_LIST)) {
    add(6, `${HAND_ID_LIST} now in spec: remove the hand path (src/lifecycle.ts)`);
  }
  return out.sort((a, b) => a.condition - b.condition);
}

async function get(url: string, accept: string): Promise<Response> {
  const res = await fetch(url, { headers: { accept, 'user-agent': 'dfs-spec-check' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

// The job summary: paths added and removed against the committed snapshot, then the problems.
export function report(
  spec: unknown,
  sha: string,
  date: string,
): { text: string; failed: boolean } {
  const problems = specProblems(spec, readOverlay());
  const snapshot = readSnapshot();
  const current = isRecord(spec) && isRecord(spec.paths) ? spec.paths : {};
  const added = Object.keys(current).filter((p) => !Object.hasOwn(snapshot.spec.paths, p));
  const removed = Object.keys(snapshot.spec.paths).filter((p) => !Object.hasOwn(current, p));
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- \`${x}\``).join('\n') : 'none');
  const text = [
    `## spec:check ${sha.slice(0, 7)} (${date}) against snapshot ${snapshot.sha.slice(0, 7)}`,
    `### Paths added (${added.length})`,
    list(added),
    `### Paths removed (${removed.length})`,
    list(removed),
    `### Problems (${problems.length})`,
    list(problems.map((p) => `${p.condition}: ${p.detail}`)),
    '',
  ].join('\n\n');
  return { text, failed: problems.length > 0 };
}

async function main(): Promise<number> {
  const { sha, date } = newestCommit(
    await (await get(COMMITS_URL, 'application/vnd.github+json')).json(),
  );
  const { text, failed } = report(parse(await (await get(rawUrl(sha), '*/*')).text()), sha, date);
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  return failed ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await main().catch((e: unknown) => {
    process.stderr.write(`spec:check: ${messageOf(e)}\n`);
    return 1;
  });
}
