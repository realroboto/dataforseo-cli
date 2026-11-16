// Envelope (docs/spec/modules/envelope.md): reads a DataForSEO response body. Pure, no I/O.
import { isRecord } from './json.ts';

type Rec = Record<string, unknown>;

// The task records of a body.
export const tasksOf = (body: unknown): Rec[] =>
  (isRecord(body) && Array.isArray(body.tasks) ? body.tasks : []).filter(isRecord);

// The result records of a task.
export const resultsOf = (task: Rec | undefined): Rec[] =>
  (Array.isArray(task?.result) ? task.result : []).filter(isRecord);

// The first result of the first task: one-result bodies (a page, user_data, a collect).
export function firstResult(body: unknown): Rec | undefined {
  const [task] = tasksOf(body);
  const [result] = Array.isArray(task?.result) ? task.result : [];
  return isRecord(result) ? result : undefined;
}

// One Compact output unit per item: `tasks[].result[].items[]` when a result has `items`, else
// `tasks[].result[]`. `head`: the line printed before the unit (the task line, plus the result's
// other fields before its first item); a unit with no item is a head alone.
export type Unit = { head?: Rec; item?: unknown };

export function* units(body: unknown): Generator<Unit> {
  for (const t of tasksOf(body)) {
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

// The items of a body, numbered 1, 2, … as Compact output numbers them (Store index, `--from`).
export function* items(body: unknown): Generator<unknown> {
  for (const u of units(body)) if ('item' in u) yield u.item;
}

// Exit table (docs/spec/exit-codes-flags.md) code sets.
const OK_WARNING = new Set([40106, 40102, 40007]); // warnings that still exit 0
const ACCOUNT = new Set([40100, 40104, 40200, 40201, 40203, 40205, 40206, 40207, 40210]);
const NOT_READY = new Set([20100, 40601, 40602]); // 20100 on a get, 40601 handed, 40602 in queue
const EXPIRED = 40403;

export const isOk = (code: unknown): boolean =>
  typeof code === 'number' && (Math.floor(code / 10_000) === 2 || OK_WARNING.has(code));
export const isAccount = (http: number, code: unknown): boolean =>
  http === 401 || http === 402 || (typeof code === 'number' && ACCOUNT.has(code));
// `get`: 20100 is not ready on a get, task created (ok) on a post.
export const isNotReady = (code: unknown, get: boolean): boolean =>
  typeof code === 'number' && NOT_READY.has(code) && (get || code !== 20100);
export const isExpired = (code: unknown): boolean => code === EXPIRED;

// Envelope success: HTTP < 300 and envelope status_code 20000.
export const succeeded = (http: number, body: unknown): boolean =>
  http < 300 && isRecord(body) && body.status_code === 20000;
