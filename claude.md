# Prism OS — guide for Claude (and other coding agents)

This repository is **[Handwired](https://github.com/chenglou/handwired)** plus **Prism OS**, a themed desktop showcase. Prism OS is not a second window manager: it reuses the same compiled numeric program as HandwiredOS (Mini OS) and only changes host-side layout, visuals, and copy.

## What Prism OS is

**Prism OS** is a small in-browser “desktop” with three windows and a dock. Visitors can drag, resize, stack, minimize, and maximize windows; open photos in a lightbox; and read the live state of the handwired program in a virtualized inspector.

| Prism OS | HandwiredOS (same program underneath) |
| --- | --- |
| Liquid glass UI in light and dark, dune wallpaper, system-blue accent, traffic-light buttons, app-icon dock | Warm paper desk, copper accents |
| **Scope**, **Inkwell**, **Chroma** | Monitor, Notes, Photos |
| **Cascade** opening layout (36px step per window) | Magazine-style tiling |

The circuit is unchanged: **234 source cells**, **4,646 operations**, **130 layers**, **9,909 weights**, **0 training**. Do not expect different weight/layer counts on the Prism page unless `src/handwiredos/window-manager.ts` itself changes.

## How Handwired fits in

Handwired programs are fixed lists of FP32 operations (`affine`, `reglu`, `boolean`, `indexRead`) built once in TypeScript “builder code,” then evaluated every frame over a `Float32Array` source table. The **host** (plain JavaScript) writes pointer/keyboard/viewport inputs, runs the program, copies next-state cells back, and updates the DOM.

Prism OS touches only the host layer for chrome and arrangement:

- **Program + machine:** `src/handwiredos/window-manager.ts` (`createWindowManagerMachine`, `mountWindowManager`)
- **HandwiredOS entry:** `src/handwiredos/boot.ts` mounts the window manager with its defaults. `window-manager.ts` itself only exports `mountWindowManager`, so importing it never mounts a page
- **Prism entry:** `src/prismos/boot.ts` calls `mountWindowManager(..., { arrange: arrangePrismWindows })` and starts the wallpaper canvas
- **Prism layout:** `src/prismos/arrangement.ts` — runs Handwired’s `arrangeInitialWindows`, then shifts each window in a cascade and clamps to the workspace
- **Prism wallpaper:** `src/prismos/wallpaper.ts`: full-bleed animated dunes behind the weight arcs, with a day and a night palette
- **Page:** `assets/prism-os.html`, `assets/prism-os.css` (imports `handwired-os.css` for geometry/hit targets)

Changing window sizes, title bar height, dock height, or hit-test geometry belongs in **`window-manager.ts` and `handwired-os.css`**, not only in Prism CSS. Prism CSS should change color, blur, radii, and branding—not layout constants the program assumes.

## Run and verify

Requires [Bun](https://bun.sh) (project tested with Bun 1.4.x).

```sh
bun install
bun start                    # demo site at http://127.0.0.1:3000/ — Prism at /prism-os/
bun ./assets/prism-os.html   # Prism page only
bun run check                # typecheck + lint
bun test tests/handwiredos   # window manager behavior (~20s)
bun test tests/prismos       # Prism's cascade arrangement
```

Demo site routes are listed in `scripts/demo-site-pages.ts`. The landing page is `assets/demos.html` (Prism is the featured card).

## Safe places to customize Prism

| Goal | Where to edit |
| --- | --- |
| Rename apps, default note text, dock icons | `assets/prism-os.html` |
| Colors, glass, traffic lights, dock tiles and shelf | `assets/prism-os.css` (tokens live on `:root.prism` and every rule starts with `.prism-desktop`, so they beat `site.css` and `handwired-os.css` in any stylesheet order; never move `#dock` itself, the program hit-tests its tiles in desktop coordinates) |
| Opening window positions | `src/prismos/arrangement.ts` (`cascadeStep`, clamp logic) |
| Wallpaper motion and palettes | `src/prismos/wallpaper.ts` |
| Mount options (e.g. another arrangement) | `src/prismos/boot.ts`, `WindowManagerMountOptions` in `window-manager.ts` |

## Design rules

- No purple or violet anywhere in Prism: the palette is blues, teals, warm sand, and the macOS traffic-light colors.
- Every color, surface and shadow has a light and a dark value under `prefers-color-scheme`.
- Transforms on dock tiles only move paint; never change the geometry of anything the program places.

## Avoid unless you mean to change the whole OS

- `src/handwiredos/window-manager.ts` — full WM + photos + monitor list circuit
- `src/handwiredos/photo-gallery.ts`, `value-list.ts` — app logic inside the program
- `docs/execution-model.md` — numeric semantics and rounding

If you add a fourth window or new interactions, you are editing the handwired program, not just Prism skin.

## Docs worth reading

1. Root `README.md` — Handwired overview  
2. `docs/tutorial.md` — cells, builder code, host loop (toggle template)  
3. `src/handwiredos/README.md` — HandwiredOS behavior (springs, hit tests, releases)  
4. `src/prismos/README.md` — short Prism-specific file map  

## Git remote

This fork is published as **AppleLamps/prism-os**. Upstream ideas and runtime live in **chenglou/handwired**.
