# free-model-aggregator-live

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/galaxy69696969/free-model-aggregator-live/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/galaxy69696969/free-model-aggregator-live/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

A live free-model aggregator: one Node server serving the OpenAI Chat Completions API and the Anthropic Messages API, answering every prompt with a real completion from the best-rated free OpenRouter model behind the grader's gateway. Model choice is ranked by the brief's own quality ratings, filtered by each prompt's requirements (JSON mode, tools, vision), with rating-ranked failover and per-model cooldowns when a model refuses — and it never answers from its own text.

## Run it

```sh
node main.ts --list   # print the catalog the server registers
node main.ts          # serve (needs the trial's MAKEFUN_* environment)
```

The server listens on `0.0.0.0` at a free port, registers with the trial env, serves `GET /v1/models`, `POST /v1/chat/completions` and `POST /v1/messages` (JSON and streaming), dials every completion through the gateway on the trial's key, and exits 0 when the env's work is done. It uses only the Node 22 standard library; `lib/` holds the brief parser, catalog builder and the Anthropic/OpenAI wire translation.

---

Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards
