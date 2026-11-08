// Lifecycle (docs/spec/modules/lifecycle.md): `+run` posts tasks under one cost guard, saves each
// post response, waits on `tasks_ready`, and collects only its own task ids.
import { setTimeout as pause } from 'node:timers/promises';
import {
  type CallFlags,
  ceilingOf,
  exchange,
  isAccount,
  isOk,
  outcome,
  priceTree,
  readBody,
  reusable,
  reuseRow,
} from './call.ts';
import { type Catalog, collectPaths, type Endpoint, type Level } from './catalog.ts';
import { DfsError, messageOf } from './errors.ts';
import { isRecord } from './json.ts';
import { type Plan, plan } from './planner.ts';
import { estimate, guard, ruleFor } from './pricing.ts';
import { BUDGET, command, compact } from './render.ts';
import type { Io } from './run.ts';
import { getRow, getTask, insertTasks, openStore, type Task, updateTask } from './store.ts';

export type RunFlags = CallFlags & { wait?: string };

const POST_MAX = 100;
const WAIT = 90; // s
const FIRST_POLL = 5000; // ms; doubles up to LAST_POLL
const LAST_POLL = 30_000;
const NOT_READY = new Set([20100, 40601, 40602]); // created, handed, in progress (exit table)
const EXPIRED = 40403;

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

const tasksOf = (body: unknown): Record<string, unknown>[] =>
  (isRecord(body) && Array.isArray(body.tasks) ? body.tasks : []).filter(isRecord);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

