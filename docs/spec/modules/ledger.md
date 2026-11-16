---
type: Module Design
title: Task ledger module
description: Owns the `task` and `sync` tables; callers hand it responses, it decides rows, states and costs.
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-16T00:00:00Z }
status: stable
---

# Task ledger module

9. **Task ledger** — owns the `task` and `sync` tables (`src/ledger.ts`; epic #32 D4). Callers hand it responses; it builds the rows. Columns and DDL: [Store](/spec/modules/store.md) (one schema contract; migrations stay there).
   - **Interface** (every function takes the [Store handle](/spec/modules/store.md)):
     - `posted(store, body, post)`: one row per task id of a paid response. `post` = response id, endpoint path, variant, sandbox, time.
       - `task_post` path: `pending` when the task code is ok, else `failed`. `collected_at`, `collect_response` empty.
       - Other paid path: `collected`, else `failed` when the code is not ok. `collected_at` = time, `collect_response` = response id on every row.
       - A task already in the Store keeps its row (replayed post). Returns the tasks as stored, plus each task's `status_message`.
       - Caller: [Dispatch](/spec/modules/dispatch.md) Send. Track off (plain call, `--page-all`): sent paid responses only. Track on (`+run` post): sent and reused posts.
     - `collected(store, task, response)`: new state of one task from its collect response (response id, endpoint path, body, time).
       - State rule, first match wins. Code sets: [Envelope](/spec/modules/envelope.md).
         1. Not ready, or no code → `pending`.
         2. 40403 → `expired`.
         3. Not ok → `failed`.
         4. Ok, on a path that is not `summary/` → `collected`.
         5. Ok on a `summary/` path: `collected` when `crawl_progress` = `finished`, else `pending`.
       - Lifecycle hands it only a saved response whose envelope succeeded. An envelope failure leaves the task unchanged (epic #32 B5).
       - Returns the stored row and the task's `status_message` (report line).
     - `recovered(store, results, list, route)`: ids from `id_list` results (`list` = response id, time). A known id gets the cost rule. An unknown id gets a new row: `pending`, or `failed` when `route` maps its url to no collect call. `route` (Lifecycle) maps a url to a path and variant.
     - `pendingTasks(store, prefix)`: pending tasks whose path starts with `prefix`, oldest first.
     - `syncStart(store, module)`, `setSync(store, module, at)`: the `id_list` window of a module ([Lifecycle](/spec/modules/lifecycle.md)).
   - **Cost rule, once.** A later cost replaces the stored cost only when non-zero (store.md, `task`). One `UPDATE … RETURNING *` statement applies it for `collected` and `recovered`; the ledger returns that row. No in-memory copy of the rule exists.
   - **Write failure.** Every write warns and the command goes on. One text: `task rows not saved (<message>); dfs +collect recovers the tasks`.
     - `posted`, `collected`: return the tasks with the new state and the old cost.
     - `recovered`, `setSync`: return the text. `+collect` stops that module's pass and keeps its sync time; the next pass lists the ids again. The next module goes on.
     - Reads (`pendingTasks`, `syncStart`) throw: a Store that cannot open exits 5.
   - **Not here:** `store spend` reads `task` in the Store module. Collect variant mapping (`collectLevel`, `recoveredVariant`) stays in Lifecycle: it needs the Catalog.
   - Test: `test/collect.test.ts` "task row writes the Store refuses: one warning text on each path; the module keeps its sync time".
