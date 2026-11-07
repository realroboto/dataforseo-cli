// pnpm spec:snapshot: writes spec/snapshot.json from the vendor spec at the newest master SHA
// (docs/spec/modules/catalog.md, Snapshot source). Network script; never run in CI.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { checkSpec, readOverlay, readSnapshot, SPEC_DIR } from '../src/catalog.ts';
import { isRecord } from '../src/json.ts';
import { applyOverlay } from '../src/overlay.ts';

const REPO = 'dataforseo/OpenApiDocumentation';
const FILE = 'openapi_specification.yaml';

async function get(url: string, accept: string): Promise<Response> {
  const res = await fetch(url, { headers: { accept } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

const commits: unknown = await (
  await get(
    `https://api.github.com/repos/${REPO}/commits?path=${FILE}&sha=master&per_page=1`,
    'application/vnd.github+json',
  )
).json();
const last = Array.isArray(commits) ? commits[0] : undefined;
const commit = isRecord(last) && isRecord(last.commit) ? last.commit.committer : undefined;
const sha = isRecord(last) ? last.sha : undefined;
const date = isRecord(commit) ? commit.date : undefined;
if (typeof sha !== 'string' || typeof date !== 'string') {
  throw new Error(
    `GitHub commits API: no commit for ${FILE}: ${JSON.stringify(commits).slice(0, 200)}`,
  );
}
// By SHA, not master: no race between the two reads.
const text = await (
  await get(`https://raw.githubusercontent.com/${REPO}/${sha}/${FILE}`, '*/*')
).text();
const spec = parse(text);

const target = join(SPEC_DIR, 'snapshot.json');
const previous = existsSync(target) ? Object.keys(readSnapshot().spec.paths).length : undefined;
const overlaid = structuredClone(spec);
applyOverlay(overlaid, readOverlay());
const problems = checkSpec(overlaid, previous);
if (problems.length > 0) {
  process.stderr.write(
    `spec ${sha.slice(0, 7)} fails the structural check:\n${problems.join('\n')}\n`,
  );
  process.exit(1);
}
const tmp = `${target}.${randomUUID()}.tmp`;
await writeFile(tmp, `${JSON.stringify({ sha, date, spec }, null, 2)}\n`, {
  flag: 'wx',
  flush: true,
});
await rename(tmp, target);
process.stdout.write(
  `spec/snapshot.json: ${sha.slice(0, 7)} ${date}, ${Object.keys(spec.paths).length} paths\n`,
);
