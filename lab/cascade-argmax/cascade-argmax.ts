// A variant of emitArgmax whose pairwise decisions come from the exact sign cascade instead of
// the boolean atom. Production emitArgmax scales the score difference into a value near 0.5 and
// rounds it with the boolean atom; that encoding keeps the left candidate on exact ties, but it
// also keeps the left candidate throughout a rounding band of roughly 2.4e-7 in absolute score
// difference (measured in the tests), and the boolean atom blocks backpropagateReference.
//
// The cascade decision is relu(right - left) followed by power-of-two scaling and clamp01
// rounds until every positive difference saturates at exactly 1: multiplying by a power of two
// only shifts the exponent, clamp01(v) = v - relu(v - 1) is exact for v below 2**24, and the
// FP32 difference f(right - left) is zero exactly when the scores are equal. The result is an
// exact bit of [right > left]; left-wins-on-ties is its negation, 1 - bit. No boolean atom
// appears anywhere. The hard decision still has no useful score gradient;
// training uses a soft relaxation rather than differentiating the hard choice.
//
// The same topology trains soft: shrink the seven scale factors from 2**23 to an annealed gain
// and each clamp01 stage becomes a ramp, making the decision a piecewise-linear saturating
// slope instead of a step. softCascadeOptions also centers the ramp on zero difference so both
// sides of a wrong decision receive gradient; the hard form sets the offset back to zero, which
// restores the exact tie rule.

import {Circuit, type Wire, emitArgmax, emitMultiply, invariant} from '../../numeric-ui-core.ts'

const f32 = Math.fround

export type CascadeOptions = {
  // Seven multiplicative stages: one after the initial relu, one after each of the six
  // clamp01 rounds. The hard form uses 2**23 everywhere: scores live in [0, 1], so the first
  // stage keeps values below 2**24 (clamp01's exactness bound), and the total gain 2**161
  // saturates even the smallest positive FP32 difference (2**-149) to exactly 1.
  stageScales: number[]
  // Added to the difference before the relu. Zero in the hard form (exact ties stay left).
  // The soft form uses half the ramp width, so a tie sits mid-ramp and gradient reaches both
  // orderings.
  rampOffset: number
  singleRampGain?: number
}

export const cascadeStageCount = 7

export function hardCascadeOptions(): CascadeOptions {
  return {stageScales: Array<number>(cascadeStageCount).fill(2 ** 23), rampOffset: 0}
}

// A soft form with the same topology: uniform per-stage gain whose product is totalGain, and a
// ramp centered on zero difference. totalGain 2**161 with offset 0 would be the hard form.
export function softCascadeOptions(totalGain: number, variant: 'cascade' | 'single-ramp' = 'cascade'): CascadeOptions {
  const scale = totalGain ** (1 / cascadeStageCount)
  return {
    stageScales: Array<number>(cascadeStageCount).fill(scale),
    rampOffset: 0.5 / totalGain,
    ...(variant === 'single-ramp' ? {singleRampGain: totalGain} : {}),
  }
}

// Separate rounding points are essential. roundAffine replaces the former
// unit-gated ReGLU workaround and prevents affine composition.
function frozenStep(circuit: Circuit, terms: [Wire, number][]): Wire {
  return circuit.roundAffine(terms)
}

// clamp01(value) = value - relu(value - 1), exact for value below 2**24.
function emitClampZeroOne(circuit: Circuit, value: Wire): Wire {
  const aboveOne = circuit.reglu([], 1, [[value, 1]], -1)
  const clamped = frozenStep(circuit, [[value, 1], [aboveOne, -1]])
  circuit.assumeRange(clamped, 0, 1)
  return clamped
}

// The decision bit of [right > left]: exactly 1 when right is strictly greater, exactly 0 on
// ties and when left is greater (hard form). The soft form is a saturating ramp in the
// difference.
export function emitCascadeGreaterBit(circuit: Circuit, left: Wire, right: Wire, unit: Wire, options: CascadeOptions): Wire {
  invariant(options.stageScales.length === cascadeStageCount, 'cascade needs exactly seven stage scales')
  invariant(circuit.ranges[unit]!.minimum === 1 && circuit.ranges[unit]!.maximum === 1, 'cascade unit must equal one')
  // relu(right - left + offset) in one operation: the difference forms the gate.
  let value = circuit.reglu([], 1, [[right, 1], [left, -1]], f32(options.rampOffset))
  if (options.singleRampGain !== undefined) {
    invariant(options.singleRampGain > 0 && options.singleRampGain <= 2 ** 23, 'soft ramp gain must be in (0, 2**23]')
    return emitClampZeroOne(circuit, frozenStep(circuit, [[value, options.singleRampGain]]))
  }
  value = frozenStep(circuit, [[value, f32(options.stageScales[0]!)]])
  for (let stage = 1; stage < cascadeStageCount; stage++) {
    value = emitClampZeroOne(circuit, value)
    value = frozenStep(circuit, [[value, f32(options.stageScales[stage]!)]])
  }
  return emitClampZeroOne(circuit, value)
}

type CascadeNode =
  | {score: Wire, item: number}
  | {score: Wire, leftWins: Wire, left: CascadeNode, right: CascadeNode}

