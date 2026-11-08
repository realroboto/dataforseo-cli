// Catalog: the spec as a command tree (docs/spec/modules/catalog.md). Opens the newest spec,
// cache or committed Spec snapshot, with the vendor overlay; the daily check swaps the cache.
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import pkg from '../package.json' with { type: 'json' };
import { DfsError, messageOf } from './errors.ts';
import { isRecord } from './json.ts';
import { applyOverlay } from './overlay.ts';
import type { Schema, Schemas } from './schema.ts';
import { configDir, privateDir } from './store.ts';

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

const REPO = 'dataforseo/OpenApiDocumentation';
const FILE = 'openapi_specification.yaml';
export const COMMITS_URL = `https://api.github.com/repos/${REPO}/commits?path=${FILE}&sha=master&per_page=1`;
// By SHA, not master: no race between the two reads.
export const rawUrl = (sha: string): string =>
  `https://raw.githubusercontent.com/${REPO}/${sha}/${FILE}`;

// SHA and committer date of the newest spec commit, from a commits API answer.
export function newestCommit(commits: unknown): { sha: string; date: string } {
  const last = Array.isArray(commits) ? commits[0] : undefined;
  const commit = isRecord(last) && isRecord(last.commit) ? last.commit.committer : undefined;
  const sha = isRecord(last) ? last.sha : undefined;
  const date = isRecord(commit) ? commit.date : undefined;
  if (typeof sha !== 'string' || typeof date !== 'string') {
    throw new Error(`GitHub commits API: no commit for ${FILE}`);
  }
  return { sha, date };
}

const cacheFile = (env: NodeJS.ProcessEnv): string => join(configDir(env), 'spec.json');
const stateFile = (env: NodeJS.ProcessEnv): string => join(configDir(env), 'spec-check.json');

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx', flush: true });
  renameSync(tmp, file);
}

// The newest spec dfs has: the cache when its commit date is newer than the snapshot's.
// No env (tests of the snapshot itself): the snapshot. A cache that does not read is absent.
export function readNewest(env?: NodeJS.ProcessEnv): Snapshot {
  const snapshot = readSnapshot();
  const c = env && readJson(cacheFile(env));
  const ok =
    isRecord(c) &&
    typeof c.sha === 'string' &&
    typeof c.date === 'string' &&
    isRecord(c.spec) &&
    isRecord(c.spec.paths);
  return ok && Date.parse(c.date as string) > Date.parse(snapshot.date)
    ? (c as Snapshot)
    : snapshot;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
type CheckState = { checked: number; etag?: string; failed?: boolean };
type CheckIo = {
  env: NodeJS.ProcessEnv;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  stderr: { write(chunk: string): unknown };
  now?: () => number;
};

async function get(io: CheckIo, url: string, headers: Record<string, string>) {
  const res = await io.fetch(url, { headers: { 'user-agent': `dfs/${pkg.version}`, ...headers } });
  if (!res.ok && res.status !== 304) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

// Daily spec check: at most once per 24 h, the commits API (ETag) gives the newest SHA; a new
// SHA is fetched raw at that SHA, checked on the overlaid copy and swapped in as the cache.
// A failure keeps the spec in use, warns once and is retried after 1 h.
export async function dailyCheck(io: CheckIo): Promise<void> {
  const now = (io.now ?? Date.now)();
  const raw = readJson(stateFile(io.env));
  const state: CheckState | undefined =
    isRecord(raw) && typeof raw.checked === 'number' ? (raw as CheckState) : undefined;
  const age = state ? now - state.checked : -1; // a future time (clock skew) counts as due
  if (state && age >= 0 && age < (state.failed ? HOUR_MS : DAY_MS)) return;
  const current = readNewest(io.env);
  let next: CheckState;
  try {
    const res = await get(io, COMMITS_URL, {
      accept: 'application/vnd.github+json',
      ...(state?.etag ? { 'if-none-match': state.etag } : {}),
    });
    const etag = res.headers.get('etag') ?? undefined;
    if (res.status !== 304) {
      const { sha, date } = newestCommit(await res.json());
      if (sha !== current.sha) {
        const spec: unknown = parse(await (await get(io, rawUrl(sha), {})).text());
        const overlaid = structuredClone(spec);
        applyOverlay(overlaid, readOverlay());
        const problems = checkSpec(overlaid, Object.keys(current.spec.paths).length);
        if (problems.length > 0) {
          const more = problems.length > 1 ? ` (+${problems.length - 1} more)` : '';
          throw new Error(
            `spec ${sha.slice(0, 7)} fails the structural check: ${problems[0]}${more}`,
          );
        }
        privateDir(configDir(io.env));
        writeAtomic(cacheFile(io.env), JSON.stringify({ sha, date, spec }));
      }
    }
    next = { checked: now, etag: etag ?? state?.etag };
  } catch (e) {
    io.stderr.write(
      `dfs: warning: spec check failed, keeping spec ${current.sha.slice(0, 7)}: ${messageOf(e).split('\n')[0]}; next try in 1 h\n`,
    );
    // The old ETag stays: a 304 must not hide a SHA that failed to load.
    next = { checked: now, etag: state?.etag, failed: true };
  }
  try {
    privateDir(configDir(io.env));
    writeAtomic(stateFile(io.env), JSON.stringify(next));
  } catch (e) {
    io.stderr.write(`dfs: warning: cannot save the spec check time: ${messageOf(e)}\n`);
  }
}

export function openCatalog(env?: NodeJS.ProcessEnv) {
  const { sha, date, spec } = readNewest(env);
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

// Collect calls of a level by variant word; '' for a path with no variant word (lifecycle.md:
// `task_get/<variant>/{id}`, bare `task_get/{id}`, or on_page `summary/{id}` when no task_get).
export function collectPaths(level: Level): Map<string, Endpoint> {
  const out = new Map<string, Endpoint>();
  const get = level.children.get('task_get');
  const bare = get?.param?.node.endpoint;
  if (bare) out.set('', bare);
  for (const [w, n] of get?.children ?? []) {
    const ep = n.param?.node.endpoint;
    if (ep) out.set(w, ep);
  }
  const summary = level.children.get('summary')?.param?.node.endpoint;
  if (!get && summary) out.set('', summary);
  return out;
}

// A level has `+run` when it has task_post and a collect call.
export const hasRun = (level: Level): boolean =>
  level.children.get('task_post')?.endpoint !== undefined && collectPaths(level).size > 0;
