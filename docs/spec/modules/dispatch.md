---
type: Module Design
title: Dispatch module
description: One planned call from the Reuse check to the outcome, in one order; Fetch free for free requests.
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-16T00:00:00Z }
status: stable
---

# Dispatch module

10. **Dispatch** — one planned call from the Reuse check to the outcome (`src/dispatch.ts`; epic #32 D5). One Dispatch per command. Built from the Catalog, `io`, the [Store handle](/spec/modules/store.md), the command's [Output](/spec/modules/render.md) and the spend flags (`--sandbox`, `--fresh`, `--max-cost`, `--dry-run`).
   - **Ceiling.** `--max-cost`, else `DFS_MAX_COST`, else $1. "Explicit" (`--max-cost` set) also sends an unknown or unbounded price. An invalid value exits 3 when the Dispatch is built: after `--body` reading, before the plan.
   - **No spend flags** (`+collect`): the Dispatch sends free requests only. It reads no ceiling, so an invalid `DFS_MAX_COST` never stops `+collect`; a paid call would be refused (ceiling 0). Test: `test/collect.test.ts` "+collect reads no cost ceiling: an invalid DFS_MAX_COST does not stop it".
   - **`prepare(ep, plan)`** → prepared call. The plan is validated first, so an invalid body sends nothing.
     1. Plan warnings go to Output.
     2. Reuse candidate: the newest exit-0 response with the same reuse key in 12 h. Paid path only, not with `--fresh` ([ADR 0003](/adr/0003-reuse-on-by-default.md)).
     3. Rule estimate: $0 for a free path or the sandbox; else rule × price tree ([Pricing](/spec/modules/pricing.md)). A reuse candidate does not change it.
     - A call that replays its candidate (not a dry run) gets no estimate. Reason: the price tree then never loads, or refreshes, for a call that sends nothing (as before epic #32).
     - The price tree loads once per command, on the first estimate that needs it. It refreshes first when older than 24 h and credentials exist, except in a dry run. A failed refresh warns and keeps the old tree.
   - **`price(ep)`** → the price tree when a paid estimate of `ep` needs one (not free, not the sandbox, rule bounded); else none. Same load as `prepare`. `--page-all` calls it right after the page-1 plan. Reason: a reused page 1 still refreshes the tree first, as before epic #32.
   - **`guard(calls, spent = 0)`** → refusal text, or none. Sums the rule estimates of the calls not reused, plus `spent`. An unknown or unbounded estimate refuses without an explicit ceiling. A free path or the sandbox is never refused. Stop rules of one command (`--page-all` stop line) stay in that command.
   - **`send(call, task?)`** → result. Line order: status line, then this call's warnings; the caller prints the outcome lines.
     - Task context: the `+run` variant and the track flag. Track on: Task ledger `posted` on sent and reused responses. Track off (default): on sent paid responses only ([Task ledger](/spec/modules/ledger.md)).
     - Reused: saves the reuse row, prints `… cost=$0 est=$0 reused=<id> age=<age>`. Cost 0, exit 0.
     - Sent:
       1. Transport, then save before print. An unsaved response prints in full on stdout and exits 5.
       2. Status line `dfs: <code> <path> tasks=<n> cost=$<real> est=$<estimate> saved=<id>`, then the save warnings.
       3. Real cost above the estimate warns (not in the sandbox).
       4. Task ledger `posted` (task context rules); a failed write warns.
       5. outcome through Render.
     - A paid send that loses its connection or times out exits 1 ([ADR 0004](/adr/0004-no-paid-retry-without-cost-0.md)). Line: `connection lost after send … dfs +collect recovers it`.
     - Returns: response id, parsed body, full text, real cost, exit class, outcome lines, tasks with their `status_message`, reused flag, HTTP status.
     - A replay returns the stored HTTP status. `+run` checks the envelope with the HTTP status and the body. It prints the outcome lines only on an envelope failure.
   - **`fetchFree(ep, plan, sandbox, deadline?)`** → parsed body, response id, saved flag, the exchange (HTTP status and text; outcome needs the text). For `tasks_ready`, collect calls and `id_list` (also the `ai_optimization` hand path). No Reuse, no guard, no status line ([Lifecycle](/spec/modules/lifecycle.md)); saved before use. The sandbox flag is per request. A network failure or timeout after Transport retries exits 1; the caller decides per request.
   - **Exchange** (inside): Transport, login redaction of `user_data`, save before print. A good non-sandbox `user_data` response also writes the price tree. The price refresh uses it as Fetch free does: free, estimate 0.
   - **Dry run.** The plain call builds the `--dry-run` JSON: rule estimate, `price_at` and reuse id of the prepared call, the ceiling, the guard result. Nothing is sent. The guard judges the rule estimate also beside a reuse candidate. Test: `test/reuse.test.ts` "--dry-run keeps its JSON object and the rule estimate when a stored response is reusable".
   - **Callers:** plain call (`src/call.ts`), `--page-all` (`src/pages.ts`; its stop rules stay there), Lifecycle (`src/lifecycle.ts`), `scripts/sandbox.ts` (Fetch free).
     - The steps inside are private: ceiling, Reuse check, price tree, exchange, reuse row.
