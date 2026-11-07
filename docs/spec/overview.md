---
type: Spec Section
title: dfs v1 spec overview
description: Status, citation key, problem, solution and module map of the dfs v1 spec.
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-07T00:00:00Z }
verified: [{ by: process:plan-verifier-blind-audit-9, at: 2026-11-07T00:00:00Z }]
status: stable
---

# dfs v1 spec overview

Status: ready for build. Passed blind `plan-verifier` audits (2026-11-07).
Label at publish: `ready-for-agent`.
Source: the owner's private planning map (tickets 09–13, 28, 31, 34; research 20, 22, 23, 28, 31, 34). Every decision cites its source line there.

## Citation key

Citations point into the owner's private planning map; they are plain-text references, not links. `NN:L` = line L of ticket NN; `rNN:L` = line L of research note NN; `G:L` = line L of the glossary; `scripts/check-vendor-spec.py` = vendor-spec checker, `spec/overlay.yaml` = overlay seed, `docs/spec/vendor-facts.txt` = checker output (this repo). `gapi SPEC:L` = line L of `docs/SPEC.md` in `realroboto/google-apis-cli`; other `google-apis-cli/<file>:L` = that file in the same repo. "Agent design" = decided by the agent under the owner's mandate (09:15), not by the owner; each one carries its reason.

| Key | File |
|---|---|
| 09 | `issues/09-dfs-mandate.md` |
| 10 | `issues/10-dfs-stack-latest-stable.md` |
| 11 | `issues/11-dfs-spec-license-not-a-factor.md` |
| 12 | `issues/12-dfs-parity-with-peers.md` |
| 13 | `issues/13-dfs-sqlite-fts5.md` |
| 28 | `issues/28-dfs-interface.md` |
| 31 | `issues/31-dfs-runtime-cost-tasks-store.md` |
| 34 | `issues/34-dfs-spec-drift-tests.md` |
| 41, 46, 47, 53 | aviato tickets that consume dfs |
| r20, r22, r23, r28, r31, r34 | `research/20-dataforseo-api.md`, `22-dfs-peers-toolchain.md`, `23-dfs-toolchain-facts.md`, `28-dfs-interface-facts.md`, `31-dfs-runtime-facts.md`, `34-dfs-spec-drift-facts.md` |

## Problem Statement

The owner wants to use 100% of the DataForSEO API — every endpoint and feature, idiomatic, best in class (09:13, 09:16). The owner's agents (Claude Code sessions) and the aviato jobs (46:310) need it from the command line, with no MCP (G:11–12; `map.md:25`; 02).

No tool meets this. The official CLI is a raw `request` passthrough with no validation, no cost estimate and no task lifecycle (r20:48). Community CLIs are subsets or passthroughs (09:17; r28:41–43).

Paid DataForSEO calls are charged per call from a prepaid balance, with no subscription (r20:54); only some calls are free (r31:105–109). So four pains follow:

- An agent can overspend by mistake. No exact pre-call price exists (31:101).
- A repeated call pays twice. Duplicates are not limited by default and no idempotency key exists (r31:140–145).
- A lost Standard task id loses paid data. Re-posting double-bills (open-seo #489, 31:138).
- Big responses flood the agent's context. In the owner's setup, Claude Code shows at most 10,000 characters of a command's output inline (`BASH_MAX_OUTPUT_LENGTH=10000`), and past it the output goes to a file and the agent sees a 2 KB preview; a failed command gets a fixed 10,000-character window with a head-and-tail excerpt (r28:90). Agents "always forget" to pipe to `jq` (28:128).

## Solution

`dfs` is a CLI generated from the official DataForSEO OpenAPI **Spec** (G:66). It is a **Peer CLI** of gapi, fbg and bwt (G:15; 12:15). gapi is the closest model because it is the only spec-driven peer (12:16).

- Every one of the 565 spec paths becomes a command. The command words are the path words (28:112; r28:81).
- dfs validates the body against the spec and its known limits before any network call (34:161).
- A three-layer **Cost guard** blocks overspend before sending (31:97–105).
- dfs saves every full response in a local SQLite + FTS5 **Store** before it prints (28:134; 13:13). Nothing paid is lost. The same paid request within 12 h is reused at $0 (31:117).
- Standard tasks run through `+run` and `+collect`. dfs never re-posts a pending task (31:127–138).
- Default stdout is a size-bounded **Compact output** (G:27). The rest stays one command away in the Store (28:135–141).
- dfs checks the spec once a day at runtime and also ships a **Spec snapshot**, so it never runs without a spec (34:87–91). A weekly **Drift check** detects upstream change (34:100–107).



Agent design after gapi's Catalog → Planner → Transport (r22:20; gapi SPEC:113). Each module is deep: small interface, behaviour inside. Reason: gapi proves the split, and tests reach every module through one seam (Testing Decisions).
