---
type: Module Design
title: Render module
description: stdout, stderr and the exit code.
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-07T00:00:00Z }
verified: [{ by: process:plan-verifier-blind-audit-9, at: 2026-11-07T00:00:00Z }]
status: stable
---

# Render module

7. **Render** — stdout, stderr and the exit code.
   - Compact output (default), from 28:135–139:
     1. Envelope removed; its cost and status go to the stderr line.
     2. Empty values removed: `null`, `""`, `[]`, `{}`. Other values verbatim: no rounding, no renaming.
     3. Compact JSON, one item per line. Items, task lines and their numbering come from [Envelope](/spec/modules/envelope.md) `units`.
     4. Budget 9,000 characters per command for stdout and stderr together, shared by all pages of `--page-all` (28:171; amended 2026-11-07, 28 end). stderr lines (status, errors, warnings) take their room first; items fill the rest. At the budget dfs stops after a whole item and prints a cut line, e.g. `{"dfs":"cut","shown":18,"total":100,"more":"dfs store show r_8f3k --from 19"}`. `--from` is 1-based.
   - **Line kinds (agent design):** a line whose only dfs key is `"dfs"` is made by dfs; all other lines are API items.
     - Before the items of each task: one task line `{"dfs":"task","id":…,"status_code":…,"tag":…}` plus the result-level fields except `items`, with empty values removed. Reason: with many tasks, an agent must know which task an item belongs to, and adding keys inside items would break "no renaming".
     - An item longer than the whole budget is replaced by an outline line `{"dfs":"outline","item":<n>,"keys":{"<key>":<chars>,…},"more":"dfs store show <id> --full"}`. Reason: a `user_data` result alone can pass the budget, and "shown 0" with no map would leave the agent blind.
   - **Output (epic #32 D2).** One writer per command; the command creates it with its mode. Every line it writes counts against the budget.
     - Modes. Default (plain call, `+run`, `+collect`, `store` commands): every stderr line prints at once. `--page-all`: a stderr line prints only while it fits the budget minus reserved room; else Output counts it as hidden. Status, outcome and error lines of a plain call and Lifecycle are never hidden.
     - Warnings: `dfs: warning: <text>`, once per text per command. A caller can give a key in place of the text: `tasks_ready failed` ignores the response id.
     - Reserve: room for closing lines known in advance (the `--page-all` stop line, the Lifecycle remedy, the `+<n> more lines` line). `--page-all` mode also keeps 100 characters for a page's cut line.
     - Response: one response as Compact output in the room left. Compact output returns its text, shown, total and cut as data. After the first cut, later responses print nothing.
     - Response list (`+run`, `+collect`): the list cut line `{"dfs":"cut","tasks":<n>,"total":<n>,"more":"dfs store list"}` keeps its room. A response cut before its first item prints only that line. A cut response that is not the last prints its items, then that line.
     - Block: the lines that fit, then the block's own cut line. Used for `store list/search/spend/sql` rows (stdout) and Lifecycle task lines (stderr). The Lifecycle remedy line follows the block and keeps its room first.
     - Unbudgeted: `--full` text and the `--dry-run` plan.
     - Exit: the worst class of the command wins, 2 > 1 > 6 > 0 ([exit-codes-flags.md](/spec/exit-codes-flags.md), combining rule). Exits 3, 4 and 5 end the command at once. The `--page-all` stop closes with exit 4.
     - Close: the hidden-lines line `dfs: +<n> more lines — all pages: dfs store list` (`--page-all` only), the final line, then the exit code.
   - **outcome.** The stderr lines after the status line of one response, and its exit class. Code sets come from Envelope. `get`: 20100 is pending on a get, task created (ok) on a post.
   - **Task exit rule** (`+run`, `+collect`), first match wins:
     1. 2: a failed or expired task is in the account class.
     2. 1: every task failed or expired.
     3. 6: a task is not collected.
     4. 0: else.
     - Output combines it with the request classes. These are a failed post, a failed `id_list` call, an account stop, and a pending task whose last collect failed (class 1).
   - **Line order per call.** Status line first, then the warnings of that call, then the outcome lines. Warnings raised before the send (Planner, price tree, estimate) print at once, before the status line.
   - `--full`: the exact API response. With `--page-all`, one line per page, like gapi (28:140, 28:171).
   - **Agent design (ticket 12):** `--page-all` (Output `--page-all` mode) writes per page: stderr lines, then its Compact items, from the budget left; room for the closing lines (stop line, `dfs: +<n> more lines — all pages: dfs store list`) is kept first. After the first cut line, later pages print no items; stderr lines that no longer fit are counted in the `+<n> more lines` line. The cut line names its own page row. `--full` drops line breaks of the API text (JSON allows none inside strings).
   - `--dry-run` (agent design on 28:171): one JSON object on stdout with `method`, `url`, `body`, `tasks`, `estimate` (`usd` number or `null`, `basis` = `rule`/`unknown`/`unbounded`, `price_at`), `ceiling`, `guard` (`send`/`refuse`), `reuse` (stored id or `null`) and `spec` (SHA of the spec in use). No auth header. Exit 0 when the plan is valid, also when `guard` = `refuse`; exit 3 when it is invalid. It makes no call to DataForSEO and uses the stored price tree at any age. Reason: aviato reads `estimate.usd` to set `--max-cost` = 3× the estimate (46:315), and a dry run must work with no credentials and in CI.
   - stderr status line, one per call: `dfs: <status_code> <spec path> tasks=<n> cost=$<real> est=$<estimate> saved=<id>`, or `reused=<id> age=<age>` instead of `saved=` (28:127, 28:141; 31:117). Errors: `dfs: <code> <message> — <remedy>`. Warnings: `dfs: warning: …` (28:165).
   - **Body not a JSON object (epic #32, D9-B7).** Error line `dfs: HTTP <status> — not a JSON object: <first 200 characters, whitespace collapsed>`, exit 1; control characters collapse like whitespace; the excerpt counts against the budget. HTTP 401, 402 keep the owner remedy: `dfs: HTTP <status> — the account owner must act: check credentials, balance and limits`, exit 2. A failed price refresh with such a body warns `price tree refresh failed (HTTP <status>, not a JSON object)`. Reason: `dfs store show` cannot print such a body (no JSON body stored for HTML; no items in an array).
   - Task lines for exit 6 (agent design, stable for programs): `dfs: task <id> pending <status_code>` or `dfs: task <id> failed <status_code> <message>`. When the task lines do not fit the budget, dfs prints those that fit and then `dfs: task +<n> more — states in the Store table task` (query by `dfs store sql`). Reason: an exit 6 of 100 pending tasks has about 7,000 characters of task lines (agent design, 2026-11-07). aviato should read task states from the Store; these lines carry the same facts for agents (46:320–321).

   - **Budget rationale (agent design, 2026-11-07).** 9,000 leaves 1,000 characters under the 10,000 window for the Bash wrapper. dfs counts UTF-16 code units, never fewer than characters. dfs never reads `BASH_MAX_OUTPUT_LENGTH`: the `bashOutputMaxChars` setting overrides it and the failure window is fixed (code.claude.com/docs/en/env-vars, tools-reference#output-limits). Pattern: the owner's `tb get` tool keeps output below the window and names the next range on its last line.
