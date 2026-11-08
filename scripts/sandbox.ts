// pnpm test:sandbox (seam 3, docs/spec/testing.md): every request example through `dfs --sandbox`
// unmodified on the overlaid snapshot, Standard tasks collected, plus the id_list hand path.
// Fails on a new 40404 or any other error; writes the 40404 file. Mac only: the DataForSEO login
// never goes to GitHub.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { exchange } from '../src/call.ts';
import { collectPaths, type Endpoint, openCatalog, readSnapshot } from '../src/catalog.ts';
import { DfsError, messageOf } from '../src/errors.ts';
import { isRecord } from '../src/json.ts';
import { HAND_ID_LIST } from '../src/lifecycle.ts';
import { plan } from '../src/planner.ts';
import { type Io, run } from '../src/run.ts';

export const COVERAGE_FILE = 'spec/sandbox-40404.json';
export type Coverage = { sha: string; date: string; paths: string[] };
type Fetch = Io['fetch'];
type Sent = { exit: number; envelopes: unknown[]; stderr: string };

const NO_DATA = 40404;
const POOL = 4;

// A fresh config dir whose daily spec check counts as done: the run tests the snapshot it ships.
export function sandboxEnv(env: NodeJS.ProcessEnv, now: () => number): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'dfs-sandbox-'));
  writeFileSync(join(dir, 'spec-check.json'), JSON.stringify({ checked: now() }));
  return { ...env, DFS_CONFIG_DIR: dir };
}

// One `dfs` command in-process; keeps every response envelope it receives.
export async function send(argv: string[], io: Io): Promise<Sent> {
  const envelopes: unknown[] = [];
  let stderr = '';
  const fetch: Fetch = async (url, init) => {
    const res = await io.fetch(url, init);
    envelopes.push(
      await res
        .clone()
        .json()
        .catch(() => undefined),
    );
    return res;
  };
  const exit = await run(argv, {
    ...io,
    fetch,
    stdin: Readable.from([]),
    stdout: { write: () => true },
    stderr: { write: (s: string) => (stderr += s) },
  });
  return { exit, envelopes, stderr };
}

// Error codes of the envelopes: the envelope's own, or each task's under a 20000 envelope.
function errorCodes(envelopes: unknown[]): number[] {
  return envelopes.flatMap((e) => {
    if (!isRecord(e)) return [];
    if (e.status_code !== 20000) return typeof e.status_code === 'number' ? [e.status_code] : [];
    const tasks = Array.isArray(e.tasks) ? e.tasks.filter(isRecord) : [];
    return tasks
      .map((t) => t.status_code)
      .filter((c): c is number => typeof c === 'number' && c >= 40000);
  });
}

// First stderr line after the `dfs: 2xxxx <path> …` status lines: the reason.
const reason = (s: string) => s.split('\n').find((l) => !l.startsWith('dfs: 2')) ?? '';
const INVALID = new Set([40501, 40506]); // invalid field or value: fails even at exit 0

