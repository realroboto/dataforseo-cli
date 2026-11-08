---
type: Architecture Decision Record
title: Exit-code table 0–6
description: Fixed exit codes tell agent and programs what happened and whether money was spent.
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-08T00:00:00Z }
status: stable
---

# Exit-code table 0–6

Status: accepted (2026-11-08, epic #1, ticket #19).

## Context

Agents and aviato jobs act on exit code alone. They must know if input was bad, if owner must act, if money was spent, and if tasks are still pending.

## Decision

Exit codes (28:148–165, with 31 amendments):

| Exit | Meaning | Money spent? |
|---|---|---|
| 0 | ok (also warning codes 40106, 40102, 40007) | yes |
| 1 | API or network error, after retries | maybe |
| 2 | account: owner must act | no |
| 3 | invalid input, nothing sent | no |
| 4 | cost guard: nothing more sent | no more |
| 5 | dfs internal bug | — |
| 6 | incomplete: a task failed or is not ready | yes |

- Many tasks: 2 if any task is account class; else 1 if request failed or every task failed; else 6 if any task failed or pending; else 0 (28:160, 28:156, 31:151).
- Unknown 4xxxx and 5xxxx → 1.
- Exit 3 guarantees no request left the machine (28:162).
- Numbers match gapi where meaning matches: 0, 1, 2, 3, 5 (28:163).

## Reason

One number answers "retry, fix input, ask owner, or collect later". Each code has one remedy. Peer CLIs share meanings, so agents reuse one habit.

## Source

[Exit codes and global flags](/spec/exit-codes-flags.md).
