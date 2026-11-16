// Render: help, schema and search text; the Compact output of a response; Output, the writer of
// stdout, stderr and the exit code of a command (docs/spec/modules/render.md). Spec descriptions
// are HTML: shown as plain text.
import { concretePath, type Endpoint, hasRun, type Level, type Spec } from './catalog.ts';
import { isAccount, isNotReady, isOk, succeeded, tasksOf, units } from './envelope.ts';
import { isRecord } from './json.ts';
import type { Task } from './ledger.ts';
import { paging } from './planner.ts';
import type { Io } from './run.ts';
import { deref, fields, isNullable, type Schema, type Schemas } from './schema.ts';
import type { Exchange } from './transport.ts';

export const SCHEMA_USAGE = 'dfs schema <words…>';
export const SEARCH_USAGE = 'dfs search "<words>"';

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"' };

// HTML to plain lines: block tags break lines, other tags drop, entities decode,
// zero-width characters go.
export const plainLines = (html = ''): string[] =>
  html
    .replace(/<\/?(p|br|li|ul|ol|div|h\d|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot);/g, (_, e: string) => ENTITIES[e])
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[​-‍﻿]/g, '')
    .split('\n')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

// shortcut: a one-line summary cut at `max` characters; `dfs schema` shows field rules in full
// once the Planner needs them.
const brief = (html: string | undefined, max: number): string => {
  const text = plainLines(html).join('; ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

export const command = (words: string[]): string => ['dfs', ...words].join(' ');

export function rootHelp(root: Level, spec: { sha: string; date: string }): string {
  return `dfs: the DataForSEO API from the command line (spec ${spec.sha.slice(0, 7)}, ${spec.date.slice(0, 10)})

usage: dfs <module> <words…> [--help]   list a level, or show an endpoint
       dfs <endpoint words…> [flags]     call an endpoint
       dfs <level> +run [variant] --body …   post tasks, wait, collect (levels with task_post)
       dfs [<module>] +collect   collect pending tasks; recover lost ids through id_list
       dfs --version

call flags:
  --body <json|@file|->   tasks: a JSON object (one task) or array; @file; - reads stdin
  --full                  print the exact API response, not the Compact output
  --sandbox               send to the free sandbox, same credentials
  --max-cost <usd>        cost ceiling (default: DFS_MAX_COST, else 1); also sends an unknown price
  --dry-run               validate, print the call plan as JSON; nothing sent, no credentials
  --no-validate           field name, type and filter faults warn instead of exit 3
  --fresh                 send even when a stored response is reusable
  --page-all              one task, all pages: offset to 10,000, then offset_token or search_after_token;
                          stops before the page that passes the ceiling (exit 4); --full: one line per page
  --wait <s>              +run: wait for tasks up to <s> seconds (default 90; 0 = post only)
  credentials: DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD from the environment
  cost guard: exit 4, nothing sent, when the estimate passes the ceiling or the price is unknown
  reuse: the same paid request within 12 h of a full success returns the stored response at $0
  +run: exit 6 with the pending task ids when the wait ends; dfs +collect collects them later
  +collect: one pass, never posts; exit 6 while tasks stay pending

modules:
${[...root.children.keys()]
  .toSorted()
  .map((m) => `  ${m}\n`)
  .join('')}
commands:
  schema <words…>    request fields of an endpoint
  search "<words>"   find endpoints by path words and descriptions
  store show <id>    reprint a saved response, no API call (--from <n>, --full)
  store list         saved responses, newest first (--since <age>, --path <words>)
  store search "<words>"   stored items holding every word, diacritics folded (--since, --path)
  store spend        cost of non-sandbox tasks (--since <age>, --by day|module|path|tag)
  store sql "<select>"     read-only SQL over the Store (schema: docs/spec/modules/store.md)
  store backup <file>      consistent copy of the Store, file 600, while dfs runs
  store path         the Store file
`;
}

const childLine = (word: string, n: Level): string => {
  const marks = [
    n.endpoint?.method.toUpperCase(),
    (n.children.size > 0 || n.param) && 'has children',
  ].filter(Boolean);
  return `  ${word}${marks.length > 0 ? `  ${marks.join(', ')}` : ''}`;
};

// A level lists its children; an endpoint shows method, concrete URL, description and children.
export function nodeHelp(node: Level, params: Record<string, string>, spec: Spec): string {
  const lines = [command(node.words)];
  const ep = node.endpoint;
  if (ep) {
    lines.push(
      `${ep.method.toUpperCase()} ${spec.servers?.[0]?.url ?? ''}${concretePath(ep, params)}`,
    );
    const description = plainLines(ep.op.description);
    if (description.length > 0) lines.push('', ...description);
    if (ep.method === 'post') lines.push('', `request fields: dfs schema ${ep.words.join(' ')}`);
    lines.push(
      '',
      `call: ${command(ep.words)}${ep.method === 'post' ? ' --body <json|@file|->' : ''} [--full] [--sandbox] [--max-cost <usd>] [--fresh]${paging(ep, spec.components.schemas) ? ' [--page-all]' : ''} [--dry-run] [--no-validate]`,
    );
  }
  const children = [...node.children].toSorted(([a], [b]) => a.localeCompare(b));
  if (children.length > 0 || node.param) {
    lines.push('', 'children:', ...children.map(([w, n]) => childLine(w, n)));
    if (hasRun(node)) {
      lines.push(`  +run  post, wait and collect tasks: ${command(node.words)} +run --help`);
    }
    if (node.param) lines.push(childLine(`<${node.param.name}>`, node.param.node));
  }
  return `${lines.join('\n')}\n`;
}

const typeLabel = (s: Schema | undefined, schemas: Schemas): string => {
  const d = deref(s, schemas);
  const t = d?.type ?? 'any';
  const label = t === 'array' ? `array of ${deref(d?.items, schemas)?.type ?? 'any'}` : t;
  return isNullable(d) ? `${label}, nullable` : label;
};

// One line per field, nested fields as `a.b` and `a[].b`; a schema already on the path stops.
function fieldLines(
  s: Schema | undefined,
  schemas: Schemas,
  prefix: string,
  path: Set<Schema>,
): string[] {
  const lines: string[] = [];
  for (const [name, f] of fields(s, schemas)) {
    const d = deref(f, schemas);
    const text = brief(f.description ?? d?.description, 160);
    lines.push(`  ${prefix}${name}  ${typeLabel(f, schemas)}${text ? `  ${text}` : ''}`);
    const inner = d?.type === 'array' ? deref(d.items, schemas) : d;
    if (!inner || path.has(inner)) continue;
    const sub = `${prefix}${name}${d?.type === 'array' ? '[]' : ''}.`;
    lines.push(...fieldLines(inner, schemas, sub, new Set([...path, inner])));
  }
  return lines;
}

export function schemaText(ep: Endpoint, spec: Spec): string {
  const lines = [command(ep.words), `${ep.method.toUpperCase()} ${ep.path}`];
  const params = (ep.op.parameters ?? []).map((p) => `<${p.name}>`);
  if (params.length > 0) lines.push(`path parameters: ${params.join(' ')}`);
  const body = ep.op.requestBody?.content?.['application/json']?.schema;
  if (!body) lines.push('body: none');
  else {
    const { schemas } = spec.components;
    const task = deref(body.items, schemas);
    lines.push('body: array of tasks; task fields:');
    lines.push(...fieldLines(task, schemas, '', new Set(task ? [task] : [])));
  }
  return `${lines.join('\n')}\n`;
}

export const searchText = (hits: Endpoint[]): string =>
  hits
    .map((e) =>
      `${command(e.words)}  ${e.method.toUpperCase()}  ${brief(e.op.description, 100)}`.trimEnd(),
    )
    .map((line) => `${line}\n`)
    .join('');

// stdout and stderr together, per command, in UTF-16 code units (never fewer than characters).
export const BUDGET = 9000;

// Empty values removed: null, "", [], {}, also once their content is removed. An array keeps its
// length, so an element shows in its empty form.
export function prune(v: unknown): unknown {
  if (Array.isArray(v)) {
    const a = v.map((x) => prune(x) ?? (isRecord(x) ? {} : Array.isArray(x) ? [] : x));
    return a.length > 0 ? a : undefined;
  }
  if (isRecord(v)) {
    const entries = Object.entries(v)
      .map(([k, x]) => [k, prune(x)] as const)
      .filter(([, x]) => x !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  return v === null || v === '' ? undefined : v;
}

// shortcut: values pass JSON.parse, so an integer above 2^53 loses digits in Compact output
// (--full keeps the API text); keep the source text once TypeScript types JSON.rawJSON.
const line = (v: unknown): string => `${JSON.stringify(prune(v) ?? v)}\n`;

export type Compact = { text: string; shown: number; total: number; cut: boolean };

// Compact output: items from number `from` (1-based) that fit in `room`, whole items only, then a
// cut line naming the next command. An item that can never fit becomes an outline line.
export function compact(body: unknown, id: string, from: number, room: number): Compact {
  const all = [...units(body)];
  const total = all.filter((u) => 'item' in u).length;
  const cut = (shown: number) =>
    line({ dfs: 'cut', shown, total, more: `dfs store show ${id} --from ${from + shown}` });
  let out = '';
  let shown = 0;
  let n = 0; // item number
  let task: Record<string, unknown> | undefined; // head of the current task
  for (const [i, u] of all.entries()) {
    const isItem = 'item' in u;
    if (isItem) n++;
    task = u.head ?? task;
    if ((isItem ? n : n + 1) < from) continue;
    // The first unit shown names its task, also when --from starts inside it.
    const head = u.head ?? (out === '' ? task : undefined);
    const headText = head ? line(head) : '';
    const reserve = i < all.length - 1 ? cut(shown + 1).length : 0;
    let itemText = isItem ? line(u.item) : '';
    if (itemText.length > room - headText.length - reserve) {
      itemText = line({
        dfs: 'outline',
        item: n,
        keys: sizes(u.item),
        more: `dfs store show ${id} --full`,
      });
    }
    if (out.length + headText.length + itemText.length + reserve > room) {
      return { text: out + cut(shown), shown, total, cut: true };
    }
    out += headText + itemText;
    if (isItem) shown++;
  }
  return { text: out, shown, total, cut: false };
}

// Characters per top-level key of an item, for the outline line.
function sizes(item: unknown): Record<string, number> {
  const p = prune(item);
  return isRecord(p)
    ? Object.fromEntries(Object.entries(p).map(([k, v]) => [k, JSON.stringify(v).length]))
    : {};
}

// 40103 is never retried by itself (transport.md): charging is unverified, so the agent decides.
const FRESH = 'to send it again, add --fresh';

// outcome: the stderr lines after the status line of one response, and its exit class.
// `get`: 20100 is pending on a get, task created (ok) on a post.
export function outcome(
  res: Exchange,
  body: unknown,
  id: string,
  get = false,
): { lines: string[]; exit: number } {
  const http = res.status;
  const show = `full response: dfs store show ${id} --full`;
  const owner = 'the account owner must act: check credentials, balance and limits';
  if (!isRecord(body)) {
    if (isAccount(http, undefined)) return { lines: [`dfs: HTTP ${http} — ${owner}`], exit: 2 };
    // Such a body has no items, and HTML has no stored body: the line carries an excerpt.
    // Control characters (a terminal escape in a proxy page) collapse like whitespace.
    const excerpt = res.text
      .replace(/[\s\p{Cc}]+/gu, ' ')
      .trim()
      .slice(0, 200);
    return { lines: [`dfs: HTTP ${http} — not a JSON object: ${excerpt}`], exit: 1 };
  }
  if (isAccount(http, body.status_code)) {
    return { lines: [`dfs: ${body.status_code} ${body.status_message} — ${owner}`], exit: 2 };
  }
  if (!succeeded(http, body)) {
    const remedy = body.status_code === 40103 ? FRESH : show;
    return { lines: [`dfs: ${body.status_code} ${body.status_message} — ${remedy}`], exit: 1 };
  }
  const tasks = tasksOf(body);
  const waiting = (t: Record<string, unknown>) => isNotReady(t.status_code, get);
  const pending = tasks.filter(waiting);
  const failed = tasks.filter((t) => !waiting(t) && !isOk(t.status_code));
  const lines = [
    ...failed.map(
      (t) =>
        `dfs: task ${t.id} failed ${t.status_code} ${t.status_message}${t.status_code === 40103 ? ` — ${FRESH}` : ''}`,
    ),
    ...pending.map((t) => `dfs: task ${t.id} pending ${t.status_code}`),
  ];
  if (failed.some((t) => isAccount(http, t.status_code))) return { lines, exit: 2 };
  if (failed.length > 0 && failed.length === tasks.length) return { lines, exit: 1 };
  return { lines, exit: failed.length + pending.length > 0 ? 6 : 0 };
}

// Task exit rule (exit-codes-flags.md): 2 if a failed or expired task is in the account class;
// else 1 if every task failed or expired; else 6 if a task is not collected; else 0.
export function taskExit(tasks: Pick<Task, 'state' | 'status_code'>[]): number {
  const failed = tasks.filter((t) => t.state === 'failed' || t.state === 'expired');
  if (failed.some((t) => isAccount(200, t.status_code))) return 2;
  if (tasks.length > 0 && failed.length === tasks.length) return 1;
  return tasks.some((t) => t.state !== 'collected') ? 6 : 0;
}

const RANK: Record<number, number> = { 0: 0, 6: 1, 1: 2, 2: 3 }; // worst class wins: 2 > 1 > 6 > 0
const CUT_MAX = 100; // longest cut line of a page: 5-digit counts, `r_` + 10 hex
const moreLines = (n: number) => `dfs: +${n} more lines — all pages: dfs store list`;

// Output: one per command. It owns the budget: every line it writes counts, and closing lines
// keep their room. Mode `pages` (--page-all): a stderr line that no longer fits is hidden and
// counted in the closing `+<n> more lines` line; else every stderr line prints.
export class Output {
  #io: Pick<Io, 'stdout' | 'stderr'>;
  #pages: boolean;
  #used = 0; // characters written to stdout and stderr
  #reserved = 0; // room kept for closing lines
  #hidden = 0;
  #said = new Set<string>(); // keys of lines printed once
  #cut = false; // a response was cut: later responses print nothing
  #exit = 0;

  constructor(io: Pick<Io, 'stdout' | 'stderr'>, mode: 'default' | 'pages' = 'default') {
    this.#io = io;
    this.#pages = mode === 'pages';
    // A page's cut line fits even when no item does.
    if (this.#pages) this.#reserved = moreLines(99_999).length + 1 + CUT_MAX;
  }

  #write(stream: 'stdout' | 'stderr', text: string): void {
    this.#io[stream].write(text);
    this.#used += text.length;
  }

  #room(): number {
    return BUDGET - this.#used - this.#reserved;
  }

  // Keeps room for a closing line printed later: give its longest form.
  reserve(line: string): void {
    this.#reserved += line.length + 1;
  }

  // One stderr line; with a `key`, only the first line of that key prints.
  line(text: string, key?: string): void {
    if (key !== undefined) {
      if (this.#said.has(key)) return;
      this.#said.add(key);
    }
    if (this.#pages && text.length + 1 > this.#room()) this.#hidden++;
    else this.#write('stderr', `${text}\n`);
  }

  // `dfs: warning: <text>`, once per key (default: the text) per command.
  warn(text: string, key = text): void {
    this.line(`dfs: warning: ${text}`, `dfs: warning: ${key}`);
  }

  // One response as Compact output in the room left; nothing once an earlier response was cut.
  // `list`: response `index` of `total` (+run, +collect). Its cut line names the Store list and
  // keeps its room; it follows a cut, except after a last response that shows an item.
  response(
    body: unknown,
    id: string,
    { from = 1, list }: { from?: number; list?: { index: number; total: number } } = {},
  ): Compact | undefined {
    if (this.#cut) return undefined;
    const rest =
      list && line({ dfs: 'cut', tasks: list.index, total: list.total, more: 'dfs store list' });
    const c = compact(body, id, from, this.#room() - (rest?.length ?? 0));
    this.#cut = c.cut;
    if (!c.cut || !rest) this.#write('stdout', c.text);
    else {
      // A response cut before its first item shows nothing of use.
      if (c.shown > 0) this.#write('stdout', c.text);
      if (c.shown === 0 || list.index < list.total - 1) this.#write('stdout', rest);
    }
    return c;
  }

  // The lines that fit, then `cut(shown)` when some do not. `after`: a closing line that keeps
  // its room and follows the block.
  block(
    lines: string[],
    cut: (shown: number) => string,
    { stream = 'stdout', after }: { stream?: 'stdout' | 'stderr'; after?: string } = {},
  ): void {
    const room = this.#room() - (after === undefined ? 0 : after.length + 1);
    let text = '';
    for (const [i, l] of lines.entries()) {
      const reserve = i < lines.length - 1 ? cut(i + 1).length + 1 : 0;
      if (text.length + l.length + 1 + reserve > room) {
        text += `${cut(i)}\n`;
        break;
      }
      text += `${l}\n`;
    }
    if (after !== undefined) text += `${after}\n`;
    this.#write(stream, text);
  }

  // stdout text outside the budget: a --full response, the --dry-run plan.
  full(text: string): void {
    this.#io.stdout.write(`${text}\n`);
  }

  // The exit class of a request or of the tasks; the worst wins.
  exit(code: number): void {
    if (RANK[code] > RANK[this.#exit]) this.#exit = code;
  }

  // The hidden-lines line (pages mode), then `final`; returns the exit code: `exit`, else the
  // worst class.
  close(final?: string, exit = this.#exit): number {
    if (this.#hidden > 0) this.#write('stderr', `${moreLines(this.#hidden)}\n`);
    if (final !== undefined) this.#write('stderr', `${final}\n`);
    return exit;
  }
}
