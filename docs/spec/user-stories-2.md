---
type: Spec Section
title: User stories 33–58
description: User stories 33–58 of dfs v1 - errors, output, store, credentials, spec drift, release.
generated: { by: claude-code/claude-opus-5-5, at: 2026-11-07T00:00:00Z }
verified: [{ by: process:plan-verifier-blind-audit-9, at: 2026-11-07T00:00:00Z }]
status: stable
---

# User stories 33–58

Actors and stories 1–32: [User stories 1–32](/spec/user-stories.md).

### Errors, retries and pace

33. As an agent, I want exit codes 0–6 with one meaning each (table in Implementation Decisions), so that my next action follows from the code (28:148–156).
34. As an aviato job, I want exit 6 to list each failed or not-ready task id with its code, so that I retry only the failed items (28:164; 31:142; 46:320–321).
35. As an agent, I want free calls retried on transient codes with backoff 1, 2, 4, 8 s plus jitter, so that short faults heal alone (31:148).
36. As the owner, I want a paid call retried only when the response proves cost 0, so that a retry never doubles a charge (31:149).
37. As an agent, I want a lost connection after a paid send to exit 1 with "money may be spent; dfs +collect recovers it", so that I know the state and the remedy (31:150).
38. As the owner, I want dfs to obey `X-RateLimit-Remaining`, keep at most 10 requests in flight, and wait 130 s for a Live answer, so that dfs stays inside the API's limits (31:152).

### Output that fits an agent

39. As an agent, I want the default stdout to drop the envelope and empty values, print one compact JSON item per line, and keep stdout plus stderr within 9,000 characters, stopping after a whole item with a cut line that names the next command, so that the whole output stays inside my 10,000-character window (28:135–139, amended 2026-11-07; r28:90).
40. As an agent, I want `dfs store show <id> [--from <n>] [--full]` to reprint a saved response with no API call and no cost, so that I can read the rest of a cut output (28:141; 31:173).
41. As a program, I want `--full` to print the exact API response, so that I can parse every field (28:140).
42. As an agent, I want one stderr status line per call with `dfs:` prefix, cost and `saved=<id>`, so that cost and store id are always visible (28:127, 28:141).

### Store and search

43. As the owner, I want every full response saved in `~/.config/dfs/store.db` (dir 700, file 600), kept forever, so that paid data is never lost (31:161–162).
44. As the owner, I want a failed save to write the response to `~/.config/dfs/unsaved/<id>.json` and import it on the next run, so that a full disk or lock does not lose a paid response (31:164).
45. As an agent, I want `dfs store search "<words>"` to search every string value of every stored item with diacritics folded, so that I can find past results without a field list (31:176).
46. As an agent, I want `dfs store list` and read-only `dfs store sql "<select>"`, so that I can answer structured questions such as one term's position over time (31:174, 31:177).
47. As aviato, I want `dfs store path` and a read-only attach of the Store, so that one query joins aviato rows and DataForSEO responses (31:178; 41:145).
48. As the owner, I want `dfs store backup <file>` to make a consistent copy while dfs runs, so that the aviato backup job can include it (31:165; 46:370).
49. As the owner, I want the login, the password and request headers never stored, so that the Store file holds no secret (31:167).

### Credentials

50. As the owner, I want dfs to read only `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` from the environment, with no credentials file, no flag and no `dfs auth`, so that secrets never reach argv or disk through dfs (28:101–103).
51. As an agent, I want a missing variable to exit 2 with the variable's name, so that I can tell the owner what to set (28:104).

### Spec freshness and drift

52. As an agent, I want dfs to check the spec at most once per 24 h, keep the previous spec when a new one fails the structural check, and never run without a spec, so that upstream breakage does not break my commands (34:88–91).
53. As the owner, I want a weekly drift check in GitHub Actions that fails on named conditions and emails me, so that I learn about upstream change within a week (34:100–107, 34:110).
54. As the owner, I want the drift check to keep its schedule alive in a public repo, so that the 60-day disable does not silence it (34:109; r23:69).

### Release and install

55. As the owner, I want each version published by npm trusted publishing with `npm stage publish` and released only after my approval on npm, so that a hijacked GitHub job cannot ship a dfs that reads my DataForSEO login (34:152–153).
56. As the maintainer, I want the release runbook to run `pnpm test:sandbox` and `pnpm up --latest` with tests green before each tag, so that each release is contract-checked and on the latest stable versions (34:154; 10:21).
57. As the owner, I want dfs installed and its skill registered in my install repos like its peers (owner checklist, not a build ticket), so that dfs installs like its peers (28:94).
58. As an agent, I want a dfs skill that tells me to use Live in sessions, `+run` only with a short wait or in the background, a raised command timeout for LLM Live endpoints, and `dfs +collect` after a timeout, so that I use dfs inside my tool limits (31:155, 31:209).
