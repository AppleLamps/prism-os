# Brief: one-hot group invariants and gather lowering in the tensor compiler

Historical July 2026 assignment, retained for provenance. Its proposed policies and success criteria are not current conclusions. Read [shared context](context-shared.md) and [current status](../status.md) before using this brief.

Folder: `lab/gather-lowering/`. Read `lab/briefs/context-shared.md` first; conclusion 10 is your foundation, and the `todo.md` section "Revisit hardAttend" is the design decision you are implementing the alternative to.

## The question

Can the compiler recognize dynamic-lookup idioms — a sum of values masked by an exact one-hot — and lower them to a gather operation in the tensor executor, bit-identically, so that reading one item out of N stops costing N stored weights per read, WITHOUT adding a fourth atom? This is the "keep the algebra closed, enrich the executor" path: atoms and executor operations do not have to be the same set, because the literal interpreter remains the definition of correctness and differential tests force agreement.

## Build

This brief, uniquely, grants you permission to modify `numeric-ui-core.ts`. Constraints: additive and minimal; every one of the existing tests in the repo must still pass unchanged (`bun test` at the repo root); the literal reference evaluator's semantics must not change at all.

1. Group invariants: a way to declare "these wires form an exact one-hot" (each is exactly 0 or 1, they sum to exactly 1 — decide and document whether you also need an all-zero-allowed variant). Follow the spirit of `assumeRange`: a declared contract the trainer/builder promises and validation can check. Have `emitArgmax` and `emitFirstActive` declare their output groups automatically, since they construct the property.
2. Idiom recognition in `compileTensorProgram`: detect an affine node whose terms are reglu products of a declared one-hot group against value wires, and emit a gather operation in the tensor program instead of dense rows: compute the index from the one-hot (the one-hot indexing trick — a dot with 0..N-1 is already exact), then an indexed read at execution time.
3. The exactness argument, written and tested: a masked sum against an exact one-hot accumulates `fround(0 * v_j) = 0` terms plus one `fround(1 * v_i) = v_i` term, so the gather is bit-identical for finite values — which declared ranges guarantee. Encode this as randomized differential tests: many seeded circuits with one-hot-masked reads, reference vs tensor-with-gather, exact equality on every wire. Include adversarial cases: values at FP32 extremes within range, groups of size 1, multiple gathers sharing one group, a gather feeding another gather.
4. Robustness to the builder's own transformations: affine inlining and expression deduplication reshape the graph; show recognition survives them (or characterize exactly when it does not — brittleness findings are findings).

## The experiments to run and report

1. The benchmark that motivated all of this: a 1,024-slot photo library where a selected item's geometry (4 values) is read via one-hot indexing. Measure stored sparse weights, tensor program size, and execution time (median over many runs, `Bun.nanoseconds()`) with lowering off versus on. Then scale: N = 64, 256, 1024, 4096; T = 1, 4, 16 reads against the same one-hot. Report the table.
2. Production impact: compile the existing `window-manager.ts` and `candidate-gallery.ts` circuits with recognition enabled. Report how many gathers were found in real circuits (zero is a legitimate finding about how production code differs from the idiom), and confirm their compiled outputs remain bit-identical on the existing test suites.
3. Validation cost: what does checking the one-hot contract cost at runtime if validated per evaluation, and what is your recommended policy (validate in tests only, validate always, validate on writeback)?

## Success criteria

- Every existing repo test passes unchanged; the new differential tests pass across thousands of seeded circuits.
- The benchmark table shows the expected asymptotic behavior (stored weights per read dropping from O(N) toward O(1) plus the shared index computation), with honest accounting of what remains O(N) (the one-hot itself, argmax if present).
- README with the invariant design, the recognition algorithm, exactness argument, benchmark tables, production-circuit findings, and limits.
