# JSON search's measurements

This folder holds the measurement scripts, the measurement pages and the raw results of [JSON search](../../src/json-search/README.md), the demo that searches 100,000 JSON documents on the GPU at each keystroke. The page, the two programs that it runs and their tests were in this folder until October 14, 2026. Since then the code is in src/json-search, the page is assets/json-search.html, and the tests are in tests/json-search. The README moved with the code: it has every table that these scripts print, and [how to run them](../../src/json-search/README.md#how-to-run-it).

| Path | What it holds |
| --- | --- |
| `gpu/` | Each measurement page with its harness, e.g. `combined-page.ts` with `combined-run.ts`, which opens the page in a headless Chrome of its own, and the scripts that print the tables, e.g. `search-summarize.ts`. `chrome.ts` is the headless Chrome driver, and `measure.ts` holds the sampling helpers |
| `results/` | The raw results of those runs, 31 JSON files |
| `report.ts` | The sizes of both programs and of their shaders, and the generated documents' distribution, without a GPU |
| `million/` | A check of a million documents with hand-written kernels, and the making and the reviews of the second code writer, src/json-search/bit-emit.ts, with [a README of its own](million/README.md) |

From the repo root:

```sh
bunx tsc -p lab/json-search    # type-check this folder's scripts, with what they import from src/ and tests/
```
