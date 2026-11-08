// One endpoint call: body, guard, send, save before print, Compact output, exit code; and the
// `store` commands that reprint saved responses.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { text } from 'node:stream/consumers';
import pkg from '../package.json' with { type: 'json' };
import { type Catalog, type Endpoint, isLive } from './catalog.ts';
import { DfsError, messageOf } from './errors.ts';
import { isRecord } from './json.ts';
import { pageAll, pagingOf } from './pages.ts';
import { type Plan, plan } from './planner.ts';
import { type Estimate, estimate, guard, isFree, ruleFor } from './pricing.ts';
import { BUDGET, command, compact } from './render.ts';
import type { Io } from './run.ts';
import {
  getRow,
  listRows,
  openStore,
  type Price,
  type Row,
  readPrice,
  reuseRows,
  save,
  storeFile,
  writePrice,
} from './store.ts';
import { authHeader, send } from './transport.ts';

export const STORE_USAGE =
  'dfs store show <id> [--from <n>] [--full] | dfs store list | dfs store path';

// Exit table (docs/spec/exit-codes-flags.md): account codes exit 2; warnings that still exit 0.
const ACCOUNT = new Set([40100, 40104, 40200, 40201, 40203, 40205, 40206, 40207, 40210]);
const OK_WARNING = new Set([40106, 40102, 40007]);
export const isAccount = (http: number, code: unknown) =>
  http === 401 || http === 402 || (typeof code === 'number' && ACCOUNT.has(code));
export const isOk = (code: unknown) =>
  typeof code === 'number' && (Math.floor(code / 10_000) === 2 || OK_WARNING.has(code));

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
// SQLite json_remove keeps the other values as the API wrote them, number digits included.
// Also deletes `login` from `body`, so the Compact output never shows it.
function redactLogin(text: string, body: unknown): string {
  const paths: string[] = [];
  const tasks = isRecord(body) && Array.isArray(body.tasks) ? body.tasks : [];
  for (const [i, t] of tasks.entries()) {
    for (const [j, r] of (isRecord(t) && Array.isArray(t.result) ? t.result : []).entries()) {
      if (isRecord(r) && 'login' in r) {
        delete r.login;
        paths.push(`$.tasks[${i}].result[${j}].login`);
      }
    }
  }
  if (paths.length === 0) return text;
  const db = new DatabaseSync(':memory:');
  try {
    const marks = paths.map(() => '?').join(', ');
    const { j } = db.prepare(`SELECT json_remove(?, ${marks}) AS j`).get(text, ...paths) as {
      j: string;
    };
    return j;
  } finally {
    db.close();
  }
}

// 40103 is never retried by itself (transport.md): charging is unverified, so the agent decides.
const FRESH = 'to send it again, add --fresh';

// stderr lines after the status line, and the exit code: worst class wins, 2 > 1 > 6 > 0.
export function outcome(
  http: number,
  body: unknown,
  id: string,
): { lines: string[]; exit: number } {
  const show = `full response: dfs store show ${id} --full`;
  const owner = 'the account owner must act: check credentials, balance and limits';
  if (!isRecord(body)) {
    const exit = isAccount(http, undefined) ? 2 : 1;
    return { lines: [`dfs: HTTP ${http} — ${exit === 2 ? owner : show}`], exit };
  }
  if (isAccount(http, body.status_code)) {
    return { lines: [`dfs: ${body.status_code} ${body.status_message} — ${owner}`], exit: 2 };
  }
  if (body.status_code !== 20000 || http >= 300) {
    const remedy = body.status_code === 40103 ? FRESH : show;
    return { lines: [`dfs: ${body.status_code} ${body.status_message} — ${remedy}`], exit: 1 };
  }
  const tasks = (Array.isArray(body.tasks) ? body.tasks : []).filter(isRecord);
  const failed = tasks.filter((t) => !isOk(t.status_code));
  const lines = failed.map(
    (t) =>
      `dfs: task ${t.id} failed ${t.status_code} ${t.status_message}${t.status_code === 40103 ? ` — ${FRESH}` : ''}`,
  );
  if (failed.some((t) => isAccount(http, t.status_code))) return { lines, exit: 2 };
  if (failed.length > 0 && failed.length === tasks.length) return { lines, exit: 1 };
  return { lines, exit: failed.length > 0 ? 6 : 0 };
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
export function reusable(io: Io, planned: Plan, sandbox: boolean): Row | undefined {
  const since = new Date((io.now ?? Date.now)() - REUSE_WINDOW).toISOString();
  const db = openStore(io.env);
  try {
    return reuseRows(db, reuseKey(planned, sandbox), since).find(
      (r) => outcome(r.http_status, JSON.parse(r.body as string), r.id).exit === 0,
    );
  } finally {
    db.close();
  }
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

// The `price` node of a user_data response with envelope 20000.
function priceNode(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body) || body.status_code !== 20000 || !Array.isArray(body.tasks)) return undefined;
  const [task] = body.tasks;
  const [result] = isRecord(task) && Array.isArray(task.result) ? task.result : [];
  return isRecord(result) && isRecord(result.price) ? result.price : undefined;
}

