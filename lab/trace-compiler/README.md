# Numeric TypeScript to circuits

This experiment compiles a defined numeric subset of TypeScript into the project's circuit representation. It walks the TypeScript AST with symbolic values; it is not a runtime tracer and does not compile arbitrary JavaScript. Static photo data and bounded integer choices let it specialize some operations that would otherwise require dynamic indexing or allocation.

The September 2026 reassessment found bugs in block returns, nullable equality, and conditional side effects, plus a shared interpreter bug that made an incorrect result look verified. Those cases now have regressions. The harness independently executes the selected source with the JS engine, in addition to comparing the FP32 circuit and interpreter.

## Reproducing

- `bun test lab/trace-compiler`
- `bunx tsc -p lab/trace-compiler`
- `bunx oxlint --type-aware lab/trace-compiler`
- `bun lab/trace-compiler/report.ts` prints the measurements and coverage classification.
- `bun lab/trace-compiler/report.ts --live` optionally checks the current external gallery files. Changes to the external source may cause rejection; this is separate from the repeatable fixture tests.

The default source is frozen in [fixtures](./fixtures/README.md), copied byte-for-byte from gallery commit `f315d5864a21b9e10126b741456e232d8ece681e`, the last committed revision of the target files before the July experiment. That revision reproduces the reported statement locations and 221-photo count. The July run did not record a working-tree hash, so this is known Git provenance, not proof that an unrecorded working tree was identical.

## What Is Checked

Every sampled trial runs five calculations:

1. The circuit's literal reference evaluator.
2. The circuit's compiled execution path, currently JavaScript rather than a GPU backend.
3. The FP32 source interpreter.
4. The float64 source interpreter.
5. The selected source executed natively by the JavaScript engine.

The first three must agree on the circuit outputs. Constant outputs have no compiled-execution comparison, and absent nullable values have no meaningful value to compare. Plus and minus zero compare equal.

The float64 interpreter must separately agree with native JS. This check includes returned values and object-parameter fields, including fields the compiler thought were unchanged. `report.sourceSemantics` records any disagreement. A regression deliberately corrupts the float64 interpreter's result and confirms that this independent check catches it even while the circuit and FP32 interpreter agree.

Precision drift compares the FP32 interpreter with native JS. Drift is reported, not treated as a compiler error. For example, `(100000000 + 1) - 100000000` is zero with a rounding step after each FP32 operation, but one in native JS. Similarly, the FP32 interpreter replaces division with `fround(a * fround(1 / b))`. That is an explicit arithmetic policy, not exact preservation of JavaScript division.

Native validation uses TypeScript only to identify reachable declarations and erase types. Arithmetic, branches, loops, and mutations then run in the JS engine. Unrelated browser initialization is not included. This executes trusted local test source; it is not a sandbox for untrusted programs.

These checks are sampled evidence within declared input ranges, not a proof for every supported program. A zero mismatch count is meaningful only alongside the domain and the independent source check.

## Supported Constructs

The implemented subset includes numeric declarations and assignments; fixed object and array structures; object destructuring; arithmetic; comparisons; logical operations over decision bits; numeric and nullable ternaries; null tests and null coalescing; `Math.min/max/abs/floor`; bounded `for` loops; `for...of` over fixed arrays; constant-index array access, append, and `.at`; function inlining; and module constants.

Runtime loop bounds need finite integer ranges. The compiler unrolls the static range and masks each iteration's writes. Returns inside ordinary blocks, constant branches, and constant iterations now propagate out of the function. Returns under a runtime condition still reject explicitly; first-match search lowering has not been implemented.

A runtime ternary, logical short circuit, or null-coalescing fallback must not mutate state. The compiler rejects assignments and array appends while evaluating those branches, including mutations inside called helpers. This conservative restriction also rejects helper-local assignments in those expressions. Pure helper calls remain supported. Runtime `if` statements can mask numeric assignments.

Nullable strict equality checks both presence and numeric values. For example, `(flag > 0 ? 5 : null) === 5` is true only when the value is present and equal to five; it is not merely a null test.

## Lowering And Rounding

| Source operation | Current lowering |
| --- | --- |
| An affine arithmetic step | `Circuit.roundAffine`, which preserves one FP32 evaluation and prevents composition into a consumer |
| Runtime multiplication | `Circuit.multiply`, with semantic multiplication metadata and a ReGLU forward expansion |
| Division by a constant | Multiplication by an FP32 reciprocal |
| Division or modulo by a small bounded integer | One branch per possible divisor, selected with exact bits |
| Integer comparison | ReLU difference bits, within the exact integer range |
| Continuous comparison | A sign cascade with ReLU, power-of-two scaling, and clamps |
| Numeric selection | Two masked products, `on * bit + off * (1 - bit)` |
| Bounded floor | A sum of threshold bits |
| Runtime conditional assignment | Selection between the old and new values |
| Small bounded structural choice | One specialized circuit per possible value, then output selection |

The compiler previously used a dummy unit ReGLU gate to prevent affine composition from removing a rounding point. `roundAffine` now expresses that requirement directly. It sorts terms by wire index, so the emitter accepts only combinations whose rounding is independent of that reordering, such as two terms with zero bias. The circuit now contains affine operations as well as ReGLUs; the old claim that every operation was a ReGLU is obsolete.

Multiplication retains its meaning for differentiation rather than differentiating only its signed ReLU expansion. This addresses the zero-operand derivative problem found during reassessment. Differentiation still refers to an intended real-valued calculation, not a literal derivative of FP32 rounding.

