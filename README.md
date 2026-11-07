# dataforseo-cli (`dfs`)

`dfs`: agent-first CLI for whole DataForSEO API, generated from official OpenAPI spec, with cost guard and local store. Status: in build. Catalog done (`--help`, `--version`, `schema`, `search`). Calls done: one HTTP exchange, Store save before print, Compact output, `store show/list/path`. Planner done: body validated before send (exit 3), `--no-validate`, `--dry-run`. Pricing core done: price tree from `user_data` (refreshed after 24 h), estimate, cost guard (exit 4; ceiling `--max-cost`, `DFS_MAX_COST`, $1 default). Price rules for all of `serp` and `keywords_data`; other paid paths need explicit `--max-cost`.

- Package manager: pnpm. Node runs `.ts` directly; tests `node --test` ([stack](docs/spec/distribution-stack.md)).
- Checks: `pnpm typecheck && pnpm lint && pnpm test`; then `pnpm build && pnpm pack:check`. `pnpm spec:snapshot` (network) rewrites `spec/snapshot.json`; never edit it by hand.
- Spec: [docs/spec/index.md](docs/spec/index.md). Start with [overview](docs/spec/overview.md).
- Docs bundle (OKF 0.2): [docs/index.md](docs/index.md).

## Agent skills

| Topic | Rule | Detail |
|---|---|---|
| Issue tracker | GitHub issues via `gh` | [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md) |
| Triage labels | 5 canonical labels (string == role) | [docs/agents/triage-labels.md](docs/agents/triage-labels.md) |
| Domain docs | Single-context (`GLOSSARY.md` + `docs/adr/`) | [docs/agents/domain.md](docs/agents/domain.md) |
