// Lifecycle (docs/spec/modules/lifecycle.md): `+run` posts tasks under one cost guard, saves each
// post response, waits on `tasks_ready`, and collects only its own task ids. `+collect` collects
// pending tasks and recovers lost ids through `id_list`.
import { setTimeout as pause } from 'node:timers/promises';
import { type Catalog, collectPaths, type Endpoint, isLive, type Level } from './catalog.ts';
import { Dispatch, type SpendFlags } from './dispatch.ts';
import { resultsOf, succeeded, tasksOf } from './envelope.ts';
import { DfsError } from './errors.ts';
import { isRecord, num } from './json.ts';
import { collected, pendingTasks, recovered, setSync, syncStart, type Task } from './ledger.ts';
import { plan, readBody } from './planner.ts';
import { command, Output, outcome, taskExit } from './render.ts';
import type { Io } from './run.ts';
import { getRow, type StoreHandle } from './store.ts';
import { type Exchange, TIMEOUT } from './transport.ts';

export type RunFlags = SpendFlags & {
  body?: string;
  full?: boolean;
  'no-validate'?: boolean;
  wait?: string;
};

const POST_MAX = 100;
const WAIT = 90; // s
const FIRST_POLL = 5000; // ms; doubles up to LAST_POLL
const LAST_POLL = 30_000;

export const runUsage = (level: Level): string => {
  const variants = [...collectPaths(level).keys()].filter(Boolean);
  const v =
    variants.length === 0
      ? ''
      : ` ${variants.length === 1 ? '[' : '<'}${variants.join('|')}${variants.length === 1 ? ']' : '>'}`;
  return `${command(level.words)} +run${v} --body <json|@file|-> [--wait <s>] [--full] [--sandbox] [--max-cost <usd>] [--fresh] [--no-validate]`;
};

// The most specific tasks_ready path for a task_post path: the longest level prefix that has one.
function readyPath(catalog: Catalog, post: string): Endpoint | undefined {
  const words = post.split('/').slice(1, -1);
  for (let k = words.length; k > 1; k--) {
    const path = `/${words.slice(0, k).join('/')}/tasks_ready`;
    const ep = catalog.endpoints.find((e) => e.path === path);
    if (ep) return ep;
  }
  return undefined;
}

function chooseVariant(level: Level, word: string | undefined): string {
  const paths = collectPaths(level);
  const variants = [...paths.keys()].filter(Boolean);
  if (word === undefined) {
    if (paths.size === 1) return [...paths.keys()][0];
    throw new DfsError(3, `${command(level.words)} +run needs a variant: ${variants.join(', ')}`);
  }
  if (word !== '' && paths.has(word)) return word;
  throw new DfsError(
    3,
    variants.length === 0
      ? `${command(level.words)} +run takes no variant; usage: ${runUsage(level)}`
      : `unknown +run variant '${word}'; want one of: ${variants.join(', ')}`,
  );
}

// The outcome of a response whose envelope failed (not a JSON object, not 20000, HTTP ≥ 300).
function envelopeFailure(x: { res: Exchange; parsed: unknown; id: string }) {
  if (succeeded(x.res.status, x.parsed)) return undefined;
  return outcome(x.res, x.parsed, x.id);
}
const outcomeText = (o: { lines: string[] }) => o.lines.join(' ').replace(/^dfs: /, '');

// Undefined when Transport gave up (exit 1: network, timeout, deadline); exit 2 and 5 still throw.
async function answered<T>(request: Promise<T>, failed: (message: string) => void) {
  try {
    return await request;
  } catch (e) {
    if (!(e instanceof DfsError) || e.exit !== 1) throw e;
    failed(e.message);
    return undefined;
  }
}

