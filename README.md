# dataforseo-cli (`dfs`)

`dfs`: agent-first CLI for whole DataForSEO API, generated from official OpenAPI spec, with cost guard and local store. Status: pre-build.

- Package manager: pnpm. Node runs `.ts` directly; tests `node --test` ([stack](docs/spec/distribution-stack.md)).
- Spec: [docs/spec/index.md](docs/spec/index.md). Start with [overview](docs/spec/overview.md).
- Docs bundle (OKF 0.2): [docs/index.md](docs/index.md).

## Agent skills

| Topic | Rule | Detail |
|---|---|---|
| Issue tracker | GitHub issues via `gh` | [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md) |
| Triage labels | 5 canonical labels (string == role) | [docs/agents/triage-labels.md](docs/agents/triage-labels.md) |
| Domain docs | Single-context (`GLOSSARY.md` + `docs/adr/`) | [docs/agents/domain.md](docs/agents/domain.md) |
