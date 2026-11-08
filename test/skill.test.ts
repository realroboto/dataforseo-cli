import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { STORE_USAGE } from '../src/store-cli.ts';
import { dfs } from './helpers/io.ts';

const SKILL = readFileSync(join(import.meta.dirname, '..', 'skills', 'dfs', 'SKILL.md'), 'utf8');
const STORE_SUBS = new Set([...STORE_USAGE.matchAll(/dfs store (\w+)/g)].map((m) => m[1]));

// Every `dfs …` command of the skill: inline code spans and code-block lines.
function commands(md: string): string[] {
  const blocks = [...md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].flatMap((m) =>
    (m[1] ?? '').split('\n'),
  );
  const inline = [...md.replace(/```[\s\S]*?```/g, '').matchAll(/`(dfs [^`]+)`/g)].map((m) => m[1]);
  return [...blocks, ...inline]
    .map((l) => (l ?? '').replace(/\s+#.*$/, '').trim())
    .filter((l) => l.startsWith('dfs '));
}

// Command words: tokens before the first flag; a quoted argument ends them too.
const wordsOf = (cmd: string): string[] => {
  const words: string[] = [];
  for (const t of cmd.split(/\s+/).slice(1)) {
    if (t.startsWith('-') || t.startsWith('"') || t.startsWith("'")) break;
    words.push(t);
  }
  return words;
};

// Endpoint, level, +run and +collect words resolve through `--help` (exit 3 on an unknown word).
async function resolves(cmd: string): Promise<string | undefined> {
  const [first, ...rest] = wordsOf(cmd);
  if (first === 'store') return STORE_SUBS.has(rest[0] ?? '') ? undefined : 'unknown store command';
  if (first === 'search') return cmd.length > 'dfs search '.length ? undefined : 'no words';
  const words = first === 'schema' ? rest : [first ?? '', ...rest].filter(Boolean);
  const { code, stderr } = await dfs([...words, '--help']);
  return code === 0 ? undefined : stderr.trim();
}

test('skill: every dfs command resolves in the Catalog', async () => {
  const all = commands(SKILL);
  assert.ok(all.length >= 10, `few commands found: ${all.length}`);
  const faults: string[] = [];
  for (const cmd of all) {
    const fault = await resolves(cmd);
    if (fault) faults.push(`${cmd}: ${fault}`);
  }
  assert.deepEqual(faults, []);
});

test('skill: the check catches an unknown word', async () => {
  assert.match(
    (await resolves('dfs serp google organik live advanced')) ?? '',
    /unknown command word/,
  );
  assert.equal(await resolves('dfs serp google organic +run advanced --wait 30'), undefined);
  assert.equal(await resolves('dfs store bogus'), 'unknown store command');
});

test('skill: covers each rule of Story 58', () => {
  for (const rule of [
    /Live/,
    /\+run[^\n]*--wait/,
    /run_in_background|background/,
    /llm_responses[\s\S]*timeout/,
    /dfs \+collect/,
    /dfs store show [^`]*--from/,
    /--dry-run/,
  ]) {
    assert.match(SKILL, rule);
  }
  assert.match(SKILL, /^---\nname: dfs\ndescription: .+\n---\n/);
});
