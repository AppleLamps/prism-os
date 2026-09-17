# Learned gallery

A photo layout drawn by a small network whose coefficients are the program's source cells. For each of 20 slots, features of the slot's position that are fixed while building, i.e. the position and its sine and cosine at 4 frequencies, go through two ReGLU layers of 6 units to the slot's left, top, width and height. Training steps the coefficients with Adam, using gradients from `circuit.backpropagateReference`, until the rectangles match the target rectangles. On the page you edit the targets: drag a rectangle to move it, drag its corner to scale it, click empty space to add one, or press Delete to remove one, and the learned layout follows while the footer shows the loss.

It moved here from the repo root on September 16, 2026, since the repo now centers on IndirectOS and its runtime. [lab/reusable-layout](../reusable-layout/README.md) also keeps a network's parameters in source cells, and feeds it features that change at runtime.

- `bun run start:learning`: the page
- `bun test lab/learned-gallery`: fits of a product layout, a layout absent from the product layouts and an irregular masonry layout, the relation loss on a rough grid drag, reset, adding and deleting rectangles, and a fit of an unseen sidebar grid
- `trainable-geometry.ts`: the network, the loss and Adam. `learned-gallery.ts`: the Cinema, Contact and Story target layouts, and the page
