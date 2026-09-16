# Hard attend

A page of plain JavaScript, not a numeric program, that walks through reading one of three items with a query. Item j has the key (2j, -j²) and the query is (query, 1), so their dot product, 2 × query × j - j², is highest at the item nearest the query. The page shows three reads of the items' values: a one-hot gather, which multiplies each value by a bit that is 1 only for the highest score and adds them up, a direct gather, which reads the value at the winner's index, and a softmax gather, whose weights move toward the one-hot bits as the sharpness slider goes up. The guide's [soft attention section](../ui-exploration/guide/sections/indexing.md#soft-attention) explains these parabola keys.

The page labels the direct gather `hardAttend`, the hard-attention operation that the June 2026 plan considered. [lab/status.md's parked entry "Revisit hardAttend"](../status.md#parked-and-deferred) says what covers that plan today, e.g. `circuit.indexRead`.

It moved here from the repo root on September 16, 2026. Run `bun run start:hard-attend`. The folder has no tests.
