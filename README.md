# Handwired

Turn your regular JavaScript code into a neural net; no training & fully differentiable!

## How It Works

A program's made of if-else, loops, and state. Handwired transform them into matrix multiplication + reglu over floats. For example:

```ts
const a = 5
const result = (a > 4) ? 10 : 12
```

The above can be expressed as basic arithmetic:

```ts
const a = 5
// Math.max(0, x) is ReLU. For an integer a, isAbove4 is 1 if a > 4, and 0 otherwise
const isAbove4 = Math.max(0, a - 4) - Math.max(0, a - 5)
// Both branches compute, and isAbove4 picks one
const result = isAbove4 * 10 + (1 - isAbove4) * 12
```

You can calculate that by hand and see that both arrive at the same result.

We then collect the + and * and relu into a giant matmul, and either run it on JS or WebGPU, for fun.

Because we basically only use these 2 promitives:
- the full program stays differentiable
- the weights don't need training since they're written manually
- existing gpu techniques, such as fusion, sparsity, reordering, have a great time optimizing such minimal primitives

This unlocks lots of funny use-cases, like:
- unfreezing the weights and train them (what does that even do? Let's find out!)
- attaching a specific frozen program to a generic neural net and train end-to-end (now a nanoGPT can do both shakespare and your particular UI?)
- achieving GPU-level of parallelism with JS code that was written in a traditional single-threaded way (see the JSON research demo that runs in miliseconds over 100k documents)

![HandwiredOS](assets/demos-handwiredos.webp)

## Demos

`bun install`, then `bun start`, serves the three demos at http://127.0.0.1:3000/, with a landing page at / ([Running](#running)):

- [HandwiredOS](src/handwiredos/README.md), at /os/, which the landing page calls Mini OS: a small desktop where one program computes the windows and their springs, the stacking order, which window a press lands on, the zoom of a photo, and a list of the program's own numbers.
- [Learned gallery](src/learned-gallery/README.md), at /learned-gallery/: a program whose 244 weights are trained instead of wired by hand, by backpropagation in the browser, until the photos match the rectangles you sketch, with edges that are nearly on one line pulled onto it.
- [Search 100,000 JSON documents](src/json-search/README.md#the-demo-page), at /json-search/: at each keystroke, a program that searches for a regex runs once per document over 100,000 JSON documents, in one pass on WebGPU. A second program, a JSON highlighter, has run over them the same way before, for the colors of the document on screen and for a search of only keys or only string values. The page shows each search's time next to native RegExp's for the same search, and a toggle runs the same search on the CPU.

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

## Docs

[template/](template/) is a toggle switch written as one numeric program and checked against the same switch in plain JavaScript, to copy as the start of a new app. Read the docs in this order:

- [tutorial.md](docs/tutorial.md) walks through the template: declaring cells, builder code, the host loop, DOM writes, the test, and how to add a second switch or a new app folder.
- [expressions.md](docs/expressions.md): one expression, e.g. `a >= b`, `Math.min(a, b)` or `table[index]`, where the hard part is an exact FP32 result.
- [patterns.md](docs/patterns.md): a loop, e.g. `findIndex` or `items.sort(compare)`. The program runs every operation on every frame and can't stop early, so a loop becomes a count, a tree, a table, or the same work on every item.
- [behavior-choices.md](docs/behavior-choices.md): a choice that changes what the user sees, e.g. hit-testing where elements are going instead of where they're drawn, to shorten dependency chains, make stored state independent of the frame rate, or keep each frame's work under a fixed maximum.
- [execution-model.md](docs/execution-model.md): the contracts, i.e. the instructions that make up a program, and the builder functions that the other docs depend on, e.g. index reads, comparisons, grids, rounding points, springs and time, and each builder function's magnitude limits.

[lab/status.md](lab/status.md) has current results, measurements, known issues in the production code and open decisions, for people following the research. [The guide](lab/ui-exploration/guide/README.md) has longer explanations that start from the familiar JavaScript, a glossary, and runnable examples checked against plain JavaScript. `bun lab/runtime-cost/report.ts` prints HandwiredOS's current sizes and its µs per evaluation in Bun.

## Where things are

- `src/runtime/`: what every program is built and run with. `numeric-ui-core.ts` has circuit construction, the builder functions, compilation, and the evaluators, which are JavaScript on the CPU. `cells.ts` has cell declarations, which give each cell its position in the source table, the circuit's declarations, the initial table, a validator, and next values for write-back. `host-timing.ts` has frame timing, spring step counts and matrices, and the evaluations between frames, computed in host JavaScript. `prefix-networks.ts` has Sklansky's and Brent-Kung's prefix networks, which compute every prefix of a list with any associative combine, e.g. running totals of row heights, or the state after every event of a state machine
- `src/handwiredos/`, `src/learned-gallery/` and `src/json-search/`: the three demos, each with a README that names its files. `src/json-search/` also holds the code that writes its two programs as WebGPU shaders, and the programs' own modules in `regex/` and `highlighter/`
- `assets/`: each demo's page and stylesheet, i.e. `index.html` with `handwired-os.css` and `photo-gallery-*.webp` for HandwiredOS, `learned-gallery.html` with `learned-gallery.css`, and `json-search.html` with `json-search.css`. `demos.html`, `demos.css` and `demos-handwiredos.webp` are the landing page. `site.css` has the colors, type sizes, spacing and the parts that every page shares, e.g. the page header, and `tool.css` the colors of highlighted JSON and the pattern field, for JSON search's page
- `template/`: the toggle switch to start an app from
- `docs/`: the docs above
- `tests/runtime/`: differential tests of the reference and compiled evaluators, including seeded random circuits (`builder-differential`, `numeric-ui-core`, `numeric-semantics`, `random-hardened`), and tests of index reads, gather lowering, comparisons, springs whose matrix the host writes, macro magnitude limits, cell declarations and prefix networks
- `tests/handwiredos/`, `tests/learned-gallery/` and `tests/json-search/`: each demo's tests, which run without a browser, e.g. HandwiredOS over scripted traces, the gallery's editor frame by frame, and JSON search's GPU code through an interpreter
- `scripts/check.ts`, `tsconfig.json`, `package.json`: `bun run check` type-checks and lints src/, tests/, scripts/, the template and each folder directly under lab/ that has a tsconfig.json, and type-checks each lab/ui-exploration prototype through its own tsconfig.json, and lab/ui-exploration/serve-demos.ts through the root one. package.json holds the scripts above. `knip.config.ts`: `bun run knip` reports unused exports in src/, scripts/ and template/
- `scripts/demo-site-pages.ts`, `scripts/serve-demo-site.ts`, `scripts/build-demo-site.ts` and `scripts/check-demo-site.ts`: the demo site, i.e. the list of its pages and their paths, the development server behind `bun start`, the static build into site/ behind `bun run site:build`, and the check of the built site in headless Chrome behind `bun run site:check`. `.github/workflows/pages.yml` runs the build on pushes to main and publishes site/ to GitHub Pages
- `scripts/measure-json-highlighter.ts`: the JSON highlighter's sizes and µs per evaluation in Bun
- `lab/`: the experiments, see [History](#history)

## History

Everything below is history: every item describes the code as it was when the item was written, and only [lab/status.md](lab/status.md) is kept current. On September 16, 2026, experiments that duplicated root HandwiredOS or each other were removed or merged into the folders that remain, and the [exploration-2026-09 tag](https://github.com/chenglou/handwired/tree/exploration-2026-09) keeps every removed path. The repo was named Indirect, and its desktop IndirectOS, until October 6, 2026. Files at the tag keep the old names in their paths, e.g. `lab/ui-exploration/indirect-os-2`, so links into the tag and mentions of files and folders that exist only at the tag use the old names too.

- `lab/`: learning experiments (learned-interpreter, reusable-layout, user-effort, data-adapter, event-window, generative-fields, cascade-argmax) and runtime studies (runtime-cost, trace-compiler), each with a README; hard-attend, a page that compares one-hot, direct and softmax gathers; candidate-gallery, where three photo layouts are scored while running and a balanced argmax picks one; regex-search, from September 17, 2026, a regex search as a tree of matrix products, timed on the CPU and on WebGPU, whose other form, a loop over the text, is the one that JSON search runs, in src/json-search/regex since October 14, 2026; json-search, the measurements of October 13 and 14, 2026 of the JSON highlighter's and regex search's programs over 100,000 documents on WebGPU, whose page and code moved into src/json-search on October 14, 2026; knuth-plass, Knuth-Plass line breaking as min-plus matrix products, timed on the CPU and on WebGPU, from September 17, 2026; `lab/research-sweep.md`, the changes landed in July 2026, and superseded experiments; `lab/reassessment-2026-09-03.md`, the September 3, 2026 review of the July results; and `lab/briefs/`, the July 2026 briefs. Four have a start script for their page: `bun run start:reusable`, `bun run start:hard-attend`, `bun run start:candidates` and `bun run start:knuth-plass`. hard-attend and research-sweep.md moved from the repo root on September 16, 2026, candidate-gallery moved from the repo root on September 17, 2026, and the earliest experiments, in `exp/`, moved into lab/event-window and lab/ui-exploration/learned-bits or were removed. Two experiments left lab/ for src/: the JSON highlighter on September 18, 2026, which is in src/json-search/highlighter since October 14, 2026, and the learned gallery, which moved from the repo root into lab/ on September 16, 2026 and into src/learned-gallery on October 14, 2026.
- `lab/ui-exploration/`: the record of the September 12-14, 2026 exploration of how far circuit UI goes, i.e. prototypes built on the runtime of that time or on copies of it, and the guide. 16 of the 24 prototypes remain, and the other 8 and the notes were removed or merged into the remaining ones on September 16, 2026. Its measurements describe the code as it was then. On September 17, 2026, lists gained text rows, a temporary demo of a traditional JavaScript task: a list of chat messages whose heights come from pretext, and text-walker gained many paragraphs at once, on the CPU and on WebGPU.

## License

MIT, see [LICENSE](LICENSE).
