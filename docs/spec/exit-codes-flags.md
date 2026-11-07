---
type: Spec Section
title: Exit codes and global flags
description: Exit code table 0–6, task combining rule and v1 global flags.
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-07T00:00:00Z }
verified: [{ by: process:plan-verifier-blind-audit-9, at: 2026-11-07T00:00:00Z }]
status: stable
---

# Exit codes and global flags

### Exit codes

From 28:148–165, with the 31 amendments (28:158–159; 31:142, 31:192) and the exit-2 codes added in 28:191:

| Exit | Meaning | Money spent? | Cases |
|---|---|---|---|
| 0 | ok | yes | 20000, 20100. Warning only: 40106 partial results (unreturned pages not charged), 40102 no search results (billable, r31:110), 40007 notice |
| 1 | API or network error, after retries | maybe | HTTP 404, 500; 5xxxx; 40401; 40403; 40404 sandbox no data; 405xx; connection lost after a paid send; every task of the call failed |
| 2 | account: the owner must act | no | HTTP 401, 402; 40100, 40104, 40200, 40201, 40203, 40205, 40206, 40207, 40210; missing credential variable |
| 3 | invalid input, nothing sent | no | unknown command, bad JSON, body outside the spec, >100 tasks, Live >1 task (or >20 where documented), >8 filters |
| 4 | cost guard: nothing **more** sent; anything already paid is saved | no more | estimate above the ceiling; unknown or unbounded price with no explicit `--max-cost`; `--page-all` stop |
| 5 | dfs internal bug | — | unexpected exception; response not saved anywhere |
| 6 | incomplete: at least one task failed **or is not ready** | yes | good tasks on stdout; stderr task lines; `+run` timeout or `--wait 0`; 20100 on a get, 40601, 40602 |

- Combining tasks (28:160 "worst class wins, 2 > 1 > 6 > 0"), read with 28:156 and 31:151 ("exit 6 or 1"): 2 if any task is in the account class; else 1 if the request failed or every task failed; else 6 if any task failed or is pending; else 0. Agent reading of three lines that must agree.
- Codes not in the table: 4xxxx → 1, 5xxxx → 1 (agent design; reason: unknown means "API refused", and money may be spent).
- Exit 3 guarantees that no request left the machine (28:162). The numbers match gapi where the meaning matches (0, 1, 2, 3, 5) (28:163; r28:58).

### Global flags (v1)

Kept: `--body`, `--full`, `--sandbox`, `--dry-run`, `--page-all` (follows `offset` to 10,000, then `offset_token` / `search_after_token`), `--max-cost <usd>`, `--fresh`, `--wait <s>` (helpers), `--no-validate` (Planner) (28:171; 31:118, 31:130). Dropped: `--items`, `--fields`, `--output`, `--tag`, `--params`, `--method`, `--mode`, `--cache`, `--no-store`, `--db` (28:114, 28:118, 28:172; 31:139, 31:179).
