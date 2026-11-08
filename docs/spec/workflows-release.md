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
- `publish.yml`: on tag `v*`. Runs the `prepublishOnly` gate, then `npm stage publish` by OIDC with provenance. The version goes out only after the owner approves it on npm (34:152). Gate order, like gapi: typecheck → lint → test → spec:check → build (r22:27) → pack check (dfs addition).

### Release runbook

1. `pnpm up --latest`; check the newest Node LTS line; tests green (10:21).
2. `pnpm spec:snapshot`; commit the snapshot when its SHA changed; tests green (Catalog, Snapshot source).
3. `pnpm test:sandbox` on the Mac (34:131–133, 34:154).
4. Tag `v<version>` on `main` → `publish.yml` → owner approves the staged version on npm (34:152).
5. First release only: the owner publishes an empty `0.0.0` by hand (own npm login + 2FA), sets the trusted publisher in the package settings (staged publish allowed), and tags `v0.1.0` within 2 days, before the new config expires (34:151; r34:43–45).

### ADRs to write in the new repo

From 28:187, 31:210 and 34:171: compact output by default; exit-code table; reuse on by default (a deviation from gapi ADR 0001, 31:121); no retry of a paid request without proof of cost 0; spec source = runtime check + snapshot; sandbox contract test on the Mac only, no DataForSEO login on GitHub; staged publish; vendor spec corrected by an Overlay 1.0 file, strict validation with `--no-validate` opt-in (agent design, Planner).
