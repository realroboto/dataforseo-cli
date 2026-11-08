---
name: dfs
description: Call the DataForSEO API through the dfs CLI: SERP, keywords, backlinks, Labs, on-page, content, business data, merchant, app data, AI optimization (LLM responses, mentions). Use for any DataForSEO task, and before the first dfs call of a session.
---

# dfs (`dfs`)

One CLI over whole DataForSEO API, generated from official OpenAPI spec. Each spec path = one command: `/v3/serp/google/organic/live/advanced` → `dfs serp google organic live advanced`. `dfs --help` and `<words> --help` show commands and flags. Each paid call passes cost guard; each response goes to local Store before print.

## Rules for a session

1. **Use Live in a session.** Live endpoint answers in one exchange; dfs waits up to 130 s: `dfs serp google organic live advanced --body '{"keyword":"coffee","location_code":2840,"language_code":"en"}'`.
2. **`--dry-run` before a paid call.** dfs validates body, prints call plan as JSON (`estimate`, `ceiling`, `guard`, `reuse`); nothing sent, no credentials: `dfs serp google organic live advanced --body '{"keyword":"coffee","location_code":2840,"language_code":"en"}' --dry-run`. Then send same command without `--dry-run`.
3. **`+run` only with short `--wait` or in background.** `+run` posts tasks, waits, collects. Default wait 90 s plus post and collect can pass command timeout (Claude Code Bash: 2 min default, 10 min max). Foreground: `dfs serp google organic +run advanced --body @tasks.json --wait 60`. Long job: Bash `run_in_background: true`, or post only: `dfs serp google organic +run advanced --body @tasks.json --wait 0`.
4. **Raise command timeout for LLM Live endpoints.** `llm_responses` and `llm_scraper` Live calls wait for a model and can use full 130 s, above 2 min default command timeout. Set Bash `timeout` to 300000 ms for `dfs ai_optimization chat_gpt llm_responses live`, `dfs ai_optimization claude llm_responses live`, `dfs ai_optimization gemini llm_responses live`, `dfs ai_optimization perplexity llm_responses live`, `dfs ai_optimization chat_gpt llm_scraper live advanced`, `dfs ai_optimization gemini llm_scraper live advanced`. `llm_responses` cost is unbounded: those calls also need explicit `--max-cost <usd>`.
5. **`dfs +collect` after timeout.** Run it when `+run` exits 6 (pending task ids), when dfs exits 1 with "money may be spent", or when your tool killed a dfs command (timeout). One pass, never posts; collects pending tasks, recovers lost task ids through `id_list`. `dfs +collect` = all modules; `dfs serp +collect` = one module. Exit 6 again → tasks still pending: run again later.
6. **`dfs store show` after a cut.** stdout plus stderr stay within 9,000 characters. Cut output ends with line `{"dfs":"cut",…,"more":"dfs store show <id> --from <n>"}`: run its `more` command for next items, no API call, no cost. `dfs store show <id> --full` prints exact API response.