Ranges must model FP32 rounding. In particular, a real-number bound just below one can round to one, changing `Math.floor`. The regression uses `x = 1 - 2^-24` and `y = 2^-25`: FP32 `x + y` rounds to one, and the compiled floor must return one. Product bounds in this compiler also round their endpoints and conservatively handle nonfinite cases.

Branch-derived ranges stay on local symbolic values. They must not be installed globally on a shared circuit wire, because the same expression can also occur outside that branch. Masked expressions require finite FP32 ranges; otherwise an unselected `Infinity * 0` could produce NaN.

## The Sign Cascade

The July comparison policy scaled a difference into a score near 0.5 and used the boolean atom. That policy failed at exact column boundaries: at viewport width 1732, reciprocal multiplication lands one FP32 step below seven, while the score loses that small difference.

The replacement first keeps positive differences with ReLU, then repeatedly scales by powers of two and clamps until every positive FP32 difference in the supported range becomes one. The compiler uses this construction for continuous comparisons and does not emit boolean atoms in the current test circuits.

This is an exact forward construction under the compiler's numeric assumptions. It does not make hard comparisons usefully differentiable, nor prove that a long cascade is the fastest execution method. A native comparison or a simpler training relaxation is a separate lowering choice.

Update, September 15, 2026: compile.ts still builds its own cascade, scaling by 2^23 and clamping until the smallest positive FP32 value reaches 1. Since September 14, numeric-ui-core.ts's `emitCompare` plans cascade stages from declared ranges, e.g. `a >= b` within 0..16,384 in 15 operations and 14 layers ([execution-model.md](../../docs/execution-model.md#comparisons)). The compiler doesn't use `emitCompare`, `circuit.indexRead` or host-written spring matrices, all added that day.

## September Fixture Results

The complete report checks 1,174,491 circuit outputs: 1,102,635 with all three FP32 comparisons, 68,300 without a compiled-execution comparison because the output was constant, and 3,556 absent nullable value slots. There were zero circuit mismatches. Native JS independently checked 1,193,491 float64 interpreter outputs with zero disagreements. The larger native count includes unchanged object fields and uses a different nullable representation.

| Gallery slice | Operations | ReGLUs | Layers | Stored weights | Trials |
| --- | ---: | ---: | ---: | ---: | ---: |
| clamp | 60 | 22 | 31 | 84 | 5,000 |
| column calculation | 524 | 174 | 91 | 700 | 4,097 |
| spring step | 14 | 4 | 8 | 24 | 5,000 |
| spring snap | 0 | 0 | 0 | 0 | 2,000 |
| 1D hit test | 117 | 47 | 32 | 158 | 5,000 |
| 2D layout, seven column variants | 24,894 | 7,286 | 600 | 38,810 | 300 |
| 1D layout, masked loops | 21,213 | 8,736 | 1,580 | 31,290 | 300 |
| occlusion bits | 25,416 | 8,619 | 32 | 34,477 | 500 |
| scroll compensation | 222 | 0 | 2 | 444 | 500 |

All rows emit zero boolean atoms. The eight synthetic gauntlet functions also passed; their full counts and drift statistics are printed by `report.ts`.

The column calculation intentionally differs between FP32 and native float64 at six of the 4,097 integer widths: 512, 756, 1000, 1244, 1488, and 1732. Reciprocal rounding selects one fewer column there, and the per-column width can differ by about 240 pixels. Circuit/interpreter agreement does not make that precision choice invisible to users.

Photo dimensions and aspect ratios are static compilation inputs. The 2D slice compiles once per column count from one through seven. It excludes hover search, dismissed-scroll adjustment, and anchor search. The 1D slice excludes keyboard string decoding, which enters as a numeric input. This is not the entire application compiled unchanged.

## Coverage And Remaining Work

The frozen render path contains 221 statement units. The slices actually compile and verify 64 units: 29.0% of all units, or 37.0% of the 173 units classified as numeric.

A syntax-based classifier identifies another 49 numeric candidates. Adding those candidates gives the historical 113/173, or 65.3%, but those 49 have not been compiled and verified. The census now labels them as candidates, not compiled code. Its remaining categories describe possible work, not actual diagnostics produced by compiling every statement.

The two explicit rejection probes remain: first-match hit testing returns under a runtime condition, and spring stepping has an unbounded runtime iteration count. Other remaining restrictions include dynamic array access, runtime allocation, string encoding, nonfinite sentinels, and browser I/O.

The deepest slice still has 1,580 layers because it accumulates positions sequentially through 221 photos. A parallel prefix sum would change rounding order, so it is not automatically interchangeable under this exactness policy. Seven-way specialization also requires a genuinely small choice set. Neither measurement establishes GPU performance.

Useful next changes are bounded first-match selection and explicit gather declarations, with the native source checks retained. Increasing coverage is an experiment to measure; it should not be inferred from syntax alone.

## Files

- `compile.ts`: symbolic AST compiler and numeric emitter.
- `annotations.ts`: input range and relation annotations.
- `twin.ts`: FP32 and float64 source interpreters.
- `native.ts`: independent native execution for selected functions and slices.
- `harness.ts`: sampling, three-way FP32 checks, independent source checks, and precision drift.
- `gauntlet.ts`: synthetic numeric examples.
- `real-slice.ts`: frozen gallery slices and optional live-source loading.
- `residue-census.ts`: heuristic coverage classification.
- `report.ts`: repeatable measurements.
