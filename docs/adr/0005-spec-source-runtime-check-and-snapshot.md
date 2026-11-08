---
type: Architecture Decision Record
title: Spec source = runtime check + snapshot
description: dfs checks vendor spec on master once a day and ships a committed snapshot as tested fallback.
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-08T00:00:00Z }
status: stable
---

# Spec source = runtime check + snapshot

Status: accepted (2026-11-08, epic #1, ticket #19).

## Context

dfs is generated from vendor OpenAPI spec (`openapi_specification.yaml` on `master` of `dataforseo/OpenApiDocumentation`). Vendor changes it without notice. Owner rejected a design where a manual script is the only way a new spec reaches users (34:36; 09:19). CI has no network (34:116), but tests need the full spec (34:121).

## Decision

- No SHA pin (34:87). Daily runtime check, at most once per 24 h (34:88): conditional GET of GitHub commits API (ETag), then raw file at the new SHA. Structural check before swap; failure keeps current spec, warns once, retries after 1 h (34:90).
- Cache `<config>/spec.json` (600, dir 700) in use when its commit is newer than the snapshot (34:89).
- Spec snapshot: committed file, parsed and checked spec plus SHA and date, written only by `pnpm spec:snapshot`; build ships it (34:91, agent design). dfs never runs without a spec.
- `--version` shows SHA and date of spec in use, offline (34:92).
- Weekly `spec.yml` drift check diffs newest spec against snapshot (34:100–107).

## Reason

Users get each new spec within 24 h with no release. Snapshot gives an offline fallback, a fixed test input and a base for drift diff.

## Source

[Catalog module](/spec/modules/catalog.md) (Spec source, Daily check, Snapshot source); [Workflows](/spec/workflows-release.md) (`spec.yml`).