export async function sandboxRun(
  io: Pick<Io, 'env' | 'fetch' | 'now' | 'sleep'>,
  only: (path: string) => boolean = () => true,
): Promise<{ uncovered: string[]; failures: string[] }> {
  const now = io.now ?? Date.now;
  const base: Io = { ...io, env: sandboxEnv(io.env, now) } as Io;
  const catalog = openCatalog(base.env);
  const uncovered = new Set<string>();
  const failures: string[] = [];

  const judge = (path: string, s: Sent) => {
    const codes = errorCodes(s.envelopes);
    if (s.exit === 0 && !codes.some((c) => INVALID.has(c))) return;
    if (codes.length > 0 && codes.every((c) => c === NO_DATA)) uncovered.add(path);
    else failures.push(`${path}: exit ${s.exit} [${codes.join(', ')}] ${reason(s.stderr)}`);
  };

  // A task_post example also collects each returned id through every collect call of its level.
  async function example(ep: Endpoint, body: unknown) {
    const s = await send([...ep.words, '--sandbox', '--body', JSON.stringify(body)], base);
    judge(ep.path, s);
    if (s.exit !== 0 || !ep.path.endsWith('/task_post')) return;
    const level = catalog.resolve(ep.words.slice(0, -1)).node;
    const ids = s.envelopes.flatMap((e) =>
      isRecord(e) && Array.isArray(e.tasks)
        ? e.tasks.filter(isRecord).flatMap((t) => (typeof t.id === 'string' ? [t.id] : []))
        : [],
    );
    for (const c of collectPaths(level).values()) {
      for (const id of ids) {
        const words = c.words.map((w) => (w.startsWith('<') ? id : w));
        judge(c.path, await send([...words, '--sandbox'], base));
      }
    }
  }

  const jobs: (() => Promise<void>)[] = [];
  for (const ep of catalog.endpoints) {
    const ex = ep.op.requestBody?.content?.['application/json']?.schema?.example;
    if (ep.method === 'post' && ex !== undefined && only(ep.path)) jobs.push(() => example(ep, ex));
  }
  if (only(HAND_ID_LIST)) jobs.push(() => handIdList());

  // The hand path is no dfs command: same plan and exchange as +collect, to the sandbox.
  async function handIdList() {
    const ex = catalog.endpoints.find((e) => e.path === '/v3/serp/id_list')?.op.requestBody
      ?.content?.['application/json']?.schema?.example;
    const ep: Endpoint = {
      path: HAND_ID_LIST,
      method: 'post',
      words: ['ai_optimization', 'id_list'],
      op: {},
    };
    try {
      if (!Array.isArray(ex)) throw new DfsError(3, 'spec has no /v3/serp/id_list example');
      const planned = plan(catalog, ep, {}, ex, {
        sandbox: true,
        validate: false,
      });
      const x = await exchange(
        catalog,
        ep,
        planned,
        { sandbox: true, free: true, estimate: 0 },
        base,
        () => {},
      );
      const exit = x.res.status < 300 && errorCodes([x.parsed]).length === 0 ? 0 : 1;
      judge(HAND_ID_LIST, { exit, envelopes: [x.parsed], stderr: `HTTP ${x.res.status}` });
    } catch (e) {
      if (!(e instanceof DfsError)) throw e;
      failures.push(`${HAND_ID_LIST}: exit ${e.exit} ${e.message}`);
    }
  }

  let next = 0;
  const worker = async () => {
    while (next < jobs.length) await jobs[next++]();
  };
  await Promise.all(Array.from({ length: POOL }, worker));
  return { uncovered: [...uncovered].sort(), failures: failures.sort() };
}

// New 40404 paths fail the run; no committed file yet means a first run, with nothing new.
export function newUncovered(uncovered: string[], committed: Coverage | undefined): string[] {
  if (!committed) return [];
  const known = new Set(committed.paths);
  return uncovered.filter((p) => !known.has(p));
}

// The baseline is the committed file (HEAD), not the working copy a failed run rewrote.
function committedCoverage(root: string): Coverage | undefined {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  const at = `HEAD:${COVERAGE_FILE}`;
  try {
    git('cat-file', '-e', at);
  } catch {
    return undefined; // not committed yet: first run
  }
  return JSON.parse(git('show', at));
}

async function main(): Promise<number> {
  if (process.platform !== 'darwin' || process.env.CI) {
    throw new Error('Mac only, never in CI: the DataForSEO login never goes to GitHub');
  }
  const root = join(import.meta.dirname, '..');
  const { uncovered, failures } = await sandboxRun({ env: process.env, fetch });
  const { sha, date } = readSnapshot();
  const coverage: Coverage = { sha, date, paths: uncovered };
  writeFileSync(join(root, COVERAGE_FILE), `${JSON.stringify(coverage, null, 2)}\n`);
  const fresh = newUncovered(uncovered, committedCoverage(root));
  for (const p of fresh) failures.push(`${p}: new 40404 (not in committed ${COVERAGE_FILE})`);
  for (const f of failures) process.stderr.write(`test:sandbox: ${f}\n`);
  process.stdout.write(
    `test:sandbox: ${failures.length === 0 ? 'ok' : `${failures.length} failures`}, ${uncovered.length} paths 40404 (spec ${sha.slice(0, 7)}, ${date.slice(0, 10)})\n`,
  );
  return failures.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main().catch((e: unknown) => {
    process.stderr.write(`test:sandbox: ${messageOf(e)}\n`);
    return 1;
  });
}
