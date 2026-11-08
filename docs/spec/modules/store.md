---
type: Module Design
title: Store module
description: `node:sqlite`, one file per user.
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-07T00:00:00Z }
verified: [{ by: process:plan-verifier-blind-audit-9, at: 2026-11-07T00:00:00Z }]
status: stable
---

# Store module

5. **Store** — `node:sqlite`, one file per user.
   - Place: `~/.config/dfs/store.db`; `DFS_CONFIG_DIR` overrides the dir. Dir 700, file 600 (31:161). WAL; busy timeout 30 s (31:163). Kept forever; no `prune` in v1 (31:162).
   - Save before print: each response is saved before any stdout (28:134).
   - **Login redaction (agent design, 2026-11-07).** Before save, dfs removes `login` from each `user_data` result (`AppendixUserDataResultInfo` carries it, spec `55a4ed0`). Reason: the login is never stored (31:167), and save before print would store it.
   - Failed save: write `~/.config/dfs/unsaved/<id>.json` (600), print as usual, warn; the next run imports the file. If that write also fails: print the full output and exit 5 with `dfs: 5 response not saved — stdout is the only copy` (31:164).
   - Data model (agent design, 31:194–201; columns named here are a contract, see below):
     - `response`: one row per HTTP exchange. Columns: id `r_…`, time, method, spec path, concrete path, sandbox, request body, HTTP status, envelope `status_code`, envelope `cost`, estimate, `reused_from`, dfs version, spec SHA (34:92), body as JSONB (verbatim), `reuse_key` (added in `user_version` 3, indexed with time). This table is the truth of the Store (31:196).
     - `task`: one row per DataForSEO task id. Columns: post response id, path, variant, state (`pending`, `collected`, `failed`, `expired`), `status_code`, `cost`, `tag`, posted time, collected time, collect response id (31:197), plus `sandbox` (agent addition: spend skips sandbox tasks). Added in `user_version` 4; column names: `id`, `post_response`, `path` (the `task_post` spec path; a recovered Live id: its Live path), `variant` (null when the collect path has no variant word), `state`, `status_code` (last known task code), `cost`, `tag`, `posted_at`, `collected_at`, `collect_response`, `sandbox`. Live tasks get a row too, collected at once. Writers: `+run` and `+collect`; and every sent call on a paid path that is not `task_post` (Live, plus `serp/screenshot`, `serp/ai_summary`, `on_page/page_screenshot`, `on_page/instant_pages`, `merchant/google/sellers/ad_url`) writes one row per task, `collected` (or `failed`) at once, `post_response` = `collect_response` = its response, `variant` null (ticket 13). A plain `task_post` writes none; `+collect` recovers its ids through `id_list`. A reuse row writes none. A row recovered by `+collect` has `post_response` = the `id_list` response id and `path` = the path of the `id_list` `url` (a Live path for a Live id). **Agent design (amended 2026-11-07):** `cost` is set from the post or Live response, the call that charges. A later report of the same task (`task_get`, `id_list`) replaces it only when non-zero and different; a 0 never replaces it. A lost task's first cost comes from `id_list` (r31:131). Reasons: LLM Responses settles after completion (r31:84); whether `task_get` and `tasks_ready` echo the post cost or report 0 is not verified (vendor docs examples differ), and this rule is correct either way.
     - `item_fts`: FTS5 `unicode61 remove_diacritics 2`, one row per item (`tasks[].result[].items[]`, else `tasks[].result[]`). It holds every string value of the item and is derived from `response.body`, so it can be rebuilt (31:176, 31:198). Added in `user_version` 6; columns `text` (string values of the item, joined by line breaks; keys not included), `response` (response id), `item` (item number, as `dfs store show <response> --from <item>` counts it). Written in the transaction of its `response` row; migration 6 fills it from stored bodies.
     - `price`: the `user_data` price tree and its fetch time; written only as the Pricing module says (31:199). Columns: `id` (always 1, one row), `fetched_at` (ISO 8601), `tree` (the `price` node as JSONB). Added in `user_version` 2.
     - `sync`: last `id_list` pass per module (31:199). Added in `user_version` 5; columns `module` (key), `last_pass` (ISO 8601, the `datetime_to` of the last full pass). **Agent design:** Store creation time = time of its first `response` row; dfs keeps no separate creation stamp.
   - **Spend source (agent design):** `store spend` sums `task.cost` over non-sandbox tasks. It does not sum `response.cost`. Reason: one task appears in several responses (post, collect, `id_list`), and `id_list` echoes the cost of a task paid earlier (r31:131), so a sum over responses can count the same charge twice; sandbox responses carry dummy data (r34:51). A reuse row has `reused_from` set and no body, and adds no cost.
   - **Store contract (agent design):** aviato attaches the Store read-only and queries it (41:145; 46:313–314). So the schema is a public contract, documented in the dfs repo, with `PRAGMA user_version` as its version. A dfs writer migrates forward on open. A breaking schema change is a major version, like the fbg rule for command shape and exit codes (r28:65).
   - Commands (31:173–178): `store show <id> [--from <n>] [--full]`, `store list [--since <age>] [--path <words…>]`, `store spend [--since <age>] [--by day|module|path|tag]`, `store search "<words>" [--path …] [--since …]`, `store sql "<select>"` (read-only connection), `store backup <file>` (`node:sqlite` `backup()`, file 600), `store path`.
   - **Store command output (agent design, ticket 13).** All JSON lines, cut to the 9,000-character budget with `{"dfs":"cut","shown":<n>,"total":<n>}`. `<age>` = `<n>m`, `<n>h` or `<n>d` before now; `--path <words>` = one argument, path words (`"serp google"`, `serp/google` or `/v3/serp/google`), matches that spec path and every path below it.
     - `store search`: every word must match one item (FTS5 AND; each word quoted, so FTS5 syntax is plain text). Newest response first. Line: `{"id","time","path","item","snippet","more":"dfs store show <id> --from <item>"}`; snippet marks hits `[…]`.
     - `store spend`: first line `{"dfs":"spend","since":<ISO|null>,"cost":<usd>,"tasks":<n>}`, then one line per group (`{"<by>":<key>,"cost","tasks"}`): days newest first, other groups by cost. `--since` reads `task.posted_at`. Day = UTC date. Module = path word after `/v3/`. Cost rounds to 10 decimals.
     - `store sql`: one statement on a read-only connection (`readOnly: true`); SQLite refuses writes. A statement with no result columns (`VACUUM INTO`, which a read-only connection still runs) exits 3 too. Rows print as JSON lines; a BLOB prints `<blob <n> bytes; select json(…)>` (JSONB columns: `json(body)`, `json(tree)`). Faults exit 3.
     - `store backup <file>`: `node:sqlite` `backup()` in one step (all pages, one read transaction), so writers in other processes never restart it; file 600 before the first page; prints `<file>`. The copy keeps WAL mode.
   - **Concurrent create (agent design, ticket 13).** Switching a new file to WAL takes a lock SQLite does not wait for (SQLITE_BUSY with no busy handler); dfs retries it for 30 s. Migration reads `user_version` inside one `BEGIN IMMEDIATE` transaction, so two processes never run one step twice.
   - **Schema contract (`PRAGMA user_version = 6`).** A fresh Store has exactly this schema (test `test/store.test.ts` compares it with `sqlite_master`; FTS5 shadow tables `item_fts_*` not listed). Versions: 1 `response`; 2 `price`; 3 `response.reuse_key` + index; 4 `task`; 5 `sync`; 6 `item_fts`. A reader (aviato) attaches read-only and checks `user_version`; added columns or tables are minor changes, a dropped or renamed one is a major version.

