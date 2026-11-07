import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const BIN = fileURLToPath(new URL('../bin/dfs.ts', import.meta.url));
const env = { ...process.env, DFS_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dfs-cli-')) };

// Bin wiring only (seam 2); every CLI behavior is tested in-process in run.test.ts.
test('--version shows the snapshot SHA and date from the bin', async () => {
  const { stdout } = await promisify(execFile)('node', [BIN, '--version'], { env });
  assert.match(stdout, /^dfs \d+\.\d+\.\d+ \(spec 55a4ed0, 2026-10-26\)\n$/);
});

test('--help exits 0', async () => {
  const { stdout } = await promisify(execFile)('node', [BIN, '--help'], { env });
  assert.match(stdout, /^ {2}serp$/m);
});
