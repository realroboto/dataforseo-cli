// One endpoint call: body, guard, send, save before print, Compact output, exit code; and the
// `store` commands that reprint saved responses.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { text } from 'node:stream/consumers';
import pkg from '../package.json' with { type: 'json' };
import type { Catalog, Endpoint } from './catalog.ts';
import { firstResult, succeeded } from './envelope.ts';
import { DfsError, messageOf } from './errors.ts';
import { isRecord } from './json.ts';
import { posted } from './ledger.ts';
import { pageAll, pagingOf } from './pages.ts';
import { type Plan, plan } from './planner.ts';
import { type Estimate, estimate, guard, isFree, ruleFor } from './pricing.ts';
import { command, Output, outcome } from './render.ts';
import type { Io } from './run.ts';
import {
  type Price,
  type Row,
  readPrice,
  reuseRows,
  type StoreHandle,
  save,
  writePrice,
} from './store.ts';
import { authHeader, send } from './transport.ts';

export type CallFlags = {
  body?: string;
  full?: boolean;
  sandbox?: boolean;
  'max-cost'?: string; // explicit ceiling; also sends an unknown or unbounded price
  'dry-run'?: boolean;
  'no-validate'?: boolean;
  fresh?: boolean; // send even when a stored response is reusable
  'page-all'?: boolean; // follow offset, then the token, over all pages (src/pages.ts)
};

