// The numeric library in one import. See README.md for each function's contract.
export {
  type CompareOptions,
  type ComparePlan,
  type Relation,
  compareCost,
  differenceBound,
  emitClampExact,
  emitCompare,
  emitDifference,
  emitMaximumExact,
  emitMinimumExact,
  emitMinimumOf,
  emitSelectBit,
  emitSignBit,
  planCompare,
  smallestFloat32,
} from './comparison.ts'
export {emitCeil, emitFloor, emitFloorDivide, emitFloorOnGrid, emitFract, emitIntegerOneHot, emitRound, roundDomain} from './rounding.ts'
export {
  type NewtonOptions,
  type SquareRootOptions,
  emitDivide,
  emitReciprocal,
  emitSqrt,
  reciprocalPlan,
  squareRootPlan,
} from './arithmetic.ts'
export {emitCos, emitSin, emitSinCos, trigonometryDomain} from './trigonometry.ts'
export {
  emitExp,
  emitHash,
  emitMix,
  emitRemap,
  emitRemapRuntime,
  emitSmoothstep,
  emitSmoothstepRuntime,
  expPlan,
  hashReference,
} from './shaping.ts'
