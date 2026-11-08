import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const BIN = fileURLToPath(new URL('../bin/dfs.ts', import.meta.url));
const env = { ...process.env, DFS_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dfs-cli-')) };
// The daily spec check counts as done today: the bin never reaches the network in CI.
writeFileSync(join(env.DFS_CONFIG_DIR, 'spec-check.json'), JSON.stringify({ checked: Date.now() }));

// Bin wiring only (seam 2); every CLI behavior is tested in-process in run.test.ts.
test('--version shows the snapshot SHA and date from the bin', async () => {
  const { stdout } = await promisify(execFile)('node', [BIN, '--version'], { env });
  assert.match(stdout, /^dfs \d+\.\d+\.\d+ \(spec 55a4ed0, 2026-10-26\)\n$/);
});

test('--help exits 0', async () => {
  const { stdout } = await promisify(execFile)('node', [BIN, '--help'], { env });
  assert.match(stdout, /^ {2}serp$/m);
});

test('a Store write waits for the lock of another process (busy timeout)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dfs-cli-'));
  await promisify(execFile)('node', [BIN, 'store', 'list'], {
    env: { ...env, DFS_CONFIG_DIR: dir },
  });
  mkdirSync(join(dir, 'unsaved'));
  const row = {
    id: 'r_0000000001',
    time: '2026-11-07T12:00:00.000Z',
    method: 'GET',
    spec_path: '/v3/appendix/status',
    path: '/v3/appendix/status',
    sandbox: 0,
    request: null,
    http_status: 200,
    status_code: 20000,
    cost: 0,
    estimate: 0,
    reused_from: null,
    dfs_version: '0.1.0',
    spec_sha: '55a4ed0',
    body: '{"tasks":[{"id":"t1","status_code":20000,"result":[{"ok":1}]}]}',
  };
  writeFileSync(join(dir, 'unsaved', `${row.id}.json`), JSON.stringify(row));
  const lock = new DatabaseSync(join(dir, 'store.db'));
  lock.exec('BEGIN IMMEDIATE');
  setTimeout(() => lock.exec('COMMIT'), 1000);
  // The import on open waits for the lock instead of failing at once.
  const { stdout } = await promisify(execFile)('node', [BIN, 'store', 'show', row.id], {
    env: { ...env, DFS_CONFIG_DIR: dir },
  });
  lock.close();
  assert.equal(stdout, '{"dfs":"task","id":"t1","status_code":20000}\n{"ok":1}\n');
});
