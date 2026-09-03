https://arxiv.org/pdf/2606.22636
harmonic analysis

## Revisit hardAttend

The June plan considered a hard-attention operation: score each candidate against a query, choose a winner with an explicit tie rule, and retrieve that candidate's values. The current circuit can express this calculation using smaller operations. That establishes expressibility, not the best execution cost or training method.

Two separate operations matter:

- **Indexed retrieval:** given an already chosen index, read one candidate. The current gather lowering recognizes a declared one-hot masked sum and replaces its multiply-and-sum arithmetic with indexed retrieval.
- **Scored selection:** compute scores from changing input data and choose the winner. Gather lowering does not discover query/key functions or remove the cost of scoring candidates.

As of September 2026, production circuits lower 26 candidate-gallery reads and 12 window-manager reads. The executor scans each one-hot group once, then performs an indexed read for each associated output. It still stores candidate-index tables and computes candidate values. See [gather lowering](lab/gather-lowering/README.md) and [current status](lab/status.md).

Exact selection does not have useful gradients with respect to the winner choice. Gradients through a retrieved value are a different matter. Soft mixtures and clipped comparison ramps are explicit training alternatives; successful hardening must be checked separately. The sign cascade provides exact forward comparison under its numeric assumptions, not a solution to learning discrete choices.

The remaining experiment is to learn a shared scoring rule from changing data. For example, retrieve the rectangle matching a selected item ID while varying its storage position, the number of active items, and distractors. Define absent-ID behavior and ties in advance, then test unseen values and orderings. A fixed slot choice cannot solve that task, but making static routing insufficient does not guarantee that gradient descent will find a working rule.

Start with an authored lookup and a small exact program-search baseline. They establish the task, numeric contracts, and attainable correctness before testing a learned query/key rule. Compare alternatives without presuming that attention must emerge.
