# dataforseo-cli (`dfs`)

`dfs` is an agent-first CLI for the DataForSEO API. It guards money, saves every response, and keeps output in one budget. Module docs: [docs/spec/modules/index.md](docs/spec/modules/index.md).

## Language

### Request and money

**Catalog**:
The vendor OpenAPI spec as a command tree: words resolve to an endpoint.
_Avoid_: registry, API map

**Planner**:
The module that turns words, flags and body into a call plan, or exits 3.
_Avoid_: validator, builder

**price tree**:
The `price` node of the `/v3/appendix/user_data` response, kept in the Store `price` table. Price rules read it.
_Avoid_: price list, rate card

**cost guard**:
The check that refuses a paid call before the send (exit 4) when the estimate passes the ceiling, or the price is unknown or unbounded and no `--max-cost` is given. Ceiling: `--max-cost`, else `DFS_MAX_COST`, else $1.
_Avoid_: budget (budget is the output limit), spend limit

**Reuse**:
A paid request that matches a fully successful stored response from the last 12 h returns that response at $0 (ADR 0003).
_Avoid_: cache, cache hit

**Dispatch**:
The module that runs one planned call from the Reuse check to the outcome: estimate, cost guard, send, save, task rows. Lands in epic #32 R5a.
_Avoid_: executor, sender

### Response and output

**Envelope**:
The top-level object of a DataForSEO response: `status_code`, `status_message`, `cost`, `tasks_count`, `tasks[]`. Also the module that reads a response body. Envelope success: HTTP < 300 and `status_code` 20000.
_Avoid_: wrapper, payload

**task**:
One element of `tasks[]` in a response; also its row in the Store `task` table (state pending, collected, failed or expired, and cost).
_Avoid_: job

**Item**:
One unit of data in a response: `tasks[].result[].items[]` when a result has `items`, else `tasks[].result[]`. Items are numbered 1, 2, … per response; Compact output, `store show --from` and `store search` use the same number.
_Avoid_: row (a row is a Store record), entry, record

**Compact output**:
The default stdout: envelope removed, empty values removed, one item per line, task lines, and a cut line at the 9,000-character budget (ADR 0001).
_Avoid_: summary, short output

**Output**:
The per-command writer in Render: it owns the 9,000-character budget of stdout and stderr, prints each warning once, and keeps the worst exit class. Lands in epic #32 R4.
_Avoid_: printer, logger

### Storage

**Store**:
The local `node:sqlite` file that keeps every response, saved before anything prints, plus the price tree, `task` rows and the search index.
_Avoid_: database, cache

**Store handle**:
The one Store connection of a command: opened on first use, closed by `run()`. Lands in epic #32 R2.
_Avoid_: connection pool, DB client

**Task ledger**:
The module that owns the `task` and `sync` tables: callers hand it responses, it writes the task rows and applies the cost rule. Lands in epic #32 R3.
_Avoid_: task store, task tracker
