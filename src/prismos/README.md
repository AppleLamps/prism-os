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
| `boot.ts` | Loads the preferences, starts the wallpaper and the shell, then mounts the window manager with Prism's arrangement |
| `arrangement.ts` | Cascade layout on top of HandwiredOS's `arrangeInitialWindows` |
| `wallpaper.ts` | Full-bleed glass dunes behind the weight arcs: four scenes, each with a day and a night palette |
| `shell.ts` | Everything beside the program: input routing, Prism's panels and their dock tiles, the menu bar extras, Spotlight and Control Center |
| `apps.ts` | The views of Calculator, Clock, Terminal, Settings and About |
| `calculator.ts`, `terminal.ts` | Calculator's arithmetic and Terminal's commands, apart from their views |
| `settings.ts`, `controls.ts` | The stored preferences, and the controls that Control Center and Settings share |
| `dom.ts` | Element and icon helpers |
| [`tests/prismos/`](../../tests/prismos) | The cascade at many viewport sizes, Calculator's arithmetic, Terminal's commands, the stored preferences, and a check that no palette or accent is purple |
| [`assets/prism-os.html`](../../assets/prism-os.html), [`assets/prism-os.css`](../../assets/prism-os.css) | Page and theme |
