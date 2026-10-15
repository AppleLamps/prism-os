# Prism OS

**Prism OS** is a showcase skin for the Handwired window-manager program: the same hand-built numeric circuit that runs [HandwiredOS](../handwiredos/README.md), with a macOS-style liquid glass look and a cascade of windows at startup.

## What is different

| Piece | HandwiredOS | Prism OS |
| --- | --- | --- |
| Look | Warm paper desk | Liquid glass windows, light and dark schemes, dune wallpaper, system-blue accent, traffic-light buttons, an app-icon dock |
| Layout | Magazine-style tiling | Gentle **cascade** (each window offset down-right) |
| Program windows | Monitor, Notes, Photos | **Scope** (circuit inspector), **Inkwell** (notes), **Chroma** (gallery) |
| Prism apps | None | **Calculator**, **Clock** (world clocks, stopwatch), **Terminal**, **Settings**, **About**, in glass panels beside the program |
| System | Links in a bar | Menu bar clock, **Spotlight** (⌘K or Ctrl+K), **Control Center**, saved preferences: appearance, accent, four wallpapers, motion, weight arcs |
| Program | 9,909 weights, 130 layers | Identical — only host chrome and arrangement change |

## How the shell and the program share the page

The program reads every press, move and key from listeners on `window`. Everything the shell draws carries `data-prism-layer`, and the shell registers its own `window` listeners before the program mounts. So an event that starts on a panel, a dock tile of Prism's, the menu bar extras, Spotlight or Control Center reaches the shell's handlers and then stops before the program sees it. Prism's panels stack among the program's windows: a press on a program window sends them behind it, and a press on a panel brings them back in front. Spotlight and Terminal open a program window the program's own way, with a press and a release on its dock tile.

## Spotlight's commands

Spotlight (⌘K or Ctrl+K) finds apps and settings, and it also runs what you type: "put Scope and Chroma side by side", "move Inkwell to the top right", "open Blue Lagoon", "note: buy milk", "dark mode and an orange accent", "lagoon wallpaper", "start the stopwatch", "what time is it in Tokyo", "what is 17 times 23". As you type, a sentence Spotlight can run shows as the first result with the calls it will make, e.g. `side_by_side(scope, chroma)`. Enter runs it, and Spotlight stays open with the reply and the calls that ran. One word is a search, a sentence is a command. "help" lists examples.

A sentence takes one path today, and a second one later:

1. **The quick parser** (`quick-commands.ts`) reads the sentences people type most, including two commands joined by "and" or "then", and arithmetic. It runs at once, with nothing to download.
2. **The model**, off until it's trained on the final command list: FunctionGemma 270M, fine-tuned on Prism OS's commands, running in a worker in the browser on WebGPU (`model-worker.ts`). It takes the sentences the patterns miss. `modelEnabled` in `command-center.ts` switches it on for everyone, and `?model=on` on the page switches it on for one visit.

Every call passes the validator in `commands.ts`, which accepts the names people use ("notes", "the gallery", "photo 3", "grey", "NYC") and rejects anything Prism OS lacks. The operator (`operator.ts`) runs what passes. Commands for the program's windows become the pointer and key events a hand would make, aimed at points the program itself computes: a click on the minimize button, a drag of a title bar, a release on a dock tile. So the program's rules hold for commands exactly as for a person, e.g. a window moved by a command still can't leave the workspace. Commands for Prism's apps go through the shell's own functions, the same ones their buttons call. Erasing or replacing the note and leaving the page ask first.

| Commands | What they do |
| --- | --- |
| `open_app`, `minimize_app`, `maximize_app`, `restore_app`, `close_app`, `move_app` | Any app: the program's windows through their buttons and dock tiles, Prism's apps through the shell |
| `resize_app`, `side_by_side`, `show_desktop`, `reset_layout` | Drags of the program's title bars and corner grips; show desktop also minimizes Prism's apps |
| `open_photo`, `next_photo`, `previous_photo`, `close_photo`, `slideshow` | Chroma, by photo name or number |
| `scope_show`, `scope_list` | Scope's sidebar and list keys |
| `write_note`, `clear_note`, `read_note` | Inkwell's note, which is saved in the browser |
| `set_theme`, `set_accent`, `set_wallpaper`, `set_motion`, `set_arcs` | The preferences in `settings.ts`, as Control Center sets them |
| `calculate`, `stopwatch`, `world_time` | Arithmetic with precedence (`expression.ts`), Clock's stopwatch, the time in 30 cities |
| `open_link`, `get_stats`, `explain` | The demos page or the source, the program's live sizes, short explanations |

### Training the model

`commands.ts` is the single source of truth for the model too. When the command list is final:

```sh
bun scripts/prismos-dataset.ts   # writes src/prismos/training/{train,eval}.jsonl and tools.json
git push                         # the job reads the data and the script from the repo
hf jobs uv run --flavor a10g-small --secrets HF_TOKEN --timeout 2h \
  https://raw.githubusercontent.com/AppleLamps/prism-os/<commit>/src/prismos/training/train.py \
  --data https://raw.githubusercontent.com/AppleLamps/prism-os/<commit>/src/prismos/training \
  --repo AppleLampsX/prism-os-functiongemma
```

The data has 8,000 training sentences and about 700 eval sentences whose phrasings never appear in training, so the eval score measures sentences shaped unlike anything the model saw. A first run on an earlier command list went from 22.1% (base FunctionGemma) to 78.4% on those held-out sentences, before the phrasings were widened. `train.py` fine-tunes the whole model, scores it, uploads the PyTorch weights, builds the browser file with ONNX Runtime GenAI's builder (4-bit weights in blocks of 32, fp16 activations), cuts the vocabulary projection to the last position (`last_token_logits.py`, which avoids about 2 GB of logits per prompt), checks the ONNX file's answers, and publishes to the Hub, privately unless `--public` is passed. The page can only load a public repo. `--checkpoint <repo> --skip-training` exports saved weights again without training.

## Run it

From the repo root:

```sh
bun install
bun start    # open /prism-os/ on the demo site (default port 3000)
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
| `shell.ts` | Everything beside the program: input routing, Prism's panels and their dock tiles, the menu bar extras, Spotlight and Control Center; it returns the controls the operator uses for Prism's apps |
| `apps.ts` | The views of Calculator, Clock, Terminal, Settings and About |
| `calculator.ts`, `terminal.ts` | Calculator's arithmetic and Terminal's commands, apart from their views |
| `settings.ts`, `controls.ts` | The stored preferences, and the controls that Control Center and Settings share |
| `dom.ts` | Element and icon helpers |
| `command-center.ts` | Spotlight's commands: the preview as you type, running a sentence, replies, confirmations, the model's status, and the slideshow |
| `commands.ts` | The commands: the function declarations the model sees, and the validator every call passes |
| `quick-commands.ts`, `expression.ts` | The patterns for common sentences, and the arithmetic parser |
| `operator.ts` | Runs a command: the program's windows through their own events, Prism's apps through the shell, preferences, the note and links in the page |
| `function-calls.ts`, `model-worker.ts` | FunctionGemma's call format, and the model in a worker through Transformers.js on WebGPU |
| [`training/`](training) | `train.py`, the Hugging Face job, `last_token_logits.py`, and the data that `scripts/prismos-dataset.ts` writes |
| [`tests/prismos/`](../../tests/prismos) | The cascade at many viewport sizes, Calculator's arithmetic, Terminal's commands, the stored preferences, and a check that no palette or accent is purple |
| [`assets/prism-os.html`](../../assets/prism-os.html), [`assets/prism-os.css`](../../assets/prism-os.css) | Page and theme |