// One HTTP exchange, saved to the Store before anything prints. A good non-sandbox user_data
// response also writes the price tree (pricing.md); sandbox prices are dummy data.
export async function exchange(
  catalog: Catalog,
  ep: Endpoint,
  planned: Plan,
  opts: { sandbox: boolean; free: boolean; estimate: number | null },
  io: Io,
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
    live: isLive(ep.path),
  });

  const parsed = parseJson(res.text);
  const kept =
    parsed !== undefined && ep.path === USER_DATA ? redactLogin(res.text, parsed) : res.text;
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
  const saved = save(io.env, row, warn);
  const tree = ep.path === USER_DATA && !opts.sandbox && res.status < 300 && priceNode(parsed);
  const price = tree ? { at: row.time, tree } : undefined;
  if (price) {
    try {
      const db = openStore(io.env);
      try {
        writePrice(db, price);
      } finally {
        db.close();
      }
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
  refresh: boolean,
  warn: (w: string) => void,
): Promise<Price | undefined> {
  const db = openStore(io.env);
  let old: Price | undefined;
  try {
    old = readPrice(db);
  } finally {
    db.close();
  }
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
      warn,
    );
    if (r.price) return r.price;
    why = `${r.row.status_code ?? `HTTP ${r.res.status}`}, ${r.saved ? `see: dfs store show ${r.row.id}` : 'not saved'}`;
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
): Promise<number> {
  const tasks = await readBody(ep, flags.body, io);
  // --dry-run plans the first page only.
  if (flags['page-all']) {
    const paging = pagingOf(catalog, ep, tasks);
    if (!flags['dry-run']) return pageAll(catalog, ep, params, paging, flags, io);
  }
  const sandbox = flags.sandbox === true;
  const { ceiling, explicit } = ceilingOf(flags, io);
  const planned = plan(catalog, ep, params, tasks, { sandbox, validate: !flags['no-validate'] });
  // Warnings before the send print at once, so a failed send still shows them.
  let early = '';
  const warnEarly = (w: string) => {
    const line = `dfs: warning: ${w}\n`;
    early += line;
    io.stderr.write(line);
  };
  planned.warnings.forEach(warnEarly);
  // Free paths always go to the API (user story 24).
  const reuse = flags.fresh || isFree(ep.path) ? undefined : reusable(io, planned, sandbox);
  if (reuse && !flags['dry-run']) return replay(catalog, ep, reuse, flags, io, early);
  // The sandbox and the free list estimate 0; the guard does not apply.
  const free = sandbox || isFree(ep.path);
  const rule = free ? undefined : ruleFor(ep.path);
  const price =
    rule && !rule.unbounded
      ? await priceTree(catalog, io, !flags['dry-run'], warnEarly)
      : undefined;
  const est: Estimate = free
    ? { usd: 0, basis: 'rule' }
    : estimate(rule, planned.body ?? [], price?.tree, (io.now ?? Date.now)());
  if (est.warning) warnEarly(est.warning);
  const refusal = free ? undefined : guard(ep.path, est, ceiling, explicit);
  if (flags['dry-run']) {
    const out = {
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
    io.stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  }
  if (refusal) throw new DfsError(4, refusal);

  const r = await sendPlanned(catalog, ep, planned, est, { sandbox, free }, io);
  const stderr = r.lines.map((l) => `${l}\n`).join('');
  io.stderr.write(stderr);
  if (r.parsed !== undefined) {
    io.stdout.write(
      flags.full
        ? `${r.full}\n`
        : compact(r.parsed, r.id, 1, BUDGET - early.length - stderr.length),
    );
  }
  return r.exit;
}

// One send of a planned call, saved before print: its stderr lines (status line first), the
// exit code and the response. An unsaved response prints in full and exits 5.
export async function sendPlanned(
  catalog: Catalog,
  ep: Endpoint,
  planned: Plan,
  est: Estimate,
  opts: { sandbox: boolean; free: boolean },
  io: Io,
) {
  const warnings: string[] = [];
  const { res, parsed, row, saved } = await exchange(
    catalog,
    ep,
    planned,
    { ...opts, estimate: est.usd },
    io,
    (w) => warnings.push(`dfs: warning: ${w}`),
  );
  const { id } = row;
  const full = row.body ?? res.text;
  if (!saved) {
    io.stdout.write(`${full}\n`);
    throw new DfsError(5, '5 response not saved — stdout is the only copy');
  }
  // Sandbox costs are dummy data (r34:51).
  if (!opts.sandbox && est.usd !== null && row.cost !== null && row.cost > est.usd) {
    warnings.push(
      `dfs: warning: real cost $${row.cost} above estimate $${est.usd} for ${ep.path} — the price rule may be out of date`,
    );
  }
  const { lines, exit } = outcome(res.status, parsed, id);
  const taskCount = isRecord(parsed) ? (parsed.tasks_count ?? 0) : 0;
  const status = `dfs: ${row.status_code ?? res.status} ${ep.path} tasks=${taskCount} cost=$${row.cost ?? '?'} est=$${est.usd ?? '?'} saved=${id}`;
  return { parsed, id, full, cost: row.cost, lines: [status, ...warnings, ...lines], exit };
}

// A stored response at $0: saves a reuse row (no body, no cost), then prints the stored output.
function replay(
  catalog: Catalog,
  ep: Endpoint,
  src: Row,
  flags: CallFlags,
  io: Io,
  early: string, // warnings already printed; they count against the budget
): number {
  const warnings: string[] = [];
  const status = reuseRow(catalog, ep, src, io, (w) => warnings.push(`dfs: warning: ${w}`));
  const full = src.body as string;
  const stderr = [status, ...warnings].map((l) => `${l}\n`).join('');
  io.stderr.write(stderr);
  io.stdout.write(
    flags.full
      ? `${full}\n`
      : compact(JSON.parse(full), src.id, 1, BUDGET - early.length - stderr.length),
  );
  return 0;
}

// Saves the reuse row of a stored response; returns its status line.
export function reuseRow(
  catalog: Catalog,
  ep: Endpoint,
  src: Row,
  io: Io,
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
  save(io.env, row, warn);
  const parsed = JSON.parse(src.body as string);
  return `dfs: ${src.status_code} ${ep.path} tasks=${parsed.tasks_count ?? 0} cost=$0 est=$0 reused=${src.id} age=${age(now - Date.parse(src.time))}`;
}

export function store(
  args: { values: { from?: string; full?: boolean }; positionals: string[] },
  io: Io,
) {
  const [sub, id, ...extra] = args.positionals;
  if (sub === 'path' && id === undefined) {
    io.stdout.write(`${storeFile(io.env)}\n`);
    return;
  }
  if (sub === 'show' && id !== undefined && extra.length === 0) {
    const from = Number(args.values.from ?? 1);
    if (!Number.isInteger(from) || from < 1) {
      throw new DfsError(3, `--from ${args.values.from}: want a whole number, 1 or more`);
    }
    const db = openStore(io.env);
    try {
      const row = getRow(db, id);
      if (!row) throw new DfsError(3, `no response ${id} in the Store; see: dfs store list`);
      if (row.body === null)
        throw new DfsError(3, `${id} has no JSON body (HTTP ${row.http_status})`);
      io.stdout.write(
        args.values.full ? `${row.body}\n` : compact(JSON.parse(row.body), id, from, BUDGET),
      );
    } finally {
      db.close();
    }
    return;
  }
  if (sub === 'list' && id === undefined) {
    const db = openStore(io.env);
    try {
      const rows = listRows(db);
      let out = '';
      const cut = (shown: number) =>
        `${JSON.stringify({ dfs: 'cut', shown, total: rows.length })}\n`;
      for (const [i, r] of rows.entries()) {
        const next = `${JSON.stringify(r)}\n`;
        const reserve = i < rows.length - 1 ? cut(i + 1).length : 0;
        if (out.length + next.length + reserve > BUDGET) {
          out += cut(i);
          break;
        }
        out += next;
      }
      io.stdout.write(out);
    } finally {
      db.close();
    }
    return;
  }
  if (['spend', 'search', 'sql', 'backup'].includes(sub)) {
    throw new DfsError(3, `store ${sub}: not in this build yet`);
  }
  throw new DfsError(3, `usage: ${STORE_USAGE}`);
}