export async function runTasks(
  catalog: Catalog,
  level: Level,
  word: string | undefined,
  flags: RunFlags,
  io: Io,
  store: StoreHandle,
): Promise<number> {
  const post = level.children.get('task_post')?.endpoint;
  const collects = collectPaths(level);
  if (!post || collects.size === 0) {
    throw new DfsError(
      3,
      `${command(level.words)} has no +run: it needs task_post and a collect call`,
    );
  }
  const variant = chooseVariant(level, word);
  const ready = readyPath(catalog, post.path);
  if (!ready) throw new DfsError(3, `${command(level.words)} has no tasks_ready path`);
  const wait = Number(flags.wait ?? WAIT);
  if (flags.wait?.trim() === '' || !(wait >= 0) || !Number.isFinite(wait)) {
    throw new DfsError(3, `--wait ${flags.wait}: want a number of seconds, 0 or more`);
  }
  if (flags['dry-run']) throw new DfsError(3, '+run --dry-run: not in this build yet');
  const all = (await readBody(post, flags.body, io)) ?? [];
  if (all.length === 0) throw new DfsError(3, '--body has no tasks');
  const sandbox = flags.sandbox === true;
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? pause;

  const out = new Output(io);
  const warn = (w: string) => out.warn(w);
  const dispatch = new Dispatch(catalog, io, store, out, flags);

  // Every post is planned (validated) before anything prints or loads.
  const plans = [];
  for (let i = 0; i < all.length; i += POST_MAX) {
    const tasks = all.slice(i, i + POST_MAX);
    plans.push(
      plan(catalog, post, {}, tasks, { sandbox, validate: !flags['no-validate'], first: i }),
    );
  }
  // In parallel: all plan warnings print before the price tree and estimate warnings (one load).
  const calls = await Promise.all(plans.map((p) => dispatch.prepare(post, p)));
  // One guard over every post that is sent; a reused post is not in its sum.
  const refusal = dispatch.guard(calls);
  if (refusal) throw new DfsError(4, refusal);

  const tasks = new Map<string, Task>(); // own tasks, post order
  const messages = new Map<string, string>();
  let stop: number | undefined; // exit class of a failed post; no later post is sent
  for (const call of calls) {
    // A lost connection: no later post, no poll; the report and `dfs +collect` follow.
    const sent = await answered(dispatch.send(call, { variant, track: true }), (m) => {
      out.line(`dfs: ${m}`);
      stop = 1;
    });
    if (!sent) break;
    // Task failures go to the report; an envelope failure prints its lines and stops posting.
    if (!succeeded(sent.status, sent.parsed)) {
      for (const l of sent.lines) out.line(l);
      stop = sent.exit;
    }
    // A replayed post keeps the stored state of its tasks.
    for (const t of sent.tasks) tasks.set(t.id, t);
    for (const [id, m] of sent.messages) messages.set(id, m);
    if (stop !== undefined) break;
  }

  const pending = () => [...tasks.values()].filter((t) => t.state === 'pending');
  const missed = new Map<string, string>(); // pending tasks whose last collect failed: message

  // Poll at 5, 10, 20, 30, 30 … s until every own task is done or the last poll ran.
  const deadline = now() + wait * 1000;
  // Requests end at the deadline. The last poll starts at it, so its requests share one Transport
  // timeout from its first request; else it could never answer.
  let closing: number | undefined;
  const requestEnd = () => {
    if (now() < deadline) return deadline;
    closing ??= now() + TIMEOUT;
    return closing;
  };
  const readyFailed = (m: string, key = m) =>
    out.warn(`tasks_ready failed: ${m}`, `tasks_ready failed: ${key}`);
  // An account failure prints its lines once and stops: no further poll and no last poll.
  const accountStop = (lines: string[]) => {
    for (const l of lines) out.line(l, l);
    stop = 2;
  };
  let interval = FIRST_POLL;
  // The last poll is the poll whose tasks_ready ends at or after the deadline. It runs once.
  // When collects of an earlier poll pass the deadline, the last poll starts with no sleep.
  let last = false;
  while (wait > 0 && !last && stop === undefined && pending().length > 0) {
    const nap = Math.min(interval, deadline - now());
    if (nap > 0) await sleep(nap);
    interval = Math.min(interval * 2, LAST_POLL);
    const planned = plan(catalog, ready, {}, undefined, { sandbox, validate: true });
    const x = await answered(dispatch.fetchFree(ready, planned, sandbox, requestEnd()), (m) =>
      readyFailed(m),
    );
    const o = x && envelopeFailure(x);
    if (o?.exit === 2) {
      accountStop(o.lines);
      break;
    }
    // Other failures: polling goes on. One warning per text; the key ignores the response id.
    if (o) readyFailed(outcomeText(o), outcomeText(o).replace(x.id, ''));
    // Only this run's ids: tasks_ready lists every uncollected task in its scope.
    const ids = tasksOf(o ? undefined : x?.parsed).flatMap((t) => resultsOf(t).map((r) => r.id));
    // The last poll also asks for own ids not listed, also when its tasks_ready failed:
    // tasks_ready lists at most 1000 tasks and never a postback_url task (vendor docs).
    last = now() >= deadline;
    const mine = last
      ? pending()
      : ids.flatMap((id) => {
          const t = typeof id === 'string' ? tasks.get(id) : undefined;
          return t?.state === 'pending' ? [t] : [];
        });
    // In parallel: Transport caps the requests in flight.
    const end = requestEnd();
    await Promise.all(
      mine.map(async (t) =>
        tasks.set(
          t.id,
          await collectTask(
            catalog,
            dispatch,
            t,
            io,
            store,
            warn,
            messages,
            missed,
            accountStop,
            end,
          ),
        ),
      ),
    );
  }

  const left = pending().length;
  if (stop !== undefined) out.exit(stop);
  return report(
    [...tasks.values()],
    messages,
    missed,
    left > 0
      ? `dfs: 6 ${left} tasks pending${stop === undefined ? ` after ${wait} s` : ''} — collect them later: dfs +collect`
      : undefined,
    flags.full === true,
    out,
    store,
  );
}

