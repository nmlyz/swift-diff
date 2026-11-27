# swift-diff

[![make.fun · diff-speed-01-run-20261126](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/nmlyz/swift-diff/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/nmlyz/swift-diff/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

swift-diff computes the patch between two texts, line by line, in the `makefun-diff/1` format: a header line with the line counts, hunks and deleted/inserted totals, then one hunk per change run with three lines of context. It answers exactly as the reference line diff does on every input, and it is built for speed on large texts: tens of thousands of lines with thousands of changed lines.

## How it works

Lines are cut after every `\n` (a `\r` stays part of its line, and a last line with no newline is a line too), then hashed to integer ids once. The edit script is Myers's greedy search: the common prefix, then the common suffix, then the search from the first lines, keeping on each diagonal the path reaching furthest into the old text, the deletion when both reach one point, never moving past either text's end, and following every run of equal lines as far as it goes. The search runs on typed arrays with no per-state allocation, the full V trace kept in one reusable buffer so the script is recovered by backtracking. A banded pass first finds an upper bound on the edit distance, and the full pass then only visits diagonals that can still reach the end within that bound; a shortest script always stays inside that diamond, so the script found is the same one. Output is deterministic: the same input gives the same patch, byte for byte, on every run.

## Run it

```sh
node main.ts
```

It reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR/cases.json`) and writes the answers to `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR/answers.json`). Node 22 or later, no dependencies, no network access needed.

---

<sub>Entered on [make.fun](https://make.fun/?ref=23ae7fx0&utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)</sub>
