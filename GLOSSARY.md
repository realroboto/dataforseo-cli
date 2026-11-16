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

**free path**:
A spec path on the Pricing free list: it never charges. Every other path is a paid path. A request on a free path is a free call; on a paid path, a paid call. Transport retries the two by different rules (ADR 0004).
_Avoid_: free endpoint, cost-0 call

**estimate**:
The worst-case price of a call, from its body: price rule × price tree. Unknown when no price tree or rule node exists, or a count or page field is not a number. Unbounded when the cost settles after the run (LLM Responses).
_Avoid_: quote, expected cost

**cost guard**:
The check that refuses a paid call before the send, with exit 4. It refuses an estimate above the ceiling. Without `--max-cost`, it also refuses an unknown or unbounded price. Ceiling: `--max-cost`, else `DFS_MAX_COST`, else $1.
_Avoid_: budget (the output limit), spend limit (the DataForSEO account limit, 40203)

**Reuse**:
A paid request gets the stored response at $0 when the same request fully succeeded in the last 12 h (ADR 0003).
_Avoid_: cache, cache hit

**Dispatch**:
The module that runs one planned call: Reuse check, estimate, cost guard, send, save, task rows, outcome.
_Avoid_: executor, sender

**Fetch free**:
The Dispatch step that sends one free request: `tasks_ready`, a collect call, `id_list`. It has no Reuse, no cost guard and no status line. It saves the response before use.
_Avoid_: raw fetch

### Response and output

**Envelope**:
The top-level object of a DataForSEO response (`status_code`, `cost`, `tasks[]`), and the module that reads it. It succeeds when HTTP < 300 and `status_code` is 20000.
_Avoid_: wrapper, payload

**task**:
One element of `tasks[]` in a response; also its row in the Store `task` table (state pending, collected, failed or expired, and cost).
_Avoid_: job

**collect call**:
The free call that fetches a task's result: `task_get` with the task's variant; on_page `summary/{id}`.
_Avoid_: get call, result fetch

**Item**:
One element of data in a response: `tasks[].result[].items[]` when a result has `items`, else `tasks[].result[]`. Compact output, `store show --from` and `store search` number items 1, 2, … in one order.
_Avoid_: row (a row is in the Store), entry

**Compact output**:
The default stdout: no envelope, no empty values, one item per line, and task lines. A cut line ends it at the 9,000-character budget (ADR 0001).
_Avoid_: summary, short output

**budget**:
The 9,000-character limit on stdout and stderr together, per command (ADR 0001). Output owns it.
_Avoid_: output cap, window (the window is the Bash wrapper's 10,000 characters)

**Output**:
The writer in Render, one per command. It owns the budget, prints each warning once, and keeps the worst exit class.
_Avoid_: printer, logger

**outcome**:
The stderr lines after the status line of one response, and its exit class. Render builds it from the Envelope code sets.
_Avoid_: result (a result is in `tasks[].result[]`), verdict

**exit class**:
The exit code that one request or task set asks for. Output keeps the worst, 2 > 1 > 6 > 0. Exits 3, 4 and 5 end the command at once (ADR 0002).
_Avoid_: exit status, error level

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