// The longest level that prefixes a task_post or Live path and has a collect call (lifecycle.md,
// recovered ids). Another path, such as on_page `instant_pages`, maps to no level.
function collectLevel(catalog: Catalog, path: string): Level | undefined {
  const words = path.split('/').filter(Boolean).slice(1); // drop `v3`
  for (let k = words.length - 1; k > 0; k--) {
    if (words[k] !== 'task_post' && words[k] !== 'live') continue;
    try {
      const { node } = catalog.resolve(words.slice(0, k));
      if (collectPaths(node).size > 0) return node;
    } catch {
      // not a level: try a shorter prefix
    }
  }
  return undefined;
}

const param = (ep: Endpoint) => /\{(\w+)\}/.exec(ep.path)?.[1] ?? 'id';

// One collect call through the task's stored variant; the task stays pending until its result is
// ready (on_page: crawl finished). Returns the task with its new state, also saved. A failed
// request or envelope leaves the task unchanged: an account failure goes to `accountStop`;
// another failure marks it in `missed`. Any other answer takes the mark out.
async function collectTask(
  catalog: Catalog,
  dispatch: Dispatch,
  t: Task,
  io: Io,
  store: StoreHandle,
  warn: (w: string) => void,
  messages: Map<string, string>,
  missed: Map<string, string>,
  accountStop: (lines: string[]) => void,
  deadline?: number,
): Promise<Task> {
  const level = collectLevel(catalog, t.path);
  // No stored variant (a plain task_post call): the variant a recovered id takes.
  const variant = t.variant ?? (level && recoveredVariant(level, false)) ?? '';
  const ep = level && collectPaths(level).get(variant);
  if (!ep) {
    warn(`task ${t.id}: no collect call for ${t.path} ${t.variant ?? ''}`.trimEnd());
    return t;
  }
  const sandbox = t.sandbox === 1;
  const planned = plan(catalog, ep, { [param(ep)]: t.id }, undefined, { sandbox, validate: true });
  const x = await answered(dispatch.fetchFree(ep, planned, sandbox, deadline), (m) =>
    missed.set(t.id, m),
  );
  if (!x) return t;
  const o = envelopeFailure(x);
  missed.delete(t.id);
  if (o?.exit === 2) accountStop(o.lines);
  else if (o) missed.set(t.id, outcomeText(o));
  if (o || !x.saved) return t; // free: the next collect fetches it again
  const update = collected(store, t, {
    id: x.id,
    path: ep.path,
    body: x.parsed,
    time: (io.now ?? Date.now)(),
  });
  if (update.message !== undefined) messages.set(t.id, update.message);
  if (update.warning) warn(update.warning);
  return update.task;
}

