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

## Files

| File | Role |
| --- | --- |
| `boot.ts` | Starts the wallpaper and mounts the window manager with Prism's arrangement |
| `arrangement.ts` | Cascade layout on top of HandwiredOS's `arrangeInitialWindows` |
| `wallpaper.ts` | Full-bleed glass dunes behind the weight arcs, with a day and a night palette |
| [`tests/prismos/`](../../tests/prismos) | The cascade at many viewport sizes: inside the workspace, and drawn by the program where it was written |
| [`assets/prism-os.html`](../../assets/prism-os.html), [`assets/prism-os.css`](../../assets/prism-os.css) | Page and theme |
