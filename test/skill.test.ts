import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { dfs } from './helpers/io.ts';

const SKILL = readFileSync(join(import.meta.dirname, '..', 'skills', 'dfs', 'SKILL.md'), 'utf8');

// Every `dfs …` command in a code span or code block, also one inside other text (the cut line).
function commands(md: string): string[] {
  const code = [
    ...[...md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].flatMap((m) => (m[1] ?? '').split('\n')),
    ...[...md.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ''),
  ];
  return code.flatMap((s) =>
    [...s.replace(/\s+#.*$/, '').matchAll(/(?:^|[\s"])(dfs (?:'[^']*'|[^"\s]+| )+)/g)].map((m) =>
      (m[1] ?? '').trim(),
    ),
  );
}

// Shell words: a quoted argument is one word.
const argv = (cmd: string): string[] =>
  [...cmd.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '').slice(1);

// Each command runs with `--help` through seam 1: an unknown word or flag exits 3. Then its help
// must show the command itself: `call: …` for an endpoint, a `+run` line on its level.
async function resolves(cmd: string): Promise<string | undefined> {
  const args = argv(cmd);
  const flag = args.findIndex((a) => a.startsWith('-'));
  const words = flag < 0 ? args : args.slice(0, flag);
  const help = await dfs([...args, '--help']);
  if (help.code !== 0) return help.stderr.trim();
  const [first] = words;
  if (first === undefined) return;
  if (first === 'store') {
    return help.stdout.includes(`dfs store ${words[1]} `) ? undefined : 'unknown store command';
  }
  const at = words.findIndex((w) => w === '+run' || w === '+collect');
  if (at < 0) {
    if (!help.stdout.includes(`\ncall: dfs ${words.join(' ')} `)) return 'not an endpoint';
    // A literal body must pass the Planner too.
    if (!args[args.indexOf('--body') + 1]?.startsWith('{')) return;
    const plan = await dfs([...args.filter((a) => a !== '--dry-run'), '--dry-run']);
    return plan.code === 0 ? undefined : plan.stderr.trim();
  }
  const level = words.slice(0, at);
  if (words[at] === '+collect') {
    if (level.length > 1) return '+collect runs at the root or one module';
    const mod = level.length === 0 || (await dfs([...level, '--help'])).code === 0;
    return mod ? undefined : 'unknown module';
  }
  const levelHelp = await dfs([...level, '--help']);
  if (!levelHelp.stdout.includes(`dfs ${level.join(' ')} +run --help`)) return 'level has no +run';
  const variant = words[at + 1];
  return variant === undefined || new RegExp(`[<[|]${variant}[|>\\]]`).test(help.stdout)
    ? undefined
    : 'unknown +run variant';
}

test('skill: every dfs command resolves in the Catalog', async () => {
  const all = commands(SKILL);
  assert.ok(all.length >= 15, `few commands found: ${all.length}`);
  assert.ok(all.includes('dfs store show <id> --from <n>'), 'command inside the cut line');
  const faults: string[] = [];
  for (const cmd of all) {
    const fault = await resolves(cmd);
    if (fault) faults.push(`${cmd}: ${fault}`);
  }
  assert.deepEqual(faults, []);
});

test('skill: the check refuses a command that does not resolve', async () => {
  for (const [cmd, fault] of [
    ['dfs serp google organik live advanced', /unknown command word/],
    ['dfs serp google organic live', /not an endpoint/],
    ['dfs serp google organic live advanced --wiat 30', /Unknown option/],
    ['dfs serp google organic live +run', /level has no \+run/],
    ['dfs serp google organic +run advancd', /unknown \+run variant/],
    ['dfs serp google +collect', /root or one module/],
    ['dfs store bogus', /unknown store command/],
    [`dfs serp google organic live advanced --body '{"keywrd":"x"}'`, /keywrd/],
  ] as const) {
    assert.match((await resolves(cmd)) ?? 'resolved', fault, cmd);
  }
  assert.equal(await resolves('dfs serp google organic +run advanced --wait 30'), undefined);
});

// One numbered rule per Story 58 rule (and ticket #18): each line names its own instruction.
test('skill: covers each rule of Story 58 and ticket #18', () => {
  const rules = SKILL.split('\n').filter((l) => /^\d+\. /.test(l));
  for (const words of [
    [/Use Live in a session/],
    [/`\+run` only with short `--wait` or in background/, /run_in_background/],
    [/Raise command timeout for LLM Live endpoints/, /llm_responses/],
    [/`dfs \+collect` after timeout/],
    [/`dfs store show` after a cut/, /--from/],
    [/`--dry-run` before a paid call/],
  ]) {
    assert.ok(
      rules.some((l) => words.every((w) => w.test(l))),
      `no rule line: ${words.join(' ')}`,
    );
  }
  assert.match(SKILL, /^---\nname: dfs\ndescription: .+\n---\n/);
});
