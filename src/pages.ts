// --page-all (pricing.md, render.md): one task, sent page by page. `offset` pages up to 10,000,
// then the endpoint's token from each response (help-center: offset vs offset_token). All pages
// share one cost ceiling and one Compact output budget. Each page runs through Dispatch; the stop
// rules stay here (epic #32 D6).
import type { Catalog, Endpoint } from './catalog.ts';
import { Dispatch, type SpendFlags } from './dispatch.ts';
import { firstResult } from './envelope.ts';
import { DfsError } from './errors.ts';
import { isRecord } from './json.ts';
import { paging, plan } from './planner.ts';
import { readNumber } from './pricing.ts';
import { command, Output } from './render.ts';
import type { Io } from './run.ts';
import type { StoreHandle } from './store.ts';

const OFFSET_MAX = 10_000; // vendor: offset only up to 10,000 results
export type Paging = { task: Record<string, unknown>; token?: string };
export type PageFlags = SpendFlags & { body?: string; full?: boolean; 'no-validate'?: boolean };

export function pagingOf(catalog: Catalog, ep: Endpoint, tasks: unknown[] | undefined): Paging {
  const p = paging(ep, catalog.spec.components.schemas);
  if (!p) throw new DfsError(3, `--page-all: ${ep.path} has no offset field, so it has one page`);
  if (tasks?.length !== 1 || !isRecord(tasks[0])) {
    throw new DfsError(3, '--page-all takes one task: a JSON object, or an array of one');
  }
  return { task: tasks[0], token: p.token };
}

const usd = (n: number) => Math.round(n * 1e6) / 1e6;
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const LONG_BODY = 1000; // characters of --body the rerun line repeats

export async function pageAll(
  catalog: Catalog,
  ep: Endpoint,
  params: Record<string, string>,
  { task, token: tokenField }: Paging,
  flags: PageFlags,
  io: Io,
  store: StoreHandle,
): Promise<number> {
  const out = new Output(io, 'page-all');
  const dispatch = new Dispatch(catalog, io, store, out, flags); // an invalid ceiling exits 3
  const { ceiling } = dispatch;
  // Rerun of a stop: same task and flags, a higher ceiling; pages already saved reuse at $0.
  // A long body would crowd out the output budget: the rerun then names it only.
  const arg = flags.body?.startsWith('@') ? flags.body : JSON.stringify(task);
  const body = arg.length > LONG_BODY ? '<the same --body>' : quote(arg);
  const rerun = (need: number) =>
    [
      command(ep.words),
      `--body ${body} --page-all`,
      flags.full && '--full',
      flags['no-validate'] && '--no-validate',
      `--max-cost ${need}`,
    ]
      .filter(Boolean)
      .join(' ');
  const stopLine = (page: number, spent: number, est: number | null, need: number) =>
    `dfs: --page-all stopped before page ${page}: cost so far $${spent} + page estimate $${est ?? '?'} above ceiling $${ceiling}; pages 1-${page - 1} saved — rerun: ${rerun(need)}`;
  // The longest stop line keeps its room, so the whole output stays within the budget.
  const big = 99_999.999999;
  out.reserve(stopLine(99_999, big, big, big));

  const planOf = (t: Record<string, unknown>) =>
    plan(catalog, ep, params, [t], {
      sandbox: flags.sandbox === true,
      validate: !flags['no-validate'],
    });
  // Page 1 validates before the price tree loads: an invalid body exits 3 with nothing sent. The
  // tree loads next, also when page 1 is reused (as before epic #32).
  let planned = planOf(task);
  await dispatch.price(ep);
  let next: Record<string, unknown> = task;
  let tokenMode = tokenField !== undefined && task[tokenField] !== undefined;
  let fetched = 0;
  let spent = 0;
  for (let page = 1; ; page++) {
    if (page > 1) planned = planOf(next);
    const call = await dispatch.prepare(ep, planned);
    const est = call.est?.usd;
    // An unknown price sent under an explicit --max-cost: the real cost so far still stops.
    const unknownOver = est === null && page > 1 && spent >= ceiling;
    const refusal = dispatch.guard([call], spent) ?? (unknownOver ? 'over' : undefined);
    if (refusal && page === 1) throw new DfsError(4, refusal);
    if (refusal) {
      const need = usd(spent + (est ?? ceiling));
      return out.close(stopLine(page, usd(spent), est ?? null, need), 4);
    }
    const r = await dispatch.send(call);
    for (const l of r.lines) out.line(l);
    out.exit(r.exit);
    spent += r.cost ?? est ?? 0;
    if (flags.full) out.full(r.full.replace(/[\r\n]/g, ''));
    else if (r.parsed !== undefined) out.response(r.parsed, r.id);
    if (r.exit !== 0) return out.close();

    // Next page: offset while it stays under 10,000, then the token of this response.
    const result = firstResult(r.parsed);
    const items = Array.isArray(result?.items) ? result.items.length : 0;
    fetched += items;
    const start = readNumber(task.offset) ?? 0;
    const limit = readNumber(task.limit);
    const done =
      items === 0 ||
      (limit !== undefined && items < limit) ||
      (typeof result?.total_count === 'number' && start + fetched >= result.total_count);
    if (done) return out.close();
    if (!tokenMode && start + fetched < OFFSET_MAX) {
      next = { ...task, offset: start + fetched };
      continue;
    }
    const token = tokenField && result?.[tokenField];
    if (typeof token !== 'string' || token === '' || token === next[tokenField ?? '']) {
      out.warn(
        tokenField
          ? `no ${tokenField} in the response of page ${page}: later pages not fetched`
          : `offset reached ${OFFSET_MAX}; ${ep.path} has no token field: later pages not fetched`,
      );
      return out.close();
    }
    // Token pages keep every other field of the first request (vendor rule).
    next = { ...task, [tokenField as string]: token };
    tokenMode = true;
  }
}