// The tasks to send: a JSON object is one task, an array is the batch.
export async function readBody(
  ep: Endpoint,
  arg: string | undefined,
  io: Io,
): Promise<unknown[] | undefined> {
  if (ep.method !== 'post') {
    if (arg !== undefined) throw new DfsError(3, `${command(ep.words)} is GET: it takes no --body`);
    return undefined;
  }
  if (arg === undefined) {
    throw new DfsError(3, `--body required; task fields: dfs schema ${ep.words.join(' ')}`);
  }
  let source = arg;
  try {
    if (arg === '-') source = await text(io.stdin);
    else if (arg.startsWith('@')) source = readFileSync(arg.slice(1), 'utf8');
  } catch (e) {
    throw new DfsError(3, `--body ${arg}: ${messageOf(e)}`);
  }
  let tasks: unknown;
  try {
    tasks = JSON.parse(source);
  } catch (e) {
    throw new DfsError(3, `--body is not JSON: ${messageOf(e)}`);
  }
  if (isRecord(tasks)) tasks = [tasks];
  if (!Array.isArray(tasks)) throw new DfsError(3, '--body must be a JSON object or array');
  return tasks;
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// The login is never stored (store.md, login redaction), and save before print would store it.
// Removes every `tasks[i].result[j].login` from the JSON text; SQLite json_remove keeps the other
// values as the API wrote them, number digits included.
const LOGIN = /^\$\.tasks\[\d+\]\.result\[\d+\]\.login$/;
function redactLogin(text: string): string {
  const db = new DatabaseSync(':memory:');
  try {
    const paths = db
      .prepare("SELECT fullkey FROM json_tree(?) WHERE key = 'login'")
      .all(text)
      .map((r) => String(r.fullkey))
      .filter((k) => LOGIN.test(k));
    if (paths.length === 0) return text;
    const marks = paths.map(() => '?').join(', ');
    const { j } = db.prepare(`SELECT json_remove(?, ${marks}) AS j`).get(text, ...paths) as {
      j: string;
    };
    return j;
  } finally {
    db.close();
  }
}

export const USER_DATA = '/v3/appendix/user_data';
const DAY = 24 * 60 * 60 * 1000;
const REUSE_WINDOW = DAY / 2;

// Reuse key (store.md): sha256 of the concrete path, the body with object keys sorted at every
// depth and no whitespace, and the sandbox flag.
function reuseKey(planned: Plan, sandbox: boolean): string {
  const body = JSON.stringify(planned.body ?? null, (_, v) =>
    isRecord(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
  return createHash('sha256')
    .update(`${planned.path}\n${body}\n${sandbox ? 1 : 0}`)
    .digest('hex');
}

// The newest fully successful response of this request in the reuse window.
export function reusable(
  io: Io,
  store: StoreHandle,
  planned: Plan,
  sandbox: boolean,
): Row | undefined {
  const since = new Date((io.now ?? Date.now)() - REUSE_WINDOW).toISOString();
  return reuseRows(store, reuseKey(planned, sandbox), since).find((r) => {
    const text = r.body as string;
    return (
      outcome({ status: r.http_status, text }, JSON.parse(text), r.id, planned.method === 'GET')
        .exit === 0
    );
  });
}

// 42s, 5m, 3h04m
function age(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m === 0) return `${s}s`;
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

// USD from a flag or variable: a number, 0 or more; undefined when not set.
function parseUsd(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === '' || !(Number(value) >= 0)) {
    throw new DfsError(3, `${name} ${value}: want a number of USD, 0 or more`);
  }
  return Number(value);
}

// The cost ceiling: --max-cost, else DFS_MAX_COST, else $1; `explicit` also sends unknown prices.
export function ceilingOf(flags: CallFlags, io: Io): { ceiling: number; explicit: boolean } {
  const explicit = parseUsd('--max-cost', flags['max-cost']);
  const ceiling = explicit ?? parseUsd('DFS_MAX_COST', io.env.DFS_MAX_COST || undefined) ?? 1;
  return { ceiling, explicit: explicit !== undefined };
}

// One HTTP exchange, saved to the Store before anything prints. A good non-sandbox user_data
// response also writes the price tree (pricing.md); sandbox prices are dummy data.
export async function exchange(
  catalog: Catalog,
  ep: Endpoint,
  planned: Plan,
  opts: { sandbox: boolean; free: boolean; estimate: number | null; deadline?: number },
  io: Io,
  store: StoreHandle,
  warn: (w: string) => void,
) {
  const auth = authHeader(io.env);
  const { method, path } = planned;
  const body = planned.body && JSON.stringify(planned.body);
  const res = await send(io, {
    method,
    url: planned.url,
    body,
    auth,
    free: opts.free,
    deadline: opts.deadline,
  });

  const raw = parseJson(res.text);
  const kept = raw !== undefined && ep.path === USER_DATA ? redactLogin(res.text) : res.text;
  // The Compact output never shows the login either.
  const parsed = kept === res.text ? raw : JSON.parse(kept);
  const envelope = isRecord(parsed) ? parsed : {};
  const row: Row = {
    id: `r_${randomBytes(5).toString('hex')}`,
    time: new Date((io.now ?? Date.now)()).toISOString(),
    method,
    spec_path: ep.path,
    path,
    sandbox: opts.sandbox ? 1 : 0,
    request: body ?? null,
    http_status: res.status,
    status_code: typeof envelope.status_code === 'number' ? envelope.status_code : null,
    cost: typeof envelope.cost === 'number' ? envelope.cost : null,
    estimate: opts.estimate,
    reused_from: null,
    dfs_version: pkg.version,
    spec_sha: catalog.sha,
    body: parsed === undefined ? null : kept,
    reuse_key: reuseKey(planned, opts.sandbox),
  };
  const saved = save(store, row, warn);
  // The `price` node of a successful user_data response.
  const tree =
    ep.path === USER_DATA && !opts.sandbox && succeeded(res.status, parsed)
      ? firstResult(parsed)?.price
      : undefined;
  const price = isRecord(tree) ? { at: row.time, tree } : undefined;
  if (price) {
    try {
      writePrice(store, price);
    } catch (e) {
      warn(`price tree not saved (${messageOf(e)})`);
    }
  }
  return { res, parsed, row, saved, price };
}

// The stored price tree. Before a send it is refreshed first when older than 24 h or absent and
// credentials exist; a failed refresh warns and keeps the old tree.
export async function priceTree(
  catalog: Catalog,
  io: Io,
  store: StoreHandle,
  refresh: boolean,
  warn: (w: string) => void,
): Promise<Price | undefined> {
  const old = readPrice(store);
  const ep = catalog.endpoints.find((e) => e.path === USER_DATA);
  const fresh = old !== undefined && (io.now ?? Date.now)() - Date.parse(old.at) <= DAY;
  const login = io.env.DATAFORSEO_LOGIN && io.env.DATAFORSEO_PASSWORD;
  if (!refresh || fresh || !login || !ep) return old;
  let why: string;
  try {
    const planned = plan(catalog, ep, {}, undefined, { sandbox: false, validate: true });
    const r = await exchange(
      catalog,
      ep,
      planned,
      { sandbox: false, free: true, estimate: 0 },
      io,
      store,
      warn,
    );
    if (r.price) return r.price;
    why = !isRecord(r.parsed)
      ? `HTTP ${r.res.status}, not a JSON object`
      : `${r.row.status_code ?? `HTTP ${r.res.status}`}, ${r.saved ? `see: dfs store show ${r.row.id}` : 'not saved'}`;
  } catch (e) {
    why = messageOf(e);
  }
  warn(
    `price tree refresh failed (${why}); ${old ? `using the tree from ${old.at}` : 'no price tree'}`,
  );
  return old;
}

export async function call(
  catalog: Catalog,
  ep: Endpoint,
  params: Record<string, string>,
  flags: CallFlags,
  io: Io,
  store: StoreHandle,
): Promise<number> {
  const tasks = await readBody(ep, flags.body, io);
  // --dry-run plans the first page only.
  if (flags['page-all']) {
    const paging = pagingOf(catalog, ep, tasks);
    if (!flags['dry-run']) return pageAll(catalog, ep, params, paging, flags, io, store);
  }
  const sandbox = flags.sandbox === true;
  const { ceiling, explicit } = ceilingOf(flags, io);
  const planned = plan(catalog, ep, params, tasks, { sandbox, validate: !flags['no-validate'] });
  // Warnings before the send print at once, so a failed send still shows them.
  const out = new Output(io);
  const warn = (w: string) => out.warn(w);
  planned.warnings.forEach(warn);
  // Free paths always go to the API (user story 24).
  const reuse = flags.fresh || isFree(ep.path) ? undefined : reusable(io, store, planned, sandbox);
  if (reuse && !flags['dry-run']) return replay(catalog, ep, reuse, flags, io, store, out);
  // The sandbox and the free list estimate 0; the guard does not apply.
  const free = sandbox || isFree(ep.path);
  const rule = free ? undefined : ruleFor(ep.path);
  const price =
    rule && !rule.unbounded
      ? await priceTree(catalog, io, store, !flags['dry-run'], warn)
      : undefined;
  const est: Estimate = free
    ? { usd: 0, basis: 'rule' }
    : estimate(rule, planned.body ?? [], price?.tree, (io.now ?? Date.now)());
  if (est.warning) warn(est.warning);
  const refusal = free ? undefined : guard(ep.path, est, ceiling, explicit);
  if (flags['dry-run']) {
    const dry = {
      method: planned.method,
      url: planned.url,
      body: planned.body ?? null,
      tasks: planned.body?.length ?? 0,
      estimate: { usd: est.usd, basis: est.basis, price_at: price?.at ?? null },
      ceiling,
      guard: refusal ? 'refuse' : 'send',
      reuse: reuse?.id ?? null,
      spec: catalog.sha,
    };
    out.full(JSON.stringify(dry));
    return out.close();
  }
  if (refusal) throw new DfsError(4, refusal);

  const r = await sendPlanned(catalog, ep, planned, est, { sandbox, free }, io, store, out);
  if (r.parsed !== undefined) {
    if (flags.full) out.full(r.full);
    else out.response(r.parsed, r.id);
  }
  return out.close();
}

// One send of a planned call, saved before print. Writes its stderr lines to `out` (status line,
// this call's warnings, outcome lines) with its exit class; returns the response. An unsaved
// response prints in full and exits 5.
export async function sendPlanned(
  catalog: Catalog,
  ep: Endpoint,
  planned: Plan,
  est: Estimate,
  opts: { sandbox: boolean; free: boolean },
  io: Io,
  store: StoreHandle,
  out: Output,
) {
  const warnings: string[] = [];
  const { res, parsed, row, saved } = await exchange(
    catalog,
    ep,
    planned,
    { ...opts, estimate: est.usd },
    io,
    store,
    (w) => warnings.push(w),
  );
  const { id } = row;
  const full = row.body ?? res.text;
  if (!saved) {
    out.full(full);
    throw new DfsError(5, '5 response not saved — stdout is the only copy');
  }
  // Sandbox costs are dummy data (r34:51).
  if (!opts.sandbox && est.usd !== null && row.cost !== null && row.cost > est.usd) {
    warnings.push(
      `real cost $${row.cost} above estimate $${est.usd} for ${ep.path} — the price rule may be out of date`,
    );
  }
  // Paid tasks get rows now, for `store spend` and `dfs +collect` (store.md, `task`).
  if (!isFree(ep.path)) {
    const { warning } = posted(store, parsed, {
      id,
      path: ep.path,
      variant: null,
      sandbox: opts.sandbox,
      time: (io.now ?? Date.now)(),
    });
    if (warning) warnings.push(warning);
  }
  const { lines, exit } = outcome(res, parsed, id, ep.method === 'get');
  const taskCount = isRecord(parsed) ? (parsed.tasks_count ?? 0) : 0;
  const status = `dfs: ${row.status_code ?? res.status} ${ep.path} tasks=${taskCount} cost=$${row.cost ?? '?'} est=$${est.usd ?? '?'} saved=${id}`;
  out.line(status);
  for (const w of warnings) out.warn(w);
  for (const l of lines) out.line(l);
  out.exit(exit);
  return { parsed, id, full, cost: row.cost, exit };
}

// A stored response at $0: saves a reuse row (no body, no cost), then prints the stored output.
function replay(
  catalog: Catalog,
  ep: Endpoint,
  src: Row,
  flags: CallFlags,
  io: Io,
  store: StoreHandle,
  out: Output,
): number {
  const warnings: string[] = [];
  out.line(reuseRow(catalog, ep, src, io, store, (w) => warnings.push(w)));
  for (const w of warnings) out.warn(w);
  const full = src.body as string;
  if (flags.full) out.full(full);
  else out.response(JSON.parse(full), src.id);
  return out.close();
}

// Saves the reuse row of a stored response; returns its status line.
export function reuseRow(
  catalog: Catalog,
  ep: Endpoint,
  src: Row,
  io: Io,
  store: StoreHandle,
  warn: (w: string) => void,
): string {
  const now = (io.now ?? Date.now)();
  const row: Row = {
    ...src,
    id: `r_${randomBytes(5).toString('hex')}`,
    time: new Date(now).toISOString(),
    cost: 0,
    estimate: 0,
    reused_from: src.id,
    dfs_version: pkg.version,
    spec_sha: catalog.sha,
    body: null,
  };
  // The stored response stays the only copy of the data; a lost reuse row loses no data.
  save(store, row, warn);
  const parsed = JSON.parse(src.body as string);
  return `dfs: ${src.status_code} ${ep.path} tasks=${parsed.tasks_count ?? 0} cost=$0 est=$0 reused=${src.id} age=${age(now - Date.parse(src.time))}`;
}
