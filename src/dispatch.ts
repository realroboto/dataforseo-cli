// Dispatch (docs/spec/modules/dispatch.md): one planned call from the Reuse check to the outcome,
// in one order: plan warnings, Reuse, rule estimate, cost guard, send, save before print, task
// rows, outcome. Fetch free sends a command's free requests. One Dispatch per command.
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import pkg from '../package.json' with { type: 'json' };
import type { Catalog, Endpoint } from './catalog.ts';
import { firstResult, succeeded } from './envelope.ts';
import { DfsError, messageOf } from './errors.ts';
import { isRecord } from './json.ts';
import { posted, type Task } from './ledger.ts';
import { type Plan, plan } from './planner.ts';
import { type Estimate, estimate, guard, isFree, ruleFor, USER_DATA } from './pricing.ts';
import { type Output, outcome } from './render.ts';
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
import { authHeader, type Exchange, send } from './transport.ts';

export type SpendFlags = {
  sandbox?: boolean;
  fresh?: boolean; // send even when a stored response is reusable
  'max-cost'?: string; // explicit ceiling; also sends an unknown or unbounded price
  'dry-run'?: boolean;
};

// A planned call, ready for the guard and the send. `reuse`: the Reuse candidate; the send replays
// it at $0. `est`: the rule estimate. A call that replays (outside a dry run) has none: the price
// tree never loads for a call that sends nothing.
export type Prepared = {
  ep: Endpoint;
  plan: Plan;
  free: boolean; // the sandbox or a free path: estimate $0, never refused
  priceAt?: string; // fetch time of the price tree behind `est`
} & ({ reuse?: undefined; est: Estimate } | { reuse: Row; est?: Estimate });

// Track on (+run): task rows for sent and reused responses. Off: for sent paid responses only.
export type TaskContext = { variant?: string | null; track?: boolean };

export type Sent = {
  id: string; // the response sent, or the stored one replayed
  parsed: unknown;
  full: string; // the exact API text
  cost: number | null;
  exit: number;
  lines: string[]; // outcome lines: the caller prints them
  tasks: Task[];
  messages: Map<string, string>; // status_message per task id
  reused: boolean;
};

export class Dispatch {
  readonly ceiling: number;
  readonly explicit: boolean;
  #catalog: Catalog;
  #io: Io;
  #store: StoreHandle;
  #out: Output;
  #flags: SpendFlags;
  #price?: Promise<Price | undefined>;
  #warn = (w: string) => this.#out.warn(w);

  // An invalid ceiling exits 3 here, before any send.
  constructor(catalog: Catalog, io: Io, store: StoreHandle, out: Output, flags: SpendFlags) {
    ({ ceiling: this.ceiling, explicit: this.explicit } = ceilingOf(flags, io));
    this.#catalog = catalog;
    this.#io = io;
    this.#store = store;
    this.#out = out;
    this.#flags = flags;
  }

