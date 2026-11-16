// Task ledger (docs/spec/modules/ledger.md): owns the `task` and `sync` tables. Callers hand it
// responses; it decides task rows, states and costs. DDL and migrations stay in the Store.
import { firstResult, isExpired, isNotReady, isOk, tasksOf } from './envelope.ts';
import { messageOf } from './errors.ts';
import { isRecord, num } from './json.ts';
import type { StoreHandle } from './store.ts';

export type TaskState = 'pending' | 'collected' | 'failed' | 'expired';
export type Task = {
  id: string;
  post_response: string; // response id of the post
  path: string; // task_post spec path
  variant: string | null; // collect variant; null: the level has one collect path with no word
  state: TaskState;
  status_code: number | null; // last known task code
  cost: number | null;
  tag: string | null;
  posted_at: string; // ISO 8601
  collected_at: string | null;
  collect_response: string | null;
  sandbox: 0 | 1;
};

const COLUMNS: (keyof Task)[] = [
  'id',
  'post_response',
  'path',
  'variant',
  'state',
  'status_code',
  'cost',
  'tag',
  'posted_at',
  'collected_at',
  'collect_response',
  'sandbox',
];

// A failed write keeps the command going: the response row holds the data, and the task stays
// pending (or unknown) in the Store, so the next `+collect` finds it.
const notSaved = (e: unknown) =>
  `task rows not saved (${messageOf(e)}); dfs +collect recovers the tasks`;

const iso = (ms: number) => new Date(ms).toISOString();

// A task already in the Store keeps its row: a replayed post never resets a task's state.
function insert(store: StoreHandle, tasks: Task[]): void {
  const stmt = store
    .db()
    .prepare(
      `INSERT INTO task (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')}) ON CONFLICT (id) DO NOTHING`,
    );
  for (const t of tasks) stmt.run(...COLUMNS.map((c) => t[c] ?? null));
}

// The cost rule, once (store.md, `task`): a later cost replaces the stored one only when non-zero.
// Other fields change only when given. Returns the stored row; none for an unknown id.
function update(
  store: StoreHandle,
  id: string,
  u: Partial<Pick<Task, 'state' | 'status_code' | 'collected_at' | 'collect_response'>> & {
    cost: number | null;
  },
): Task | undefined {
  return store
    .db()
    .prepare(
      `UPDATE task SET state = coalesce(:state, state), status_code = coalesce(:status_code, status_code),
     collected_at = coalesce(:collected_at, collected_at),
     collect_response = coalesce(:collect_response, collect_response),
     cost = CASE WHEN :cost != 0 THEN :cost ELSE cost END WHERE id = :id RETURNING *`,
    )
    .get({
      state: null,
      status_code: null,
      collected_at: null,
      collect_response: null,
      ...u,
      id,
    }) as Task | undefined;
}

// Posted: one row per task of a paid response. A task_post task is pending, any other paid call
// is collected at once; a task whose code is not ok is failed. Returns the tasks as stored and the
// `status_message` of each task.
export function posted(
  store: StoreHandle,
  body: unknown,
  post: { id: string; path: string; variant: string | null; sandbox: boolean; time: number },
): { tasks: Task[]; messages: Map<string, string>; warning?: string } {
  const taskPost = post.path.endsWith('/task_post');
  const at = iso(post.time);
  const messages = new Map<string, string>();
  const rows: Task[] = [];
  for (const t of tasksOf(body)) {
    if (typeof t.id !== 'string') continue;
    if (typeof t.status_message === 'string') messages.set(t.id, t.status_message);
    rows.push({
      id: t.id,
      post_response: post.id,
      path: post.path,
      variant: post.variant,
      state: !isOk(t.status_code) ? 'failed' : taskPost ? 'pending' : 'collected',
      status_code: num(t.status_code),
      cost: num(t.cost),
      tag: isRecord(t.data) && typeof t.data.tag === 'string' ? t.data.tag : null,
      posted_at: at,
      collected_at: taskPost ? null : at,
      collect_response: taskPost ? null : post.id,
      sandbox: post.sandbox ? 1 : 0,
    });
  }
  try {
    insert(store, rows);
    const get = store.db().prepare('SELECT * FROM task WHERE id = ?');
    return { tasks: rows.map((t) => (get.get(t.id) as Task | undefined) ?? t), messages };
  } catch (e) {
    return { tasks: rows, messages, warning: notSaved(e) };
  }
}

