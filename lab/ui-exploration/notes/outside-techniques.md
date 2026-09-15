# Outside techniques for writing UI as fixed numeric layers

This note surveys techniques from shader programming, GPU compute, machine learning, classic parallel algorithms, and immediate-mode UI practice. For each one it asks what the technique could do inside an Indirect circuit: a fixed feed-forward program of affine operations, ReLU-gated products (ReGLU), and exact bits, evaluated once per frame over a Float32Array source table. Each entry gives a short description, a pointer (paper, post, or repo), the UI job it could do, and its cost in depth (layers) and width (operations and stored weights). The note ends with ten prototypes.

Line numbers in `numeric-ui-core.ts` refer to commit c3d8e54 (September 5, 2026); on September 14, 2026 the file grew from 1,653 to 3,158 lines.

Where a cost says "measured", the number comes from a scratch script in `scratchpad/phase1/outside-techniques/` (`histogram.ts`, `springs.ts`, `prefix.ts`, `sort.ts`, `linebreak.ts`, `eventscan.ts`, `nearest.ts`, sharing `common.ts`). Every script builds circuits with the real `Circuit` class from `numeric-ui-core.ts`, measures `compileTensorProgram(roots)`, and checks outputs for exact equality against a plain JavaScript reference on random inputs. Run any of them with `bun <script>.ts` from that folder.

## Context this survey assumes

- Depth means compiled layers (`compileTensorProgram(...).layers.length`). Width means live operations and stored sparse weights. Only stored weights reveal O(n²) growth, since affine composition can inline shared sums back into consumers.
- The current executor is serial JavaScript on the CPU. On the CPU, cost grows with live operations and weights, and depth does not matter by itself. Depth matters for a parallel backend (the GPU megakernel parked in `research-sweep.md`) or when many source tables run together (`ideas.md`, "Candidate futures").
- IndirectOS today is deep and narrow. From `bun lab/runtime-cost/report.ts` plus `histogram.ts`: 201 sources, 5,253 live operations (2,346 affine, 2,843 ReGLU, 64 boolean), 1,685 multiplies, 210 selects, 192 layers, widest layer 123 operations (about 27 per layer on average), 11,598 stored weights, 37 µs per evaluation with the reusable evaluator. The candidate gallery has 417 live operations, 60 layers, widest layer 66, 848 weights.
- Every measured circuit got exact results through integer discipline instead of the `boolean` atom: widths in 1/64 px units (the 26.6 fixed point that FreeType uses), integer pixel coordinates, and the count-based bit `relu(v) - relu(v - 1)` from `tricks.md`.
- The code's `affineShareThreshold` is currently 4 (`numeric-ui-core.ts:883`): an affine form with 4 or more terms becomes a shared wire instead of being inlined into its consumers.

## Measurements from this survey

| Job | Formulation | Live operations | Layers | Stored weights |
| --- | --- | ---: | ---: | ---: |
| One spring field for one frame | production `emitSpring`: 4 Euler substeps, stiffness, damping, and timestep as runtime cells | 46 | 33 | 104 |
| | the same linear map as a 2×2 frame matrix read from 4 source cells | 31 | 11 | 65 |
| | the same map with constant coefficients | 18 | 8 | 44 |
| Running maximum, 64 items | serial chain of `emitMaximum` | 189 | 189 | 315 |
| | Sklansky prefix network | 576 | 18 | 960 |
| | Brent-Kung prefix network | 360 | 30 | 600 |
| Running maximum, 256 items | serial / Sklansky / Brent-Kung | 765 / 3,072 / 1,506 | 765 / 24 / 42 | 1,275 / 5,120 / 2,510 |
| Running sum, 64 items | serial chain / Sklansky | 63 / 105 | 21 / 4 | 189 / 393 |
| Sort 16 items by key, carrying a payload | bitonic network with selects / rank by counting with gathers | 1,248 / 1,056 | 50 / 5 | 2,400 / 2,496 |
| Sort 64 items by key, carrying a payload | bitonic network, keys only, `emitMinimum`/`emitMaximum` | 2,752 | 64 | 4,768 |
| | bitonic network with payload selects | 10,624 | 105 | 20,512 |
| | rank by counting, then one-hot retrieval lowered to gathers | 16,512 | 5 | 40,704 |
| | rank by counting, dense masked sums | 20,608 | 6 | 52,992 |
| Greedy line breaking, 64 words, x and line index per word | serial scan, one unrolled step per word | 816 | 315 | 2,004 |
| | pointer jumping with doubling tables, gathers | 52,487 | 47 | 129,214 |
| | pointer jumping with doubling tables, dense masked sums | 76,605 | 47 | 201,630 |
| | next-line pointers plus one gather per line | 13,303 | 211 | 54,003 |
| Fold a frame's queue of 8 pointer events | serial update per event / Sklansky scan | 281 / 392 | 46 / 33 | 536 / 772 |
| Fold a frame's queue of 32 pointer events | serial update per event / Sklansky scan | 1,121 / 2,084 | 166 / 47 | 2,144 / 4,296 |
| Nearest of 4 snap corners | targets as runtime cells / targets as constants | 61 / 27 | 15 / 11 | 125 / 56 |
| Nearest of 64 snap targets | targets as runtime cells / targets as constants | 1,141 / 602 | 43 / 40 | 2,380 / 1,293 |

The spring variants used IndirectOS's constants (stiffness 650, damping 45, timestep 1/240 s). Over 90 frames toward a destination of 500, positions from the matrix variants differ from the production spring by at most 0.00006 px, which is one FP32 step at that magnitude. Every other row agreed exactly with its JavaScript reference on 50 to 500 random cases.

## 1. Shader and GPU compute techniques

### Signed distance functions for shapes and hit tests

