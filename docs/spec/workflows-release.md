---
type: Spec Section
title: Workflows, release runbook and ADRs
description: ci.yml, spec.yml, spec:check conditions, pack check, publish.yml, release steps, ADR list.
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-07T00:00:00Z }
verified: [{ by: process:plan-verifier-blind-audit-9, at: 2026-11-07T00:00:00Z }]
status: stable
---

# Workflows, release runbook and ADRs

### Workflows (GitHub Actions)

- `ci.yml`: on pull_request and push to `main`. Runs typecheck, lint, test, build, pack check. No network, no secrets (34:116). Tests read the committed snapshot.
- **Pack check (agent design, 2026-11-07).** After `build`: `npm pack --dry-run --json` must list the snapshot and `spec/overlay.yaml`; then a test runs the built `dist` entry (not `src`) with a temp `DFS_CONFIG_DIR`, a fetch that fails, and asserts `dfs --version` shows the snapshot SHA and date and `--dry-run` of the `backlinks/anchors/live` example exits 0. Also in the `prepublishOnly` gate. Reason: gapi ships only `dist/` (`google-apis-cli/package.json:22`) and its seam 2 runs from the checkout (`google-apis-cli/test/cli.test.ts:7`), so no gapi test sees the tarball; a release without the overlay would refuse 85 filter fields, and one without the snapshot would break "never runs without a spec" (34:91).
- `spec.yml`: weekly `17 6 * * 1` plus `workflow_dispatch`. Runs `pnpm spec:check` against the newest master spec, with no secrets (34:100). When the repository variable `SPEC_CHECK_FORCE_FAIL` is `1`, the job fails after the re-enable step (alert check, Owner setup checklist 7). The job summary lists paths added and removed against the committed snapshot (34:106). Detection only: no auto PR, no auto merge (34:107). The job re-enables itself each run (`gh api -X PUT repos/<repo>/actions/workflows/spec.yml/enable`, `permissions: actions: write`), on its own line, with no third-party action (34:109). The file and its `cron` are created and edited from the owner's GitHub account, so that failure emails reach the owner (34:163; r23:62).
- `spec:check` fails when (34:101–105):
  1. the spec fails the runtime structural check;
  2. a spec path is neither on the free list nor covered by a price rule;
  3. a price rule, a helper or the free list names a path absent from the spec (a pattern must match at least one path); the `id_list` hand path is exempt (Lifecycle);
  4. a spec request example (272) fails dfs validation on the overlaid spec; or an overlay action has no target or changes nothing, so the overlay only shrinks as the vendor fixes faults (Catalog, Vendor overlay);
  5. a `task_post` level has no collect call (agent design, Lifecycle);
  6. the spec has the `id_list` hand path; the drift-fix session removes the hand entry (31:214);
  7. a request field named `filters` or `*_filters` has a typed `items` schema after the overlay. Reason: filter syntax is the one class of vendor type fault found (85 of 85 such fields in spec `55a4ed0`), and only 38 of the 272 examples carry a filter, so fields with no example need this check (check.py `examples`, `request.filter_field_names`).
- **Check scope (agent design, 2026-11-08, #16).** Code: `scripts/spec-check.ts`, pure `specProblems(spec, overlay)` plus `report()` (job summary), tested by fixtures in `test/spec-drift.test.ts`, no network. Condition 3 "helper" paths = planner 20-task paths and `user_data`; lifecycle paths come from the spec (condition 5 covers them). Condition 4 runs each example through `plan()` (types, names, filter count, task count). A structural fault (1) does not stop conditions 2–7; only a document with no `paths` or `components.schemas` does. `spec.yml` uses GitHub-owned actions only; pnpm from `npm install --global <packageManager>`; re-enable step runs first, forced failure last.
- **Release scope (agent design, 2026-11-08, #17).** `publish.yml`: guard (tag = `package.json` version, tag commit on `main`, like gapi), then `npm stage publish --provenance`; npm runs `prepublishOnly` itself before it stages (npm `lib/commands/publish.js`, also for `stage publish`). No npm token, no third-party action (pnpm as in `spec.yml`), environment `npm`, `permissions: id-token: write`. No GitHub Release step. The gate's `spec:check` reads the public vendor spec (network); publish.yml is no CI run, so testing.md "CI never uses the network" holds. `pnpm test:sandbox` = `scripts/sandbox.ts`: in-process `run()` per request example (POST, 272, unmodified but for time-bound dates (#26), snapshot + overlay, temp config dir with the daily check counted as done), pool of 4; each `task_post` example then calls every collect path of its level with each returned id (sandbox `tasks_ready` never lists own ids, probed 2026-11-08; sandbox `task_get` answers any id); hand `id_list` through `plan` + `exchange` (no dfs command). Verdict per command: exit 0 with no 40501/40506 = ok; else all error codes 40404 = coverage file entry; else failure. Coverage file `spec/sandbox-40404.json` (`sha`, `date`, `paths`), rewritten each run; baseline for "new 40404" = file at `HEAD` (git), none = first run. `pnpm fixtures:record` = `scripts/fixtures-record.ts`: 3 sandbox responses (`backlinks/anchors/live`, `serp/google/organic` `task_post` + `task_get/advanced`) to `test/fixtures/`, every `items` array cut to 3 entries, refused when it holds the login. Both scripts refuse outside macOS and under `CI`.
- **Sandbox finding (2026-11-08, spec `55a4ed0`).** First run: 3 paths 40404, 14 failures: 11 `id_list` examples (10 + hand path; `datetime_from` older than 1 month with `include_metadata: true`, vendor docs `serp/id_list`), 2 `hotel_searches` examples (`check_in` in the past), `merchant/amazon/sellers/task_post` (`language_code` invalid). 13 are time-bound vendor examples: unmodified, they fail every run. Resolved (#26): `datetime_from`/`datetime_to` and `check_in`/`check_out` move into vendor window (testing.md seam 3); overlay sets amazon/sellers `language_code` `en_US`; 11 `id_list` paths in window answer 40404, now in coverage file.
- `publish.yml`: on tag `v*`. Runs the `prepublishOnly` gate, then `npm stage publish` by OIDC with provenance. The version goes out only after the owner approves it on npm (34:152). Gate order, like gapi: typecheck → lint → test → spec:check → build (r22:27) → pack check (dfs addition).

### Release runbook

1. `pnpm up --latest`; check the newest Node LTS line; tests green (10:21).
2. `pnpm spec:snapshot`; commit the snapshot when its SHA changed; tests green (Catalog, Snapshot source).
3. `pnpm test:sandbox` on the Mac (34:131–133, 34:154), with `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` set; commit `spec/sandbox-40404.json` when it changed. A new fixture need: `pnpm fixtures:record`, commit `test/fixtures/`.
4. Tag `v<version>` on `main` → `publish.yml` → owner approves the staged version on npm (34:152).
5. First release only: the owner publishes an empty `0.0.0` by hand (own npm login + 2FA), sets the trusted publisher in the package settings (staged publish allowed), and tags `v0.1.0` within 2 days, before the new config expires (34:151; r34:43–45).

### ADRs (written 2026-11-08, #19: [ADR index](/adr/index.md))

From 28:187, 31:210 and 34:171: compact output by default; exit-code table; reuse on by default (a deviation from gapi ADR 0001, 31:121); no retry of a paid request without proof of cost 0; spec source = runtime check + snapshot; sandbox contract test on the Mac only, no DataForSEO login on GitHub; staged publish; vendor spec corrected by an Overlay 1.0 file, strict validation with `--no-validate` opt-in (agent design, Planner).
