# dataforseo-cli (`dfs`)

`dfs` is an agent-first CLI for the whole DataForSEO API, generated from the official OpenAPI spec, with a cost guard and a local store. Status: pre-build; spec in issue #1.

## Agent skills

| Topic | Rule | Detail |
|---|---|---|
| Issue tracker | GitHub issues via `gh` | [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md) |
| Triage labels | 5 canonical labels (string == role) | [docs/agents/triage-labels.md](docs/agents/triage-labels.md) |
| Domain docs | Single-context (`GLOSSARY.md` + `docs/adr/`) | [docs/agents/domain.md](docs/agents/domain.md) |