A signed distance function (SDF) returns the distance from a point to a shape's boundary, negative inside. Shapes combine with `min` (union), `max` (intersection), and a smooth minimum that rounds the blend. Shaders evaluate SDFs per pixel for antialiased shapes (coverage `clamp(0.5 - distance, 0, 1)`), outlines, glows, and soft shadows. Pointers: Inigo Quilez's catalog of 2D distance functions (https://iquilezles.org/articles/distfunctions2d/) and his smooth minimum article (https://iquilezles.org/articles/smin/).

UI job: hit tests for controls that are not rectangles (circular buttons, rounded windows, pill toggles), forgiving hit areas that grow smoothly between adjacent buttons, capsule drop zones, and effects driven by distance to the pointer, like dock icons that magnify near the cursor. The window manager's `emitRectangleHit` (`window-manager.ts:1566`) already covers plain rectangles with clamp scores.

Cost: a hit test only needs the sign, so comparing squares avoids the square root in `length()`. For a rounded rectangle with center `(centerX, centerY)`, half extents, and corner radius `r`: `qx = |pointerX - centerX| - (halfWidth - r)`, likewise `qy`, and the pointer is inside when `relu(qx)² + relu(qy)² <= r²`. That is 4 ReLUs for the absolute values, 2 more ReLUs, 2 signed products, and one comparison bit: about 10 operations and depth about 4 per shape. A runtime radius adds one product. Antialiased coverage needs an actual distance. A true distance needs a square root, which the FP32 transcendentals memory says is buildable from a lookup-table seed plus 2 or 3 Newton steps (about 3 products per step). For a circle with a known radius there is a cheaper edge estimate, `clamp01((r² - d²) / (2r) + 0.5)`: `1/(2r)` is a constant coefficient, and `r² - d² ≈ 2r(r - d)` near the edge. Union and intersection are `emitMinimum` and `emitMaximum` (3 layers each). A smooth minimum with a constant blend width `k` (`h = clamp01(0.5 + 0.5(b - a)/k)`, result `mix(b, a, h) - k·h·(1 - h)`) costs 2 ReLUs, 2 products, and one select, about 4 layers.

FP32 note: squared distances on 4K coordinates leave the exact integer range, since `3840² + 2160² ≈ 19.4M > 2²⁴`. The nearest-target script used a 1280×800 viewport, where the largest squared distance is about 2.28M. On large displays, compare in coordinates relative to the shape, scale down before squaring, or use the sign cascade from `tricks.md`.

### smoothstep, remap, mix

These are the shader functions for shaping values: `mix(a, b, t) = a + t(b - a)`, `remap(x, inMin, inMax, outMin, outMax)`, and `smoothstep(e0, e1, x) = t²(3 - 2t)` with `t = clamp01((x - e0)/(e1 - e0))`. Pointer: the GLSL built-in function reference; vibescript's `ui.md` "Layout" section already recommends borrowing remap, clamp, fract, step, and vector types from shaders.

UI job: easing curves for opacity and scale during a transition, resistance at scroll edges, mapping drag progress to a sheet's corner radius.

Cost: `mix` with a fractional gate is `emitSelect` (2 products). `remap` with constant endpoints is one affine operation; with runtime endpoints it needs a reciprocal, which the macro library does not have yet (Newton-Raphson `x ← x(2 - b·x)` from a table seed would add about 3 products per step). `smoothstep` with constant edges costs 2 ReLUs and 2 products at about 3 layers; runtime edges add a reciprocal.

### fract, floor, step

`step(edge, x)` is a comparison; `floor` and `fract` split a value into integer and fractional parts. Shaders use `fract` for repeating patterns and coordinates local to a cell, and `floor` for cell indices. Pointer: The Book of Shaders, "Patterns" (https://thebookofshaders.com/09/).

UI job: which grid cell is under the pointer (the hovered photo tile), snapping a dragged window to an 8 px grid, repeating stripes or dotted leaders, cyclic carousel positions.

Cost: ReLU networks are continuous, so a staircase with jumps needs exact bits. For integer inputs, `step` is the count-based bit (2 ReLUs, 1 layer). For a continuous value in `[0, K)`, `floor(x) = Σ_k [x >= k]` costs K comparison bits in one layer (width K, depth about 2), or log₂K stages of compare-and-subtract (a few operations per stage, depth about 5 per stage). Continuous periodic functions are cheaper than staircases. The tent map `t(x) = 2·relu(x) - 4·relu(x - 0.5)` on `[0, 1]`, composed k times, gives a triangle wave with 2^k linear pieces at 2 ReLUs per stage (Telgarsky, "Benefits of depth in neural networks", COLT 2016, https://arxiv.org/abs/1602.04485). Evaluated at integers, a triangle wave gives exact periodic integer patterns such as parity. Each doubling shifts one mantissa bit out, so the continuous composition degrades after about 24 stages, far past what UI needs. Grid snapping with a known cell size can happen on an integer pointer coordinate, e.g. `cellIndex = Σ_k [pointerX >= k·cellWidth]`, where each comparison is exact because both sides are integers.

### Hashing without integer bit operations

Shaders often lack reliable integer operations, so hashes are built from floating-point arithmetic, e.g. Dave Hoskins's "Hash without Sine" (`fract(p * 0.1031)`, `p *= p + 33.33`, `fract((p + p) * p)`; https://www.shadertoy.com/view/4djSRW). Jarzynski and Olano compare integer and float hashes for quality and speed ("Hash Functions for GPU Rendering", JCGT 2020, https://jcgt.org/published/0009/03/02/). Vibescript's `ui.md` "Pseudo-Random" recommends `lowbias32`, which uses `Math.imul`, shifts, and xor.

UI job: deterministic per-item jitter (random rotations in a photo stack), shuffle order, noise.

Cost: `fract` of a large product needs a staircase across the whole value range (width proportional to the range), and xor and shifts have no cheap affine form, so hashing belongs outside the circuit. The reformulation is the same as pretext's `prepare`: JavaScript computes `hash(itemID)` into source constants once per item. If the hashed key changes at runtime, a table of precomputed hashes read through a one-hot gather costs one index resolution plus one read. A few tent-map stages applied to a continuous input give visually random jitter at 2 ReLUs per stage, without lowbias32's statistical guarantees.

### Jump flooding

Jump flooding computes, for every pixel of a G×G texture, the nearest seed point in log₂G passes. Each pass looks at 8 neighbors at a distance that halves every pass (G/2, G/4, ..., 1) and keeps the nearest seed seen so far, which gives approximate Voronoi diagrams and distance transforms at a fixed cost regardless of how many seeds exist. Pointer: Rong and Tan, "Jump Flooding in GPU with Applications to Voronoi Diagram and Distance Transform" (I3D 2006).

UI job: nearest snap target, magnetic edges for dragged objects, which drop zone contains the pointer when there are many zones.

Cost: per pass, 9 distance evaluations and a 9-way argmin per cell. A 64×64 grid of snap cells is 4,096 cells × 6 passes × roughly 50 operations, about 1.2M operations. For the target counts UIs have, a direct argmin is far cheaper: 64 runtime targets cost 1,141 operations and 43 layers (measured). Jump flooding is only interesting as a texture computed outside the circuit (by JavaScript or a real GPU pass), which the circuit reads by quantized pointer position, and that read needs a floor again.

### Parallel prefix sums (Blelloch scan) and Vello

A prefix scan computes every running combination `x0`, `x0⊕x1`, `x0⊕x1⊕x2`, ... of an associative operation ⊕ that has an identity (a monoid). Blelloch's work-efficient scan does an up-sweep and a down-sweep: 2n combines at depth 2·log₂n (the Brent-Kung network). Sklansky's network uses n·log₂n/2 combines at depth log₂n with large fan-out; Kogge-Stone uses about n·log₂n combines at depth log₂n with fan-out 2. The operation can be a sum, a max, a latch, or function composition. Pointers: Blelloch, "Prefix Sums and Their Applications" (CMU-CS-90-190, 1990); GPU Gems 3, chapter 39 (https://developer.nvidia.com/gpugems/gpugems3/part-vi-gpu-computing/chapter-39-parallel-prefix-sum-scan-cuda); Raph Levien, "Prefix sum on Vulkan" (https://raphlinus.github.io/gpu/2020/04/30/prefix-sum.html). Vello's first pipeline stages are monoid prefix sums that turn sequential scene parsing (current transform, current style, path bounding boxes) into parallel work (https://github.com/linebender/vello; Levien and Uguray, "GPU-friendly Stroke Expansion", HPG 2024, https://arxiv.org/abs/2405.00127).

UI job: running offsets (each row's y is the sum of earlier row heights), running maxima (the start of the current line, the tallest item so far in a row), latches (the latest press position), bold or in-quote state while scanning text, the current clip rectangle while walking a flattened display list.

Cost, measured with `emitMaximum` as ⊕ (3 layers per combine): at 64 items, serial 189 layers / 315 weights, Sklansky 18 layers / 960 weights, Brent-Kung 30 layers / 600 weights. At 256 items, serial 765 layers, Sklansky 24 layers / 5,120 weights, Brent-Kung 42 layers / 2,510 weights. For sums the builder already merges small affine chains: a dense sum per output is 1 layer with n(n+1)/2 weights (2,080 at 64 items), the serial chain materializes a wire every 3 steps (21 layers, 189 weights), and Sklansky sums take 4 layers / 393 weights. On the current CPU executor the serial chain is the cheapest form; the parallel networks only buy depth.

### The stack monoid and tree-structured scenes

A sequence of stack pushes and pops can be summarized as a pair: the number of unmatched pops and the list of unmatched pushes. Combining two summaries cancels the second one's pops against the first one's pushes. The combination is associative because each summary is a function on stacks, and function composition is associative. A prefix scan over a flattened tree of open and close tokens then gives every node's parent and nesting depth, and with rectangles in the pushes, bounding boxes and the current clip rectangle. Pointers: Levien, "The stack monoid" (https://raphlinus.github.io/gpu/2020/09/05/stack-monoid.html), "The stack monoid revisited" (https://raphlinus.github.io/gpu/2021/05/13/stack-monoid-revisited.html), and "Fast GPU bounding boxes on tree-structured scenes" (https://arxiv.org/abs/2205.11659), which intersects clip boxes and unions blend boxes with a new parentheses matching algorithm at its core.

UI job: when a tree's shape is runtime data in the source table (a file tree with drag to reparent, an outline editor, comment threads with nesting that differs per page), compute each node's parent and depth, then indentation and clip rectangles.

Cost: the general version has summaries of variable size, which a fixed circuit cannot hold. With a maximum depth D, a simpler formulation fits the atoms: nesting depth is a prefix sum of `open - close` (affine); "the most recent open token at depth d" is one latch scan per depth level; each open token's parent is one gather from those D latches by its own depth minus one. For D = 8 and n = 256 tokens, the scans are about 8,000 latch combines (about 16,000 products) at depth about 30, plus n·D equality bits for the write conditions. When the tree shape is fixed at compile time, none of this is needed, because every parent is a constant.

### Sorting networks

A sorting network is a fixed sequence of compare-exchange operations that sorts any input, so its structure does not depend on the data, like a circuit. Batcher's bitonic and odd-even merge networks use about n·log₂²n/4 comparators arranged in log₂n·(log₂n + 1)/2 comparator layers, and GPUs sort with bitonic networks in shaders. Pointers: Batcher, "Sorting networks and their applications" (AFIPS 1968); Kipfer and Westermann, "Improved GPU Sorting" (GPU Gems 2, chapter 46); Petersen et al., "Differentiable Sorting Networks for Scalable Sorting and Ranking Supervision" (ICML 2021, https://arxiv.org/abs/2105.04019).

UI job: sort items by a runtime key (photos by date or by name after a toggle, a list during drag to reorder, masonry column assignment by shortest column, z-order by focus time), then animate items toward their new slots with springs.

Cost, measured on 64 items with integer keys and one payload value per item: a bitonic network on keys only takes 64 layers and 4,768 weights; with payload selects (one comparison bit and 4 selects per comparator) it takes 105 layers and 20,512 weights. The alternative from compiled transformers (RASP's sort) is rank by counting: an item's rank is the number of items with a smaller composite key (`key·n + index`, which makes keys distinct), which is n² comparison bits in one layer. Then, for each rank r, the bits `[rank_i = r]` form a declared one-hot group, and the sorted payload is a masked sum that lowers to a gather. That form takes 5 layers, 16,512 operations, and 40,704 weights (52,992 without gather lowering). At 16 items, counting costs about the same weights as bitonic (2,496 versus 2,400) at 5 layers instead of 50. For the item counts UIs usually have, counting is the better formulation; n² comparisons start to hurt around hundreds of items.

The window manager already avoids sorting by storing the stacking order as a permutation matrix in the source table (`stackSourceField`, `window-manager.ts:277`), with `emitFrontmost` (`window-manager.ts:1532`) scanning ranks serially. Storing ranks or permutations instead of links removes the sort; a choice of representation replaces an algorithm.

### GPU text rendering and layout

GPU text work splits into rasterization and layout. Rasterization has mature GPU techniques: signed distance field glyph atlases (Chris Green, "Improved Alpha-Tested Magnification for Vector Textures and Special Effects", SIGGRAPH 2007), multi-channel SDFs (Viktor Chlumský, msdfgen), Eric Lengyel's Slug, which computes glyph coverage directly from outlines per pixel ("GPU-Centered Font Rendering Directly from Glyph Outlines", JCGT 2017), and Vello's glyph paths. Layout mostly stays on the CPU. Levien's "Text layout is a loose hierarchy of segmentation" (https://raphlinus.github.io/text/2020/10/26/text-layout.html) describes the stages: paragraph segmentation, rich text and BiDi analysis, font itemization, script runs, and shaping clusters. Those stages are string processing over large tables. Line breaking is the stage that is arithmetic, and Pavel Panchekha's "Parallel Line Breaking" (https://pavpanchekha.com/blog/line-breaking.html) gives a parallel greedy algorithm: prefix sums of word widths, a search per word for the longest fitting run, pointer doubling into a skip list, and binary decomposition of the line number.

UI job: geometry that depends on text inside the circuit: card heights that follow wrapped captions, a Notes window whose content height sets its scroll range, labels that wrap or truncate as a window resizes.

Cost: see "Parallel greedy line breaking" below and the pretext section. Rasterization belongs outside the circuit, where the DOM or a canvas draws glyphs. Glyph advances along a line are a prefix sum (affine), break decisions are comparisons, and everything before widths exist is pretext's `prepare` step in JavaScript.

### Stateless evaluation per item plus reductions

The shader model runs one kernel independently per pixel or per instance, then combines results with a few reductions (sum, max, first hit). GPU instancing draws many copies of a mesh from per-instance attributes. Pointer: the Vulkan Guide's compute shader chapter (https://vkguide.dev/docs/gpudriven/compute_shaders/).

UI job: this is already `tricks.md` "Instancing" (one shared layout function per item index) and the Photos thumbnail strip. The reductions exist as `emitArgmax` and `emitFirstActive` (`numeric-ui-core.ts:1245` and `:1316`), both balanced trees.

Cost: the kernel's cost per item, plus the reduction. The measured nearest-target argmin shows the tournament setting the depth: 64 targets take 40 layers even when every score is affine, because each tree level costs a comparison, a select, and a routing product. A shallower argmin uses counting like the sort: item i is the minimum when `Σ_j [score_i <= score_j]` (with a tie rule by index) equals n − 1. That is n² comparisons in one layer and an estimated 4 layers total, with 4,032 comparisons for 64 targets.

## 2. Machine learning mechanisms

### Attention as lookup, and hard max

Attention scores every stored key against a query (`score_i = query · key_i`), turns scores into weights with softmax, and returns the weighted sum of values. When scores are scaled up, softmax approaches hard max, and attention becomes exact retrieval of the best-matching value. Pointers: Vaswani et al., "Attention Is All You Need" (2017); Merrill et al., "Saturated Transformers are Constant-Depth Threshold Circuits" (TACL 2022); `hard-attend.ts` in this repo, whose `keyFor(itemIndex) = [2·itemIndex, -itemIndex²]` is the parabola trick: with query `(q, 1)`, the score is `2qi - i² = q² - (q - i)²`, largest at `i = q`.

UI job: retrieve a record by ID (the rectangle of the item whose ID equals the selected ID, as planned in `todo.md` "Revisit hardAttend" and tested in `lab/data-adapter`), nearest snap target, the slot where a dragged card lands.

Cost: softmax needs `exp`, which the atoms do not have, so a hard tournament replaces it. With runtime keys, each score costs d products for d dimensions. With constant keys, like fixed slot positions, the parabola lift makes each score affine in the query. Measured for 64 targets: 1,141 operations with runtime targets versus 602 with constant targets, 43 versus 40 layers. Retrieval after selection is a gather (`execution-model.md`, "One-hot groups and gathers"). Attention's main reason to exist is reading from a history that grows with every token. Indirect's state is a fixed table, so masked sums and gathers already cover retrieval.

### Mixture-of-experts routing as switching

A mixture of experts computes a gate score per expert and sends each token to its best expert (Switch Transformer) or its top k experts. Dense mixtures run every expert and blend the outputs. Sparse routing gives each expert a fixed capacity: GShard computes each token's position inside its expert's buffer with a cumulative sum over the assignment mask and drops tokens past capacity, which keeps tensor shapes static. Pointers: Shazeer et al., "Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer" (2017); Lepikhin et al., "GShard" (2020, https://arxiv.org/abs/2006.16668); Fedus, Zoph, Shazeer, "Switch Transformers" (2021, https://arxiv.org/abs/2101.03961); Puigcerver et al., "From Sparse to Soft Mixtures of Experts" (2023).

UI job: dense mixtures are what `emitSelect` already does between normal, maximized, and docked window geometry. Capacity routing is the construction that `tricks.md` "Bounded visibility compaction" proposes: count earlier visible items to get a slot number, then route visible items 0..9 into ten expensive slots. For UI this is virtualization inside the circuit: 1,000 rows each get a cheap visibility test, and only 20 visible rows get the expensive path (text wrapping, springs, hover effects).

Cost: slot numbers are a prefix count (dense affine, or Brent-Kung for many items). Routing bits `[slot_i = c] · visible_i` cost about 8 operations per (item, slot) pair, at depth about 3. Each slot's input is a masked sum over items; the bits for one slot form a one-hot-or-all-zero group, so the sum can lower to a gather. For 1,000 items and 20 slots that is about 160,000 routing operations, compared with running the expensive path for all 1,000 items. A cheaper routing uses the fact that the visible rows of a scrolled list are contiguous: the first visible index is one count, and slot c reads item `first + c` with one gather per field. `tricks.md` notes that this construction still needs an exact-bit routing test.

### Parallel associative scans for recurrences (S4, S5, Mamba)

A linear recurrence `h_t = a_t·h_{t-1} + b_t` applies one affine map per step, and composing affine maps is associative: `(a2, b2) ∘ (a1, b1) = (a2·a1, a2·b1 + b2)`. A prefix scan therefore computes every state at log depth. Structured state space models (S4) turn continuous linear dynamics `dx/dt = Ax + Bu` into steps with a matrix exponential. S5 and Mamba evaluate the recurrence with a parallel associative scan, and Mamba's input-dependent `a_t` acts as a gate that decides how much old state to keep. Pointers: Martin and Cundy, "Parallelizing Linear Recurrent Neural Nets Over Sequence Length" (ICLR 2018, https://arxiv.org/abs/1709.04057); Gu, Goel, Ré, "Efficiently Modeling Long Sequences with Structured State Spaces" (https://arxiv.org/abs/2111.00396); Smith, Warrington, Linderman, "Simplified State Space Layers for Sequence Modeling" (https://arxiv.org/abs/2208.04933); Gu and Dao, "Mamba" (https://arxiv.org/abs/2312.00752).

UI job, first: springs. A fixed-step spring with constant stiffness, damping, and timestep is a linear time-invariant system on (offset from destination, velocity), so any number of substeps collapses at compile time into one 2×2 matrix, and a matrix exponential (as in S4) gives the exact analytic map for a whole frame instead of Euler substeps. Measured: the production 4-substep `emitSpring` costs 46 operations and 33 layers per field; the constant 2×2 matrix costs 18 operations and 8 layers, and those remaining layers are the settle test. IndirectOS has 44 springs: 4 windows × 5 fields (`window-manager.ts:921`) and 12 thumbnails × 2 fields (`photo-gallery.ts:447`), about 2,000 of its 5,253 live operations if the isolated count of 46 per spring holds in context. Stiffness and damping are runtime source cells (`window-manager.ts:139`, set to 650 and 45 at `:1204`), which keeps them editable as behavior knobs, and the timestep follows the frame duration (`window-manager.ts:416`). The reformulation that keeps knobs editable is pretext's prepare idea applied to springs: JavaScript recomputes the 4 matrix entries when a knob or the frame duration changes, and all 44 springs read the same 4 cells (31 operations, 11 layers per field). The measured matrix is the product of the 4 Euler substeps, so it matches production within one FP32 step; an analytic matrix exponential would be more accurate than production and would differ from it slightly. A frame that applies several fixed steps (vibescript's `Animation.md` accumulates whole steps) can read `M^steps` from a small table of precomputed powers through a gather.

UI job, second: a frame's queue of pointer events. `lab/event-window/demo.ts:311-322` runs one circuit evaluation per queued event, so that a press followed by an outward-and-back move cancels the click. The measured part of that state (press point, pressed bit, largest distance from the press point since the latest press, last position) updates with latches ("keep the most recent written value") and a maximum that resets at each press, and both operations are associative. For 32 queued events: 166 layers serially versus 47 with a Sklansky scan, 2,144 versus 4,296 weights, exact on 300 random queues. The rest of the event-window state (focus at press, maximize toggle and drag commit at release) is also a function applied per event, so it composes, but two clicks within one frame toggle maximize twice, which needs a parity counter rather than a latch.

### Neural cellular automata

A neural cellular automaton is a grid of cells, each updated by the same small network from its neighbors, iterated many steps. Growing NCA learns rules that grow and regenerate patterns. Pointers: Mordvintsev et al., "Growing Neural Cellular Automata" (Distill 2020, https://distill.pub/2020/growing-ca/); Kaiser and Sutskever, "Neural GPUs Learn Algorithms" (ICLR 2016), an earlier learned algorithm built from a convolution applied repeatedly.

UI job: grid behavior defined by local rules, like dashboard tiles falling into empty cells, flood-fill selection regions, or propagating occupancy while packing a masonry layout.

Cost: G cells × k iterations × stencil size, with depth k times a few layers. For most UI jobs a global counting formula is cheaper than local iteration: "a tile falls to the lowest free cell" is a count of occupied cells below it, one affine sum per column. Local iteration only matters when no counting formula exists, e.g. packing irregular shapes, or when the rule is learned.

### Differentiable rendering and layout by optimization

Differentiable vector graphics rasterization computes gradients of pixel losses with respect to shape parameters. Layout by optimization defines an energy (overlap, alignment, balance) and descends it. Constraint solvers like Cassowary solve linear constraints with a simplex method, and differentiable sorting and Sinkhorn assignment relax discrete ordering. Unrolled optimization turns a fixed number of solver iterations into network layers. Pointers: Li, Lukáč, Gharbi, Ragan-Kelley, "Differentiable Vector Graphics Rasterization for Editing and Learning" (SIGGRAPH Asia 2020); O'Donovan, Agarwala, Hertzmann, "Learning Layouts for Single-Page Graphic Designs" (TVCG 2014); Badros, Borning, Stuckey, "The Cassowary Linear Arithmetic Constraint Solving Algorithm" (TOCHI 2001); Cuturi, Teboul, Vert, "Differentiable Ranks and Sorting using Optimal Transport" (NeurIPS 2019); Mena et al., "Learning Latent Permutations with Gumbel-Sinkhorn Networks" (ICLR 2018); Gregor and LeCun, "Learning Fast Approximations of Sparse Coding" (ICML 2010).

UI job, forward only since training is out of scope here: K unrolled relaxation steps for soft constraints that have no closed form, for example popovers pushing away from each other and from viewport edges, or chart labels avoiding overlap. `lab/generative-fields` already repairs invalid layouts by projection in JavaScript; a few unrolled projection steps inside the circuit would run that repair every frame.

Cost: each iteration computes pairwise overlaps (n² products) and a clamped update, about 4 layers. For 8 popovers and 6 iterations: a few hundred operations per iteration and about 24 layers. The result is a fixed number of solver steps, not a converged answer, which is acceptable for positions and not for decisions.

### Compiled transformer programs (RASP, Tracr, Percepta)

RASP is a language whose primitives match what a transformer layer computes: `map` (a function per token, an MLP), `select` (a predicate over query and key values that forms an attention pattern), `aggregate` (average the selected values), and `selector_width` (count the selected positions). Tracr compiles RASP programs into actual transformer weights, with categorical (one-hot) and numerical encodings. Percepta compiled a WebAssembly interpreter into a standard softmax-ReGLU transformer: its computation graph has ReGLU gates (`reglu(a, b) = ReLU(b)·a`), attention lookups using hard max over 2D keys on a parabola, and cumulative sums computed by attention averaging. A mixed-integer linear program places gates into layers while minimizing peak live values, interval coloring reuses residual slots, and a convex hull cache answers each hard-max lookup in O(log n). Pointers: Weiss, Goldberg, Yahav, "Thinking Like Transformers" (ICML 2021, https://arxiv.org/abs/2106.06981); Lindner et al., "Tracr: Compiled Transformers as a Laboratory for Interpretability" (2023, https://arxiv.org/abs/2301.05062); Percepta, "Can LLMs Be Computers?" (https://www.percepta.ai/blog/can-llms-be-computers) and "Constructing an LLM-Computer" (https://www.percepta.ai/blog/constructing-llm-computer); code at https://github.com/Percepta-Core/transformer-vm.

UI job: RASP is a plausible authoring vocabulary for layouts written against items instead of fixed slots. "How many visible items come before me" is `selector_width` over the predicate `other index < my index and other visible`. "My rank" is RASP's sort. "The item to my left in the same row" is a `select` with row and column predicates followed by `aggregate`. Percepta's mixed-integer scheduling is the reference approach named in the README's parked "Retry layer scheduling" TODO.

Cost: `map` is per-item affine and ReGLU work. `select` over n items is n² predicate bits, about 3 operations each for an integer comparison. `aggregate` over a one-hot selection is a masked sum, one gather per output field with gather lowering. `selector_width` is an integer count, exact through the count-based bit. The measured counting sort (5 layers, 40,704 weights at 64 items) is a direct RASP program.

## 3. Classic parallel algorithms for layout and text

### Pointer jumping and list ranking

Given a linked list as an array of next pointers, pointer jumping replaces every pointer by its target's pointer (`next[i] ← next[next[i]]`) while accumulating distances, so every node learns its position in log₂n rounds. It underlies list ranking, tree contraction, and connected components on parallel machines. Pointers: Wyllie, "The Complexity of Parallel Computations" (PhD thesis, Cornell 1979); JáJá, "An Introduction to Parallel Algorithms" (1992), chapter 3.

UI job: when order is stored as links (each list item stores the ID of the next item after the user reorders), compute each item's position; when lines are described by "the first word of the next line", compute which line each word belongs to.

Cost: each round needs one gather per node, and a gather by a runtime integer index first needs a one-hot of that index: n + 1 equality bits at about 7 operations each. A round therefore costs about 8n² operations, O(n² log n) in total. The measured line breaking rows show the effect. The cheaper reformulation is to store order as ranks or as a permutation matrix instead of links, so position becomes a direct read.

### Parallel greedy line breaking

Panchekha's algorithm (linked above) computes, for every word, where a line starting at that word would end, follows those pointers with doubling, and finds each line's first word by binary decomposition of the line number.

The measured translation (`linebreak.ts`) uses widths in 1/64 px integer units, one space width, and a maximum line width. `prefix[k] = Σ_{i<k} (width_i + space)` is a dense affine sum. `next[a] = a + 1 + Σ_{b=a+2..n} [prefix[b] - prefix[a] - space <= maxWidth]` counts fitting runs, which works because the runs that fit from `a` are a prefix of the candidates. Doubling tables `next^(2^j)` come from gathers, line starts come from binary decomposition, each word gets a line-start bit, the line index is a running count of those bits, and x is `prefix[word]` minus a running maximum of `lineStart · prefix`. Outputs agreed exactly with a JavaScript greedy reference.

| Words | Serial scan (operations / layers / weights) | Doubling (operations / layers / weights) | Next pointers plus one gather per line |
| ---: | --- | --- | --- |
| 16 | 192 / 75 / 468 | 2,395 / 33 / 6,022 | 967 / 61 / 3,427 |
| 32 | 400 / 155 / 980 | 11,297 / 40 / 28,218 | 3,527 / 112 / 13,603 |
| 64 | 816 / 315 / 2,004 | 52,487 / 47 / 129,214 | 13,303 / 211 / 54,003 |

The serial scan costs about 12 operations and 5 layers per word. At 64 words, pointer jumping divides depth by about 6.7 and multiplies weights by about 64, which is a loss on the CPU executor and possibly a gain on a GPU executor with wide layers. Two cheaper variants were not tested. First, `next` is monotone in `a`, so it is the merge of two sorted sequences (`prefix[a] + maxWidth + space` against `prefix[b]`), which Batcher's odd-even merge ranks with O(n log n) comparators instead of n² bits. Second, a UI card rarely shows more than a few lines, so the line bound L can be far smaller than the word count.

FP32 note: prefix sums must stay below 2²³ for exact integer comparisons. In 1/64 px units that allows about 131,000 px of accumulated paragraph width, roughly 1,300 words of 100 px each: enough for a paragraph, not for a document.

### Euler tours, tree contraction, and tree layout

The Euler tour technique turns a tree into a linked list that walks down and up every edge. Prefix sums over the tour give preorder numbers, depths, and subtree sizes, so many tree computations become list computations. Tree contraction evaluates bottom-up expressions over a tree at log depth. Pointers: Tarjan and Vishkin, "An Efficient Parallel Biconnectivity Algorithm" (SIAM J. Computing 1985); Miller and Reif, "Parallel Tree Contraction and Its Applications" (FOCS 1985). For layout specifically: Meyerovich and Bodík, "Fast and Parallel Webpage Layout" (WWW 2010), and Meyerovich, Torok, Atkinson, Bodík, "Parallel Schedule Synthesis for Attribute Grammars" (PPoPP 2013), specify CSS-like layout as attribute grammars and synthesize schedules of tree traversals that process one tree level at a time; Superconductor runs those on GPUs (https://github.com/lmeyerov/sc). Aaron Hsu's APL compiler hosted on the GPU encodes trees as parent and depth vectors and writes tree transformations as array operations ("A Data Parallel Compiler Hosted on the GPU", Indiana University 2019, https://scholarworks.iu.edu/dspace/handle/2022/24749).

UI job: nested box layout. Fit-content sizes are bottom-up sums, grow and percent sizes are top-down, and positions are top-down running sums of sibling sizes.

Cost: when the tree shape is fixed at compile time, the tour is a constant order. "The sum of my descendants' heights" is then one dense affine sum over constant indices (1 layer, with weights equal to the total descendant count, O(n·height)), and the top-down pass is affine except where clamps and min or max appear. A static widget tree compiles into a few layers per pass per tree level. Only structure that changes at runtime (reparenting, nesting loaded from data) needs Euler tours or pointer jumping, at O(n² log n) per structure pass through gathers. Hsu's Key operator (group values by parent) is a scatter rather than a gather, so it stays dense in this runtime: n² products.

### Prefix computations over finite state machines

Running a finite state machine over a string looks sequential, but each symbol's effect is a function from states to states, and function composition is associative. Represent each function as an S×S one-hot matrix (or a table of S entries), scan with composition, and apply the result to the start state. Pointers: Blelloch's 1990 report uses lexing as an example; Mytkowicz, Musuvathi, Schulte, "Data-Parallel Finite-State Machines" (ASPLOS 2014, https://www.microsoft.com/en-us/research/publication/data-parallel-finite-state-machines/) enumerate transitions from all states for SIMD; simdjson finds regions inside strings with a prefix xor computed by carry-less multiplication (Langdale and Lemire, "Parsing Gigabytes of JSON per Second", VLDB Journal 2019).

UI job: text that changes every frame inside the circuit, like word boundaries for double-click selection or Option+arrow navigation in a text input, markdown emphasis state, or whether a character sits inside a quoted string for syntax coloring.

Cost: with one-hot S×S matrices whose entries are affine in the character-class bits, a composition is a product of bit matrices, S³ products at depth about 2. For S = 4 and 128 characters, a Brent-Kung scan needs 254 compositions, about 16,000 products at depth about 26. A serial scan multiplies the one-hot state vector by one matrix per character: about 16 products and 2 layers per character, about 2,500 operations and 256 layers in total. Character classes come from JavaScript, like pretext's segmentation.

### Optimal line breaking as a least-weight subsequence

Knuth-Plass line breaking minimizes total badness over all choices of break points with dynamic programming: `best[j] = min over i < j of best[i] + badness(i, j)`. Concave badness enables SMAWK-style speedups, and in parallel, min-plus matrix products give log-depth solutions. Pointers: Knuth and Plass, "Breaking Paragraphs into Lines" (Software: Practice and Experience, 1981); Hirschberg and Larmore, "The Least Weight Subsequence Problem" (SIAM J. Computing 1987); Wilber, "The Concave Least-Weight Subsequence Problem Revisited" (J. Algorithms 1988).

UI job: balanced headings and captions (like CSS `text-wrap: balance` and `pretty`), where the word count is small.

Cost: n² badness evaluations (one product for the squared slack of each pair) and n min reductions. Computed serially over j, depth is about n × 5·log₂n; with min-plus squaring, each squaring costs n³ products over log₂n squarings. A 16-word heading costs 256 badness products and 16 tournaments, which is affordable; a paragraph is not.

## 4. Data-oriented and immediate-mode UI practice

Immediate-mode UI rebuilds the widget hierarchy every frame from application state. Widgets are identified by hashing labels or ID stacks, so interaction state (the "hot" widget under the pointer, the "active" widget while pressed) persists across frames, and hit tests use the previous frame's rectangles. Casey Muratori's 2005 talk "Immediate-Mode Graphical User Interfaces" introduced hot and active IDs. Dear ImGui (https://github.com/ocornut/imgui) lays out widgets with a cursor that advances per widget. Ryan Fleury's UI series (https://www.dgtlgrove.com/p/ui-part-2-build-it-every-frame-immediate) computes autolayout per axis in five passes: standalone sizes (pixels, text content), upward-dependent sizes (percent of parent, pre-order), downward-dependent sizes (sum of children, post-order), solving violations (shrink children that extend past the parent, weighted by strictness, pre-order), and positions (pre-order). Clay (https://github.com/nicbarker/clay) runs `Clay__SizeContainersAlongAxis` for x, wraps text with the final widths (`Clay__WrapTextLines`), sizes y, then computes positions and render commands in `Clay__CalculateFinalLayout`, with a static arena ("~3.5mb for 8192 layout elements") and a configurable maximum element count. Flutter's layout protocol passes constraints down and sizes up in one tree walk (https://docs.flutter.dev/ui/layout/constraints).

UI job: this is the existing practice closest to the circuit. Vibescript's render loop (`ui.md`, "Render Loop") is already immediate mode, and Clay's maximum element count matches the fixed maximum item count in `tricks.md` "Instancing". The pass structure translates directly: each pass walks a static tree, so each costs a few layers per tree level. Hot and active IDs become one-hot latches in the source table. Hit testing on the previous frame's geometry matches `lab/event-window` (which hit-tests against the rectangles the user saw on the previous frame) and vibescript's hit testing against destination rectangles.

Cost, and the one real loop: GROW distribution with min and max constraints is iterative in Clay (distribute remaining space, clamp, repeat), and Fleury's violation solving is a weighted shrink. A fixed circuit can unroll K rounds, where each round needs about n selects and a division by the number of unclamped children. That division needs a reciprocal, or a constant lookup table when child counts are small integers. The alternative is water filling: every child's size is `clamp(base_i + level·grow_i, min_i, max_i)`, the total is monotone and piecewise linear in `level`, and the right `level` comes from sorting the 2n breakpoints (counting sort, about 5 layers) followed by one pass of running sums. Text wrapping between the x and y passes is where pretext fits.

## Pretext translation, from this survey's angle

Pretext's `prepare` segments text and measures segments with canvas, which are string and platform operations that belong outside the circuit. Its `layout` is arithmetic over cached widths. The simple path, `walkPreparedLinesSimple` (`src/line-break.ts:305-492` in the copy), is a greedy loop whose state is `lineW`, `hasContent`, `pendingBreakSegmentIndex`, `pendingBreakPaintWidth`, and the line start and end cursors. Every branch in the loop is either a comparison against `fitLimit = maxWidth + lineFitEpsilon` or a test on a segment kind. Segment kinds are constant per string after `prepare`, so `breaksAfter(kind)` and `consumesAtLineStart` become constant coefficients or source bits.

The measured serial translation of plain greedy breaking costs about 12 operations and 5 layers per word. The full simple path adds the pending break (the position after the most recent space, which is a latch) and hanging trailing spaces, which should roughly double the per-segment cost. `appendBreakableSegmentFrom` (line-break.ts:378), which breaks a word wider than the line at grapheme boundaries, is a nested loop over graphemes; a fixed circuit needs a maximum grapheme count per overlong word and an inner scan. `getTabAdvance` (line-break.ts:80) takes `%` of a runtime line width, which needs a floor; with a constant tab stop and integer widths it becomes a bounded staircase.

A cheaper route than unrolling per word: a UI card usually shows few lines, so the "next pointers plus one gather per line" form with a small line bound, or a monotone merge for `next`, may cost less. The contract to preserve is pretext's own `lineFitEpsilon` comparison. Quantizing widths to 1/64 px makes that comparison an exact integer comparison, at the cost of up to 1/64 px disagreement with float64 `layout`. A differential test against `layout()` over pretext's corpus would show how often quantization changes a break.

## Observations across techniques

1. Depth only pays off with a parallel backend. Every parallel reformulation measured here (prefix networks, counting sort, pointer jumping, event scan) costs more operations than its serial form, and the current executor runs layers in serial JavaScript, so the serial forms are faster today. The spring collapse is the exception: it reduces both depth and operations.
2. Static structure is cheap, and structure stored as data is expensive. IndirectOS has four window slots and twelve photos at fixed indices, so its layout is affine arithmetic plus clamps. Sorting, line breaking, runtime tree shapes, and linked orders turn structure into runtime values, and costs jump to n² comparisons or n gathers per level. Choices of representation (ranks instead of links, permutation matrices, trees fixed at compile time) remove whole algorithms.
3. Integer discipline makes exactness easy. Every measured circuit used integer comparisons through `relu(v) - relu(v - 1)` and matched its reference exactly without a single boolean atom. Font metrics are already integers or 26.6 fixed point, and `lab/event-window/demo.ts:302-309` already rounds pointer coordinates to integers once at the boundary.
4. FP32 bounds appear in new places: squared distances on 4K coordinates, prefix sums of long paragraphs in 1/64 px, and composite sort keys `key·n + index`.
5. Gather lowering helps retrieval but not index resolution. Lowering removed about a third of the weights in the pointer jumping circuit (201,630 to 129,214 at 64 words), but each gather by an integer index still pays n + 1 equality bits. An executor-level read of `table[index]` from an exact integer wire would make pointer jumping O(n log n) operations, but that is a new construction with its own exactness contract.

## Ten promising prototypes

1. Spring as a frame matrix. Replace `emitSpring`'s 4 Euler substeps with a 2×2 frame matrix that JavaScript computes (from the substep product, or the analytic solution) and stores in 4 shared source cells. Question: how much of IndirectOS's 192 layers and 5,253 operations are springs, and does exact settling (`macro-ranges.md`, "Settled emitSpring") still hold? Expected per field from the isolated measurement: 33 to 11 layers, 46 to 31 operations.
2. Pretext's simple line walk as a circuit. Put `prepare` widths and segment kinds into the source table, unroll `walkPreparedLinesSimple` per segment with integer widths, test differentially against `layout()` on pretext's corpus, then use the result for photo captions or a Notes window inside IndirectOS. Question: can UI with wrapped text join the one circuit, what is the cost per segment with pending breaks and hanging spaces, and how often does 1/64 px quantization change a break?
3. One evaluation per frame for queued pointer events. Replace `lab/event-window`'s per-event evaluation with a fixed-size event buffer folded by latch and reset-maximum scans (47 layers for 32 events, measured for the pointer part). Question: does all of a frame's coalesced input fit in one evaluation with zero divergence on the existing 120,000-frame traces, including focus, drag commit, and maximize toggles?
4. A sortable, reorderable list by counting ranks. Up to 64 items sorted by a runtime key (toggle the sort field, drag to reorder), with thumbnails spring-animating toward their new ranks. Question: does rank by counting (5 layers) plus springs give a smooth reorder animation, and at what item count do n² comparisons become the dominant cost?
5. A static widget tree with Fleury's or Clay's passes. Compile a fixed app shell (header, sidebar, a list of cards with wrapped text, footer) as unrolled size and position passes, including GROW with min and max constraints through water filling. Question: how deep and wide is a realistic nested layout, and could chenglou.github.io's or nicer-hacker-news's layout be written this way?
6. Capacity routing for virtualized lists. A 1,000-row list with a cheap visibility test per row and 20 expensive slots filled through GShard-style cumulative counts, or through a single first-visible index. Question: is the per-frame cost flat in the item count apart from the cheap test, and does exact routing hold (the open item in `tricks.md` "Bounded visibility compaction")?
7. Nearest-target snapping with parabola keys and a counting argmin. Implement gesture-flick-snap-target's `nearestCorner` (`snap-layout.ts:26`) and drop-slot assignment in the circuit, and compare the tournament (40 layers at 64 targets) against a counting argmin (estimated 4 layers). Question: which formulation suits "which slot" jobs best, and which coordinate transform keeps squared distances exact on large displays?
8. Shader-style shapes: SDF hit tests and forgiving hit areas. Rounded-rectangle and circle hit tests by squared comparisons, smooth-union hover regions between dock icons, and an antialiased edge estimate without square roots. Question: does interaction with shapes that are not rectangles stay around 10 operations per shape, and is a canvas projection of SDF coverage a useful complement to the DOM projection?
9. Tree structure that changes at runtime, from a token buffer. An outline or file tree stored as open and close tokens, with depth from a prefix sum, parents from per-depth latch scans, and indentation and clip rectangles derived from those. Question: can drag to reparent, expand, and collapse stay inside a fixed circuit at acceptable cost for depth 8 and 256 tokens?
10. Pointer jumping line breaking with a monotone merge and a small line bound. Rebuild the parallel line breaker with Batcher's odd-even merge for `next` (O(n log n) comparators instead of n² bits) and a bound of 8 lines, then time it with batched source tables or the parked GPU megakernel. Question: at what word count, if any, does the log-depth line breaker beat the serial scan in wall-clock time, and how much would an integer-index gather change the answer?

Other directions that did not make the top ten: syntax-colored text inputs through finite state machine scans, unrolled relaxation for popover placement, Knuth-Plass for balanced 16-word headings, periodic patterns through tent-map composition, and precomputed hash tables read by gathers.
