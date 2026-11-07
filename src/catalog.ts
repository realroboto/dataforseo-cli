// Catalog: the spec as a command tree (docs/spec/modules/catalog.md). This build opens the
// committed Spec snapshot with the vendor overlay; the daily check and cache come later.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { DfsError } from './errors.ts';
import { isRecord } from './json.ts';
import { applyOverlay } from './overlay.ts';
import type { Schema, Schemas } from './schema.ts';

export const SPEC_DIR = join(import.meta.dirname, '..', 'spec');

export type Operation = {
  description?: string;
  tags?: string[];
  parameters?: { name?: string; in?: string }[];
  requestBody?: { content?: { 'application/json'?: { schema?: Schema } } };
};
export type Spec = {
  servers?: { url: string }[];
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Schemas };
};
// The vendor spec unchanged, with its commit identity (34:92).
export type Snapshot = { sha: string; date: string; spec: Spec };

export type Endpoint = {
  path: string;
  method: string; // lower case, as in the spec
  words: string[]; // command words; a path parameter shows as `<name>`
  op: Operation;
};
export type Level = {
  words: string[];
  children: Map<string, Level>;
  param?: { name: string; node: Level };
  endpoint?: Endpoint;
};
export type Resolved = { node: Level; params: Record<string, string> };

const HTTP = new Set(['get', 'post', 'put', 'delete', 'patch']);
const PARAM = /^\{(\w+)\}$/;
// Hand-written words a spec path must not take: root words, and `+collect` also as module word.
const ROOT_WORDS = new Set(['schema', 'search', 'store', '+collect']);

export const pathWords = (path: string): string[] => path.split('/').slice(2);
export const isLive = (path: string): boolean => pathWords(path).includes('live');

// The spec path with its parameters filled; a parameter with no value stays `{name}`.
export const concretePath = (ep: Endpoint, params: Record<string, string>): string =>
  ep.path.replace(/\{(\w+)\}/g, (m, name: string) =>
    Object.hasOwn(params, name) ? encodeURIComponent(params[name]) : m,
  );

// Structural check of an overlaid spec; [] when it is fit to use (Catalog, before swap).
export function checkSpec(doc: unknown, previousPaths?: number): string[] {
  if (!isRecord(doc) || !isRecord(doc.paths) || !isRecord(doc.components)) {
    return ['not an OpenAPI document with paths and components'];
  }
  if (!isRecord(doc.components.schemas)) return ['no components.schemas'];
  const problems: string[] = [];
  const commands = new Map<string, string>();
  const slots = new Map<string, string>();
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!/^\/v3(\/[^/]+)+$/.test(path)) {
      problems.push(`${path}: not a /v3/ path`);
      continue;
    }
    const methods = isRecord(item) ? Object.keys(item).filter((m) => HTTP.has(m)) : [];
    if (methods.length !== 1) problems.push(`${path}: ${methods.length} methods, want 1`);
    for (const m of methods) {
      const op = isRecord(item) ? item[m] : undefined;
      const params = isRecord(op) && Array.isArray(op.parameters) ? op.parameters : [];
      if (params.some((p) => !isRecord(p) || p.in !== 'path')) {
        problems.push(`${path}: a parameter not in the path`);
      }
      const body = isRecord(op) ? op.requestBody : undefined;
      const schema =
        isRecord(body) && isRecord(body.content) ? body.content['application/json'] : undefined;
      if (
        m === 'post' &&
        !(
          isRecord(schema) &&
          isRecord(schema.schema) &&
          schema.schema.type === 'array' &&
          isRecord(schema.schema.items)
        )
      ) {
        problems.push(`${path}: POST body is not an array of tasks`);
      }
    }
    const words = pathWords(path);
    const key = words.map((w) => (PARAM.test(w) ? '{}' : w)).join(' ');
    const other = commands.get(key);
    if (other) problems.push(`${path}: same command words as ${other}`);
    commands.set(key, path);
    words.forEach((w, i) => {
      const name = PARAM.exec(w)?.[1];
      if (!name) return;
      const prefix = words.slice(0, i).join(' ');
      const old = slots.get(prefix);
      if (old && old !== name) problems.push(`${path}: {${name}} and {${old}} share one slot`);
      slots.set(prefix, name);
    });
    if (ROOT_WORDS.has(words[0]) || words[1] === '+collect' || words.includes('+run')) {
      problems.push(`${path}: a command word clashes with a dfs command`);
    }
  }
  const n = Object.keys(doc.paths).length;
  if (previousPaths !== undefined && n < previousPaths * 0.9) {
    problems.push(`path count fell from ${previousPaths} to ${n}, more than 10 %`);
  }
  return problems;
}

const level = (words: string[]): Level => ({ words, children: new Map() });

function buildTree(spec: Spec): { root: Level; endpoints: Endpoint[] } {
  const root = level([]);
  const endpoints: Endpoint[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP.has(method)) continue;
      let node = root;
      for (const w of pathWords(path)) {
        const name = PARAM.exec(w)?.[1];
        if (name) {
          node.param ??= { name, node: level([...node.words, `<${name}>`]) };
          node = node.param.node;
        } else {
          const next = node.children.get(w) ?? level([...node.words, w]);
          node.children.set(w, next);
          node = next;
        }
      }
      node.endpoint = { path, method, words: node.words, op };
      endpoints.push(node.endpoint);
    }
  }
  return { root, endpoints };
}

export function readSnapshot(): Snapshot {
  return JSON.parse(readFileSync(join(SPEC_DIR, 'snapshot.json'), 'utf8'));
}

export const readOverlay = (): unknown =>
  parse(readFileSync(join(SPEC_DIR, 'overlay.yaml'), 'utf8'));

export function openCatalog() {
  const { sha, date, spec } = readSnapshot();
  applyOverlay(spec, readOverlay());
  const { root, endpoints } = buildTree(spec);

  // Words resolve to the longest spec path they match; a path-parameter slot takes the next
  // word only when that word is not a child word of the node.
  function resolve(words: string[]): Resolved {
    let node = root;
    const params: Record<string, string> = {};
    for (const w of words) {
      const next = node.children.get(w);
      if (next) node = next;
      else if (node.param) {
        params[node.param.name] = w;
        node = node.param.node;
      } else {
        const at = node.words.length > 0 ? `dfs ${node.words.join(' ')}` : 'dfs';
        throw new DfsError(3, `unknown command word '${w}' after '${at}'; see: ${at} --help`);
      }
    }
    return { node, params };
  }

  return { sha, date, spec, root, endpoints, resolve };
}

export type Catalog = ReturnType<typeof openCatalog>;
