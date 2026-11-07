import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { type Io, run } from '../../src/run.ts';

// Runs the CLI in-process with in-memory streams, a temp DFS_CONFIG_DIR and a fixed clock;
// any network call fails loudly.
export async function dfs(argv: string[], io: Partial<Io> = {}) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    env: { DFS_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dfs-run-')) },
    fetch: () => Promise.reject(new Error('unexpected network call')),
    sleep: async () => {}, // retry backoff never waits in tests
    now: () => Date.parse('2026-11-07T12:00:00Z'),
    stdin: Readable.from([]),
    stdout: {
      write: (s: string) => {
        stdout += s;
      },
    },
    stderr: {
      write: (s: string) => {
        stderr += s;
      },
    },
    ...io,
  });
  return { code, stdout, stderr };
}
