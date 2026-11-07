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
   - Price tree source: the `price` tree of `GET /v3/appendix/user_data` (free, 6/min), kept in the Store's `price` table with its fetch time (31:107, 31:199). Only a non-sandbox `user_data` response with envelope `status_code` 20000 and a `price` node writes that table. A sandbox or failed response never does: sandbox data is dummy (r34:51). Any such call writes it, including aviato's daily balance read (46:359). **Agent design:** before a paid call, when the tree is older than 24 h and credentials exist, dfs calls `user_data` first. If that refresh fails, dfs uses the older tree and warns. No stored tree counts as older than 24 h. If the refresh fails and no tree exists, the price is unknown.
   - Price rules: dfs's own data, one rule per paid spec path or path pattern. A rule gives the price node, a factor against the node price, the billing unit and the parameter multipliers (31:107; r31:16–22, r31:58–66, r31:92). Reason: node keys do not mirror paths, and one node covers several list prices (r31:16–22).
   - **Agent design (ticket 05):** a rule may name paid body fields (multiply the task price, add base prices, or add a fixed USD per unit) and a count field for `per_result` leaves (else 1). Vendor sources disagree on an extra → higher price. Organic `se_type`: each SERP after the first 25% less (help-center rule; Bing Live `depth` 100 = $0.0155), though pricing-page tables show full price; the real-cost warning flags a miss. Other types and YouTube: full price per page. `serp` and `keywords_data` have no unbounded cost: every multiplier has a published cap.
   - Free list: the paths that never charge (`task_get`, `tasks_ready`, `tasks_fixed`, `id_list`, `errors`, `user_data`, `locations`, `languages`, `webhook_resend`, the reference lists `locations_and_languages`, `categories`, `status`, `industries`, `job_functions` (docs: "not be charged"), …) (r31:105–109).
   - Estimate = worst case from the body: task count, priority, `depth`, `limit`, `max_crawl_pages`, known multipliers (31:104). **Agent design (ticket 05):** `max_crawl_pages` only lowers the cost (help-center/what-is-max-crawl-pages-and-how-does-it-work), so the serp estimate ignores it. Rounding follows the API (depth rounds up to the billing unit, r31:60).
   - **Vendor fact (help-center/above-100-results-with-serp-api, read 2026-11-07):** Google organic bills per SERP of 10 results; `depth` 15 bills 2 SERPs; each SERP after the first of an Organic `se_type` costs 25% less. `priority: 2` reads the `priority_high` leaf, else `priority_normal`.
   - **Agent design:** a missing tree triggers the refresh, so the first paid call loads it. Reason: a fresh install must not need a manual `user_data` call. `DFS_MAX_COST` sets the ceiling only; it does not unlock an unknown or unbounded price (user story 17). `--dry-run` reads the stored tree, never refreshes.
   - **Agent design:** a rule whose cost has no bound in the body (LLM Responses: provider cost settles after the run, r31:84) is marked unbounded and treated like an unknown price. Reason: the glossary defines the Estimate as worst case (G:47), and an unbounded cost has none.
   - Guard: estimate > ceiling → exit 4, nothing sent. Unknown or unbounded price → exit 4 unless `--max-cost` was given explicitly (31:104–105). `--page-all`: before each next page, dfs adds that page's estimate to the cost so far and stops before the page that would pass the ceiling (31:189). **Agent design:** one `+run` is one command, so all its posts share one ceiling. Reason: 31:104 sets the ceiling per command.
   - `--sandbox`: estimate 0, guard not applied. Agent design. Reason: the sandbox never charges (r34:49).
   - After each paid call, dfs stores the estimate and the real `cost`, and warns when the real cost is higher (31:105).
   - Price-tree check on the Mac: a rule that names a missing price node → unknown price for its paths (exit 4 unless explicit) plus a warning naming the rule (34:108).
