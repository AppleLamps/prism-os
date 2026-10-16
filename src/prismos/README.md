# Prism OS

**Prism OS** is a showcase skin for the Handwired window-manager program: the same hand-built numeric circuit that runs [HandwiredOS](../handwiredos/README.md), with a macOS-style liquid glass look and a cascade of windows at startup.

## What is different

| Piece | HandwiredOS | Prism OS |
| --- | --- | --- |
| Look | Warm paper desk | Liquid glass windows, light and dark schemes, dune wallpaper, system-blue accent, traffic-light buttons, an app-icon dock |
| Layout | Magazine-style tiling | Gentle **cascade** (each window offset down-right) |
| Program windows | Monitor, Notes, Photos | **Scope** (circuit inspector), **Inkwell** (notes), **Chroma** (gallery) |
| Prism apps | None | **Cabinet** (files), **Browser** (web pages), **Calculator**, **Clock** (world clocks, stopwatch), **Terminal**, **Settings**, **About**, in glass panels beside the program |
| System | Links in a bar | A Mac-style menu bar (prism logo, the front app's name, clock), **Spotlight** (⌘K or Ctrl+K), **Control Center**, saved preferences: appearance, accent, four wallpapers, motion, weight arcs |
| Program | 9,909 weights, 130 layers | Shared circuit, with runtime gallery pages; 10,163 weights and 132 layers |

## How the shell and the program share the page

The program reads every press, move and key from listeners on `window`. Everything the shell draws carries `data-prism-layer`, and the shell registers its own `window` listeners before the program mounts. So an event that starts on a panel, a dock tile of Prism's, the menu bar extras, Spotlight or Control Center reaches the shell's handlers and then stops before the program sees it. Prism's panels stack among the program's windows: a press on a program window sends them behind it, and a press on a panel brings them back in front. Spotlight and Terminal open a program window the program's own way, with a press and a release on its dock tile.

## Spotlight's commands

Spotlight (⌘K or Ctrl+K) finds apps and settings, and it also runs what you type: "put Scope and Chroma side by side", "move Inkwell to the top right", "open Blue Lagoon", "note: buy milk", "dark mode and an orange accent", "lagoon wallpaper", "start the stopwatch", "what time is it in Tokyo", "what is 17 times 23". As you type, a sentence Spotlight can run shows as the first result with the calls it will make, e.g. `side_by_side(scope, chroma)`. Enter runs it, and Spotlight stays open with the reply and the calls that ran. One word is a search, a sentence is a command. "help" lists examples.

A sentence takes one path today, and a second one later:

1. **The quick parser** (`quick-commands.ts`) reads the sentences people type most, including several commands joined by commas, "and" or "then", or run together the way speech recognition writes them ("close inkwell open safari and search for youtube"), and arithmetic. It runs at once, with nothing to download.
2. **The model**, off until it's trained on the final command list: FunctionGemma 270M, fine-tuned on Prism OS's commands, running in a worker in the browser on WebGPU (`model-worker.ts`). It takes the sentences the patterns miss. `modelEnabled` in `command-center.ts` switches it on for everyone, and `?model=on` on the page switches it on for one visit.

Every call passes the validator in `commands.ts`, which accepts the names people use ("notes", "the gallery", "photo 3", "grey", "NYC") and rejects anything Prism OS lacks. The operator (`operator.ts`) runs what passes. Commands for the program's windows become the pointer and key events a hand would make, aimed at points the program itself computes: a click on the minimize button, a drag of a title bar, a release on a dock tile. So the program's rules hold for commands exactly as for a person, e.g. a window moved by a command still can't leave the workspace. Commands for Prism's apps go through the shell's own functions, the same ones their buttons call. Erasing or replacing the note asks first.

| Commands | What they do |
| --- | --- |
| `open_app`, `minimize_app`, `maximize_app`, `restore_app`, `close_app`, `move_app` | Any app: the program's windows through their buttons and dock tiles, Prism's apps through the shell |
| `resize_app`, `side_by_side`, `show_desktop`, `reset_layout` | Drags of the program's title bars and corner grips; show desktop also minimizes Prism's apps |
| `open_photo`, `next_photo`, `previous_photo`, `close_photo`, `slideshow` | Chroma, by photo name or number |
| `scope_show`, `scope_list` | Scope's sidebar and list keys |
| `write_note`, `clear_note`, `read_note` | Inkwell's note, which is saved in the browser |
| `set_theme`, `set_accent`, `set_wallpaper`, `set_motion`, `set_arcs` | The preferences in `settings.ts`, as Control Center sets them |
| `calculate`, `stopwatch`, `start_timer`, `timer`, `world_time` | Arithmetic with precedence (`expression.ts`), Clock's stopwatch, Clock's timer (lengths as people say them, `durations.ts`; pause, resume, cancel), the time in 30 cities |
| `open_website`, `search_web`, `browser_navigate` | Browser, at an address or a Bing search, and its back, forward, reload and Favorites buttons, see below. Questions about the world ("what's the weather in Tokyo") are searches. A bare "back" or "next" is `previous_photo` or `next_photo` marked `bare`, which acts on the front app: Browser's pages while Browser is in front |
| `get_stats`, `explain` | The program's live sizes, short explanations |

### Training the model

`commands.ts` is the single source of truth for the model too. When the command list is final:

```sh
bun scripts/prismos-dataset.ts   # writes src/prismos/training/{train,eval}.jsonl and tools.json
bun test tests/prismos/training-data.test.ts   # the data matches the commands and the quick parser
python3 src/prismos/training/train.py --data src/prismos/training --repo x --check-data   # the scorer, no GPU
git push                         # the job reads the data and the script from the repo
hf jobs uv run --flavor a100-large --secrets HF_TOKEN --timeout 2h \
  https://raw.githubusercontent.com/AppleLamps/prism-os/<commit>/src/prismos/training/train.py \
  --data https://raw.githubusercontent.com/AppleLamps/prism-os/<commit>/src/prismos/training \
  --repo AppleLampsX/prism-os-functiongemma
```

The data has 10,000 training sentences and about 900 eval sentences whose phrasings never appear in training, so the eval score measures sentences shaped unlike anything the model saw. How the data is made:

- **Every command gets its share.** Each kind of row is made about as often as the commands it teaches, more for commands whose arguments vary most, so the rarest command has about 50 training rows and every command appears in eval.
- **Arguments are copied as written.** Paths, notes, searches, addresses, timer lengths and arithmetic are the user's own words, which the validator reads; a sentence that copies words is never written in capitals.
- **Free text ends where a command can start.** In a longer sentence, a search, a path or an address is followed by a comma or "and", never run straight into the next command, since where it ends would be a guess.
- **The quick parser agrees.** `tests/prismos/training-data.test.ts` checks that every row the quick parser reads gets the same calls as the data, that every call validates, that eval and training never share a sentence, and that `tools.json` matches `commands.ts`.

`train.py --check-data` runs without a GPU or downloads: every expected answer, written as the model writes calls, must parse and score as correct, and the scorer must accept equal calls written differently (`17 times 23` and `17 * 23`, `an hour and a half` and `90 minutes`, `wikipedia dot org` and `https://wikipedia.org/`) while telling different ones apart. During training, about 150 eval sentences are a dev set scored every half epoch; the best checkpoint's weights are kept, and the reported scores leave the dev sentences out. Each prompt carries all 50 declarations, about 3,300 tokens, and 3,288 of them are the same in every prompt, so `train.py` runs that shared prefix once per batch and only each sentence's own ~40 tokens on top: the same loss and gradients as running every row whole (checked on CPU against the whole-row method), for about a fourteenth of the work. Weights stay in fp32 for AdamW while the math runs in bf16, and evaluation decodes up to 64 sentences at once, grouped by length so nothing is padded; the script checks that against Transformers' own `generate()` before it starts. Run it on `a100-large` ($2.50 an hour): training should take about 5 to 15 minutes and the whole job about 30 to 45, so `--timeout 2h` leaves plenty of room. These are estimates from the work per step, not a measured run. On a GPU with less than 40 GB pass `--micro 8`. A first run on an earlier command list went from 22.1% (base FunctionGemma) to 78.4% on those held-out sentences, before the phrasings were widened. `train.py` fine-tunes the whole model, scores it, uploads the PyTorch weights, and builds the browser file by writing the fine-tuned weights into onnx-community/functiongemma-270m-it-ONNX's q4f16 graph (`onnx_weights.py`: 4-bit weights in blocks of 32 with ONNX Runtime's own quantizer, which reproduces the reference file's weights byte for byte), so the browser runs exactly the graph it already runs. It then cuts the vocabulary projection to the last position (`last_token_logits.py`, which avoids about 1.7 GB of logits per prompt), checks the browser file's answers against PyTorch's, and publishes to the Hub, privately unless `--public` is passed. The page can only load a public repo. `--checkpoint <repo> --skip-training` builds the browser file again from saved weights without training.

## Voice

Spotlight's microphone (`voice.ts`, drawn by `shell.ts`) turns what's said into the search text, as if typed, with the words appearing as they're heard. Enter runs it, as for typed text. Every phrasing works the same spoken or typed: browser names mean Browser ("open safari"), spoken addresses are addresses ("go to wikipedia dot org"), and commands said in one breath without commas run in order.

Where the speech is recognized decides what Voice asks:

- **On the device** (Chrome and Edge 139 and later, `SpeechRecognition.available` with `processLocally`): with the language pack installed, Voice just listens and nothing leaves the computer. Without it, Voice asks before the browser downloads it (`SpeechRecognition.install`).
- **Online** (Safari, and Chrome without on-device support): the browser sends the audio to its maker's service. Voice says so and asks once; the answer is kept under `prism-os.voice-online`.
- **Neither** (Firefox): no microphone.

Voice listens for English, the language of the commands: the visitor's English locale, else `en-US`. Recognition errors become one line under the search, e.g. a blocked microphone or no speech heard.

## Browser

Browser (`browser.ts`) shows web pages in a sandboxed iframe inside a glass panel, with an address bar, back, forward, reload, Open in New Tab and a page of favorites. Open it from the dock, Spotlight ("open the browser", "go to wikipedia.org", "search the web for glass prisms") or Terminal ("open browser"). Words that aren't an address search Bing.

- **Sites that refuse frames.** Many big sites send `X-Frame-Options` or a CSP `frame-ancestors` rule, and the visitor's browser then leaves the frame empty. A page can't read that from a cross-origin frame, so `web-address.ts` lists the sites known to refuse (Google, YouTube, GitHub, X, Reddit and others, each checked) and Browser shows a card with an Open in New Tab button instead. A site missing from the list shows the browser's own error page in the frame. YouTube watch links play in YouTube's embed player, and Google searches use `igu=1`, which Google allows in frames.
- **History.** Cross-origin pages hide their addresses, so back and forward step through the pages Browser opened (address bar, favorites, Spotlight), and a link followed inside a page doesn't change the address bar. Browser moves the frame with `location.replace`, so its own navigations don't add to the desktop's history.
- **Sandbox.** `allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox`, and never `allow-top-navigation`, so nothing in a page can navigate Prism OS away. With scripts and same-origin together, a page of Prism OS's own origin could lift the sandbox, so Browser refuses that origin. Chrome logs a warning about that pair of flags whenever a frame exists, so the frame is made the first time a page shows, never at boot.
- **Input.** A press inside the frame never reaches the page, so the shell brings a panel to the front when the page loses the keyboard to a frame in it. While any press is held, the frame takes no pointer events, so a drag of a window or panel over it isn't swallowed.
- **Visibility.** A minimized Browser keeps its page, which the browser stops painting while the panel is hidden. Closing Browser unloads the page and forgets its history.

## Cabinet

Cabinet stores files in this browser using IndexedDB. Open it from the dock, Spotlight
("open files"), or Terminal ("open cabinet"). Import individual files up to 50 MiB,
organize folders, search all live files, rename, move, duplicate, download, and use
recoverable Trash. Permanent deletion asks for confirmation. Browser storage can be
cleared or evicted; download copies of anything you want to keep. There is no cloud sync,
disk-folder access, folder import/export, or archive extraction.

UTF-8 text files up to 1 MiB open in Inkwell. It saves after 500 ms of inactivity and
flushes before switching documents or closing. Save As makes a new file. Failed saves
retain the draft; Retry, Save As, Download, or Discard resolve it. Revisions prevent a
second tab from silently replacing newer content. The old `prism-os.note` value is kept
as a migration backup; migration creates `Documents/Notes.txt` only once.

PNG, JPEG, WebP, GIF, and AVIF open in Chroma as a name-sorted collection of images from
the same folder. The circuit still lays out 12 slots; queued page-load events set which
slots exist and reset animation state. Arrow keys, controls, and slideshow cross page
boundaries. The toolbar switches back to the bundled gallery. HTML and SVG are download
only. Previews release blob URLs when no longer needed.

Spotlight examples: `list files in /Documents`, `search files for Plan`,
`create document /Documents/Plan.txt`, `open file /Documents/Plan.txt`,
`save my note as /Documents/Copy.txt`, `rename file /Documents/Copy.txt to Draft.txt`,
`move file /Documents/Draft.txt to /`, `duplicate file /Documents/Plan.txt`,
`trash file /Documents/Plan.txt`, `restore file /Documents/Plan.txt`,
`download file /Documents/Plan.txt`, `delete file /Documents/Plan.txt`, `empty trash`,
and `import files`. Paths are relative to Cabinet's current folder unless they start
with `/`. An ambiguous name returns paths to choose from. Import requires pressing
Cabinet's Import button. Named bundled photos switch collections; image numbers use
the active collection.

Storage, migration, conflict, document, command, and numeric gallery tests run with
`bun test tests/prismos`. The browser acceptance fixture uses a dedicated Playwright CLI
session and resets only that session's Cabinet database. With `bun start` running:

```powershell
npx --yes --package @playwright/cli playwright-cli -s=cabinet open http://127.0.0.1:3000/ --browser msedge
npx --yes --package @playwright/cli playwright-cli -s=cabinet run-code --filename tests/prismos/cabinet.pwcode
npx --yes --package @playwright/cli playwright-cli -s=cabinet run-code --filename tests/prismos/cabinet-failures.pwcode
```

The fixtures check import, autosave, reload, duplicate, rename, Trash and restore,
binary download, 25-image pagination by keyboard and pointer, slideshow, commands,
desktop/dark/narrow layouts, conflicting revisions, Save As recovery, transaction
aborts, and broken images. Narrow layouts have a Preview toggle beside Grid / List.
Screenshots are written under `output/playwright/`. For the production smoke test on
Windows, set `CHROME_PATH` to a Chrome or Edge executable before `bun run site:check`.

## Run it

From the repo root:

```sh
bun install
bun start    # Prism OS at http://127.0.0.1:3000/ (the site's front page)
```

Or only this page:

```sh
bun ./assets/prism-os.html
```

## Files

| File | Role |
| --- | --- |
| `boot.ts` | Loads the preferences and the saved note, starts the wallpaper and the shell, mounts the window manager with Prism's arrangement, and connects Spotlight's commands to it |
| `arrangement.ts` | Cascade layout on top of HandwiredOS's `arrangeInitialWindows` |
| `wallpaper.ts` | Full-bleed glass dunes behind the weight arcs: four scenes, each with a day and a night palette |
| `glass.ts` | What the CSS glass can't do alone: refraction at the rims of the dock, Spotlight and Control Center (an SVG displacement map per element, redrawn only when its size changes; Chromium only, off with `?refraction=off` or under `prefers-reduced-transparency`), and the light that follows the pointer over `[data-glass-light]` elements, written once a frame and only while the pointer moves |
| `shell.ts` | Everything beside the program: input routing, Prism's panels and their dock tiles, the menu bar (the front app's name, the extras), Spotlight and Control Center; it returns the controls the operator uses for Prism's apps |
| `apps.ts` | The views of Calculator, Clock, Terminal, Settings and About |
| `calculator.ts`, `terminal.ts` | Calculator's arithmetic and Terminal's commands, apart from their views |
| `settings.ts`, `controls.ts` | The stored preferences, and the controls that Control Center and Settings share |
| `dom.ts` | Element and icon helpers |
| `command-center.ts` | Spotlight's commands: the preview as you type, running a sentence, replies, confirmations, the model's status, and the slideshow |
| `commands.ts` | The commands: the function declarations the model sees, and the validator every call passes |
| `quick-commands.ts`, `expression.ts` | The patterns for common sentences, and the arithmetic parser |
| `operator.ts` | Runs a command: the program's windows through their own events, Prism's apps through the shell, preferences and the note in the page |
| `function-calls.ts`, `model-worker.ts` | FunctionGemma's call format, and the model in a worker through Transformers.js on WebGPU |
| [`training/`](training) | `train.py`, the Hugging Face job, its helpers `onnx_weights.py` and `last_token_logits.py`, and the data that `scripts/prismos-dataset.ts` writes |
| [`tests/prismos/`](../../tests/prismos) | The cascade at many viewport sizes, Calculator's arithmetic, Terminal's commands, the stored preferences, and a check that no palette or accent is purple |
| [`assets/prism-os.html`](../../assets/prism-os.html), [`assets/prism-os.css`](../../assets/prism-os.css) | Page and theme |
