---
type: Architecture Decision Record
title: Sandbox contract test on the Mac only
description: pnpm test:sandbox sends real HTTP to DataForSEO sandbox from owner's Mac; DataForSEO login never goes to GitHub.
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-08T00:00:00Z }
status: stable
---

# Sandbox contract test on the Mac only

Status: accepted (2026-11-08, epic #1, ticket #19).

## Context

Stubbed-`fetch` tests miss transport faults: open-seo's gzip regression passed them (r34:72). Real HTTP needs a DataForSEO login. A login stored on GitHub can leak from a hijacked job.

## Decision

- Seam 3 `pnpm test:sandbox`: real HTTP to `sandbox.dataforseo.com` at cost 0. Sends each spec request example unmodified on overlaid spec, collects Standard tasks, saves to a temp Store (34:131–133).
- Committed file `spec/sandbox-40404.json` lists paths sandbox does not cover. New 40404 or any other error fails the run.
- Runs on the owner's Mac only; script refuses outside macOS and under `CI`. Release runbook requires it (34:132, 34:154).
- CI never uses network or a DataForSEO login; login never goes to GitHub (34:116, 34:134). Fixtures come from sandbox by `pnpm fixtures:record`, committed.

## Reason

Real wire behaviour checked before each release, at $0, with no secret outside the owner's machine.

Open (2026-11-08): run red on 13 time-bound vendor examples plus one `language_code` fault; owner decision in #26.

## Source

[Testing decisions](/spec/testing.md) (Seam 3, fixtures, CI rule); [Workflows](/spec/workflows-release.md) (Release scope, runbook step 3).
