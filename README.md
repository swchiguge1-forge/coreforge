# coreforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/swchiguge1-forge/coreforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/swchiguge1-forge/coreforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single process, written in TypeScript with the Node standard library only — no dependencies. It serves the git smart HTTP protocol (advertise, fetch, push, with packfile read/write and delta resolution), a GitHub REST v3 API surface (repositories, issues, pull requests), a GraphQL endpoint covering the gh / github-mcp-server document shapes, and an MCP endpoint. State is per-process and deterministic: identical request sequences produce identical responses.

## Run it

```sh
MAKEFUN_ENV_URL=<env origin> MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

The process binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL/register`, serves until the environment says done, and exits 0. Locally, Node 24 runs it with `node --experimental-strip-types main.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=g9gpq3bv&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
