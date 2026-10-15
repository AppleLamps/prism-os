# Template

A toggle switch written as one numeric program and checked against the same switch in plain JavaScript, to copy as the start of a new app. [docs/tutorial.md](../docs/tutorial.md) walks through it.

From the repo root:

```sh
bun run start:template   # the page, at http://localhost:3000/
bun test template        # its test
bunx tsc -p .            # the type-check, which prints nothing when it passes
```

- `toggle.ts`: the cells, the builder code, the host loop and the DOM writes
- `toggle-reference.ts`: the same switch in plain JavaScript
- `toggle.test.ts`: runs both over a scripted trace and compares them every frame
- `index.html` and `main.ts`: the page

To start an app, copy this folder to a new folder at the repo root and follow [A new app folder](../docs/tutorial.md#a-new-app-folder).
