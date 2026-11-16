// The plain call: one endpoint call through Dispatch (body, guard, send, save before print,
// Compact output, exit code), or its --dry-run plan. `--page-all` runs in src/pages.ts.
import type { Catalog, Endpoint } from './catalog.ts';
import { Dispatch } from './dispatch.ts';
import { DfsError } from './errors.ts';
import { type PageFlags, pageAll, pagingOf } from './pages.ts';
import { plan, readBody } from './planner.ts';
import { Output } from './render.ts';
import type { Io } from './run.ts';
import type { StoreHandle } from './store.ts';

export type CallFlags = PageFlags & {
  'page-all'?: boolean; // follow offset, then the token, over all pages (src/pages.ts)
};

export async function call(
  catalog: Catalog,
  ep: Endpoint,
  params: Record<string, string>,
  flags: CallFlags,
  io: Io,
  store: StoreHandle,
): Promise<number> {
  const tasks = await readBody(ep, flags.body, io);
  // --dry-run plans the first page only.
  if (flags['page-all']) {
    const paging = pagingOf(catalog, ep, tasks);
    if (!flags['dry-run']) return pageAll(catalog, ep, params, paging, flags, io, store);
  }
  // Warnings before the send print at once, so a failed send still shows them.
  const out = new Output(io);
  const dispatch = new Dispatch(catalog, io, store, out, flags);
  const sandbox = flags.sandbox === true;
  const planned = plan(catalog, ep, params, tasks, { sandbox, validate: !flags['no-validate'] });
  const prepared = await dispatch.prepare(ep, planned);
  const refusal = dispatch.guard([prepared]);
  if (flags['dry-run']) {
    // A dry run estimates the call also when a stored response is reusable (user story 42).
    const { est, priceAt, reuse } = prepared;
    const dry = {
      method: planned.method,
      url: planned.url,
      body: planned.body ?? null,
      tasks: planned.body?.length ?? 0,
      estimate: { usd: est?.usd ?? null, basis: est?.basis, price_at: priceAt ?? null },
      ceiling: dispatch.ceiling,
      guard: refusal ? 'refuse' : 'send',
      reuse: reuse?.id ?? null,
      spec: catalog.sha,
    };
    out.full(JSON.stringify(dry));
    return out.close();
  }
  if (refusal) throw new DfsError(4, refusal);

  const r = await dispatch.send(prepared);
  for (const l of r.lines) out.line(l);
  out.exit(r.exit);
  if (r.parsed !== undefined) {
    if (flags.full) out.full(r.full);
    else out.response(r.parsed, r.id);
  }
  return out.close();
}
