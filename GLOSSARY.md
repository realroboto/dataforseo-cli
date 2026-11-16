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
The check that refuses a paid call before the send, with exit 4. It refuses an estimate above the ceiling. Without `--max-cost`, it also refuses an unknown or unbounded price. Ceiling: `--max-cost`, else `DFS_MAX_COST`, else $1.
_Avoid_: budget (budget is the output limit), spend limit

**Reuse**:
A paid request gets the stored response at $0 when the same request fully succeeded in the last 12 h (ADR 0003).
_Avoid_: cache, cache hit

**Dispatch**:
The module that runs one planned call: Reuse check, estimate, cost guard, send, save, task rows, outcome. Lands in epic #32 R5a.
_Avoid_: executor, sender

### Response and output

**Envelope**:
The top-level object of a DataForSEO response (`status_code`, `cost`, `tasks[]`), and the module that reads it. It succeeds when HTTP < 300 and `status_code` is 20000.
_Avoid_: wrapper, payload

**task**:
One element of `tasks[]` in a response; also its row in the Store `task` table (state pending, collected, failed or expired, and cost).
_Avoid_: job

**Item**:
One element of data in a response: `tasks[].result[].items[]` when a result has `items`, else `tasks[].result[]`. Compact output, `store show --from` and `store search` number items 1, 2, … in one order.
_Avoid_: row (a row is in the Store), entry

**Compact output**:
The default stdout: no envelope, no empty values, one item per line, and task lines. A cut line ends it at the 9,000-character budget (ADR 0001).
_Avoid_: summary, short output

**Output**:
The writer in Render, one per command. It owns the 9,000-character budget, prints each warning once, and keeps the worst exit class.
_Avoid_: printer, logger

### Storage

**Store**:
The local `node:sqlite` file that keeps every response, saved before anything prints. It also holds the price tree, `task` rows and the item search index.
_Avoid_: database, cache

**Store handle**:
The one Store connection of a command: opened on first use, closed by `run()`. Command modules get it; only the Store module opens the Store file.
_Avoid_: connection pool, DB client

**Task ledger**:
The module that owns the `task` and `sync` tables. Callers hand it responses; it writes task rows and applies the cost rule.
_Avoid_: task store, task tracker
