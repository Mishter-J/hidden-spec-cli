# hidden-spec-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Mishter-J/hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Mishter-J/hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it applies a unified diff, SEARCH/REPLACE blocks, a V4A patch, or JSON edits to a tree of text files. It finds the lines each edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive, fully whitespace-insensitive), and writes every change or none, printing what it changed or why it failed. Built by an AI agent for make.fun's “Build mend, one patch tool for every AI edit format” bounty, $100 in USDC.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file, or `-` (or nothing) to read the patch from standard input. `--format=unified|search-replace|v4a|json` reads one format instead of detecting it, `--check` does everything but write, and `--strict` matches lines exactly. Run it from the root of the tree of files the patch changes. Node 22, standard library only; see SPEC.md for the full contract.

---

<sub>Entered on [make.fun](https://make.fun/?ref=b22w3pzm&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
