// Render: help, schema and search text, and the Compact output of a response
// (docs/spec/modules/render.md). Spec descriptions are HTML: shown as plain text.
import { concretePath, type Endpoint, type Level, type Spec } from './catalog.ts';
import { isRecord } from './json.ts';
import { deref, fields, isNullable, type Schema, type Schemas } from './schema.ts';

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
       dfs --version

call flags:
  --body <json|@file|->   tasks: a JSON object (one task) or array; @file; - reads stdin
  --full                  print the exact API response, not the Compact output
  --sandbox               send to the free sandbox, same credentials
  --max-cost <usd>        send a call whose price dfs does not know yet
  --dry-run               validate, print the call plan as JSON; nothing sent, no credentials
  --no-validate           field name, type and filter faults warn instead of exit 3
  credentials: DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD from the environment

modules:
${[...root.children.keys()]
  .toSorted()
  .map((m) => `  ${m}\n`)
  .join('')}
commands:
  schema <words…>    request fields of an endpoint
  search "<words>"   find endpoints by path words and descriptions
  store show <id>    reprint a saved response, no API call (--from <n>, --full)
  store list         saved responses, newest first
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
      `call: ${command(ep.words)}${ep.method === 'post' ? ' --body <json|@file|->' : ''} [--full] [--sandbox] [--max-cost <usd>] [--dry-run] [--no-validate]`,
    );
  }
  const children = [...node.children].toSorted(([a], [b]) => a.localeCompare(b));
  if (children.length > 0 || node.param) {
    lines.push('', 'children:', ...children.map(([w, n]) => childLine(w, n)));
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

// One unit per item (`tasks[].result[].items[]`, else `tasks[].result[]`); `head` is the task
// line printed before the first item of a task, or alone when the task has none.
type Unit = { head?: Record<string, unknown>; item?: unknown };

function* units(body: unknown): Generator<Unit> {
  const tasks = isRecord(body) && Array.isArray(body.tasks) ? body.tasks : [];
  for (const t of tasks) {
    if (!isRecord(t)) continue;
    const tag = isRecord(t.data) ? t.data.tag : undefined;
    const task = { dfs: 'task', id: t.id, status_code: t.status_code, tag };
    let named = false; // task line printed
    for (const r of Array.isArray(t.result) ? t.result : []) {
      if (isRecord(r) && Array.isArray(r.items)) {
        const { items, ...rest } = r;
        const head = { ...task, ...rest };
        if (items.length === 0) yield { head };
        for (const [k, item] of items.entries()) yield { head: k === 0 ? head : undefined, item };
      } else {
        yield { head: named ? undefined : task, item: r };
      }
      named = true;
    }
    if (!named) yield { head: task };
  }
}

// shortcut: values pass JSON.parse, so an integer above 2^53 loses digits in Compact output
// (--full keeps the API text); keep the source text once TypeScript types JSON.rawJSON.
const line = (v: unknown): string => `${JSON.stringify(prune(v) ?? v)}\n`;

// Compact output: items from number `from` (1-based) that fit in `room`, whole items only, then a
// cut line naming the next command. An item that can never fit becomes an outline line.
export function compact(body: unknown, id: string, from: number, room: number): string {
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
    if (out.length + headText.length + itemText.length + reserve > room) return out + cut(shown);
    out += headText + itemText;
    if (isItem) shown++;
  }
  return out;
}

// Characters per top-level key of an item, for the outline line.
function sizes(item: unknown): Record<string, number> {
  const p = prune(item);
  return isRecord(p)
    ? Object.fromEntries(Object.entries(p).map(([k, v]) => [k, JSON.stringify(v).length]))
    : {};
}
