// Process io is injected so tests drive the whole CLI in-process (seam 1, docs/spec/testing.md).
import { type ParseArgsConfig, parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { call } from './call.ts';
import { dailyCheck, openCatalog, readNewest } from './catalog.ts';
import { DfsError, messageOf } from './errors.ts';
import { COLLECT_USAGE, collectAll, runTasks, runUsage } from './lifecycle.ts';
import {
  nodeHelp,
  rootHelp,
  SCHEMA_USAGE,
  SEARCH_USAGE,
  schemaText,
  searchText,
} from './render.ts';
import { search } from './search.ts';
import { StoreHandle } from './store.ts';
import { STORE_USAGE, store } from './store-cli.ts';

export type Io = {
  env: NodeJS.ProcessEnv; // DFS_CONFIG_DIR, DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  stdin: NodeJS.ReadableStream;
  sleep?: (ms: number) => Promise<void>; // retry backoff and rate-limit wait; tests skip the wait
  now?: () => number; // clock of the reuse, spec and price windows; tests set it
};

// Routing runs first, so help and argv faults never open the Store; the command gets the handle.
type Command = (handle: StoreHandle) => Promise<number>;

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    const command = await route(argv, io);
    if (!command) return 0;
    const handle = new StoreHandle(io.env);
    try {
      return await command(handle);
    } finally {
      handle.close();
    }
  } catch (e) {
    const err = e instanceof DfsError ? e : new DfsError(5, messageOf(e));
    io.stderr.write(`dfs: ${err.message}\n`);
    return err.exit;
  }
}

// Strict argv parsing: an unknown flag is an input error.
function parse<T extends ParseArgsConfig['options']>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new DfsError(3, messageOf(e));
  }
}

// argv to a command; help, search, schema and --version print here and return nothing.
async function route(argv: string[], io: Io): Promise<Command | undefined> {
  const [first, ...rest] = argv;

  if (argv.length === 1 && first === '--version') {
    const { sha, date } = readNewest(io.env);
    io.stdout.write(`dfs ${pkg.version} (spec ${sha.slice(0, 7)}, ${date.slice(0, 10)})\n`);
    return;
  }
  // Store commands do not read the spec; --version reports it offline.
  if (first !== 'store') await dailyCheck(io);
  const catalog = openCatalog(io.env);

  if (first === 'search') {
    // No option parse: a word like `-site` is query text.
    if (rest.includes('--help')) {
      io.stdout.write(`usage: ${SEARCH_USAGE}\n`);
      return;
    }
    const hits = search(catalog.endpoints, rest.join(' '));
    if (hits.length === 0) io.stderr.write('dfs: no match\n');
    io.stdout.write(searchText(hits));
    return;
  }

  if (first === 'schema') {
    const { values, positionals } = parse(rest, { help: { type: 'boolean' } });
    if (values.help) {
      io.stdout.write(`usage: ${SCHEMA_USAGE}\n`);
      return;
    }
    if (positionals.length === 0) throw new DfsError(3, `usage: ${SCHEMA_USAGE}`);
    const { node } = catalog.resolve(positionals);
    // An id slot left empty still names its endpoint: `dfs schema … task_get advanced`.
    const ep = node.endpoint ?? node.param?.node.endpoint;
    if (!ep) throw new DfsError(3, `dfs ${positionals.join(' ')} is a level, not an endpoint`);
    io.stdout.write(schemaText(ep, catalog.spec));
    return;
  }

  if (first === 'store') {
    const args = parse(rest, {
      help: { type: 'boolean' },
      from: { type: 'string' },
      full: { type: 'boolean' },
      since: { type: 'string' },
      path: { type: 'string' },
      by: { type: 'string' },
    });
    if (args.values.help || args.positionals.length === 0) {
      io.stdout.write(`usage: ${STORE_USAGE}\n`);
      return;
    }
    const { help: _, ...values } = args.values;
    return (handle) => store({ values, positionals: args.positionals }, io, handle).then(() => 0);
  }

  const { values, positionals } = parse(argv, {
    help: { type: 'boolean' },
    body: { type: 'string' },
    full: { type: 'boolean' },
    sandbox: { type: 'boolean' },
    'max-cost': { type: 'string' },
    'dry-run': { type: 'boolean' },
    'no-validate': { type: 'boolean' },
    fresh: { type: 'boolean' },
    wait: { type: 'string' },
    'page-all': { type: 'boolean' },
    params: { type: 'string' },
  });
  if (positionals.length === 0) {
    io.stdout.write(rootHelp(catalog.root, catalog));
    return;
  }
  // +run and +collect collect calls send no query parameters: vendor defaults.
  const flag = (['page-all', 'params'] as const).find((f) => values[f] !== undefined);
  if (flag && positionals.some((w) => w === '+run' || w === '+collect')) {
    throw new DfsError(3, `--${flag} applies to endpoint calls only, not +run or +collect`);
  }
  if (positionals.includes('+collect')) {
    if (values.help) {
      io.stdout.write(`usage: ${COLLECT_USAGE}\n`);
      return;
    }
    const [module, ...extra] = positionals.slice(0, -1);
    if (
      positionals.at(-1) !== '+collect' ||
      extra.length > 0 ||
      (module && !catalog.root.children.has(module))
    ) {
      throw new DfsError(3, `+collect runs at the root or one module; usage: ${COLLECT_USAGE}`);
    }
    if (values.wait !== undefined) throw new DfsError(3, '+collect --wait: not in this build yet');
    return (handle) => collectAll(catalog, module, values, io, handle);
  }
  const at = positionals.indexOf('+run');
  if (at >= 0) {
    const { node } = catalog.resolve(positionals.slice(0, at));
    const [variant, ...extra] = positionals.slice(at + 1);
    if (extra.length > 0) throw new DfsError(3, `usage: ${runUsage(node)}`);
    if (values.help) {
      io.stdout.write(`usage: ${runUsage(node)}\n`);
      return;
    }
    return (handle) => runTasks(catalog, node, variant, values, io, handle);
  }
  if (values.wait !== undefined) throw new DfsError(3, '--wait applies to +run only');
  const { node, params } = catalog.resolve(positionals);
  const ep = node.endpoint;
  if (ep && !values.help) return (handle) => call(catalog, ep, params, values, io, handle);
  io.stdout.write(nodeHelp(node, params, catalog.spec));
}
