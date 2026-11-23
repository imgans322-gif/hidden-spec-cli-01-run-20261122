# mend — a patch tool for four AI edit formats

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/imgans322-gif/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/imgans322-gif/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

An entry for [make.fun's hidden-spec-cli-01 bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
(22 November 2026 run): `mend`, a command-line tool that applies patches written in
any of the four formats AI coding tools emit — unified diffs, SEARCH/REPLACE blocks,
OpenAI-style V4A patches, and Anthropic-style JSON edits — exactly as `SPEC.md`
specifies.

`main.ts` (Node 22, standard library only) implements the whole spec: the command
line and exit codes, safe paths, format auto-detection, three-tier line matching
(exact, trailing-whitespace-insensitive, indent-insensitive) with `--strict` for
exact-only, CRLF and final-line-break preservation, and the all-or-nothing write —
if any edit fails, nothing is written. `runner.ts` is the kit's trial hand-over,
kept as required; `check.ts` runs the practice set.

## Run

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

PATCH absent or `-` reads the patch from stdin. Exit 0 lists the changed files
(`A`/`D`/`M`, `R old -> new` for a move) and an `ok:` line; exit 1 reports each
failed edit; exit 2 is a usage, unreadable-patch, format or parse error.
