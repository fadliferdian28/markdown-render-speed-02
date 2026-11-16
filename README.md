# Markdash

A fast, dependency-free Markdown renderer that returns byte-identical HTML to
marked 18.1.3 with its default options (GFM on, breaks off, pedantic off).
Written from scratch as a single-pass scanner: first-character block dispatch
plus a hand-written inline scanner with a delimiter stack, rendering HTML
directly instead of building token objects.

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/fadliferdian28/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/fadliferdian28/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

## Run

The harness runs `node main.ts`, which reads `cases.json` from the input
directory, renders each case alone with `parse()` from `parse.js`, and writes
`html.json` to the output directory.

## License

MIT. Behavioural compatibility target: marked 18.1.3 (MIT, markedjs).
