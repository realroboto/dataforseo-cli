---
type: Module Design
title: Envelope module
description: Reads a DataForSEO response body; one item numbering, the exit-table code sets.
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-16T00:00:00Z }
status: stable
---

# Envelope module

8. **Envelope** — reads a DataForSEO response body (`src/envelope.ts`; epic #32 D1). Pure: no I/O.
   - **Interface:**
     - `tasksOf(body)`: the task records (`tasks[]` elements that are objects).
     - `resultsOf(task)`: the result records of one task.
     - `firstResult(body)`: the first result of the first task record, when it is an object. Readers: `--page-all` (item count, `total_count`, token field), the `user_data` price tree, on_page `crawl_progress`.
     - `units(body)`: the Compact output units, in one numbering: `tasks[].result[].items[]` when a result has `items`, else `tasks[].result[]`. A unit carries its head line: the task line before the first unit of a task; for a result with `items`, the task line plus the other result fields before its first item. A result with `items: []`, or a task with no result, gives a head with no item.
     - `items(body)`: the items, numbered 1, 2, … in the same order. Derived from `units`.
     - Exit-table code sets ([exit codes](/spec/exit-codes-flags.md)): `isOk` (2xxxx, plus warnings 40106, 40102, 40007), `isAccount` (HTTP 401, 402; codes 40100, 40104, 40200, 40201, 40203, 40205, 40206, 40207, 40210), `isNotReady(code, get)` (40601, 40602; 20100 on a get only), `isExpired` (40403).
     - `succeeded(http, body)`: envelope success = HTTP < 300 and envelope `status_code` 20000.
   - **One numbering.** Compact output (Render), the Store item index (`item_fts.item`), `dfs store show <id> --from <n>` and `store search` hits all count items through `items`/`units`. Reason: two copies drift silently, and a search hit then opens the wrong item. Test: `test/store.test.ts` "store search and --from number items as Compact output does (results with and without items)".
   - **Not here:** Transport keeps its retry code sets (transient, paid transient). Lifecycle keeps the `id_list` "not served" set (40400, 40402) of the hand path. Login redaction runs on the JSON text (SQLite `json_tree`, then `json_remove`). Reason: exact JSON paths, and the stored text keeps the API's number digits.
   - **Callers:** Render (Compact output, outcome, task exit rule), Store (item index), Dispatch (price tree), `--page-all` (next page), Task ledger (task codes, cost, tag, message, collect state), Lifecycle (`tasks_ready` ids, `id_list` results).
