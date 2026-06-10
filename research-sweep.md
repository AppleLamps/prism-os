# Research sweep

Land changes that strengthen the numeric model without adding another format,
mode, or runtime.

## Landed

- Seeded random circuits compare every live wire between literal and compiled
  FP32 execution.
- `execution-model.md` fixes instruction, rounding, and layer semantics.
- Photos is inlined into IndirectOS before one fused compile.
- Photo nodes attach only while numeric size and opacity are positive.
- Compiler indexes use the smallest safe 8, 16, or 32-bit storage.
- Static winner priority uses a balanced reduction instead of a serial scan.
- The compiler already performs affine composition, aliases, constant folding,
  common-expression merging, dead-value removal, compact layer inputs, sparse
  weights, and basic range reasoning.

## Parked

- **Compiler mutation tests:** 49 lines mostly restated validator checks.
- **Executor split:** a separate dependency-free executor added a module
  without shrinking the product.
- **Precompiled demos:** faster startup, but a generator and 124 KB of generated
  source made browser bundles much larger.
- **Portable tensor format:** exact JSON round-tripping added versioning and a
  second representation with no consumer.
- **Layer scheduling:** latest-legal scheduling increased gathered inputs.
  Retry after circuit shapes change.
- **Relation layout:** the older demo added about 400 lines and proved less than
  the current window and Photos behaviors.
- **GPU megakernel:** feasible in one 256-thread workgroup, but interesting only
  when many source tables run together.
- **Slot reuse:** saved about 4.5 KB for windows and 1 KB for Photos. Larger
  gains need a narrower output contract and more runtime machinery.

## Deferred

Strings, arbitrary division, variable allocation, fixed point, editable
instructions, and batching still lack a UI behavior that requires them. Keep
the preallocated FP32 model until one of those limits becomes concrete.
