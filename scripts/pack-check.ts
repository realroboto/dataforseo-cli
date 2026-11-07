// pnpm pack:check, after `pnpm build` (docs/spec/workflows-release.md, Pack check): the tarball
// lists the snapshot and the overlay, and the built dist (not src) shows the snapshot identity.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { readSnapshot } from '../src/catalog.ts';

const root = join(import.meta.dirname, '..');
const [pack] = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' }),
);
const files: string[] = pack.files.map((f: { path: string }) => f.path);
for (const f of ['dist/bin/dfs.js', 'dist/spec/snapshot.json', 'dist/spec/overlay.yaml']) {
  assert.ok(files.includes(f), `npm pack does not list ${f}`);
}

const { sha, date } = readSnapshot();
const dist = (...args: string[]) =>
  execFileSync('node', [join(root, 'dist/bin/dfs.js'), ...args], {
    env: { ...process.env, DFS_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'dfs-pack-')) },
    encoding: 'utf8',
  });
const version = dist('--version');
assert.equal(version, `dfs ${pkg.version} (spec ${sha.slice(0, 7)}, ${date.slice(0, 10)})\n`);
const anchors = {
  target: 'forbes.com',
  limit: 4,
  order_by: ['backlinks,desc'],
  filters: ['anchor', 'like', '%news%'],
};
const plan = dist('backlinks', 'anchors', 'live', '--body', JSON.stringify(anchors), '--dry-run');
assert.equal(JSON.parse(plan).tasks, 1, 'dist --dry-run of the backlinks/anchors/live example');
process.stdout.write(`pack check: ok (${files.length} files, ${version.trim()})\n`);
