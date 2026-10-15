# Prism OS

**Prism OS** is a showcase skin for the Handwired window-manager program: the same hand-built numeric circuit that runs [HandwiredOS](../handwiredos/README.md), with a macOS-style liquid glass look and a cascade of windows at startup.

## What is different

| Piece | HandwiredOS | Prism OS |
| --- | --- | --- |
| Look | Warm paper desk | Liquid glass windows, light and dark schemes, dune wallpaper, system-blue accent, traffic-light buttons, an app-icon dock |
| Layout | Magazine-style tiling | Gentle **cascade** (each window offset down-right) |
| Apps | Monitor, Notes, Photos | **Scope** (circuit inspector), **Inkwell** (notes), **Chroma** (gallery) |
| Program | 9,909 weights, 130 layers | Identical — only host chrome and arrangement change |

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

## The command center

Press ⌘K (Ctrl+K elsewhere) or the "Ask Prism" button in the system bar, and type what Prism OS should do: "put Scope and Chroma side by side", "open Blue Lagoon", "write call the dentist in my note", "dark mode and a teal accent".

A sentence takes one of two paths, and both end in the same place:

1. **The quick parser** (`quick-commands.ts`) matches whole common sentences, e.g. "dark mode" or "minimize inkwell", and runs them at once, with no model.
2. **The model**: FunctionGemma 270M, fine-tuned on Prism OS's commands, runs in a worker in the browser on WebGPU (`model-worker.ts`). It answers with function calls, or a short reply. It downloads once, about 425 MB, after the visitor clicks "Load model", and nothing typed leaves the browser.

Every call then passes the validator in `commands.ts`, which accepts the names people use ("notes", "the gallery", "photo 3", "top left") and rejects anything Prism OS lacks. The operator (`operator.ts`) runs what passes. Window, photo and Scope commands become the pointer and key events a hand would make, aimed at points the program itself computes: a click on the minimize button, a drag of a title bar, a release on a dock tile. So the program's rules hold for the model exactly as for a person, e.g. a window it moves still can't leave the workspace. Settings, the note and links are page state outside the program. Under each reply the panel lists the calls that ran. Erasing or replacing the note and leaving the page ask first.

| Commands | What they do |
| --- | --- |
| `open_app`, `minimize_app`, `maximize_app`, `restore_app`, `close_app` | The dock tile and the title bar's buttons |
| `move_app`, `resize_app`, `side_by_side`, `show_desktop`, `reset_layout` | Drags of title bars and corner grips |
| `open_photo`, `next_photo`, `previous_photo`, `close_photo`, `slideshow` | Chroma, by photo name or number |
| `scope_show`, `scope_list` | Scope's sidebar and list keys |
| `write_note`, `clear_note`, `read_note` | Inkwell's note, which is saved in the browser |
| `set_theme`, `set_accent`, `set_wallpaper`, `set_transparency`, `set_arcs` | The settings in `settings.ts` |
| `open_link`, `get_stats`, `explain` | The demos page or the source, the program's live sizes, short explanations |

### Changing the commands, and training the model again

`commands.ts` is the single source of truth. After a change there:

```sh
bun scripts/prismos-dataset.ts   # writes src/prismos/training/{train,eval}.jsonl and tools.json
git push                         # the job reads the data and the script from the repo
hf jobs uv run --flavor a10g-small --secrets HF_TOKEN --timeout 2h \
  https://raw.githubusercontent.com/AppleLamps/prism-os/<commit>/src/prismos/training/train.py \
  --data https://raw.githubusercontent.com/AppleLamps/prism-os/<commit>/src/prismos/training \
  --repo AppleLampsX/prism-os-functiongemma
```

The data has about 6,000 training sentences and 600 eval sentences whose phrasings never appear in training, so the eval score measures sentences shaped unlike anything the model saw. `train.py` fine-tunes the whole model, scores it, builds the browser file with ONNX Runtime GenAI's builder (4-bit weights in blocks of 32, fp16 activations, the layout of onnx-community's FunctionGemma build), cuts the vocabulary projection to the last position (`last_token_logits.py`, which avoids about 2 GB of logits per prompt), checks the ONNX file's answers, and publishes to the Hub, privately unless `--public` is passed. The page can only load a public repo.

`?model-device=wasm` on the page runs the model on the CPU instead of WebGPU, slowly, for testing on a machine whose GPU can't run it.

## Files

| File | Role |
| --- | --- |
| `boot.ts` | Starts the wallpaper and mounts the window manager with Prism's arrangement |
| `arrangement.ts` | Cascade layout on top of HandwiredOS's `arrangeInitialWindows` |
| `commands.ts` | The command center's commands: the function declarations the model sees, and the validator every call passes |
| `quick-commands.ts` | Whole-sentence patterns for common commands, which run without the model |
| `function-calls.ts` | Reads FunctionGemma's call format |
| `operator.ts` | Runs a command: windows, photos and Scope through the program's own events, settings, the note and links in the page |
| `settings.ts` | Theme, accent, wallpaper motion, transparency and weight arcs, as data attributes on `<html>`, saved in the browser |
| `command-center.ts` | The panel, the flow from sentence to calls, confirmations, and the slideshow |
| `model-worker.ts` | FunctionGemma in a worker, through Transformers.js on WebGPU |
| [`training/`](training) | `train.py`, the Hugging Face job, `last_token_logits.py`, and the data that `scripts/prismos-dataset.ts` writes |
| `wallpaper.ts` | Full-bleed glass dunes behind the weight arcs, with a day and a night palette |
| [`tests/prismos/`](../../tests/prismos) | The cascade at many viewport sizes: inside the workspace, and drawn by the program where it was written |
| [`assets/prism-os.html`](../../assets/prism-os.html), [`assets/prism-os.css`](../../assets/prism-os.css) | Page and theme |