  // Plan warnings, the Reuse candidate, then the rule estimate. The price tree loads once per
  // command, on the first estimate that needs it; a dry run never refreshes it.
  async prepare(ep: Endpoint, planned: Plan): Promise<Prepared> {
    for (const w of planned.warnings) this.#warn(w);
    const sandbox = this.#flags.sandbox === true;
    // Free paths always go to the API (user story 24).
    const reuse =
      this.#flags.fresh || isFree(ep.path)
        ? undefined
        : reusable(this.#io, this.#store, planned, sandbox);
    const free = sandbox || isFree(ep.path);
    const call = { ep, plan: planned, free, reuse };
    if (reuse && !this.#flags['dry-run']) return { ...call, reuse };
    if (free) return { ...call, est: { usd: 0, basis: 'rule' } };
    const rule = ruleFor(ep.path);
    const price = rule && !rule.unbounded ? await this.#priceTree() : undefined;
    const est = estimate(rule, planned.body ?? [], price?.tree, (this.#io.now ?? Date.now)());
    if (est.warning) this.#warn(est.warning);
    return { ...call, est, priceAt: price?.at };
  }

  #priceTree(): Promise<Price | undefined> {
    const refresh = !this.#flags['dry-run'];
    this.#price ??= priceTree(this.#catalog, this.#io, this.#store, refresh, this.#warn);
    return this.#price;
  }

  // The cost guard over calls not reused, plus the cost spent so far: the refusal, or undefined.
  // The calls of one guard share one endpoint.
  guard(calls: Prepared[], spent = 0): string | undefined {
    const paid = calls.flatMap((c) => (!c.free && c.est ? [c.est] : []));
    if (paid.length === 0) return undefined;
    const unknown = paid.find((e) => e.usd === null);
    const usd = paid.reduce((sum, e) => sum + (e.usd ?? 0), spent);
    const total = unknown ?? { usd: Math.round(usd * 1e9) / 1e9, basis: 'rule' as const };
    return guard(calls[0].ep.path, total, this.ceiling, this.explicit);
  }

  // Replays the Reuse candidate, else sends. Line order: status line, then the warnings of this
  // call; the caller prints the outcome lines.
  async send(call: Prepared, task: TaskContext = {}): Promise<Sent> {
    const sandbox = this.#flags.sandbox === true;
    const { ep } = call;
    if (!call.reuse) {
      const opts = { sandbox, free: call.free };
      return sendPlanned(
        this.#catalog,
        ep,
        call.plan,
        call.est,
        opts,
        this.#io,
        this.#store,
        this.#out,
        task,
      );
    }
    const src = call.reuse;
    const warnings: string[] = [];
    this.#out.line(
      reuseRow(this.#catalog, ep, src, this.#io, this.#store, (w) => warnings.push(w)),
    );
    const full = src.body as string;
    const parsed = JSON.parse(full);
    const rows = taskRows(
      task.track === true,
      ep,
      parsed,
      src.id,
      sandbox,
      task,
      this.#io,
      this.#store,
    );
    if (rows.warning) warnings.push(rows.warning);
    for (const w of warnings) this.#warn(w);
    const { tasks, messages } = rows;
    return { id: src.id, parsed, full, cost: 0, exit: 0, lines: [], tasks, messages, reused: true };
  }

  // A free request (tasks_ready, collect, id_list): no Reuse, no guard, no status line; saved
  // before use. The sandbox flag is per request: +collect collects sandbox and live tasks.
  async fetchFree(ep: Endpoint, planned: Plan, sandbox: boolean, deadline?: number) {
    const opts = { sandbox, free: true, estimate: 0, deadline };
    const x = await exchange(this.#catalog, ep, planned, opts, this.#io, this.#store, this.#warn);
    return { parsed: x.parsed, id: x.row.id, saved: x.saved, res: x.res };
  }
}

// The steps of a call. The exported ones serve --page-all (#45) and Lifecycle (#46) until those run
// over Dispatch; then they turn private.

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
export function ceilingOf(flags: SpendFlags, io: Io): { ceiling: number; explicit: boolean } {
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
): Promise<{ res: Exchange; parsed: unknown; row: Row; saved: boolean; price?: Price }> {
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

// Ledger Posted for one response when `on`; `task.variant` is the +run variant.
function taskRows(
  on: boolean,
  ep: Endpoint,
  body: unknown,
  id: string,
  sandbox: boolean,
  task: TaskContext,
  io: Io,
  store: StoreHandle,
): { tasks: Task[]; messages: Map<string, string>; warning?: string } {
  if (!on) return { tasks: [], messages: new Map() };
  const time = (io.now ?? Date.now)();
  return posted(store, body, { id, path: ep.path, variant: task.variant || null, sandbox, time });
}

// One send of a planned call, saved before print. Writes the status line, then this call's
// warnings, to `out`; returns the outcome lines and exit class for the caller. An unsaved response
// prints in full and exits 5.
export async function sendPlanned(
  catalog: Catalog,
  ep: Endpoint,
  planned: Plan,
  est: Estimate,
  opts: { sandbox: boolean; free: boolean },
  io: Io,
  store: StoreHandle,
  out: Output,
  task: TaskContext = {},
): Promise<Sent> {
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
  const rows = taskRows(
    task.track || !isFree(ep.path),
    ep,
    parsed,
    id,
    opts.sandbox,
    task,
    io,
    store,
  );
  if (rows.warning) warnings.push(rows.warning);
  const { lines, exit } = outcome(res, parsed, id, ep.method === 'get');
  const taskCount = isRecord(parsed) ? (parsed.tasks_count ?? 0) : 0;
  out.line(
    `dfs: ${row.status_code ?? res.status} ${ep.path} tasks=${taskCount} cost=$${row.cost ?? '?'} est=$${est.usd ?? '?'} saved=${id}`,
  );
  for (const w of warnings) out.warn(w);
  const { tasks, messages } = rows;
  return { id, parsed, full, cost: row.cost, exit, lines, tasks, messages, reused: false };
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