// stderr: task lines of tasks not collected, cut to the budget, then the remedy line. stdout: the
// collect responses of collected tasks, in order, sharing the budget. Returns the exit code: the
// task exit rule, class 1 while a pending task's last collect failed, and the request classes.
function report(
  tasks: Task[],
  messages: Map<string, string>,
  missed: Map<string, string>,
  remedy: string | undefined,
  full: boolean,
  out: Output,
  store: StoreHandle,
): number {
  const open = tasks.filter((t) => t.state !== 'collected');
  const lines = open.map((t) => {
    const why = missed.get(t.id);
    if (why) return `dfs: task ${t.id} not collected: ${why}`;
    const msg = t.state !== 'failed' ? '' : ` ${messages.get(t.id) ?? ''}`.trimEnd();
    return `dfs: task ${t.id} ${t.state} ${t.status_code}${msg}`;
  });
  const more = (shown: number) =>
    `dfs: task +${open.length - shown} more — states in the Store table task`;
  out.block(lines, more, { stream: 'stderr', after: remedy });

  const done = tasks.filter((t) => t.state === 'collected');
  for (const [i, t] of done.entries()) {
    const row = t.collect_response ? getRow(store, t.collect_response) : undefined;
    if (!row?.body) continue;
    if (full) {
      out.full(row.body);
      continue;
    }
    const list = { index: i, total: done.length };
    if (out.response(JSON.parse(row.body), row.id, { list })?.cut) break;
  }
  if (missed.size > 0) out.exit(1);
  out.exit(taskExit(tasks));
  return out.close();
}

export const COLLECT_USAGE = 'dfs [<module>] +collect [--full]';

// shortcut: not in the spec, remove when the spec adds it (lifecycle.md, id_list hand path).
export const HAND_ID_LIST = '/v3/ai_optimization/id_list';
const NOT_SERVED = new Set([40400, 40402]);
const ID_PAGE = 1000; // ids per id_list call
const ID_WINDOW = 180 * 24 * 60 * 60 * 1000; // id_list reaches 6 months back
// id_list time format: "yyyy-mm-dd hh:mm:ss +00:00"
const listTime = (ms: number) =>
  `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} +00:00`;

function idListOf(catalog: Catalog, module: string): Endpoint | undefined {
  const path = `/v3/${module}/id_list`;
  const ep = catalog.endpoints.find((e) => e.path === path);
  if (ep || path !== HAND_ID_LIST) return ep;
  return { path, method: 'post', words: [module, 'id_list'], op: {} };
}

// Collect call of a recovered id: one collect path, else `advanced`, then `regular`. A Live id
// takes task_get only (31:136); on_page summary is for crawls.
function recoveredVariant(level: Level, live: boolean): string | undefined {
  const paths = collectPaths(level);
  const word =
    paths.size === 1 ? [...paths.keys()][0] : ['advanced', 'regular'].find((w) => paths.has(w));
  if (word === undefined) return undefined;
  return !live || paths.get(word)?.path.includes('/task_get/') ? word : undefined;
}

const pathOf = (url: unknown): string | undefined => {
  if (typeof url !== 'string') return undefined;
  try {
    return new URL(url).pathname;
  } catch {
    return url.startsWith('/') ? url : undefined;
  }
};

