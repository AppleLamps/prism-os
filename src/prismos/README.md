# Prism OS

**Prism OS** is a showcase skin for the Handwired window-manager program: the same hand-built numeric circuit that runs [HandwiredOS](../handwiredos/README.md), with a new visual identity and opening layout.

## What is different

| Piece | HandwiredOS | Prism OS |
| --- | --- | --- |
| Look | Warm paper desk | Twilight glass, aurora wallpaper, teal/violet accents |
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
| `boot.ts` | Mounts the window manager with Prism's arrangement and starts the aurora canvas |
| `arrangement.ts` | Cascade layout on top of HandwiredOS's `arrangeInitialWindows` |
| `aurora-wallpaper.ts` | Animated background behind the weight arcs |
| [`tests/prismos/`](../../tests/prismos) | The cascade at many viewport sizes: inside the workspace, and drawn by the program where it was written |
| [`assets/prism-os.html`](../../assets/prism-os.html), [`assets/prism-os.css`](../../assets/prism-os.css) | Page and theme |
