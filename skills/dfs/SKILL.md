---
name: dfs
description: Call the DataForSEO API through the dfs CLI: SERP, keywords, backlinks, Labs, on-page, content, business data, merchant, app data, AI optimization (LLM responses, mentions). Cost guard, local Store of every response. Use for any DataForSEO task, and before the first dfs call of a session.
---

# dfs (`dfs`)

One CLI over the whole DataForSEO API, generated from the official OpenAPI spec. Every spec path is a command: `/v3/serp/google/organic/live/advanced` → `dfs serp google organic live advanced`. Each paid call passes a cost guard. Each response is saved in a local Store before it prints.

Credentials: `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` from the environment (missing → exit 2).

## Find a command

```sh
dfs search "keyword volume"            # endpoints by path words and descriptions
dfs keywords_data google_ads           # list a level
dfs serp google organic live advanced --help   # endpoint: method, URL, call line
dfs schema serp google organic live advanced   # request fields
```

## Rules for a session

1. **Use Live in a session.** A Live endpoint answers in one exchange: `dfs serp google organic live advanced --body '{"keyword":"coffee","location_code":2840,"language_code":"en"}'`. dfs waits up to 130 s for a Live answer.
2. **`--dry-run` before a paid call.** It validates the body and prints the call plan as JSON (`estimate`, `ceiling`, `guard`, `reuse`); nothing sent, no credentials: `dfs serp google organic live advanced --body '{"keyword":"coffee","location_code":2840,"language_code":"en"}' --dry-run`. Then send the same command without `--dry-run`.
3. **`+run` only with a short wait or in the background.** `+run` posts tasks, waits for them, collects them. Its default wait (90 s) plus post and collect can pass your command timeout (Claude Code Bash: 2 min by default, 10 min at most). In the foreground give a short wait: `dfs serp google organic +run advanced --body @tasks.json --wait 60`. For a long job run it in the background (Bash `run_in_background: true`) or post only: `dfs serp google organic +run advanced --body @tasks.json --wait 0`.
4. **Raise the command timeout for LLM Live endpoints.** `llm_responses` and `llm_scraper` Live calls wait for a model and can use the full 130 s, more than the 2 min default timeout of the command. Set the Bash `timeout` to 300000 ms for `dfs ai_optimization chat_gpt llm_responses live`, `dfs ai_optimization claude llm_responses live`, `dfs ai_optimization gemini llm_responses live`, `dfs ai_optimization perplexity llm_responses live`, `dfs ai_optimization chat_gpt llm_scraper live advanced`, `dfs ai_optimization gemini llm_scraper live advanced`. LLM Responses cost is unbounded: these calls need an explicit `--max-cost`, e.g. `--max-cost 0.5`.
5. **`dfs +collect` after a timeout.** Run it when `+run` ends with exit 6 (pending task ids), when dfs exits 1 with "money may be spent", or when your tool killed a dfs command. One pass, never posts; collects pending tasks and recovers lost task ids through `id_list`. `dfs +collect` covers every module; `dfs serp +collect` one module. Exit 6 again → tasks still pending: run it again later.
6. **`dfs store show` after a cut.** Output stays within 9,000 characters. A cut ends with a line `{"dfs":"cut",…,"more":"dfs store show <id> --from <n>"}`: run that command to read the next items, at no cost. `dfs store show <id> --full` prints the exact API response.

## Cost

- Ceiling: `--max-cost <usd>`, else `DFS_MAX_COST`, else $1. Estimate above it, or unknown price with no explicit `--max-cost` → exit 4, nothing sent.
- The same paid request within 12 h of a full success returns the stored response at $0 (`reused=<id>` on stderr). `--fresh` sends again.
- `--sandbox` sends to the free sandbox (demo data, same credentials).
- Each call prints one stderr status line: `dfs: …` with cost and `saved=<id>`.

## Store

```sh
dfs store list --since 1d --path "serp google"   # saved responses, newest first
dfs store search "coffee shop"                   # stored items holding every word
dfs store spend --by module                      # cost of non-sandbox tasks
dfs store sql "select id, path, cost from response order by time desc limit 5"
dfs store path                                   # the Store file
```

Tables and columns: [Store schema contract](../../docs/spec/modules/store.md).

## Exit codes

| Exit | Meaning | Next step |
|---|---|---|
| 0 | ok | — |
| 1 | API or network error, after retries | read stderr; "money may be spent" → `dfs +collect` |
| 2 | account: the owner must act | tell the owner (credentials, balance, limits) |
| 3 | invalid input, nothing sent | fix words (`--help`) or body (`schema` fields) |
| 4 | cost guard, nothing more sent | raise `--max-cost` only when the owner allows the cost |
| 5 | dfs bug | report it |
| 6 | incomplete: a task failed or is not ready | good tasks on stdout; pending → `dfs +collect` later |
