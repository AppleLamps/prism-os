# Bounded data adapters

This is the small program-search experiment proposed in section 4 of the September reassessment. Given examples of available rectangles and desired answers, exhaustive search chooses which rows to read and which arithmetic steps to apply. Nothing trains neural weights here.

**Result:** 12 training scenes identify one program for each of eight tasks from 868 candidates. All eight programs agree exactly with an independent JavaScript lookup on 438 held-out scenes, including larger collections and fractional FP32 values. The repeated lookup becomes a reusable function, but the extraction rule is authored, not a learned neural abstraction.

## Inputs and answers

One circuit has 12 storage slots. Each slot contains an active bit, an integer ID, and `left`, `top`, `width`, and `height`. Other inputs are the selected ID, two coordinate origins, and a scale. Counts and storage positions change through inputs, without rebuilding the circuit. An active row's complete contents move together when storage is permuted.

Each answer is `{found, value}`. An absent ID returns `{found: 0, value: 0}`, even when the coordinate origins are nonzero. A present rectangle with a zero coordinate still returns `found: 1`. Active IDs must be unique; inactive rows may repeat any ID and contain misleading geometry. Duplicate active IDs are rejected rather than assigned an order-dependent meaning.

For example, select ID 20 from these active rows, regardless of their storage order:

| ID | Left | Top | Width | Height |
| --- | ---: | ---: | ---: | ---: |
| 10 | 7 | 3 | 5 | 9 |
| 20 | 40 | 10 | 12 | 8 |
| 30 | -6 | 24 | 20 | 4 |

The selected left is 40; its right is 52. With origin X = 4 and scale = 2, its local left is `(40 - 4) * 2 = 72`. Selecting absent ID 99 returns `found = 0` and zero for every task.

## What search can choose

The vocabulary is deliberately small:

- Zero, one, or two row predicates: active, same ID, or first storage slot. Multiple predicates are combined with AND. Repeated predicates and different orders of the same predicates are excluded because these are exact bits.
- Read one field: left, top, width, or height. A read sums that field multiplied by each row's selection bit. A wrong candidate can select several rows; the candidate is still evaluated, not silently treated as a valid lookup.
- Apply zero, one, or two steps: add selected width, add selected height, subtract origin X, subtract origin Y, or multiply by scale. Arithmetic step order is preserved.

There are `7 * 4 * (1 + 5 + 25) = 868` programs. Every program runs through the existing `Circuit` implementation. Search rejects candidates on the first training example that eliminates all remaining tasks. There is no heuristic, partial-program score, gradient, or fitted coefficient.

The eight target functions use native JavaScript `find` and separately written FP32 arithmetic. They do not interpret candidate programs or call the circuit builder. These are authored targets for a controlled experiment, not examples collected from users.

| Target | Unique program after the common lookup |
| --- | --- |
| Left | Read left |
| Top | Read top |
| Right | Read left, add width |
| Bottom | Read top, add height |
| Local left | Read left, subtract origin X, multiply by scale |
| Local top | Read top, subtract origin Y, multiply by scale |
| Scaled right | Read left, add width, multiply by scale |
| Scaled bottom | Read top, add height, multiply by scale |

The recovered common lookup is **active AND same ID**. None of the fitting programs omits either predicate. That excludes both ignoring identity and accidentally reading matching inactive rows within this candidate vocabulary.

## Reuse

After search, `repeatedLookup` counts repeated predicate sequences in the solutions. The repeated sequence is stored once, with the read field as a function argument:

```text
selectedField(field) = active & same-id -> read field
right = selectedField(left) + selectedField(width)
localLeft = (selectedField(left) - originX) * scale
```

The actual function also returns whether a match exists, and the final answer remains zero when no row matches. Its row selection is computed once for all eight tasks in the combined circuit. Only four distinct fields need retrieval.

This is a narrow, authored extraction rule: find a repeated predicate prefix and parameterize the field read that follows it. It does not search for arbitrary new abstractions. No neural guide is implemented; eight tasks and a search of 868 programs are too small to justify one.

There is also no extra graph-size saving from naming the function. The core already deduplicates identical expressions when the unfactored programs are built together. Both joint versions contain 200 constructed operations and lower four reads to gathers. Building eight independent circuits constructs 1,118 operations in total; that comparison measures sharing between separate computations, not an advantage over the core's existing deduplication. These counts are for this checkout and may change with the core.

## Verification

Training uses seeds 1 and 2, one/two/three active rows, both present and absent IDs, and integer geometry: 12 scenes, with eight target answers each. Inactive rows deliberately use the selected ID. Search evaluates 997 candidate/scene pairs after early rejection. On the development machine, the bounded search takes about 60 ms; this is not a controlled performance benchmark.

Held-out data uses seeds 1001-1024 and counts 0, 4, 6, 9, and 12. Nonempty collections include both present and absent selections; empty collections have only the absent case. These 216 generated scenes use new IDs, fractional geometry, and fractional positive or negative scales. Reversing each scene's storage adds 216 permutation checks. Six additional cases exercise ID endpoints, rounded inputs, intermediate rounding, subnormal numbers, signed zero, and large values within the contract: 438 scenes total.

Every fitting program is checked, not just the first candidate. Each answer's presence bit and coordinate are compared against both literal and compiled execution: 14,016 scalar comparisons. Joint unfactored and factored execution repeat those checks over the same inputs; these are implementation comparisons, not additional independent samples. Tests also exercise every selected storage position and compare gather-lowered execution with the unlowered circuit.

## Numeric contract and limits

- IDs are integers from 0 through 65,535. The equality construction is `ReLU(1 - abs(id - selectedID))`, exact for this integer domain. It is not a general continuous equality operation or a learned query/key rule.
- Coordinates and origins lie in `[-2^20, 2^20]`, sizes in `[0, 2^16]`, and scale in `[-4, 4]`. All stored values, including inactive rows, must be finite. `encode` checks these contracts and unique active IDs before execution.
- Inputs are rounded to FP32 before arithmetic. Each addition, subtraction, and multiplication rounds separately. `roundAffine` prevents later graph construction from removing required rounding. For example, `fround(fround(1 + 2^-24) * 3)` is 3, while rounding only after the multiplication gives a different result.
- Positive and negative zero are treated as the same answer. NaN and infinity are outside the input domain. There is no claim of exhaustive verification over every allowed FP32 value.
- The selection bits can be declared one-hot only for active AND same ID, using the validated uniqueness contract. This enables the existing gather lowering. Finding a match still examines all 12 slots; it is not constant-time attention or a learned lookup algorithm.
- The graph is fixed for a capacity of 12. More than 12 storage slots requires another graph. There are no strings, nested objects, arbitrary loops, joins between tables, or general JavaScript synthesis. The vocabulary does not even contain enough steps for `(left + width - originX) * scale`.
- These results establish reuse across changing data for eight authored tasks. They do not establish that a learned search guide will transfer to new task families, or that this symbolic baseline fulfills the project's native-neural goal. A useful next comparison would increase task variety and search cost before adding such a guide.

## Run

```sh
bun lab/data-adapter/report.ts
bun test lab/data-adapter
bunx tsc -p lab/data-adapter/tsconfig.json
bunx oxlint --type-aware lab/data-adapter
```

Files: `experiment.ts` contains the vocabulary, circuit construction, independent oracle, datasets, search, and verification. `report.ts` prints results without writing artifacts. `experiment.test.ts` contains regression checks. `tsconfig.json` scopes type checking to this experiment. No files under `exp/` were read.
