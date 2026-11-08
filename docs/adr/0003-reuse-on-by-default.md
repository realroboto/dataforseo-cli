---
type: Architecture Decision Record
title: Reuse on by default
description: Same paid request within 12 h of a full success returns stored response at $0; --fresh sends. Deviates from gapi ADR 0001.
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-08T00:00:00Z }
status: stable
---

# Reuse on by default

Status: accepted (2026-11-08, epic #1, ticket #19).

## Context

Paid DataForSEO calls cost money from a prepaid balance. Duplicates are not limited by default and API has no idempotency key (r31:140–145). An agent that repeats a call after a context reset pays twice. gapi has the opposite rule: its response cache is opt-in per call (`--cache <age>`, realroboto/google-apis-cli `docs/adr/0001-response-cache.md`), because Google calls cost quota, not money.

## Decision

- Same paid request (spec path with values, canonical body with keys sorted at every depth, sandbox flag) within 12 h of a full success returns stored response at $0. stderr: `reused=<id> age=<age>` (31:116–117).
- `--fresh` forces a new paid call (31:118).
- Free calls (`task_get`, `tasks_ready`, `id_list`, `user_data`, `locations`, …) always go to API (31:119).
- Repeated `task_post` in window collects tasks already posted, never posts again (31:120).
- Deviation from gapi ADR 0001 on purpose (31:121).

## Reason

A repeat that costs money is the worse error; a stale answer is one flag away (`--fresh`). Only full successes are reused, so a failed call never blocks a resend. Reuse key holds sandbox flag, so sandbox and real data never mix.

## Source

[Store module](/spec/modules/store.md) (Reuse key); [Lifecycle module](/spec/modules/lifecycle.md) (Reuse per post); [user stories 22–25](/spec/user-stories.md).