export async function runTasks(
  catalog: Catalog,
  level: Level,
  word: string | undefined,
  flags: RunFlags,
  io: Io,
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
  const { ceiling, explicit } = ceilingOf(flags, io);
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? pause;

  let used = 0; // characters on stdout and stderr, against the budget
  const err = (line: string) => {
    used += line.length + 1;
    io.stderr.write(`${line}\n`);
  };
  const warn = (w: string) => err(`dfs: warning: ${w}`);

  const posts: { planned: Plan; reuse?: ReturnType<typeof reusable> }[] = [];
  for (let i = 0; i < all.length; i += POST_MAX) {
    const tasks = all.slice(i, i + POST_MAX);
    const planned = plan(catalog, post, {}, tasks, {
      sandbox,
      validate: !flags['no-validate'],
      first: i,
    });
    posts.push({ planned });
  }
  for (const w of new Set(posts.flatMap((p) => p.planned.warnings))) warn(w);
  for (const p of posts) p.reuse = flags.fresh ? undefined : reusable(io, p.planned, sandbox);

  // One guard over every post that is sent; the sandbox estimates 0.
  const toSend = posts.filter((p) => !p.reuse);
  const rule = sandbox ? undefined : ruleFor(post.path);
  const price =
    rule && !rule.unbounded && toSend.length > 0
      ? await priceTree(catalog, io, true, warn)
      : undefined;
  const cost = (tasks: unknown[]) => estimate(rule, tasks, price?.tree, now());
  if (!sandbox && toSend.length > 0) {
    const est = cost(toSend.flatMap((p) => p.planned.body ?? []));
    if (est.warning) warn(est.warning);
    const refusal = guard(post.path, est, ceiling, explicit);
    if (refusal) throw new DfsError(4, refusal);
  }

  const tasks = new Map<string, Task>(); // own tasks, post order
  const messages = new Map<string, string>();
  let stop: number | undefined; // exit class of a failed post; no later post is sent
  for (const p of posts) {
    let body: unknown;
    let postId: string;
    if (p.reuse) {
      err(reuseRow(catalog, post, p.reuse, io, warn));
      body = JSON.parse(p.reuse.body as string);
      postId = p.reuse.id;
    } else {
      const est = sandbox ? 0 : cost(p.planned.body ?? []).usd;
      const x = await exchange(
        catalog,
        post,
        p.planned,
        { sandbox, free: sandbox, estimate: est },
        io,
        warn,
      );
      if (!x.saved) {
        io.stdout.write(`${x.row.body ?? x.res.text}\n`);
        throw new DfsError(5, '5 response not saved — stdout is the only copy');
      }
      body = x.parsed;
      postId = x.row.id;
      err(
        `dfs: ${x.row.status_code ?? x.res.status} ${post.path} tasks=${isRecord(body) ? (body.tasks_count ?? 0) : 0} cost=$${x.row.cost ?? '?'} est=$${est ?? '?'} saved=${postId}`,
      );
      if (!isRecord(body) || body.status_code !== 20000 || x.res.status >= 300) {
        const o = outcome(x.res.status, body, postId);
        o.lines.forEach(err);
        stop = o.exit;
      }
    }
    const rows: Task[] = tasksOf(body)
      .filter((t) => typeof t.id === 'string')
      .map((t) => ({
        id: t.id as string,
        post_response: postId,
        path: post.path,
        variant: variant || null,
        state: isOk(t.status_code) ? 'pending' : 'failed',
        status_code: num(t.status_code),
        cost: num(t.cost),
        tag: isRecord(t.data) && typeof t.data.tag === 'string' ? t.data.tag : null,
        posted_at: new Date(now()).toISOString(),
        collected_at: null,
        collect_response: null,
        sandbox: sandbox ? 1 : 0,
      }));
    for (const t of tasksOf(body)) {
      if (typeof t.id === 'string' && typeof t.status_message === 'string') {
        messages.set(t.id, t.status_message);
      }
    }
    try {
      const db = openStore(io.env);
      try {
        insertTasks(db, rows);
        // A replayed post keeps the stored state of its tasks.
        for (const t of rows) tasks.set(t.id, getTask(db, t.id) ?? t);
      } finally {
        db.close();
      }
    } catch (e) {
      warn(`task rows not saved (${messageOf(e)}); dfs +collect recovers the tasks`);
      for (const t of rows) tasks.set(t.id, t);
    }
    if (stop !== undefined) break;
  }

  const pending = () => [...tasks.values()].filter((t) => t.state === 'pending');
  const free = { sandbox, free: true, estimate: 0 };
  const param = (ep: Endpoint) => /\{(\w+)\}/.exec(ep.path)?.[1] ?? 'id';

  // One collect call; the task stays pending until its result is ready (on_page: crawl finished).
  async function collect(t: Task) {
    const ep = collects.get(t.variant ?? '') ?? (collects.get(variant) as Endpoint);
    const planned = plan(catalog, ep, { [param(ep)]: t.id }, undefined, {
      sandbox,
      validate: true,
    });
    const x = await exchange(catalog, ep, planned, free, io, warn);
    if (!x.saved) return; // free: the next collect fetches it again
    const [r] = tasksOf(x.parsed);
    const code = num(r?.status_code);
    const [result] = Array.isArray(r?.result) ? r.result : [];
    const crawled =
      !ep.path.includes('/summary/') || (isRecord(result) && result.crawl_progress === 'finished');
    let state: Task['state'] = 'pending';
    if (code === null || NOT_READY.has(code)) state = 'pending';
    else if (code === EXPIRED) state = 'expired';
    else if (!isOk(code)) state = 'failed';
    else if (crawled) state = 'collected';
    if (typeof r?.status_message === 'string') messages.set(t.id, r.status_message);
    const done = state === 'collected';
    const u = {
      state,
      status_code: code ?? t.status_code,
      collected_at: done ? new Date(now()).toISOString() : null,
      collect_response: done ? x.row.id : null,
      cost: num(r?.cost),
    };
    try {
      const db = openStore(io.env);
      try {
        updateTask(db, t.id, u);
      } finally {
        db.close();
      }
    } catch (e) {
      warn(`task ${t.id} state not saved (${messageOf(e)})`);
    }
    tasks.set(t.id, { ...t, ...u, cost: u.cost ? u.cost : t.cost });
  }

  // Poll at 5, 10, 20, 30, 30 … s until every own task is done or the wait ends.
  const deadline = now() + wait * 1000;
  let interval = FIRST_POLL;
  while (stop === undefined && pending().length > 0 && now() < deadline) {
    await sleep(Math.min(interval, deadline - now()));
    interval = Math.min(interval * 2, LAST_POLL);
    const planned = plan(catalog, ready, {}, undefined, { sandbox, validate: true });
    const x = await exchange(catalog, ready, planned, free, io, warn);
    // Only this run's ids: tasks_ready lists every uncollected task in its scope.
    const ids = tasksOf(x.parsed).flatMap((t) =>
      (Array.isArray(t.result) ? t.result : []).flatMap((r) => (isRecord(r) ? [r.id] : [])),
    );
    const mine = ids.flatMap((id) => {
      const t = typeof id === 'string' ? tasks.get(id) : undefined;
      return t?.state === 'pending' ? [t] : [];
    });
    // In parallel: Transport caps the requests in flight.
    await Promise.all(mine.map(collect));
  }

  // stderr: task lines of tasks not collected, cut to the budget.
  const open = [...tasks.values()].filter((t) => t.state !== 'collected');
  const left = pending().length;
  const remedy =
    left > 0
      ? `dfs: 6 ${left} tasks pending${stop === undefined ? ` after ${wait} s` : ''} — collect them later: dfs +collect`
      : '';
  const room = BUDGET - used - remedy.length - 1;
  let shown = '';
  for (const [i, t] of open.entries()) {
    const msg = t.state !== 'failed' ? '' : ` ${messages.get(t.id) ?? ''}`.trimEnd();
    const next = `dfs: task ${t.id} ${t.state} ${t.status_code}${msg}\n`;
    const more = `dfs: task +${open.length - i - 1} more — states in the Store table task\n`;
    const reserve = i < open.length - 1 ? more.length : 0;
    if (shown.length + next.length + reserve > room) {
      shown += `dfs: task +${open.length - i} more — states in the Store table task\n`;
      break;
    }
    shown += next;
  }
  if (remedy) shown += `${remedy}\n`;
  used += shown.length;
  io.stderr.write(shown);

  // stdout: the collect responses of collected tasks, in post order, sharing the budget.
  const done = [...tasks.values()].filter((t) => t.state === 'collected');
  const db = openStore(io.env);
  try {
    let out = '';
    for (const [i, t] of done.entries()) {
      const row = t.collect_response ? getRow(db, t.collect_response) : undefined;
      if (!row?.body) continue;
      if (flags.full) {
        out += `${row.body}\n`;
        continue;
      }
      const rest = `${JSON.stringify({ dfs: 'cut', tasks: i, total: done.length, more: 'dfs store list' })}\n`;
      const part = compact(
        JSON.parse(row.body),
        row.id,
        1,
        BUDGET - used - out.length - rest.length,
      );
      const last = JSON.parse(part.trimEnd().split('\n').at(-1) || '{}');
      if (last.dfs !== 'cut') {
        out += part;
        continue;
      }
      // A task cut before its first item shows nothing of use; the Store list line names the rest.
      if (last.shown > 0) out += part;
      if (last.shown === 0 || i < done.length - 1) out += rest;
      break;
    }
    io.stdout.write(out);
  } finally {
    db.close();
  }

  // Worst class wins, 2 > 1 > 6 > 0 (exit-codes-flags.md).
  const failed = [...tasks.values()].filter((t) => t.state === 'failed' || t.state === 'expired');
  if (stop === 2 || failed.some((t) => isAccount(200, t.status_code))) return 2;
  if (stop === 1 || (tasks.size > 0 && failed.length === tasks.size)) return 1;
  return open.length > 0 ? 6 : 0;
}
