// `dfs store …`: read the Store with no API call (docs/spec/modules/store.md, Commands).
import { closeSync, openSync } from 'node:fs';
import { DfsError, messageOf } from './errors.ts';
import { BUDGET, compact } from './render.ts';
import type { Io } from './run.ts';
import {
  backupStore,
  type Filter,
  getRow,
  listRows,
  openReadOnly,
  openStore,
  SPEND_BY,
  type SpendBy,
  searchItems,
  spend,
  storeFile,
} from './store.ts';

export const STORE_USAGE = `dfs store show <id> [--from <n>] [--full]
       dfs store list [--since <age>] [--path <words>]
       dfs store search "<words>" [--since <age>] [--path <words>]
       dfs store spend [--since <age>] [--by ${SPEND_BY.join('|')}]
       dfs store sql "<select>"
       dfs store backup <file>
       dfs store path
  <age>: <n>m, <n>h or <n>d before now; <words>: path words, such as "serp google" or serp/google`;

export type StoreFlags = {
  from?: string;
  full?: boolean;
  since?: string;
  path?: string;
  by?: string;
};

// Flags each subcommand takes; any other flag is a usage fault (exit 3).
const FLAGS: Record<string, (keyof StoreFlags)[]> = {
  show: ['from', 'full'],
  list: ['since', 'path'],
  search: ['since', 'path'],
  spend: ['since', 'by'],
  sql: [],
  backup: [],
  path: [],
};

export async function store(
  args: { values: StoreFlags; positionals: string[] },
  io: Io,
): Promise<void> {
  const { values: v } = args;
  const [sub, ...rest] = args.positionals;
  const allowed = Object.hasOwn(FLAGS, sub) ? FLAGS[sub] : undefined;
  const usage = new DfsError(3, `usage: ${STORE_USAGE}`);
  if (!allowed) throw usage;
  const extra = Object.keys(v).filter((k) => !allowed.includes(k as keyof StoreFlags));
  if (extra.length > 0)
    throw new DfsError(3, `store ${sub} takes no --${extra[0]}; usage: ${STORE_USAGE}`);
  const words = rest.join(' ').split(/\s+/).filter(Boolean);
  const arity = ({ show: 1, sql: 1, backup: 1 } as Record<string, number>)[sub] ?? 0;
  if (sub === 'search' ? words.length === 0 : rest.length !== arity) throw usage;

  if (sub === 'path') {
    io.stdout.write(`${storeFile(io.env)}\n`);
    return;
  }
  if (sub === 'backup') {
    // backup() overwrites its target, so only a new file is taken: an existing one may be other data.
    try {
      closeSync(openSync(rest[0], 'wx', 0o600));
    } catch (e) {
      const exists = (e as NodeJS.ErrnoException).code === 'EEXIST';
      throw new DfsError(
        3,
        exists
          ? `${rest[0]} exists — remove it first or name a new file`
          : `store backup: ${messageOf(e)}`,
      );
    }
    await backupStore(io.env, rest[0]);
    io.stdout.write(`${rest[0]}\n`);
    return;
  }
  if (sub === 'sql') return sql(rest[0], io);
  const db = openStore(io.env);
  try {
    if (sub === 'show') return show(db, rest[0], v, io);
    const f: Filter = { since: since(v.since, io), path: pathOf(v.path) };
    if (sub === 'list') io.stdout.write(fit(listRows(db, f)));
    if (sub === 'search') io.stdout.write(fit(searchItems(db, words, f).map(hit)));
    if (sub === 'spend') {
      if (v.by !== undefined && !SPEND_BY.includes(v.by as SpendBy)) {
        throw new DfsError(3, `--by ${v.by}: want ${SPEND_BY.join(', ')}`);
      }
      const [total, ...groups] = spend(db, f.since, v.by as SpendBy | undefined);
      const by = v.by as SpendBy;
      io.stdout.write(
        fit([
          { dfs: 'spend', since: f.since ?? null, ...total },
          ...groups.map(({ key, ...g }) => ({ [by]: key, ...g })),
        ]),
      );
    }
  } finally {
    db.close();
  }
}

function show(db: ReturnType<typeof openStore>, id: string, v: StoreFlags, io: Io): void {
  const from = Number(v.from ?? 1);
  if (!Number.isInteger(from) || from < 1) {
    throw new DfsError(3, `--from ${v.from}: want a whole number, 1 or more`);
  }
  const row = getRow(db, id);
  if (!row) throw new DfsError(3, `no response ${id} in the Store; see: dfs store list`);
  if (row.body === null) throw new DfsError(3, `${id} has no JSON body (HTTP ${row.http_status})`);
  io.stdout.write(v.full ? `${row.body}\n` : compact(JSON.parse(row.body), id, from, BUDGET));
}

const hit = (h: ReturnType<typeof searchItems>[number]) => ({
  ...h,
  more: `dfs store show ${h.id} --from ${h.item}`,
});

// A query on a read-only connection: SQLite refuses every write. A statement with no result
// columns (VACUUM INTO, a write) is refused too: `store sql` reads rows.
function sql(query: string, io: Io): void {
  const db = openReadOnly(io.env);
  try {
    let rows: unknown[];
    try {
      const stmt = db.prepare(query);
      if (stmt.columns().length === 0) throw new Error('not a query that returns rows');
      rows = stmt.all();
    } catch (e) {
      throw new DfsError(
        3,
        `store sql: ${messageOf(e)} — the Store is read-only here; JSONB columns read with json(<column>)`,
      );
    }
    io.stdout.write(
      fit(rows, (_, x) =>
        x instanceof Uint8Array ? `<blob ${x.length} bytes; select json(…)>` : x,
      ),
    );
  } finally {
    db.close();
  }
}

// JSON lines that fit the budget, then a cut line with the count shown and the total.
function fit(rows: unknown[], replacer?: (k: string, v: unknown) => unknown): string {
  let out = '';
  const cut = (shown: number) => `${JSON.stringify({ dfs: 'cut', shown, total: rows.length })}\n`;
  for (const [i, r] of rows.entries()) {
    const next = `${JSON.stringify(r, replacer)}\n`;
    const reserve = i < rows.length - 1 ? cut(i + 1).length : 0;
    if (out.length + next.length + reserve > BUDGET) return out + cut(i);
    out += next;
  }
  return out;
}

const UNIT = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

// `--since <n>m|h|d`: ISO 8601 time that far before now.
function since(age: string | undefined, io: Io): string | undefined {
  if (age === undefined) return undefined;
  const m = /^(\d+)([mhd])$/.exec(age);
  if (!m) throw new DfsError(3, `--since ${age}: want <n>m, <n>h or <n>d`);
  const ms = Number(m[1]) * UNIT[m[2] as keyof typeof UNIT];
  return new Date((io.now ?? Date.now)() - ms).toISOString();
}

// `--path "serp google"`, `serp/google` or `/v3/serp/google` → `/v3/serp/google`.
function pathOf(words: string | undefined): string | undefined {
  if (words === undefined) return undefined;
  const parts = words
    .replace(/^\/?v3\//, '')
    .split(/[\s/]+/)
    .filter(Boolean);
  if (parts.length === 0) throw new DfsError(3, '--path: want path words, such as "serp google"');
  return `/v3/${parts.join('/')}`;
}
