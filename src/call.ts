// One endpoint call: body, guard, send, save before print, Compact output, exit code; and the
// `store` commands that reprint saved responses.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { text } from 'node:stream/consumers';
import pkg from '../package.json' with { type: 'json' };
import { type Catalog, concretePath, type Endpoint } from './catalog.ts';
import { DfsError, messageOf } from './errors.ts';
import { isRecord } from './json.ts';
import { estimate } from './pricing.ts';
import { BUDGET, command, compact } from './render.ts';
import type { Io } from './run.ts';
import { getRow, listRows, openStore, type Row, save, storeFile } from './store.ts';
import { authHeader, send } from './transport.ts';

const SANDBOX = 'https://sandbox.dataforseo.com';
export const STORE_USAGE =
  'dfs store show <id> [--from <n>] [--full] | dfs store list | dfs store path';

// Exit table (docs/spec/exit-codes-flags.md): account codes exit 2; warnings that still exit 0.
const ACCOUNT = new Set([40100, 40104, 40200, 40201, 40203, 40205, 40206, 40207, 40210]);
const OK_WARNING = new Set([40106, 40102, 40007]);
const isAccount = (http: number, code: unknown) =>
  http === 401 || http === 402 || (typeof code === 'number' && ACCOUNT.has(code));
const isOk = (code: unknown) =>
  typeof code === 'number' && (Math.floor(code / 10_000) === 2 || OK_WARNING.has(code));

export type CallFlags = { body?: string; full?: boolean; sandbox?: boolean; 'max-cost'?: string };

// The tasks to send: a JSON object is one task, an array is the batch.
async function readBody(
  ep: Endpoint,
  arg: string | undefined,
  io: Io,
): Promise<string | undefined> {
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
  return JSON.stringify(tasks);
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

// stderr lines after the status line, and the exit code: worst class wins, 2 > 1 > 6 > 0.
function outcome(http: number, body: unknown, id: string): { lines: string[]; exit: number } {
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
    return { lines: [`dfs: ${body.status_code} ${body.status_message} — ${show}`], exit: 1 };
  }
  const tasks = (Array.isArray(body.tasks) ? body.tasks : []).filter(isRecord);
  const failed = tasks.filter((t) => !isOk(t.status_code));
  const lines = failed.map((t) => `dfs: task ${t.id} failed ${t.status_code} ${t.status_message}`);
  if (failed.some((t) => isAccount(http, t.status_code))) return { lines, exit: 2 };
  if (failed.length > 0 && failed.length === tasks.length) return { lines, exit: 1 };
  return { lines, exit: failed.length > 0 ? 6 : 0 };
}

export async function call(
  catalog: Catalog,
  ep: Endpoint,
  params: Record<string, string>,
  flags: CallFlags,
  io: Io,
): Promise<number> {
  const body = await readBody(ep, flags.body, io);
  const sandbox = flags.sandbox === true;
  const est = estimate(ep.path, sandbox);
  if (flags['max-cost'] !== undefined && !(Number(flags['max-cost']) >= 0)) {
    throw new DfsError(3, `--max-cost ${flags['max-cost']}: want a number of USD, 0 or more`);
  }
  // shortcut: an explicit --max-cost lets an unknown price pass, as the guard rule says; the
  // ceiling is checked against an estimate once ticket 04 adds price rules.
  if (est === undefined && flags['max-cost'] === undefined) {
    throw new DfsError(
      4,
      `price unknown for ${ep.path} in this build — pass --max-cost <usd> to send, or --sandbox`,
    );
  }
  const auth = authHeader(io.env);
  const path = concretePath(ep, params);
  const method = ep.method.toUpperCase();
  const base = sandbox ? SANDBOX : (catalog.spec.servers?.[0]?.url ?? 'https://api.dataforseo.com');
  const res = await send(io.fetch, { method, url: `${base}${path}`, body, auth });

  const parsed = parseJson(res.text);
  const kept =
    parsed !== undefined && ep.path === '/v3/appendix/user_data'
      ? redactLogin(res.text, parsed)
      : res.text;
  const envelope = isRecord(parsed) ? parsed : {};
  const id = `r_${randomBytes(5).toString('hex')}`;
  const row: Row = {
    id,
    time: new Date((io.now ?? Date.now)()).toISOString(),
    method,
    spec_path: ep.path,
    path,
    sandbox: sandbox ? 1 : 0,
    request: body ?? null,
    http_status: res.status,
    status_code: typeof envelope.status_code === 'number' ? envelope.status_code : null,
    cost: typeof envelope.cost === 'number' ? envelope.cost : null,
    estimate: est ?? null,
    reused_from: null,
    dfs_version: pkg.version,
    spec_sha: catalog.sha,
    body: parsed === undefined ? null : kept,
  };

  const warnings: string[] = [];
  const full = row.body ?? res.text;
  if (!save(io.env, row, (w) => warnings.push(`dfs: warning: ${w}`))) {
    io.stdout.write(`${full}\n`);
    throw new DfsError(5, '5 response not saved — stdout is the only copy');
  }
  const { lines, exit } = outcome(res.status, parsed, id);
  const tasks = envelope.tasks_count ?? 0;
  const status = `dfs: ${row.status_code ?? res.status} ${ep.path} tasks=${tasks} cost=$${row.cost ?? '?'} est=$${est ?? '?'} saved=${id}`;
  const stderr = [status, ...warnings, ...lines].map((l) => `${l}\n`).join('');
  io.stderr.write(stderr);
  if (parsed !== undefined) {
    io.stdout.write(flags.full ? `${full}\n` : compact(parsed, id, 1, BUDGET - stderr.length));
  }
  return exit;
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