// `dfs [<module>] +collect`: one pass. Lost ids through id_list since the last pass, then a
// collect call for every pending task (lifecycle.md). Never posts.
export async function collectAll(
  catalog: Catalog,
  module: string | undefined,
  flags: { full?: boolean },
  io: Io,
  store: StoreHandle,
): Promise<number> {
  const now = (io.now ?? Date.now)();
  const out = new Output(io);
  const warn = (w: string) => out.warn(w);
  const dispatch = new Dispatch(catalog, io, store, out); // free requests only
  const messages = new Map<string, string>();
  const missed = new Map<string, string>();
  const accountStop = (lines: string[]) => {
    for (const l of lines) out.line(l, l);
    out.exit(2);
  };

  const modules = module ? [module] : [...catalog.root.children.keys()].toSorted();
  for (const m of modules) {
    const ep = idListOf(catalog, m);
    if (!ep) continue;
    const from = Math.max(
      Date.parse(syncStart(store, m) ?? new Date(now).toISOString()),
      now - ID_WINDOW,
    );
    let ok = true;
    // `from < now` only guards entry: an empty window lists nothing.
    for (let offset = 0; from < now; offset += ID_PAGE) {
      const body = [
        {
          datetime_from: listTime(from),
          datetime_to: listTime(now),
          limit: ID_PAGE,
          offset,
          sort: 'asc',
        },
      ];
      const planned = plan(catalog, ep, {}, body, { sandbox: false, validate: false });
      // A failed request: its line, exit class 1; the module keeps its sync time.
      const x = await answered(dispatch.fetchFree(ep, planned, false), (m) => {
        out.line(`dfs: ${m}`);
        out.exit(1);
      });
      if (!x) {
        ok = false;
        break;
      }
      const [t] = tasksOf(x.parsed);
      const code =
        isRecord(x.parsed) && x.parsed.status_code !== 20000
          ? x.parsed.status_code
          : t?.status_code;
      if (ep.path === HAND_ID_LIST && (x.res.status === 404 || NOT_SERVED.has(num(code) ?? 0))) {
        warn('ai_optimization id_list not served — lost ids not recoverable');
        ok = false;
        break;
      }
      const o = outcome(x.res, x.parsed, x.id);
      if (o.exit !== 0) {
        for (const l of o.lines) out.line(l);
        // A not-ready code (class 6) leaves the pass exit: epic #32 changes no exit here (D0).
        if (o.exit !== 6) out.exit(o.exit);
        ok = false;
        break;
      }
      const results = resultsOf(t);
      // A failed write keeps the module's sync time: the next pass lists these ids again.
      const warning = recovered(store, results, { id: x.id, time: now }, route);
      if (warning) {
        warn(warning);
        ok = false;
        break;
      }
      if (results.length < ID_PAGE) break;
    }
    const syncFailed = ok ? setSync(store, m, new Date(now).toISOString()) : undefined;
    if (syncFailed) warn(syncFailed);
  }

  // Collect call of a lost id, mapped from its url. None: a warning; the ledger stores it failed.
  function route(r: Record<string, unknown>) {
    const path = pathOf(r.url);
    const level = path && collectLevel(catalog, path);
    const variant = level ? recoveredVariant(level, isLive(path)) : undefined;
    if (variant === undefined)
      warn(`task ${r.id}: ${String(r.url)} maps to no collect call — not collected`);
    return { path: path ?? String(r.url), variant };
  }

  const pending = pendingTasks(store, module ? `/v3/${module}/` : '/v3/');
  // In parallel: Transport caps the requests in flight.
  const tasks = await Promise.all(
    pending.map((t) =>
      collectTask(catalog, dispatch, t, io, store, warn, messages, missed, accountStop),
    ),
  );
  const left = tasks.filter((t) => t.state === 'pending').length;
  return report(
    tasks,
    messages,
    missed,
    left > 0 ? `dfs: 6 ${left} tasks pending — collect them later: dfs +collect` : undefined,
    flags.full === true,
    out,
    store,
  );
}