// Collected: the new state of a task from its collect response. Lifecycle hands it only a saved
// response whose envelope succeeded: an envelope failure leaves the task unchanged (B5). Returns
// the stored row and the task's `status_message`; on a failed write, the new state, the old cost.
export function collected(
  store: StoreHandle,
  t: Task,
  res: { id: string; path: string; body: unknown; time: number },
): { task: Task; message?: string; warning?: string } {
  const [r] = tasksOf(res.body);
  const code = num(r?.status_code);
  const crawled =
    !res.path.includes('/summary/') || firstResult(res.body)?.crawl_progress === 'finished';
  let state: TaskState = 'pending';
  if (code === null || isNotReady(code, true)) state = 'pending';
  else if (isExpired(code)) state = 'expired';
  else if (!isOk(code)) state = 'failed';
  else if (crawled) state = 'collected';
  const done = state === 'collected';
  const u = {
    state,
    collected_at: done ? iso(res.time) : null,
    collect_response: done ? res.id : null,
  };
  const next: Task = { ...t, ...u, status_code: code ?? t.status_code };
  const message = typeof r?.status_message === 'string' ? r.status_message : undefined;
  try {
    const stored = update(store, t.id, { ...u, status_code: code, cost: num(r?.cost) });
    return { task: stored ?? next, message };
  } catch (e) {
    return { task: next, message, warning: notSaved(e) };
  }
}

// Recovered: ids from `id_list` results. A known id gets the cost rule; an unknown one a new row,
// pending, or failed when `route` maps its url to no collect call (it is not tried again).
export function recovered(
  store: StoreHandle,
  results: Record<string, unknown>[],
  list: { id: string; time: number },
  route: (r: Record<string, unknown>) => { path: string; variant: string | undefined },
): string | undefined {
  try {
    for (const r of results) {
      if (typeof r.id !== 'string' || update(store, r.id, { cost: num(r.cost) })) continue;
      const { path, variant } = route(r);
      const at = Date.parse(String(r.datetime_posted));
      insert(store, [
        {
          id: r.id,
          post_response: list.id,
          path,
          variant: variant || null,
          state: variant === undefined ? 'failed' : 'pending',
          status_code: null,
          cost: num(r.cost),
          tag: null,
          posted_at: iso(Number.isNaN(at) ? list.time : at),
          collected_at: null,
          collect_response: null,
          sandbox: 0,
        },
      ]);
    }
    return undefined;
  } catch (e) {
    return notSaved(e);
  }
}

// Pending tasks whose task_post path starts with `prefix`, oldest first.
export const pendingTasks = (store: StoreHandle, prefix: string): Task[] =>
  store
    .db()
    .prepare(`SELECT * FROM task WHERE state = 'pending' AND path LIKE ? || '%' ORDER BY rowid`)
    .all(prefix) as Task[];

// Start of the next id_list pass of a module: the last pass, else the Store's creation, which is
// the time of its first response (lifecycle.md); undefined for an empty Store.
export function syncStart(store: StoreHandle, module: string): string | undefined {
  const db = store.db();
  const row = db.prepare('SELECT last_pass FROM sync WHERE module = ?').get(module) as
    | { last_pass: string }
    | undefined;
  if (row) return row.last_pass;
  const first = db.prepare('SELECT min(time) AS t FROM response').get() as { t: string | null };
  return first.t ?? undefined;
}

// Sets the time of a module's last full pass. A failed write keeps the old time: the next pass
// lists the same ids again.
export function setSync(store: StoreHandle, module: string, at: string): string | undefined {
  try {
    store
      .db()
      .prepare('INSERT OR REPLACE INTO sync (module, last_pass) VALUES (?, ?)')
      .run(module, at);
    return undefined;
  } catch (e) {
    return notSaved(e);
  }
}
