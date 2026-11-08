// pnpm fixtures:record (docs/spec/testing.md, Fixtures): sandbox responses (free), each array cut to
// a few entries, written to test/fixtures/ for commit. Mac only, like test:sandbox.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCatalog } from '../src/catalog.ts';
import { messageOf } from '../src/errors.ts';
import { isRecord } from '../src/json.ts';
import { sandboxEnv, send } from './sandbox.ts';

const KEEP = 3;
const DIR = join(import.meta.dirname, '..', 'test', 'fixtures');

// Every `items` array keeps its first KEEP entries; other arrays (`path`, `tasks`) stay whole.
export function prune(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(prune);
  if (isRecord(v)) {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k,
        prune(k === 'items' && Array.isArray(x) ? x.slice(0, KEEP) : x),
      ]),
    );
  }
  return v;
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin' || process.env.CI) {
    throw new Error('Mac only, never in CI: the DataForSEO login never goes to GitHub');
  }
  const io = { env: sandboxEnv(process.env, Date.now), fetch } as Parameters<typeof send>[1];
  const catalog = openCatalog(io.env);
  const example = (path: string) => {
    const ep = catalog.endpoints.find((e) => e.path === path && e.method === 'post');
    return JSON.stringify(ep?.op.requestBody?.content?.['application/json']?.schema?.example);
  };
  const record = async (name: string, argv: string[]) => {
    const s = await send([...argv, '--sandbox'], io);
    const [envelope] = s.envelopes;
    if (s.exit !== 0 || !isRecord(envelope)) throw new Error(`${name}: exit ${s.exit} ${s.stderr}`);
    const text = `${JSON.stringify(prune(envelope), null, 2)}\n`;
    // A fixture is committed: refuse one that echoes the login.
    if (io.env.DATAFORSEO_LOGIN && text.includes(io.env.DATAFORSEO_LOGIN)) {
      throw new Error(`${name}: response holds the login, not written`);
    }
    writeFileSync(join(DIR, `${name}.json`), text);
    process.stdout.write(`fixtures:record: test/fixtures/${name}.json\n`);
    return envelope;
  };

  await record('backlinks-anchors-live', [
    ...['backlinks', 'anchors', 'live', '--body'],
    example('/v3/backlinks/anchors/live'),
  ]);
  const post = await record('serp-google-organic-task-post', [
    ...['serp', 'google', 'organic', 'task_post', '--body'],
    example('/v3/serp/google/organic/task_post'),
  ]);
  const [task] = Array.isArray(post.tasks) ? post.tasks.filter(isRecord) : [];
  if (typeof task?.id !== 'string') throw new Error('serp-google-organic-task-post: no task id');
  await record('serp-google-organic-task-get-advanced', [
    ...['serp', 'google', 'organic', 'task_get', 'advanced'],
    task.id,
  ]);
}

if (import.meta.main) {
  await main().catch((e: unknown) => {
    process.stderr.write(`fixtures:record: ${messageOf(e)}\n`);
    process.exitCode = 1;
  });
}
