# Runtime costs

`bun lab/runtime-cost/report.ts` compares literal reference execution, the existing tensor executor returning a full wire array, and the tensor executor with reusable buffers returning only requested outputs. A two-operation coordinate transformation also has a direct scalar-JS baseline. The UI circuits do not have independent handwritten baselines in this study.

Each measurement reports the median of seven samples, rotates method order, warms each method, and consumes all requested outputs. Checksums must agree across methods. This is steady-state CPU execution on an unchanged input, not event processing, GPU execution, compilation, or a browser frame benchmark. Repeated input avoids mixing state transitions with evaluation cost; the reusable evaluator's changing-input correctness is tested in `numeric-semantics.test.ts`.

The reusable evaluator is an opt-in API: `circuit.createTensorEvaluator(roots)`. It captures a compiled program and returns a function whose output array is overwritten on its next call. Callers that retain a frame must copy the output. Existing evaluators retain their old ownership behavior.

The purpose is to measure simple allocation and output-copying costs before pursuing a more elaborate layer scheduler. Timings depend on the machine and concurrent work; rerun locally rather than treating a single ratio as an architectural guarantee.
