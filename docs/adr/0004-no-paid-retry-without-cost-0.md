---
type: Architecture Decision Record
title: No paid retry without proof of cost 0
description: Paid call retries only when response shows cost 0; lost connection after paid send exits 1 with dfs +collect.
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-08T00:00:00Z }
status: stable
---

# No paid retry without proof of cost 0

Status: accepted (2026-11-08, epic #1, ticket #19).

## Context

A resent paid request can charge twice. API has no idempotency key (r31:140–145). `fetch` gives no sure signal that nothing was sent when it fails.

## Decision

Retries by class (31:148–151):

- Free call: up to 4 retries on 40202, 40209, 50000, 50301, 50303, HTTP 500 or network error; wait 1, 2, 4, 8 s plus jitter.
- Paid call: retry only when response proves cost 0 and code is 40202, 40209, 50000, 50301, 50303 or 50401. Same backoff.
- Connection lost after paid send (every failed `fetch` on a paid call): no retry; exit 1 with remedy `dfs +collect`.
- 40103: never retried; task counts as failed, remedy names `--fresh`.
- Retry code = envelope code; under a 20000 envelope, retry only when every task has a listed code (agent design).

## Reason

Double charge is the worst outcome. Proof of cost 0 is the only signal that a resend cannot charge again. Lost Standard task ids come back through `+collect` (`id_list`), not through a re-post.

## Source

[Transport module](/spec/modules/transport.md) (Retries).
