---
type: Architecture Decision Record
title: Staged publish
description: publish.yml stages each version by npm trusted publishing (OIDC); version goes out only after owner approves on npm.
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-08T00:00:00Z }
status: stable
---

# Staged publish

Status: accepted (2026-11-08, epic #1, ticket #19).

## Context

dfs reads the owner's DataForSEO login from the environment. A malicious dfs version could read it. A hijacked GitHub job that publishes directly could ship such a version.

## Decision

- `publish.yml` on tag `v*`: guard (tag = `package.json` version, tag commit on `main`), then `npm stage publish --provenance` by OIDC trusted publishing. No npm token (34:152).
- npm runs `prepublishOnly` gate first: typecheck → lint → test → spec:check → build → pack check.
- Version goes out only after owner approves staged version on npm (34:152–153).
- First release: owner publishes empty `0.0.0` by hand, sets trusted publisher, tags `v0.1.0` within 2 days (34:151).

## Reason

A second, human step on npm stops a hijacked job from shipping. OIDC removes a stored publish token.

## Source

[Workflows](/spec/workflows-release.md) (`publish.yml`, Release scope, runbook); [user story 55](/spec/user-stories-2.md).
