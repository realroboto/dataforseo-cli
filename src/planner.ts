// Planner (docs/spec/modules/planner.md): pure. Endpoint + path values + tasks → call plan, or
// exit 3 naming the field and the remedy. Nothing here touches the network.
import { type Catalog, concretePath, type Endpoint, isLive } from './catalog.ts';
import { DfsError } from './errors.ts';
import { isRecord } from './json.ts';
import { deref, type Fault, faults, fields, type Schema, type Schemas } from './schema.ts';

const SANDBOX = 'https://sandbox.dataforseo.com';
const SHOWN = 10; // faults named in one message; the rest are counted
// Limits table: these paths take 20 tasks, by path, not by the word `live` (r31:154).
const TWENTY_TASK_PATHS = new Set([
  '/v3/on_page/instant_pages',
  '/v3/on_page/content_parsing/live',
  '/v3/on_page/page_screenshot',
]);
const maxTasks = (path: string): number =>
  TWENTY_TASK_PATHS.has(path) ? 20 : isLive(path) ? 1 : 100;
const MAX_FILTERS = 8;
const FILTER_LIMIT = /8 filters maximum/i;

const describe = (f: Fault): string =>
  f.kind === 'name'
    ? `${f.path}: unknown field`
    : f.kind === 'null'
      ? `${f.path}: null, but the field is not nullable`
      : `${f.path}: ${f.detail}`;

// Filter count (planner.md): only on fields whose description states "8 filters maximum". A
// `filters` array that starts with a string is one condition; otherwise each top-level item is
// one, a nested group too, and `and`/`or` strings do not count.
function filterFaults(task: unknown, items: Schema | undefined, schemas: Schemas, at: string) {
  if (!isRecord(task)) return [];
  const known = fields(deref(items, schemas), schemas);
  const out: string[] = [];
  for (const [k, v] of Object.entries(task)) {
    const f = known.get(k);
    const text = `${f?.description ?? ''} ${deref(f, schemas)?.description ?? ''}`;
    if (!Array.isArray(v) || !FILTER_LIMIT.test(text)) continue;
    const n = typeof v[0] === 'string' ? 1 : v.filter((x) => typeof x !== 'string').length;
    if (n > MAX_FILTERS) out.push(`${at}.${k}: ${n} filter conditions, at most ${MAX_FILTERS}`);
  }
  return out;
}

// One message for many problems: the first SHOWN, then a count of the rest.
const list = (items: string[]): string =>
  items.slice(0, SHOWN).join('; ') +
  (items.length > SHOWN ? `; +${items.length - SHOWN} more` : '');

export type Plan = {
  method: string;
  path: string; // concrete path
  url: string;
  body?: unknown[];
  warnings: string[];
};

export function plan(
  catalog: Catalog,
  ep: Endpoint,
  params: Record<string, string>,
  tasks: unknown[] | undefined,
  opts: { sandbox: boolean; validate: boolean },
): Plan {
  const base = opts.sandbox
    ? SANDBOX
    : (catalog.spec.servers?.[0]?.url ?? 'https://api.dataforseo.com');
  const warnings: string[] = [];
  const max = maxTasks(ep.path);
  if (tasks && tasks.length > max) {
    throw new DfsError(
      3,
      `${tasks.length} tasks, at most ${max} on ${ep.path} — split the tasks over several calls`,
    );
  }
  const items = ep.op.requestBody?.content?.['application/json']?.schema?.items;
  const schemas = catalog.spec.components.schemas;
  const found = (tasks ?? []).flatMap((t, i) => [
    ...faults(t, items, schemas, `body[${i}]`).map(describe),
    ...filterFaults(t, items, schemas, `body[${i}]`),
  ]);
  if (found.length > 0) {
    if (!opts.validate) warnings.push(`${list(found)} — sent anyway: --no-validate`);
    else {
      throw new DfsError(
        3,
        `${list(found)} — fix the body (fields: dfs schema ${ep.words.join(' ')}), or pass --no-validate when the DataForSEO docs list the field`,
      );
    }
  }
  const path = concretePath(ep, params);
  return {
    method: ep.method.toUpperCase(),
    path,
    url: `${base}${path}`,
    body: tasks,
    warnings,
  };
}