// Same tree shape and result contract as emitArgmax: a one-hot over the candidates plus the
// winning score. Differences: the decision bit is the exact cascade (negated, so exact ties
// keep the left candidate, matching production's documented tie rule), and the winner's score
// moves up the tree through the two-product select left*leftWins + right*rightWins, which is
// exact for finite fractional scores. Production now uses two-product selection
// too, but retains its approximate comparison near ties.
export function emitCascadeArgmax(
  circuit: Circuit,
  scores: readonly Wire[],
  unit: Wire,
  options: CascadeOptions = hardCascadeOptions(),
): {selected: Wire[], score: Wire} {
  invariant(scores.length > 0, 'argmax needs at least one score')
  const unitRange = circuit.ranges[unit]!
  invariant(unitRange.minimum === 1 && unitRange.maximum === 1, 'argmax unit must equal one')
  for (const score of scores) {
    const range = circuit.ranges[score]!
    invariant(range.minimum >= 0 && range.maximum <= 1, 'argmax scores must be within zero and one')
  }
  let level = scores.map((score, item): CascadeNode => ({score, item}))
  while (level.length > 1) {
    const next: CascadeNode[] = []
    for (let item = 0; item < level.length; item += 2) {
      const left = level[item]!
      const right = level[item + 1]
      if (right === undefined) {
        next.push(left)
        continue
      }
      const rightWins = emitCascadeGreaterBit(circuit, left.score, right.score, unit, options)
      const leftWins = circuit.affine([[rightWins, -1]], 1)
      circuit.assumeRange(leftWins, 0, 1)
      const leftPart = circuit.reglu([[left.score, 1]], 0, [[leftWins, 1]], 0)
      const rightPart = circuit.reglu([[right.score, 1]], 0, [[rightWins, 1]], 0)
      const score = circuit.affine([[leftPart, 1], [rightPart, 1]])
      circuit.assumeRange(score, 0, 1)
      next.push({score, leftWins, left, right})
    }
    level = next
  }
  const root = level[0]!
  const selected = Array<Wire>(scores.length)
  routeCascade(circuit, root, unit, selected)
  return {selected, score: root.score}
}

function routeCascade(circuit: Circuit, node: CascadeNode, route: Wire, selected: Wire[]) {
  if ('item' in node) {
    selected[node.item] = route
    return
  }
  const leftRoute = emitMultiply(circuit, route, node.leftWins)
  const rightRoute = circuit.affine([[route, 1], [leftRoute, -1]])
  circuit.assumeRange(rightRoute, 0, 1)
  routeCascade(circuit, node.left, leftRoute, selected)
  routeCascade(circuit, node.right, rightRoute, selected)
}

// ============================== measurement helpers ==============================

export type OpCounts = {
  operations: number
  affine: number
  reglu: number
  boolean: number
  layers: number
  storedWeights: number
}

export function circuitOpCounts(circuit: Circuit): OpCounts {
  let affine = 0
  let reglu = 0
  let booleanCount = 0
  let storedWeights = 0
  const depths = new Set<number>()
  for (const operation of circuit.operations) {
    if (operation.kind === 'affine') affine++
    else if (operation.kind === 'reglu') reglu++
    else booleanCount++
    storedWeights += operation.leftTerms.length + operation.gateTerms.length
    depths.add(operation.depth)
  }
  return {
    operations: circuit.operations.length,
    affine,
    reglu,
    boolean: booleanCount,
    layers: depths.size,
    storedWeights,
  }
}

// The leftmost index attaining the maximum: the tie rule both trees are meant to implement.
export function leftmostArgmax(scores: readonly number[]): number {
  let winner = 0
  for (let item = 1; item < scores.length; item++) {
    if (scores[item]! > scores[winner]!) winner = item
  }
  return winner
}

// ============================== shared build and run helpers ==============================

export type ArgmaxVariant = 'production' | 'cascade'

export type ArgmaxTree = {
  circuit: Circuit
  scoreWires: Wire[]
  unitWire: Wire
  selected: Wire[]
  scoreWire: Wire
}

// Candidate scores as source wires in [0, 1], plus the unit wire the routing needs.
export function buildArgmaxTree(candidateCount: number, variant: ArgmaxVariant, options?: CascadeOptions): ArgmaxTree {
  const circuit = new Circuit(candidateCount + 1)
  const scoreWires: Wire[] = []
  for (let item = 0; item < candidateCount; item++) {
    circuit.assumeRange(item, 0, 1)
    scoreWires.push(item)
  }
  const unitWire = candidateCount
  circuit.assumeRange(unitWire, 1, 1)
  const {selected, score} = variant === 'production'
    ? emitArgmax(circuit, scoreWires, unitWire)
    : emitCascadeArgmax(circuit, scoreWires, unitWire, options)
  circuit.tensorProgram = circuit.compileTensorProgram([...selected, score])
  return {circuit, scoreWires, unitWire, selected, scoreWire: score}
}

export type ArgmaxRun = {
  winner: number
  selectedValues: number[]
  exactOneHot: boolean
  score: number
}

export function runArgmaxTree(tree: ArgmaxTree, scores: readonly number[], backend: 'reference' | 'tensor'): ArgmaxRun {
  invariant(scores.length === tree.scoreWires.length, 'score count mismatch')
  const source = new Float32Array(tree.circuit.sourceSize)
  for (let item = 0; item < scores.length; item++) source[item] = scores[item]!
  source[tree.unitWire] = 1
  const values = backend === 'reference'
    ? tree.circuit.evaluateReference(source)
    : tree.circuit.evaluateTensor(source)
  const selectedValues = tree.selected.map(wire => values[wire]!)
  let winner = 0
  for (let item = 1; item < selectedValues.length; item++) {
    if (selectedValues[item]! > selectedValues[winner]!) winner = item
  }
  const exactOneHot = selectedValues.every((value, item) => value === (item === winner ? 1 : 0))
  return {winner, selectedValues, exactOneHot, score: values[tree.scoreWire]!}
}
