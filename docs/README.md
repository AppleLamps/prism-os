# Docs

[template/](../template/) is a toggle switch written as one numeric program and checked against the same switch in plain JavaScript, to copy as the start of a new app. Read the docs in this order:

- [tutorial.md](tutorial.md) walks through the template: declaring cells, builder code, the host loop, DOM writes, the test, and how to add a second switch or a new app folder.
- [expressions.md](expressions.md): one expression, e.g. `a >= b`, `Math.min(a, b)` or `table[index]`, where the hard part is an exact FP32 result.
- [patterns.md](patterns.md): a loop, e.g. `findIndex` or `items.sort(compare)`. The program runs every operation on every frame and can't stop early, so a loop becomes a count, a tree, a table, or the same work on every item.
- [behavior-choices.md](behavior-choices.md): a choice that changes what the user sees, e.g. hit-testing where elements are going instead of where they're drawn, to shorten dependency chains, make stored state independent of the frame rate, or keep each frame's work under a fixed maximum.
- [execution-model.md](execution-model.md): the contracts. It defines the instructions that make up a program, and what the other docs depend on, e.g. index reads, comparisons, grids, rounding points, springs and time, and each builder function's magnitude limits.

[lab/status.md](../lab/status.md) has current results, measurements, known issues in the production code and open decisions, for people following the research. [The guide](../lab/ui-exploration/guide/README.md) has longer explanations that start from the familiar JavaScript, a glossary, and runnable examples checked against plain JavaScript. `bun lab/runtime-cost/report.ts` prints HandwiredOS's current sizes and its µs per evaluation in Bun, in the entry named "window manager".

## Running

The repo needs [Bun](https://bun.sh), and its tests and checks were last run with Bun 1.4.3.

```sh
bun install
bun start                                 # the demo site at http://127.0.0.1:3000/: the landing page, and the demos at /os/, /learned-gallery/ and /json-search/
bun run start:template                    # the template app, a toggle switch
bun run test
bun run check
bun run site:build                        # the demo site as static files in site/
bun run site:check                        # builds the site and loads every page in headless Chrome
bun lab/ui-exploration/serve-demos.ts     # every demo except the JSON search, history included, at http://127.0.0.1:4321/
```

`bun start` takes `--port` for another port, and `bun run site:check` needs Chrome, with `CHROME_PATH` for a binary that isn't at the macOS default path.

## Where things are

- `src/runtime/`: what every program is built and run with. `numeric-ui-core.ts` has circuit construction, the builder functions, compilation, and the evaluators, which are JavaScript on the CPU. `cells.ts` has cell declarations, which give each cell its position in the source table, the circuit's declarations, the initial table, a validator, and next values for write-back. `host-timing.ts` has frame timing, spring step counts and matrices, and the evaluations between frames, computed in host JavaScript. `prefix-networks.ts` has Sklansky's and Brent-Kung's prefix networks, which compute every prefix of a list with any associative combine, e.g. running totals of row heights, or the state after every event of a state machine
- `src/handwiredos/`, `src/learned-gallery/` and `src/json-search/`: the three demos, each with a README that names its files. `src/json-search/` also holds the code that writes its two programs as WebGPU shaders, and the programs' own modules in `regex/` and `highlighter/`
- `assets/`: each demo's page and stylesheet, i.e. `index.html` with `handwired-os.css` and `photo-gallery-*.webp` for HandwiredOS, `learned-gallery.html` with `learned-gallery.css`, and `json-search.html` with `json-search.css`. `demos.html`, `demos.css` and `demos-handwiredos.webp` are the landing page. `site.css` has the colors, type sizes, spacing and the parts that every page shares, e.g. the page header, and `tool.css` the colors of highlighted JSON and the pattern field, for JSON search's page
- `template/`: the toggle switch to start an app from
- `docs/`: this folder
- `tests/runtime/`: differential tests of the reference and compiled evaluators, including seeded random circuits (`builder-differential`, `numeric-ui-core`, `numeric-semantics`, `random-hardened`), and tests of index reads, gather lowering, comparisons, springs whose matrix the host writes, macro magnitude limits, cell declarations and prefix networks
- `tests/handwiredos/`, `tests/learned-gallery/` and `tests/json-search/`: each demo's tests, which run without a browser, e.g. HandwiredOS over scripted traces, the gallery's editor frame by frame, and JSON search's GPU code through an interpreter
- `scripts/check.ts`, `tsconfig.json`, `package.json` and `knip.config.ts`: `bun run check` type-checks and lints the code ([lab/status.md](../lab/status.md#verification-and-reproduction) says which folders), package.json holds the scripts under [Running](#running), and `bun run knip` reports unused exports in src/, scripts/ and template/
- `scripts/demo-site-pages.ts`, `scripts/serve-demo-site.ts`, `scripts/build-demo-site.ts` and `scripts/check-demo-site.ts`: the demo site, i.e. the list of its pages and their paths, the development server behind `bun start`, the static build into site/ behind `bun run site:build`, and the check of the built site in headless Chrome behind `bun run site:check`. `.github/workflows/pages.yml` runs the build on pushes to main and publishes site/ to GitHub Pages
- `scripts/measure-json-highlighter.ts`: the JSON highlighter's sizes and µs per evaluation in Bun
- `lab/`: the experiments. Their READMEs describe the code as it was when each was written, and only [lab/status.md](../lab/status.md) is kept current
