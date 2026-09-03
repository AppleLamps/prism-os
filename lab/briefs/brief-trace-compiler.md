# Brief: trace-based compilation from vibescript-style code to circuits

Historical July 2026 assignment, retained for provenance. Its proposed policies and success criteria are not current conclusions. Read [shared context](context-shared.md) and [current status](../status.md) before using this brief.

Folder: `lab/trace-compiler/`. Read `lab/briefs/context-shared.md` first; conclusion 9 is your foundation. Also read `~/github/vibescript/docs/ui.md`, `~/github/vibescript/docs/engineering.md`, and the real demo `~/github/chenglou.github.io/index.ts`.

## The question

How much of a real vibescript-style render tick compiles mechanically into a circuit, with the residue precisely characterized? The hypothesis from the design conversation: straight-line numeric layout math traces cleanly; the residue is data-dependent branching (which must become selects), capacities, and encodings — and naming that residue precisely is the research finding about "coding pattern shifts."

## Build

1. A compiler from a restricted TypeScript subset to `Circuit` builder calls. Use the `typescript` package already in the repo's devDependencies for parsing (no new dependencies). Support at minimum: numeric `const`/`let` with single assignment per branch, arithmetic operators, comparison operators inside ternaries, `Math.min`/`Math.max`/`Math.abs`, the repo-style `clamp`, bounded `for` loops over compile-time-constant ranges (unrolled), array reads at constant or loop indices, and function calls that inline (single level is fine). Reject everything else with a precise diagnostic naming the construct and the line — the diagnostics ARE data.
2. Lowering rules: ternaries on comparisons become select macros over decision bits; document your policy for the decision (boolean atom for continuous comparisons; integer-exact bits where operands are provably integers — `@fit`-style annotations in comments may declare integrality and ranges, and you should support reading them since Cheng's real code already contains them).
3. Exactness policy, decided and documented up front: the circuit computes in FP32; the source JS computes in float64. Either (a) generate an fround-instrumented twin of the source function and require bit-exact agreement with the circuit, plus measured drift statistics between the twin and the original float64 function, or (b) a justified tolerance regime. Option (a) is strongly preferred — it matches the repo's differential-testing DNA.
4. Equivalence harness: run source function and compiled circuit over thousands of seeded random inputs within declared ranges; compare per the policy; report.

## The experiments to run and report

1. Synthetic gauntlet: a suite of representative layout functions (responsive column count, gap distribution, clamped positions, wrap arithmetic, a spring destination computation) — compile, verify equivalence, report op counts per function.
2. The real target: extract the pure layout math from `~/github/chenglou.github.io/index.ts` (the column/position computations and spring destination logic; NOT the DOM or event plumbing). Compile the largest slice that fits the subset. Report: percent of the render path's numeric statements that compiled, categorized diagnostics for everything that did not (dynamic array length? string work? closure state? DOM read?), and equivalence results for the compiled slice over randomized viewport/scroll/input values.
3. The residue taxonomy: a table of every rejection category encountered in real code, with counts, an example line each, and for each category: mechanically fixable (how), annotation-fixable (what annotation), or genuinely judgment-required (why). This table is the deliverable Cheng cares most about.

## Success criteria

- The synthetic gauntlet compiles and matches bit-exactly under the fround-twin policy across thousands of seeded inputs.
- A non-trivial slice of the real file compiles and matches; the slice's boundaries are stated honestly.
- The residue taxonomy exists with real counts from real code.
- README with the lowering rules, the exactness policy, equivalence numbers, and the taxonomy.
