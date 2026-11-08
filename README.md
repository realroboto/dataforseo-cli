# dataforseo-cli (`dfs`)

`dfs`: agent-first CLI for whole DataForSEO API, generated from official OpenAPI spec, with cost guard and local store. Status: in build. Catalog done (`--help`, `--version`, `schema`, `search`). Calls done: one HTTP exchange, Store save before print, Compact output, `store show/list/path`. Planner done: body validated before send (exit 3), `--no-validate`, `--dry-run`. Pricing core done: price tree from `user_data` (refreshed after 24 h), estimate, cost guard (exit 4; ceiling `--max-cost`, `DFS_MAX_COST`, $1 default). Price rules: every paid spec path has a rule or sits on the free list; LLM Responses (`llm_responses`) cost is unbounded, so it needs explicit `--max-cost`. Reuse done: same paid request within 12 h of a full success returns stored response at $0 (`reused=<id> age=<age>`); `--fresh` sends; free paths always sent. Transport done: free calls retry transient codes 4 times (1, 2, 4, 8 s + jitter); paid calls retry only when response shows cost 0; lost connection after paid send exits 1 (`dfs +collect`); 40103 never retried (remedy `--fresh`); pace: `X-RateLimit-Remaining: 0` waits to next minute, ≤ 10 in flight per process, Live timeout 130 s. `+run` done: posts ≤ 100 tasks per post under one guard, saves post responses and `task` rows, polls most specific `tasks_ready` (5 s doubling to 30 s, `--wait` default 90 s), collects only own ids (on_page via `summary/{id}` until `crawl_progress` = `finished`); timeout or `--wait 0` exits 6 with pending ids.

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
