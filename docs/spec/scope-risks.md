---
type: Spec Section
title: Out of scope, owner checklist and risks
description: What v1 excludes, owner setup steps, unverified facts and risks.
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-07T00:00:00Z }
verified: [{ by: process:plan-verifier-blind-audit-9, at: 2026-11-07T00:00:00Z }]
status: stable
---

# Out of scope, owner checklist and risks

## Out of Scope

- MCP servers (map Out of scope; 02).
- `.ai` responses; curated TSV output (28:125–126).
- `--mode`; dfs never switches mode (31:139). The mode per use is aviato's input (31:206; 46:311).
- Postback/pingback helpers; they need a public URL (31:140).
- `prune`, store compression, trigram URL search, per-module field maps (31:162, 31:179, 31:201).
- `dfs auth`, credentials file, `DATAFORSEO_USERNAME` alias (28:101–103).
- oasdiff, auto-PR or auto-merge on drift, openapi-typescript codegen (34:37, 34:107).
- Weekly sandbox runs on GitHub (34:136).
- TypeScriptClient `knowledge-base/` as a search source (34:144).
- launchd jobs, backup schedule, tag spelling, cost view: aviato (31:206; 46:310–315).
- Map fog, beyond v1: dfs skill content and helpers beyond the rules in User Story 58; Store size measurement after the first month (map Not yet specified).

## Further Notes

### Owner setup checklist (not build tickets)

1. DataForSEO dashboard → Settings → API Settings: daily spend limit $10 for the whole account (31:103, 31:208).
2. GitHub notification settings → Actions → Email, failed workflows only (34:110).
3. Store the DataForSEO API login and password in the owner's secret store (46:341–342).
4. First npm publish, trusted publisher, first tag within 2 days (Release runbook step 5).
5. Approve each staged version on npm (34:152).
6. After the first release (Release runbook step 5), register dfs and its skill in the owner's private install repos (owner's own checklist).
7. After the first scheduled `spec.yml` run (it re-enables itself), set the repository variable `SPEC_CHECK_FORCE_FAIL` to `1`, wait for the next scheduled run (Monday 06:17 UTC), check that the failure email reaches the owner, then delete the variable. Not by `workflow_dispatch`: a manual run notifies the user who started it, so it proves nothing about scheduled runs. If it does not, report it to the agent: the alert path must change before the drift check is trusted (Risks, `spec.yml` re-enable).

### Risks and unverified facts

- `node:sqlite` is a release candidate; status can change inside LTS (r23:55).
- The self re-enable of `spec.yml` may not reset the 60-day timer; GitHub docs do not confirm it (34:109; r34:38).
- The need to publish a first version by hand before a trusted publisher exists is indicated, not confirmed (34:151; r34:44).
- Live retrieval by id, and which `task_get` variant counts as "collected", are unverified (r31:136).
- `/v3/ai_optimization/id_list` is not in the spec; only the docs and the price tree list it (r31:132). Not yet called with real credentials, and the sandbox may not prove the real API. If the API does not serve it, lost `ai_optimization` ids stay lost and `+collect` warns (31:214).
- For the 5 fields the overlay adds (Vendor overlay), that the real API accepts them is read from the vendor's own examples, not checked; the sandbox may not validate fields. A 40506 from the real API means the overlay entry is wrong: remove it.
- Charging of 405xx refusals is unverified (r31:115). This is why the Planner stays strict by default and `--no-validate` is opt-in.
- on_page: `summary/{id}` with `crawl_progress` = `finished` as the collected mark is read from the spec, not checked on a real crawl. Whether `summary/{id}` is free is unverified; the crawl bills per crawled page, with a refund after completion (r31:70). `spec:check` condition 2 forces a free-list entry or a price rule for it.
- Whether Live results are kept 30 days: sources conflict (r31:169).
- Charging of 40103, 5xxxx and a dropped Live connection is unverified (r31:115–116). Retry rules assume the worst.
- Price rules are hand data for about 270 paid paths. The drift check covers paths, not prices; the daily price-tree check covers node names; the real-cost warning covers amounts.
- `tasks_ready` hides ids past the first 1,000 uncollected in its scope (r31:124). With 1,000 or more uncollected tasks of other runs, `+run` may not see its own ids and exits 6 at timeout; no money is lost, and `dfs +collect` collects them by direct collect calls.
- `spec.yml` re-enables itself with `GITHUB_TOKEN`. GitHub sends scheduled-workflow notifications to the user who re-enabled a disabled workflow (r23:62); whether an enable call on an enabled workflow counts is unverified. If it counts, failure emails go to the bot, not the owner. Owner setup checklist 7 checks it once.
- `task.cost` never takes a later 0 (Store). If DataForSEO reports a full refund as 0 (r31:114, r31:60), spend is overstated, never understated.
- The 1,000-character margin under the 10,000 window is an estimate; the docs say "roughly 10,000". A failed command keeps head and tail, so the cut line survives.
- shortcut: two processes that send the same paid request in the same second both pay; the reuse check sees no stored response yet. Upgrade with an in-flight claim row if `store sql` ever shows two paid rows with one reuse key under 12 h apart.
