---
type: Spec Section
title: Names, distribution and stack
description: npm name, repo, skill form, secrets, stack and versions.
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-07T00:00:00Z }
verified: [{ by: process:plan-verifier-blind-audit-9, at: 2026-11-07T00:00:00Z }]
status: stable
---

# Names, distribution and stack

### Names, repo, distribution

- npm `@reallroboto/dfs`, scoped like `@reallroboto/qb`, `publishConfig.access: public` (28:82). Binary `dfs` (28:84). Repo `realroboto/dataforseo-cli`, public like the peers (28:83, 28:95). Deviation accepted by the owner: peers use unscoped `<api>-cli` npm names (28:85).
- Install and skill registration happen in the owner's private install repos after the first release (Owner setup checklist 6); not part of this build.
- **Skill form (agent design, 2026-11-07):** the skill ships from git, not npm. The file is `skills/dfs/SKILL.md` in the repo, outside the npm package. Reason: gapi, the closest peer (12:16), and bwt ship their skills in git the same way (gapi file `google-apis-cli/skills/gapi/SKILL.md`), and the owner's installer links each `skills/<name>/SKILL.md` of a git repo. v1 content: the rules of User Story 58. A test checks that each `dfs …` command in the skill resolves in the Catalog.
- Secrets: dfs reads `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` from the environment, like `BING_WEBMASTER_API_KEY` for bwt (28:102). The owner's secret store exports them (46:341–342).

### Stack

- Same shape as gapi: ESM, TypeScript strict with gapi's tsconfig flags, Node runs `.ts` directly, Biome, pnpm, `node --test`, native `fetch` (10:17).
- Versions = latest stable at build time; "stable" = npm `latest` dist-tag / Node LTS, never beta, rc or alpha (10:16, 10:18). Baseline read 2026-11-04: Node 26.13.0 LTS, TypeScript 7.0.2, Biome 2.6.5, pnpm 12.16.1, @types/node 26.6.6 (10:18). The build ticket re-reads `latest` tags on its day.
- `target`/`lib` `es2025` (r23:44). `.nvmrc` = `26` (34:125), `engines.node >=26` (10:18).
- One runtime dependency: `yaml` (ISC, no service). Reason: the spec exists only as YAML and Node has no YAML parser (34:160).
- `node:sqlite` is Stability 1.2 (release candidate). Never call it stable in docs. Pin Node in CI and keep a smoke test (10:19; r23:55).
- Version refresh: release runbook step, no scheduled job (10:21).
