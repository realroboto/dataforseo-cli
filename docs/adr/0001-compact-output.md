---
type: Architecture Decision Record
title: Compact output by default
description: Default stdout drops envelope and empty values, one item per line, 9,000-character budget with cut line.
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-08T00:00:00Z }
status: stable
---

# Compact output by default

Status: accepted (2026-11-08, epic #1, ticket #19).

## Context

Agents run dfs in Claude Code. Owner setup shows at most 10,000 characters of command output inline; past that, agent sees a 2 KB preview (r28:90). Raw DataForSEO responses pass this often. Agents "always forget" to pipe to `jq` (28:128).

## Decision

- Default stdout = Compact output (28:135–139): envelope removed (cost and status go to stderr status line); `null`, `""`, `[]`, `{}` removed; other values verbatim; compact JSON, one item per line.
- Budget 9,000 characters per command, stdout and stderr together, shared by all `--page-all` pages. stderr lines first, items fill the rest. At budget, dfs stops after a whole item and prints a cut line that names next command (`dfs store show <id> --from <n>`).
- Every full response is saved in the Store before print (28:134), so nothing cut is lost.
- `--full` opt-in: exact API response.

## Reason

Whole output stays inside agent window with no flag to remember. 1,000 characters stay free for Bash wrapper. No renaming or rounding, so items match vendor docs.

## Source

[Render module](/spec/modules/render.md) (Compact output, budget rationale); [user story 39](/spec/user-stories-2.md); [overview](/spec/overview.md) Problem Statement.
