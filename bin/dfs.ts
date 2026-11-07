#!/usr/bin/env node
import { run } from '../src/run.ts';

const { argv, env, stdin, stdout, stderr } = process;
// stdout EPIPE (`dfs … | head`): the reader is gone, so stop. Any other stream error (ENOSPC,
// EBADF) lost output: exit 5, never a silent 0.
for (const s of [stdout, stderr]) {
  s.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EPIPE') process.exit(5);
    if (s === stdout) process.exit(0);
  });
}
process.exitCode = await run(argv.slice(2), { env, fetch, stdin, stdout, stderr });
