---
type: Module Design
title: Transport module
description: one HTTP exchange with auth, pace and retries.
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-07T00:00:00Z }
verified: [{ by: process:plan-verifier-blind-audit-9, at: 2026-11-07T00:00:00Z }]
status: stable
---

# Transport module

4. **Transport** — one HTTP exchange with auth, pace and retries.
   - Basic auth from `DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD`, read per request from `io.env`. Never logged, never stored (28:101; 31:167).
   - Retries, by class (31:148–151):
     - Free call: up to 4 retries on 40202, 40209, 50000, 50301, 50303, HTTP 500 or a network error; wait 1, 2, 4, 8 s plus jitter.
     - Paid call: retry only when the response proves cost 0 and the code is 40202, 40209, 50000, 50301, 50303 or 50401. Same backoff.
     - Connection lost after a paid send: no retry; exit 1 with remedy `dfs +collect`.
     - 40103: no automatic retry; the task counts as failed, and the remedy names `--fresh`.
   - Pace: `X-RateLimit-Remaining` 0 → wait for the next minute; at most 10 requests in flight per process; Live client timeout 130 s (31:152).
