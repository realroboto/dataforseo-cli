---
type: Module Design
title: Lifecycle module
description: `+run` and `+collect` (31:127–141).
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-07T00:00:00Z }
verified: [{ by: process:plan-verifier-blind-audit-9, at: 2026-11-07T00:00:00Z }]
status: stable
---

# Lifecycle module

6. **Lifecycle** — `+run` and `+collect` (31:127–141).
   - `+run <variant>` exists at each endpoint level that has `task_post` and a collect call. The variant is optional when the level has at most one collect path. Agent design; reason: some modules have one `task_get` and no variant word, and on_page has none.
   - **Collect call (agent design, 2026-11-07).** The call that fetches a task's result: `task_get` with the task's variant. One exception in spec `55a4ed0`: `/v3/on_page/task_post` is the only `task_post` level with no `task_get`. Its collect call is `GET /v3/on_page/summary/{id}`. The task is collected when `crawl_progress` is `finished`; else it stays pending. The other on_page results (`pages`, `resources`, …) stay hand commands with the id in the body. Reason: `summary/{id}` is the only on_page result path keyed by the task id, and `/v3/on_page/tasks_ready` lists done crawls. A new `task_post` level with no collect call gets no `+run` and fails `spec:check` (condition 5).
   - Flow: plan, guard over all posts, post ≤ 100 per request, save each post response, then wait up to `--wait` (default 90 s). While waiting, dfs polls the most specific `tasks_ready` path the spec has for the endpoint (free, 20/min). The poll interval starts at 5 s, doubles, and caps at 30 s (agent design inside 31:130's "growing interval"). Each ready id **of this run's post responses** gets its collect call, and is saved (31:130). **Agent design:** dfs ignores other ready ids and leaves them to `+collect`. Reason: `tasks_ready` lists every uncollected task of the last 3 days in its scope, other runs and other clients included (r31:123–124). Without the filter, `+run` would fetch and print tasks that are not its own.
   - Timeout or `--wait 0` → exit 6. stderr lists every pending id and `dfs +collect` (31:130, 31:132; 46:311, 46:321).
   - Each collect call (`+run` and `+collect`) uses the variant stored in the task row. Only recovered ids, which have no stored variant, follow the rule below.
   - `+collect` (root = all modules; module level = one module), one pass by default; `--wait` keeps polling (31:133).
     1. Pending tasks → collect call (31:134).
     2. Lost ids: `id_list` per module (free, 10/min, ≤ 1,000 ids per call, 6-month window) since the last pass. Ids missing from the Store → collect call and save (31:135; r31:130, r31:133). **Agent design:** the first pass on a new Store starts at the Store's creation time. Reason: older tasks belong to no dfs history, and a 6-month import would fill the Store with other clients' data.
        - **`id_list` hand path (owner decision, 31:214).** The spec has `id_list` for 10 modules and none for `ai_optimization`; the docs list it (r31:132). dfs keeps one hand path, `POST /v3/ai_optimization/id_list`, with the body and result of the spec's other `id_list` paths. It is not a command; only steps 2 and 3 use it. HTTP 404, 40400 or 40402 from it (r28:33) → `dfs: warning: ai_optimization id_list not served — lost ids not recoverable`, no exit 1, and `+collect` goes on. The code marks it `shortcut: not in the spec, remove when the spec adds it` (`spec:check` condition 6).
     3. Lost Live ids: record the cost from `id_list`. Run `task_get` where the module has one; otherwise warn (31:136). Live retrieval by id is unverified (r31:136).
     4. A task older than 30 days → 40403 → state `expired`, reported (31:137).
   - Recovered ids have no recorded variant. **Agent design (refines 31:141):** dfs maps the `id_list` result `url` (r31:130) to the longest spec level that prefixes it. A level with one collect path uses it: bare `task_get/{id}`, `on_page/lighthouse` `task_get/json/{id}`, or on_page `summary/{id}`. Otherwise `advanced`, then `regular` (31:141). A `url` that maps to no level → warning, no call. Reason: in spec `55a4ed0`, 26 of 69 `task_post` levels have no `advanced` or `regular` path (24 bare `task_get/{id}`, 1 `json` only, 1 none), so 31:141 alone would call a path that does not exist.
   - Never re-post a pending task. A new paid post happens only through an explicit call outside the reuse window, or with `--fresh` (31:138).
   - **Interim (ticket 08, 2026-11-07).** A repeated `task_post` inside the reuse window replays the stored post response: no post, task ids printed. It does not collect yet, and it does not read task state, so a failed or expired task blocks a new post for 12 h unless `--fresh`. Upgrade with the `task` table and collect call (tickets 10, 11).
