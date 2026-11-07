// Text for --help, --version, schema and search. Spec descriptions are HTML: shown as plain text.
import type { Endpoint, Level, Spec } from './catalog.ts';
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
       dfs --version

modules:
${[...root.children.keys()]
  .toSorted()
  .map((m) => `  ${m}\n`)
  .join('')}
commands:
  schema <words…>    request fields of an endpoint
  search "<words>"   find endpoints by path words and descriptions
  store              the local Store of responses (not in this build yet)
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
    const path = ep.path.replace(/\{(\w+)\}/g, (m, name: string) =>
      Object.hasOwn(params, name) ? encodeURIComponent(params[name]) : m,
    );
    lines.push(`${ep.method.toUpperCase()} ${spec.servers?.[0]?.url ?? ''}${path}`);
    const description = plainLines(ep.op.description);
    if (description.length > 0) lines.push('', ...description);
    if (ep.method === 'post') lines.push('', `request fields: dfs schema ${ep.words.join(' ')}`);
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
