---
type: Module Design
title: Pricing module
description: Estimate (G:47) and Cost guard (G:51).
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-07T00:00:00Z }
verified: [{ by: process:plan-verifier-blind-audit-9, at: 2026-11-07T00:00:00Z }]
status: stable
---

# Pricing module

3. **Pricing** — Estimate (G:47) and Cost guard (G:51).
   - Price tree source: the `price` tree of `GET /v3/appendix/user_data` (free, 6/min), kept in the Store's `price` table with its fetch time (31:107, 31:199). Only a non-sandbox `user_data` response with envelope `status_code` 20000 and a `price` node writes that table. A sandbox or failed response never does: sandbox data is dummy (r34:51). Any such call writes it, including aviato's daily balance read (46:359). **Agent design:** before a paid call, when the tree is older than 24 h and credentials exist, dfs calls `user_data` first. If that refresh fails, dfs uses the older tree and warns. With no tree at all, the price is unknown.
   - Price rules: dfs's own data, one rule per paid spec path or path pattern. A rule gives the price node, a factor against the node price, the billing unit and the parameter multipliers (31:107; r31:16–22, r31:58–66, r31:92). Reason: node keys do not mirror paths, and one node covers several list prices (r31:16–22).
   - Free list: the paths that never charge (`task_get`, `tasks_ready`, `tasks_fixed`, `id_list`, `errors`, `user_data`, `locations`, `languages`, `webhook_resend`, …) (r31:105–109).
   - Estimate = worst case from the body: task count, priority, `depth`, `limit`, `max_crawl_pages`, known multipliers (31:104). Rounding follows the API (depth rounds up to the billing unit, r31:60).
   - **Agent design:** a rule whose cost has no bound in the body (LLM Responses: provider cost settles after the run, r31:84) is marked unbounded and treated like an unknown price. Reason: the glossary defines the Estimate as worst case (G:47), and an unbounded cost has none.
   - Guard: estimate > ceiling → exit 4, nothing sent. Unknown or unbounded price → exit 4 unless `--max-cost` was given explicitly (31:104–105). `--page-all`: before each next page, dfs adds that page's estimate to the cost so far and stops before the page that would pass the ceiling (31:189). **Agent design:** one `+run` is one command, so all its posts share one ceiling. Reason: 31:104 sets the ceiling per command.
   - `--sandbox`: estimate 0, guard not applied. Agent design. Reason: the sandbox never charges (r34:49).
   - After each paid call, dfs stores the estimate and the real `cost`, and warns when the real cost is higher (31:105).
   - Price-tree check on the Mac: a rule that names a missing price node → unknown price for its paths (exit 4 unless explicit) plus a warning naming the rule (34:108).
