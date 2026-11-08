// --page-all (pricing.md, render.md): one task, sent page by page. `offset` pages up to 10,000,
// then the endpoint's token from each response (help-center: offset vs offset_token). All pages
// share one cost ceiling and one Compact output budget.
import { type CallFlags, ceilingOf, priceTree, reusable, reuseRow, sendPlanned } from './call.ts';
import type { Catalog, Endpoint } from './catalog.ts';
import { DfsError } from './errors.ts';
import { isRecord } from './json.ts';
import { paging, plan } from './planner.ts';
import { type Estimate, estimate, guard, isFree, ruleFor } from './pricing.ts';
import { BUDGET, command, compact } from './render.ts';
import type { Io } from './run.ts';

const OFFSET_MAX = 10_000; // vendor: offset only up to 10,000 results
export type Paging = { task: Record<string, unknown>; token?: string };

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
const CUT_MAX = 100; // longest cut line: 5-digit counts, `r_` + 10 hex

export async function pageAll(
  catalog: Catalog,
  ep: Endpoint,
  params: Record<string, string>,
  { task, token: tokenField }: Paging,
  flags: CallFlags,
  io: Io,
): Promise<number> {
  const sandbox = flags.sandbox === true;
  const { ceiling, explicit } = ceilingOf(flags, io);
  const free = sandbox || isFree(ep.path);
  const rule = free ? undefined : ruleFor(ep.path);
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
    `dfs: --page-all stopped before page ${page}: cost so far $${spent} + page estimate $${est ?? '?'} above ceiling $${ceiling}; pages 1-${page - 1} saved — rerun: ${rerun(need)}\n`;
  const moreLine = (n: number) => `dfs: +${n} more lines — all pages: dfs store list\n`;
  // Room kept for the closing lines, so the whole output stays within the budget.
  const big = 99_999.999999;
  const tail = stopLine(99_999, big, big, big).length + moreLine(99_999).length;

  let used = 0;
  let hidden = 0;
  const said = new Set<string>();
  const say = (line: string) => {
    const text = `${line}\n`;
    if (used + text.length + tail + CUT_MAX <= BUDGET) {
      io.stderr.write(text);
      used += text.length;
    } else hidden++;
  };
  const warn = (w: string) => {
    if (!said.has(w)) say(`dfs: warning: ${w}`);
    said.add(w);
  };
  const close = (exit: number, line = '') => {
    io.stderr.write((hidden > 0 ? moreLine(hidden) : '') + line);
    return exit;
  };

  const price = rule && !rule.unbounded ? await priceTree(catalog, io, true, warn) : undefined;
  let next: Record<string, unknown> = task;
  let tokenMode = tokenField !== undefined && task[tokenField] !== undefined;
  let fetched = 0;
  let spent = 0;
  let cut = false;
  for (let page = 1; ; page++) {
    const planned = plan(catalog, ep, params, [next], {
      sandbox,
      validate: !flags['no-validate'],
    });
    planned.warnings.forEach(warn);
    const src = flags.fresh || isFree(ep.path) ? undefined : reusable(io, planned, sandbox);
    let r: { parsed: unknown; id: string; full: string; cost: number | null; exit: number };
    if (src) {
      say(reuseRow(catalog, ep, src, io, warn));
      const full = src.body as string;
      r = { parsed: JSON.parse(full), id: src.id, full, cost: 0, exit: 0 };
    } else {
      const est: Estimate = free
        ? { usd: 0, basis: 'rule' }
        : estimate(rule, planned.body ?? [], price?.tree, (io.now ?? Date.now)());
      if (est.warning) warn(est.warning);
      const total = est.usd === null ? est : { ...est, usd: usd(spent + est.usd) };
      // An unknown price sent under an explicit --max-cost: the real cost so far still stops.
      const unknownOver = est.usd === null && page > 1 && spent >= ceiling;
      const refusal = free
        ? undefined
        : (guard(ep.path, total, ceiling, explicit) ?? (unknownOver ? 'over' : undefined));
      if (refusal && page === 1) throw new DfsError(4, refusal);
      if (refusal) {
        return close(4, stopLine(page, usd(spent), est.usd, total.usd ?? usd(spent + ceiling)));
      }
      const sent = await sendPlanned(catalog, ep, planned, est, { sandbox, free }, io);
      sent.lines.forEach(say);
      r = { ...sent, cost: sent.cost ?? est.usd };
    }
    spent += r.cost ?? 0;
    if (flags.full) io.stdout.write(`${r.full.replace(/[\r\n]/g, '')}\n`);
    else if (!cut && r.parsed !== undefined) {
      // compact keeps its cut line inside `room`, except when not even one line fits: CUT_MAX.
      const text = compact(r.parsed, r.id, 1, BUDGET - used - tail - CUT_MAX);
      io.stdout.write(text);
      used += text.length;
      cut = text.split('\n').at(-2)?.startsWith('{"dfs":"cut"') ?? false;
    }
    if (r.exit !== 0) return close(r.exit);

    // Next page: offset while it stays under 10,000, then the token of this response.
    const [t] = isRecord(r.parsed) && Array.isArray(r.parsed.tasks) ? r.parsed.tasks : [];
    const [result] = isRecord(t) && Array.isArray(t.result) ? t.result : [];
    const items = isRecord(result) && Array.isArray(result.items) ? result.items.length : 0;
    fetched += items;
    const start = Number(task.offset ?? 0);
    const done =
      items === 0 ||
      (typeof task.limit === 'number' && items < task.limit) ||
      (isRecord(result) &&
        typeof result.total_count === 'number' &&
        start + fetched >= result.total_count);
    if (done) return close(0);
    if (!tokenMode && start + fetched < OFFSET_MAX) {
      next = { ...task, offset: start + fetched };
      continue;
    }
    const token = tokenField && isRecord(result) ? result[tokenField] : undefined;
    if (typeof token !== 'string' || token === '' || token === next[tokenField ?? '']) {
      warn(
        tokenField
          ? `no ${tokenField} in the response of page ${page}: later pages not fetched`
          : `offset reached ${OFFSET_MAX}; ${ep.path} has no token field: later pages not fetched`,
      );
      return close(0);
    }
    // Token pages keep every other field of the first request (vendor rule).
    next = { ...task, [tokenField as string]: token };
    tokenMode = true;
  }
}