```sql
CREATE TABLE response (
  id TEXT PRIMARY KEY,
  time TEXT NOT NULL,
  method TEXT NOT NULL,
  spec_path TEXT NOT NULL,
  path TEXT NOT NULL,
  sandbox INTEGER NOT NULL,
  request TEXT,
  http_status INTEGER NOT NULL,
  status_code INTEGER,
  cost REAL,
  estimate REAL,
  reused_from TEXT,
  dfs_version TEXT NOT NULL,
  spec_sha TEXT NOT NULL,
  body BLOB
, reuse_key TEXT);
CREATE TABLE price (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fetched_at TEXT NOT NULL,
  tree BLOB NOT NULL
);
CREATE INDEX response_reuse ON response (reuse_key, time);
CREATE TABLE task (
  id TEXT PRIMARY KEY,
  post_response TEXT NOT NULL,
  path TEXT NOT NULL,
  variant TEXT,
  state TEXT NOT NULL,
  status_code INTEGER,
  cost REAL,
  tag TEXT,
  posted_at TEXT NOT NULL,
  collected_at TEXT,
  collect_response TEXT,
  sandbox INTEGER NOT NULL
);
CREATE TABLE sync (
  module TEXT PRIMARY KEY,
  last_pass TEXT NOT NULL
);
CREATE VIRTUAL TABLE item_fts USING fts5(
  text,
  response UNINDEXED,
  item UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

   - Reuse key: sha256 of the canonical request: spec path with values, body with keys sorted and no whitespace, sandbox flag (31:116, 31:200). **Agent design:** keys sorted at every depth; array order kept. Reuse source: newest row with that key, a body, no `reused_from`, time at most 12 h old, and a full success (envelope 20000, HTTP below 300, no failed task; warning codes that exit 0, such as 40102, count as success). A reuse saves a row with `reused_from`, cost 0, estimate 0, no body.
