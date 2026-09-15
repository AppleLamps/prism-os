# Patterns: the long forms

Each doc here is the long form of one short entry in the repo root's [patterns.md](../../../../patterns.md), which covers constructions that replace a familiar loop, [expressions.md](../../../../expressions.md), which covers constructions that replace one expression, or [behavior-choices.md](../../../../behavior-choices.md), which covers choices that change what the user sees. Each doc gives the loop or habit it replaces, the circuit with a builder excerpt, cost with measured sizes, when it's exact, when not to use it, where it's used, and its runnable example and test.

Costs use the guide's two measures: operations, the total work of one evaluation, and layers, the longest chain of operations that must run one after another. n is the item count, k the number of steps or events, S the number of states, L the number of line slots, C the number of candidates, and K a number of DOM slots or possible results fixed while building. `bun test lab/ui-exploration/guide/examples/patterns` from the repo root runs every pattern's test.

Loops, with short entries in patterns.md:

- [Count instead of search](count-instead-of-search.md)
- [The first active candidate, in a tree](first-active-tree.md)
- [The highest score, in a tree](highest-score-tree.md)
- [Run every candidate, then pick one](run-every-candidate.md)
- [Running totals as a tree of additions](running-totals.md)
- [Repeated steps as one matrix power](matrix-powers.md)
- [Events through a state machine, as a prefix scan](state-machine-prefix-scan.md)
- [Speculation](speculation.md)
- [Following links by doubling](pointer-jumping.md)
- [Ranks instead of sorting](ranks-instead-of-sorting.md)
- [Compaction into K DOM slots](compaction-into-slots.md)
- [One program per item](one-program-per-item.md)
- [Breakpoints found ahead of time](breakpoints-found-ahead-of-time.md)
- [Tables that JavaScript writes](tables-javascript-writes.md)

An expression, with its short entry in expressions.md:

- [Threshold counts instead of floor and division](threshold-counts.md)

Behavior choices, with short entries in behavior-choices.md:

- [Hit-test destinations instead of drawn positions](hit-test-destinations.md)
- [Commit state at events](commit-at-events.md)
- [Read last frame's value](read-last-frame.md)
