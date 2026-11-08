import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { type Io, run } from '../../src/run.ts';

const NOW = () => Date.parse('2026-11-07T12:00:00Z');

// Runs the CLI in-process with in-memory streams, a temp DFS_CONFIG_DIR and a fixed clock;
// any network call fails loudly. The daily spec check counts as just done unless `specCheck`.
export async function dfs(argv: string[], io: Partial<Io> = {}, { specCheck = false } = {}) {
  let stdout = '';
  let stderr = '';
  const env = io.env ?? { DFS_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dfs-run-')) };
  const dir = env.DFS_CONFIG_DIR;
  if (!specCheck && dir && existsSync(dir)) {
    writeFileSync(join(dir, 'spec-check.json'), JSON.stringify({ checked: (io.now ?? NOW)() }));
  }
  const code = await run(argv, {
    fetch: () => Promise.reject(new Error('unexpected network call')),
    sleep: async () => {}, // retry backoff never waits in tests
    now: NOW,
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
    env,
  });
  return { code, stdout, stderr };
}
