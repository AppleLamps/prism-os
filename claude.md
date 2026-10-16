# Prism OS: guide for Claude and other coding agents

Read this file before changing anything. It says what Prism OS is today, how it's built, the rules that keep it working, and what comes next.

## What Prism OS is

Prism OS is a desktop that runs in the browser. Its three main windows are run by a neural network that was written by hand, not trained: [Handwired](https://github.com/chenglou/handwired) compiles ordinary JavaScript window-manager logic into exact matrix multiplications and ReGLU gates over FP32 numbers. Prism OS puts a liquid glass desktop around that program, adds its own apps beside it, and adds Spotlight, which runs typed sentences as commands.

- **Live site:** https://prism-os-orcin.vercel.app (Vercel project `prism-os` in the team "applelamps' projects"). The plain `prism-os.vercel.app` belongs to someone else.
- **Repo:** `AppleLamps/prism-os`, a fork of `chenglou/handwired`. Every push to `main` deploys to production.
- **The site is Prism OS alone.** No demo list, no "All demos" link, no "Source" link, no command that leaves the page. The old addresses (`/prism-os/`, `/demos/`, `/os/`, `/learned-gallery/`, `/json-search/`) redirect to `/`. Keep it that way: Prism OS is a product of its own, not one demo among several.
- The other Handwired pages (`assets/demos.html`, `assets/index.html` for HandwiredOS, `learned-gallery.html`, `json-search.html`) and their code stay in the repo, since Prism OS runs on Handwired's engine and upstream changes should merge cleanly. They are never published. They still run locally with `bun ./assets/<page>.html`.

### What a visitor gets

| Part | What it is |
| --- | --- |
| **Scope**, **Inkwell**, **Chroma** | The three program windows: the live circuit inspector, the note (saved in the browser), the photo gallery with a lightbox. Drag, resize, stack, minimize, maximize, all decided by the handwired program |
| **Cabinet**, **Browser**, **Calculator**, **Clock**, **Terminal**, **Settings**, **About** | Prism's own apps, in glass panels beside the program, in plain JavaScript. Cabinet keeps files in the browser. Browser shows web pages in a sandboxed iframe. Clock has world clocks and a stopwatch with laps |
| Menu bar | Laid out like a Mac's: the prism logo (opens About) and the front app's name in bold at the left (Prism OS when nothing is open), Spotlight, Control Center and the clock at the right. Nothing else |
| **Spotlight** (⌘K or Ctrl+K) | Finds apps and settings, and runs sentences as commands, see below. Its microphone turns speech into the search text (`voice.ts`) |
| **Control Center** and Settings | Appearance (light, dark, auto), seven accents, four wallpapers (dunes, lagoon, ember, graphite), motion, weight arcs. Saved in the browser |

The program is unchanged from HandwiredOS: **234 source cells, 4,646 operations, 130 layers, 9,909 weights, no training.** Those counts change only if `src/handwiredos/window-manager.ts` changes.

## How it's built

Handwired programs are fixed lists of FP32 operations (`affine`, `reglu`, `boolean`, `indexRead`) built once in TypeScript and evaluated every frame over a `Float32Array` source table. The **host** (plain JavaScript) writes pointer, key and viewport inputs into the machine, runs it, copies next-state cells back, and writes the DOM. Prism OS lives almost entirely in the host.

| Piece | Where |
| --- | --- |
| The program and its machine | `src/handwiredos/window-manager.ts` (`createWindowManagerMachine`, `mountWindowManager`). Photos and Scope's list live inside the program too: `photo-gallery.ts`, `value-list.ts` |
| Prism's entry | `src/prismos/boot.ts`: loads preferences and the saved note, starts the wallpaper and the shell, mounts the window manager with Prism's arrangement, connects Spotlight |
| Opening layout | `src/prismos/arrangement.ts`: Handwired's tiling, then a cascade, clamped to the workspace |
| Wallpaper | `src/prismos/wallpaper.ts`: animated dunes on a canvas behind the weight arcs |
| Glass | `src/prismos/glass.ts`: the refraction at the rims of the dock, Spotlight and Control Center, and the light that follows the pointer over lit glass |
| Shell | `src/prismos/shell.ts` with `apps.ts`, `browser.ts` and `web-address.ts`, `calculator.ts`, `terminal.ts`, `settings.ts`, `controls.ts`, `dom.ts`: panels, dock tiles, menu bar, Spotlight and Control Center |
| Spotlight's commands | `commands.ts`, `quick-commands.ts`, `voice.ts`, `expression.ts`, `operator.ts`, `command-center.ts`, `function-calls.ts`, `model-worker.ts` |
| Page | `assets/prism-os.html`, `assets/prism-os.css` (which builds on `site.css` and `handwired-os.css` for geometry and hit targets) |

How the shell and the program share the page is explained in `src/prismos/README.md`. In short: everything the shell draws carries `data-prism-layer`, the shell's `window` listeners run before the program's and stop events that start on shell elements, and Prism's panels stack among the program's windows.

Window sizes, title bar height, dock height and hit-test geometry belong to `window-manager.ts` and `handwired-os.css`. Prism CSS changes color, blur, radii and branding, never layout constants the program assumes.

## Spotlight's commands

Spotlight runs what people type: "put Scope and Chroma side by side", "move Inkwell to the top right", "open Blue Lagoon", "note: buy milk", "dark mode and an orange accent", "start the stopwatch", "what time is it in Tokyo", "what is 17 times 23", "go to wikipedia.org", "search the web for glass prisms". One word is a search, a sentence is a command. The full list of 47 commands is the table in `src/prismos/README.md`.

A sentence goes through two readers:

1. **The quick parser** (`quick-commands.ts`): patterns for the sentences people type most, several commands joined by commas, "and" or "then" or run together without them as speech writes them ("close inkwell open safari and search for youtube"), and arithmetic. Instant, nothing to download. This is what the live site uses today.
2. **The model**: FunctionGemma 270M fine-tuned on Prism OS's commands, running in a Web Worker in the browser on WebGPU (`model-worker.ts`, Transformers.js, 4-bit weights). No server, no API key, nothing leaves the browser. It handles the sentences the patterns miss. **It is off** until it's trained on the final command list. `?model=on` turns it on for one visit, for testing.

Every call, from either reader, passes the validator in `commands.ts`, and the operator (`operator.ts`) runs it. Rules:

- `src/prismos/commands.ts` is the single source of truth, for the page and for the model's training data. A new feature people would ask for by name gets: a command in `commands.ts`, a pattern in `quick-commands.ts` if it's common, a case in `operator.ts`, phrasings in `scripts/prismos-dataset.ts`, and a test.
- The operator acts on the program only through its event methods (`pointerDown`, `pointerMove`, `pointerUp`, `photoNext`, `valueListKey`, ...), aimed at points read from the program's outputs. Never write source cells from outside the machine. `mountWindowManager` returns `{machine, nextFrame}` for this.
- Prism's apps are reached only through the controls `startShell` returns, never by editing panel elements.
- Anything hard to undo asks first (`needsConfirmation`): erasing the note, replacing it.
- Voice (`voice.ts`) only fills Spotlight's field: what's heard runs when Enter is pressed. It listens on the device when the browser can (Chrome and Edge 139+, after a language pack the visitor agrees to download), and otherwise asks once before using the browser's online service (Google's in Chrome, Apple's in Safari), because that sends the audio off the device. Browser names (Safari, Chrome, Firefox, Edge) are aliases of Browser, so "open safari" works.
- There is no command that navigates away from the page, and there shouldn't be one. Browser's pages stay inside its frame: the sandbox has no `allow-top-navigation`, and Browser never frames Prism OS's own origin, since a same-origin page could lift the sandbox. Only the visitor's own press on Open in New Tab opens a tab.

## Performance rules

Prism OS should never do work nobody can see. These rules came from a performance review (commit `543e3d2`) and keep the page light on laptops and phones:

- **Hidden apps don't draw.** A panel app gets `visible(true)` when it opens or comes back from the dock, and `visible(false)` when it closes or is minimized (`AppInstance` in `apps.ts`, called by `openPanel` and `hidePanel` in `shell.ts`). Timers and animation frames run only while the content is seen. Clock's world clocks tick only while their tab shows, and the stopwatch animates only while it runs on screen. Time is always computed from `performance.now()`, never counted by frames, so pausing the drawing never changes the time, and anything that comes back into view is drawn at once.
- **Build DOM once, update text.** Stopwatch laps are created once each. Only the running lap's time changes. Write text and attributes only when the value changed (`textWriter` in `apps.ts`).
- **Diff style writes.** `projectWindowElements` and `projectDockItem` in `window-manager.ts`, Scope's list in `value-list.ts`, and `place()` in `shell.ts` remember what they last wrote and skip unchanged values. Only those functions write those properties. If you add another writer, it bypasses the cache and the two will disagree.
- **Batch drags into frames.** A panel drag records the pointer and moves the panel once per displayed frame. The program's own windows keep every timestamped pointer sample: that's how its springs stay exact, so don't batch those.
- **Hidden Scope records but doesn't chart.** The footer keeps recording frame times while Scope is in the dock and draws them when it returns. Scope's list keeps rendering while hidden (its diffing makes that nearly free), since skipping it could break its scroll handling.
- **Wallpaper:** each dune's crest is computed once per draw and traced for both fill and rim. The sky and dune gradients are cached until the size or palette changes. `set()` ignores settings the wallpaper doesn't show (accent, arcs).
- **Prove that it looks the same.** A performance change must leave the pixels unchanged. For the wallpaper, draw the old and new code at the same time and size and compare every pixel (this is how commit `543e3d2` was checked: identical in all 104 cases). For the page, compare screenshots taken with Playwright's fake clock. The dune rims and stopwatch digits vary slightly between two runs of the same build, so compare against that noise.

## Building and deploying

```sh
bun install
bun start                    # Prism OS at http://127.0.0.1:3000/
bun ./assets/prism-os.html   # the page alone
bun run check                # type-check and lint (must be clean)
bun x knip                   # unused files and exports (must be clean)
bun test tests/prismos       # Prism: cascade, apps, settings, Spotlight's commands (~2 s)
bun test --timeout 30000 tests/handwiredos   # the window manager (~30 s; one test needs the longer timeout)
bun run site:build           # the site as static files in site/
```

- `scripts/demo-site-pages.ts` lists what the site publishes: one page, `assets/prism-os.html` at `/`, and one worker, `model-worker.js` next to it. `build-demo-site.ts` builds it, `serve-demo-site.ts` serves it while developing, `check-demo-site.ts` loads it in headless Chrome.
- `vercel.json` installs and builds with **Bun 1.4.3** through `npx -y bun@1.4.3`. Vercel's own Bun (1.3.x) writes empty script chunks that other scripts import, and an earlier build deleted them, which left a blank page in production. The build now keeps any empty chunk that a script imports. Don't remove the pin without testing a production build.
- Every link on the page is relative, so the site also works under a path prefix.
- After a push, check the deployment: the page loads, Scope shows its counts, and the console has no errors.
- `tests/json-search` has a CPU search test that fails on `main` too. It's upstream code that Prism OS doesn't use.

## Plans

### 1. Launch on Vercel. Done

The site is live, standalone, and deployed from `main`.

### 2. Freeze the features, then train the model once

The decision was to finish Prism OS's features before training, so the model is trained once on the final command list instead of retrained after every feature. Training costs a GPU run on Hugging Face (account **AppleLampsX**).

Before training, the command list must be final: every feature people would ask for by name has a command, and `bun scripts/prismos-dataset.ts` has been run so `src/prismos/training/` matches `commands.ts`. The data today: 8,000 training sentences and about 700 eval sentences whose phrasings never appear in training, over 47 commands.

The run, from `src/prismos/README.md`:

```sh
bun scripts/prismos-dataset.ts   # writes train.jsonl, eval.jsonl and tools.json
git push                         # the job reads the data and the script from GitHub
hf jobs uv run --flavor a10g-small --secrets HF_TOKEN --timeout 2h \
  https://raw.githubusercontent.com/AppleLamps/prism-os/<commit>/src/prismos/training/train.py \
  --data https://raw.githubusercontent.com/AppleLamps/prism-os/<commit>/src/prismos/training \
  --repo AppleLampsX/prism-os-functiongemma
```

`train.py` fine-tunes the whole model, scores the base and the fine-tuned model on the eval set, uploads the PyTorch weights, exports a browser model with ONNX Runtime GenAI (4-bit weights in blocks of 32, `last_token_logits.py` so a prompt doesn't produce about 2 GB of logits), checks the ONNX model's answers, and publishes to the Hub **privately**. `--checkpoint <repo> --skip-training` re-exports saved weights without training. `--public` publishes publicly.

The first run, on an earlier command list, went from 22.1% (base FunctionGemma) to 78.4% on the held-out eval sentences. The eval phrasings have been widened since.

Earlier mistakes to avoid: whole skills held out of training (ordinal photo names, "night mode", exits from full screen) made the eval look worse than the model was, so every kind of phrase appears in both splits with different wording. An export once crashed for a missing `onnx-ir` dependency, so the script uploads its checkpoint before exporting and can export alone.

### 3. Turn the model on

1. Load the private model with `?model=on` and test it against the quick parser's misses.
2. The owner makes the Hugging Face repo public (the page can only load a public repo).
3. Set `modelEnabled` in `src/prismos/command-center.ts` to true for everyone. Keep `?model=on` working for testing.
4. Keep the existing guards: the model downloads only after the visitor agrees (stored under `prism-os.model-consent`), WebGPU needs the `shader-f16` feature, `?model-device=wasm` runs it slowly on the CPU for testing, and the quick parser still answers first for the common sentences.

### 4. Measure before optimizing further

- Record real performance traces on a Windows desktop and an iPhone, in Chrome and Safari, covering script, paint and compositing, while dragging, resizing, maximizing and running the stopwatch.
- Moving the weight-arc drawing (`wiring.ts`) into a worker is on hold. It's worth doing only if traces show its redraws causing visible stalls, and it must keep resolution, stroke order, opacity and blending.
- Also unmeasured: the wallpaper asks for an animation frame at the display's rate and draws only every 66 ms. Whether that matters belongs in the same traces.

### Open items

- The old remote branch `command-center` is superseded by `main` and can be deleted when the owner agrees.
- A custom domain can be added in the Vercel project's Domains settings.

## Safe places to customize

| Goal | Where to edit |
| --- | --- |
| Rename apps, default note text, dock icons | `assets/prism-os.html` |
| Colors, glass, traffic lights, dock tiles | `assets/prism-os.css`: tokens live on `:root.prism`, every rule starts with `.prism-desktop`. Never move `#dock` itself, since the program hit-tests its tiles in desktop coordinates |
| Opening window positions | `src/prismos/arrangement.ts` |
| Wallpaper motion and palettes | `src/prismos/wallpaper.ts` (check pixels against the old code, see the performance rules) |
| A new Prism app | `src/prismos/apps.ts` (a `PanelApp`, with `visible()` if it runs timers), its dock side in `shell.ts`, its colors as `.prism-app-<id>` in `assets/prism-os.css`, and a command for it |
| Mount options | `src/prismos/boot.ts`, `WindowManagerMountOptions` in `window-manager.ts` |

## Design rules

- No purple or violet anywhere. The palette is blues, teals, warm sand and the macOS traffic-light colors. A test checks this.
- Every color, surface and shadow has a light and a dark value.
- Transforms on dock tiles only move paint. Never change the geometry of anything the program places.
- The glass follows Apple's Liquid Glass. The tokens are on `:root.prism`: `--glass-clear` (dock, floating controls) and `--glass-regular` (Spotlight, Control Center), their blurs, `--glass-specular` for the rim, `--glass-inner` for the inner glow, `--glass-lift` for the shadow. A glass surface takes its rim as a gradient border: `border: 1px solid transparent; background: linear-gradient(fill, fill) padding-box, var(--glass-specular) border-box`. Inner shapes follow the outer ones' radii, and buttons are capsules.
- The dock's shelf is `.prism-dock-glass`, a shell element inside `#dock` (it replaced `#dock::before`), sized from the number of tiles. It has `pointer-events: none`.
- Refraction runs in Chromium only (the only engine that takes an SVG filter in `backdrop-filter`). Elsewhere, under `prefers-reduced-transparency` and with `?refraction=off`, the same glass shows without the bend. The displacement map moves pixels and never splits colors, so there are no chromatic fringes, which would break the purple rule. Refracting glass blurs less (`--glass-blur-lens`), or the blur would erase the bend.
- `prefers-reduced-transparency` (Windows sends it when "Transparency effects" is off) makes all glass dense and turns off the refraction and the pointer's light.
- The menu bar holds the prism logo, the front app's name, Spotlight, Control Center and the clock. No outbound links. The name comes from the shell: the front panel while panels are in front, otherwise the program's focused window, which `mountWindowManager` reports through its `onFocusChange` option.

## Avoid unless you mean to change the whole OS

- `src/handwiredos/window-manager.ts`: the window manager, photos and Scope's list as one circuit
- `src/handwiredos/photo-gallery.ts`, `value-list.ts`: app logic inside the program
- `docs/execution-model.md`: numeric semantics and rounding

A fourth program window, or new interactions inside the program's windows, means editing the handwired program, not Prism's skin. An app that doesn't need to be part of the program belongs in Prism's shell as a panel. Never give a shell element the `.window` or `.dock-item` class: the program counts those at mount.

## Docs worth reading

1. `src/prismos/README.md`: Prism's files, the shell, every command, training
2. `src/handwiredos/README.md`: the window manager's behavior (springs, hit tests, releases)
3. `docs/tutorial.md`: cells, builder code, the host loop
4. Root `README.md`: Handwired itself (upstream's README)
