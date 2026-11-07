// Process io is injected so tests drive the whole CLI in-process (seam 1, docs/spec/testing.md).
import { type ParseArgsConfig, parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { call, STORE_USAGE, store } from './call.ts';
import { openCatalog } from './catalog.ts';
import { DfsError, messageOf } from './errors.ts';
import {
  nodeHelp,
  rootHelp,
  SCHEMA_USAGE,
  SEARCH_USAGE,
  schemaText,
  searchText,
} from './render.ts';
import { search } from './search.ts';

export type Io = {
  env: NodeJS.ProcessEnv; // DFS_CONFIG_DIR
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  stdin: NodeJS.ReadableStream;
  sleep?: (ms: number) => Promise<void>; // retry backoff; tests skip the wait
  now?: () => number; // clock of the reuse, spec and price windows; tests set it
};

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    return (await dispatch(argv, io)) ?? 0;
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

async function dispatch(argv: string[], io: Io): Promise<number | undefined> {
  const catalog = openCatalog();
  const [first, ...rest] = argv;

  if (argv.length === 1 && first === '--version') {
    io.stdout.write(
      `dfs ${pkg.version} (spec ${catalog.sha.slice(0, 7)}, ${catalog.date.slice(0, 10)})\n`,
    );
    return;
  }

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
    });
    if (args.values.help || args.positionals.length === 0) {
      io.stdout.write(`usage: ${STORE_USAGE}\n`);
      return;
    }
    store(args, io);
    return;
  }

  const { values, positionals } = parse(argv, {
    help: { type: 'boolean' },
    body: { type: 'string' },
    full: { type: 'boolean' },
    sandbox: { type: 'boolean' },
    'max-cost': { type: 'string' },
  });
  if (positionals.length === 0) {
    io.stdout.write(rootHelp(catalog.root, catalog));
    return;
  }
  const { node, params } = catalog.resolve(positionals);
  if (node.endpoint && !values.help) return call(catalog, node.endpoint, params, values, io);
  io.stdout.write(nodeHelp(node, params, catalog.spec));
}
