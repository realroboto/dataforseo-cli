---
type: Architecture Decision Record
title: Vendor overlay + strict validation with --no-validate
description: Overlay 1.0 file corrects vendor spec faults; Planner refuses bodies outside the spec (exit 3) unless --no-validate.
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-08T00:00:00Z }
status: stable
---

# Vendor overlay + strict validation with --no-validate

Status: accepted (2026-11-08, epic #1, ticket #19).

## Context

Planner validates field names, JSON types and known limits before send (34:161). Charging of 405xx refusals is unverified and a failed task can be charged (r31:112, r31:115), so a local refusal is the only sure $0. But vendor spec has faults: types its own docs contradict (85 of 85 filter fields in spec `55a4ed0`), fields its examples use but its schemas lack. Runtime check brings new vendor spec within 24 h (34:88), so a new fault can block a documented call before a fix ships. Mandate is 100% of the API (09:13).

## Decision

- Vendor faults corrected as data in committed `spec/overlay.yaml`, OpenAPI Overlay 1.0, targets only in RFC 9535 normalized-path form, actions `update` and `remove`. Catalog applies it to every spec (cache, fetch, snapshot) before structural check. Snapshot and cache keep vendor spec unchanged.
- `spec:check` fails when an overlay action has no target or changes nothing, so overlay only shrinks as vendor fixes faults.
- Validation strict by default: body outside spec → exit 3, nothing sent. No vendor-specific rule in Planner.
- `--no-validate` opt-in: field-name and type faults become stderr warnings and request is sent. Bad JSON, body shape, task counts and Cost guard still apply.

## Reason

Overlay is the OpenAPI standard for repeatable changes to a spec the user does not own; normalized paths need no JSONPath dependency; vendor quirks live in one checked file, not in code. Strict default protects money; `--no-validate` keeps every documented call reachable. Precedent: `kubectl --validate` (default `strict`).

## Source

[Planner module](/spec/modules/planner.md) (`--no-validate`); [Catalog module](/spec/modules/catalog.md) (Vendor overlay); [Workflows](/spec/workflows-release.md) (spec:check condition 4).
