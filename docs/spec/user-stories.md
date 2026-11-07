---
type: Spec Section
title: User stories 1–32
description: User stories 1–32 of dfs v1 - endpoints, input errors, spend, reuse, Standard tasks.
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-07T00:00:00Z }
verified: [{ by: process:plan-verifier-blind-audit-9, at: 2026-11-07T00:00:00Z }]
status: stable
---

# User stories 1–32

## User Stories

Actors: **agent** (LLM in a Claude Code session), **owner** (person who pays and maintains), **aviato job** (unattended program, 46:310), **maintainer** (agent in a release session).

### Reach every endpoint

1. As an agent, I want each spec path to be a command whose words are the path words (`dfs serp google organic live advanced`), so that the docs URL maps to the command with no lookup (28:112).
2. As an agent, I want path parameters as positional values in their slot (`dfs serp google organic task_get advanced <id>`), so that ids and countries need no flag (28:113).
3. As an agent, I want the HTTP method implied by the spec, so that I never pass `--method` (28:114; r28:82).
4. As an agent, I want `--body` to take a JSON object, a JSON array, `@file` or `-` for stdin, so that I can pass one task, a batch, or a generated file (28:115).
5. As an agent, I want `--help` at every level to list the children, so that I can explore 12 modules with no `ls` command (28:116).
6. As an agent, I want `dfs schema <words…>` to show request and response fields, so that I can write a valid body (28:116).
7. As an agent, I want `dfs search "<words>"` to find endpoints by path words and descriptions, with case and diacritics folded, so that I can find "AI Mode" or "migração"-like terms fast and offline (34:142–143).
8. As an agent, I want `dfs --version` to show the dfs version and the spec commit and date (`dfs 0.1.0 (spec 55a4ed0, 2026-10-26)`), so that I know which API surface I see (34:92).
9. As an agent, I want `--sandbox` to send the same command to the free sandbox with the same credentials, so that I can rehearse at $0 (28:106, 28:171; r34:49–51).
10. As an agent, I want `--dry-run` to validate and show method, URL, body, task count and the cost estimate, with nothing sent, so that I can check a call before I pay (28:171).
11. As an agent, I want `postback_url` and `pingback_url` to pass as plain body fields, so that nothing in the API is hidden from me (28:173).

### Input errors stop before the network

12. As an agent, I want an unknown command, bad JSON, an unknown field, a wrong JSON type, >100 tasks, >1 task on Live, or >8 filters to exit 3 with nothing sent, so that a mistake costs $0 (28:153, 28:162; 34:161).
13. As an agent, I want the exit 3 message to name the field and the remedy (fix the body, or `--no-validate` when the DataForSEO docs list the field), so that I can fix the body in one try or pass a field the vendor spec lacks (format 28:165; naming the field and `--no-validate` are agent design, Planner).

### Spend money safely

14. As the owner, I want a $10 daily account spend limit set at DataForSEO, so that a dfs bug cannot spend more than $10 a day (31:103).
15. As the owner, I want a default cost ceiling of $1 per command, changeable by `DFS_MAX_COST` or `--max-cost <usd>`, so that one command cannot spend much by default (31:104).
16. As an agent, I want dfs to refuse with exit 4 and nothing sent when the estimate passes the ceiling, so that overspend is impossible without an explicit choice (28:154; 31:104).
17. As an agent, I want dfs to refuse a path with no **Price rule** (G:74) unless I pass `--max-cost` explicitly, so that a new paid endpoint cannot spend unseen money (31:105; 34:93).
18. As an agent, I want `--page-all` to stop before the page that would pass the ceiling, keep the paid pages, and exit 4 with the rerun command, so that I keep what I paid for (31:189–192).
19. As the owner, I want dfs to warn on stderr when the real cost passes the estimate and to store both, so that bad price rules show up (31:105).
20. As the owner, I want `dfs store spend --since <age> --by day|module|path|tag` to sum real costs, so that I can see where money went (31:175).
21. As an agent, I want to check credentials and balance with `dfs appendix user_data` (free), so that no extra auth command exists (28:105).

### Never pay twice by accident

22. As an agent, I want the same paid request (same path, same canonical body, same sandbox flag) within 12 h and fully successful to return the stored response at $0, with stderr `reused=<id> age=<age>`, so that a repeat costs nothing (31:116–117).
23. As an agent, I want `--fresh` to force a new paid call, so that I can get new data when I need it (31:118).
24. As an agent, I want free calls (`task_get`, `tasks_ready`, `id_list`, `user_data`, `locations`, …) to always go to the API, so that their data is current (31:119).
25. As an agent, I want a repeated `task_post` inside the window to collect the tasks already posted instead of posting again, so that a retry never doubles a batch (31:120).

### Standard tasks without loss

26. As an agent, I want `+run <variant>` at each endpoint level that has `task_post`, taking any number of tasks, so that I post, wait and collect in one command (31:127–131).
27. As an agent, I want dfs to save every post response with its task ids before it waits, so that a crash loses nothing (31:129).
28. As an agent, I want `+run` to wait up to `--wait` (default 90 s; `0` = post only) and exit 6 with the pending ids and `dfs +collect` on timeout, so that my command fits under the 2-minute tool limit (31:125, 31:130–132).
29. As an aviato job, I want `+run --wait 0` to exit 6 with every id listed as pending, so that the step is done and later ticks collect (46:321; 31:130).
30. As an agent or aviato job, I want `dfs +collect` (root: all modules; module level: one module) to collect pending tasks, recover lost ids through `id_list` (every task module; `ai_optimization` through a hand path, 31:214), record costs of lost Live tasks, and mark tasks older than 30 days as expired, so that every paid task ends in the Store (31:133–137).
31. As the owner, I want dfs never to re-post a pending task, so that the open-seo #489 double billing cannot happen (31:138).
32. As an agent, I want to pick the mode by the path (`live` or `task_post`) with no `--mode` flag, so that dfs never switches mode behind my back (31:139).

Next: [User stories 33–58](/spec/user-stories-2.md).
