// Reusable constructions for hand-authoring UI circuits, plus measurement helpers.
// Every construction lowers into the three runtime atoms through the shared builder.
import {Circuit, invariant, type Terms, type Wire} from '../../../numeric-ui-core.ts'

export type Program = ReturnType<Circuit['compileTensorProgram']>
export type Matrix = [number, number, number, number]
export type WireMatrix = [Wire, Wire, Wire, Wire]

// ---------------------------------------------------------------------------
// Source table layout

export class SourceLayout {
  names: string[] = []
  minimums: number[] = []
  maximums: number[] = []

  add(name: string, minimum: number, maximum: number): Wire {
    this.names.push(name)
    this.minimums.push(minimum)
    this.maximums.push(maximum)
    return this.names.length - 1
  }

  get size() {
    return this.names.length
  }

  applyRanges(circuit: Circuit) {
    for (let wire = 0; wire < this.size; wire++) circuit.assumeRange(wire, this.minimums[wire]!, this.maximums[wire]!)
  }
}

// ---------------------------------------------------------------------------
// Sections: which part of the builder appended which operations, so the compiled
// program's live operations and stored weights can be attributed to UI features.

export class Sections {
  circuit: Circuit
  ranges: {name: string, start: number, end: number}[] = []

  constructor(circuit: Circuit) {
    this.circuit = circuit
  }

  run<T>(name: string, build: () => T): T {
    const start = this.circuit.operations.length
    const result = build()
    this.ranges.push({name, start, end: this.circuit.operations.length})
    return result
  }

  names() {
    return [...new Set(this.ranges.map(range => range.name))]
  }

  sectionOf(operationIndex: number) {
    for (const range of this.ranges) {
      if (operationIndex >= range.start && operationIndex < range.end) return range.name
    }
    return 'unattributed'
  }
}

export type ProgramStats = {
  liveOperations: number
  layers: number
  storedWeights: number
  regluOperations: number
  booleanOperations: number
  gatherReads: number
  widestLayer: number
}

export type SectionStats = {name: string, liveOperations: number, storedWeights: number, firstLayer: number, lastLayer: number}

export function measureProgram(circuit: Circuit, roots: readonly Wire[], sections?: Sections) {
  const program = circuit.compileTensorProgram(roots)
  const stats: ProgramStats = {
    liveOperations: program.valueCount - program.sourceSize,
    layers: program.layers.length,
    storedWeights: 0,
    regluOperations: 0,
    booleanOperations: 0,
    gatherReads: 0,
    widestLayer: 0,
  }
  const sectionByOperation = new Map<number, string>()
  if (sections !== undefined) {
    for (const range of sections.ranges) {
      for (let operation = range.start; operation < range.end; operation++) {
        if (!sectionByOperation.has(operation)) sectionByOperation.set(operation, range.name)
      }
    }
  }
  const bySection = new Map<string, SectionStats>()
  const record = (wire: Wire, weights: number, layerIndex: number, isOutputRow: boolean) => {
    const name = sectionByOperation.get(wire - program.sourceSize) ?? 'unattributed'
    let entry = bySection.get(name)
    if (entry === undefined) {
      entry = {name, liveOperations: 0, storedWeights: 0, firstLayer: layerIndex, lastLayer: layerIndex}
      bySection.set(name, entry)
    }
    if (isOutputRow) entry.liveOperations++
    entry.storedWeights += weights
    entry.firstLayer = Math.min(entry.firstLayer, layerIndex)
    entry.lastLayer = Math.max(entry.lastLayer, layerIndex)
  }
  let available = program.sourceSize
  program.layers.forEach((layer, layerIndex) => {
    stats.storedWeights += layer.weights.length
    stats.regluOperations += layer.gateRows.length
    stats.booleanOperations += layer.booleanRows.length
    stats.gatherReads += layer.gatherReads.length
    stats.widestLayer = Math.max(stats.widestLayer, layer.outputSize)
    for (let row = 0; row < layer.outputSize; row++) {
      const wire = program.wireOrder[available + row]!
      record(wire, layer.rowOffsets[row + 1]! - layer.rowOffsets[row]!, layerIndex + 1, true)
    }
    for (let gateIndex = 0; gateIndex < layer.gateRows.length; gateIndex++) {
      const row = layer.outputSize + gateIndex
      const wire = program.wireOrder[available + layer.gateRows[gateIndex]!]!
      record(wire, layer.rowOffsets[row + 1]! - layer.rowOffsets[row]!, layerIndex + 1, false)
    }
    available += layer.outputSize
  })
  return {program, stats, bySection: [...bySection.values()]}
}

// ---------------------------------------------------------------------------
// Comparisons on preserved differences
//
// A condition is `sign * difference > 0` (strict) or `>= 0`, where `difference` is a
// roundAffine wire, e.g. `roundAffine([[pointerX, 1], [boxLeft, -1]])`. Its score is
// `relu(2^40 * sign * difference + (strict ? 0 : 0.5))`: exactly 0 when the condition fails and
// at least 0.5 when it holds. Several scores combine in one saturating ReLU. The result is an
// exact 0/1 whenever each difference is zero or at least 2^-41 in magnitude, and there is no upper
// limit short of FP32 overflow, because the saturation `relu(1 - 2 * score)` never subtracts 1 from
// a large number (the `clamp01` hazard for values above 2^23 doesn't apply).

export const comparisonScale = 2 ** 40

export type Condition = {difference: Wire, sign: 1 | -1, strict: boolean}

export const atLeastZero = (difference: Wire): Condition => ({difference, sign: 1, strict: false})
export const aboveZero = (difference: Wire): Condition => ({difference, sign: 1, strict: true})
export const atMostZero = (difference: Wire): Condition => ({difference, sign: -1, strict: false})
export const belowZero = (difference: Wire): Condition => ({difference, sign: -1, strict: true})

function negateCondition(condition: Condition): Condition {
  return {difference: condition.difference, sign: condition.sign === 1 ? -1 : 1, strict: !condition.strict}
}

function conditionScore(circuit: Circuit, condition: Condition) {
  return circuit.reglu([], 1, [[condition.difference, condition.sign * comparisonScale]], condition.strict ? 0 : 0.5)
}

export type BitOptions = {
  // Exact 0/1 wires that must be 1 (for emitAll) or that also make the result 1 (for emitAny).
  bits?: readonly Wire[]
  // Exact 0/1 wires that must be 0 (emitAll only).
  forbidden?: readonly Wire[]
  // Round the result through a boolean atom. The result is already exact outside the 2^-41
  // band; the atom makes it an exact bit unconditionally, which one-hot declarations rely on.
  booleanAtom?: boolean
}

// 1 when every condition holds and every required bit is 1.
export function emitAll(circuit: Circuit, conditions: readonly Condition[], options: BitOptions = {}): Wire {
  const terms: [Wire, number][] = []
  let bias = 1
  for (const condition of conditions) terms.push([conditionScore(circuit, negateCondition(condition)), -2])
  for (const bit of options.bits ?? []) {
    terms.push([bit, 2])
    bias -= 2
  }
  for (const bit of options.forbidden ?? []) terms.push([bit, -2])
  const allHold = circuit.reglu([], 1, terms, bias)
  circuit.assumeRange(allHold, 0, 1)
  return options.booleanAtom === true ? circuit.boolean(allHold) : allHold
}

// 1 when any condition holds or any listed bit is 1.
export function emitAny(circuit: Circuit, conditions: readonly Condition[], options: BitOptions = {}): Wire {
  invariant(options.forbidden === undefined, 'emitAny does not take forbidden bits')
  const terms: [Wire, number][] = []
  for (const condition of conditions) terms.push([conditionScore(circuit, condition), -2])
  for (const bit of options.bits ?? []) terms.push([bit, -2])
  const noneHold = circuit.reglu([], 1, terms, 1)
  const anyHolds = circuit.affine([[noneHold, -1]], 1)
  circuit.assumeRange(anyHolds, 0, 1)
  return options.booleanAtom === true ? circuit.boolean(anyHolds) : anyHolds
}

// ---------------------------------------------------------------------------
// Integers

// [value >= 0] for an integer-valued affine form below 2^23 in magnitude, as the ramp
// relu(value + 1) - relu(value). Both ReLUs share one layer.
export function emitIntegerAtLeastZero(circuit: Circuit, terms: Terms, bias: number): Wire {
  const upper = circuit.reglu([], 1, terms, bias + 1)
  const lower = circuit.reglu([], 1, terms, bias)
  const bit = circuit.affine([[upper, 1], [lower, -1]])
  circuit.assumeRange(bit, 0, 1)
  return bit
}

// min(value, 1) for an integer-valued, non-negative wire: exact "is at least one" bit.
export function emitSaturateCount(circuit: Circuit, count: Wire): Wire {
  const bit = circuit.affine([[count, 1], [circuit.reglu([], 1, [[count, 1]], -1), -1]])
  circuit.assumeRange(bit, 0, 1)
  return bit
}

// The one-hot of an integer index in 0..count-1, built from shared ramps r_k = relu(index - k + 1):
// [index >= k] = r_k - r_(k+1) and member_k = r_k - 2 r_(k+1) + r_(k+2). It costs count - 2 ReLUs.
// With `present`, the index must be 0 when present is 0, and all members are then 0.
export function emitIndexOneHot(circuit: Circuit, index: Wire, count: number, present?: Wire) {
  invariant(count >= 2, 'an index one-hot needs at least two positions')
  const ramps: {terms: Terms, bias: number}[] = []
  for (let k = 0; k <= count + 1; k++) {
    if (k === 0) ramps.push({terms: [[index, 1]], bias: 1})
    else if (k === 1) ramps.push({terms: [[index, 1]], bias: 0})
    else if (k < count) ramps.push({terms: [[circuit.reglu([], 1, [[index, 1]], 1 - k), 1]], bias: 0})
    else ramps.push({terms: [], bias: 0})
  }
  const combine = (parts: [number, number][]) => {
    const terms: [Wire, number][] = []
    let bias = 0
    for (const [k, coefficient] of parts) {
      const ramp = ramps[k]!
      for (const [wire, weight] of ramp.terms) terms.push([wire, weight * coefficient])
      bias += ramp.bias * coefficient
    }
    return {terms, bias}
  }
  const atLeastCache = new Map<number, Wire>()
  const atLeast = (k: number): Wire => {
    const cached = atLeastCache.get(k)
    if (cached !== undefined) return cached
    let wire: Wire
    if (k <= 0) wire = present ?? circuit.affine([], 1)
    else if (k >= count) wire = circuit.affine([], 0)
    else {
      const {terms, bias} = combine([[k, 1], [k + 1, -1]])
      wire = circuit.affine(terms, bias)
      circuit.assumeRange(wire, 0, 1)
    }
    atLeastCache.set(k, wire)
    return wire
  }
  const members: Wire[] = []
  for (let k = 0; k < count; k++) {
    let member: Wire
    if (k === 0 && present !== undefined) {
      const {terms, bias} = combine([[1, -1], [2, 1]])
      member = circuit.affine([...terms, [present, 1]], bias)
    } else {
      const {terms, bias} = combine([[k, 1], [k + 1, -2], [k + 2, 1]])
      member = circuit.affine(terms, bias)
    }
    circuit.assumeRange(member, 0, 1)
    members.push(member)
  }
  circuit.assumeOneHot(members, present !== undefined)
  return {members, atLeast}
}

// ---------------------------------------------------------------------------
// Selection

// Σ member_i * candidate_i over a declared one-hot. The compiler lowers this sum to one indexed
// read, so the products store no weights and drop out of the compiled program.
export function emitGather(circuit: Circuit, members: readonly Wire[], candidates: readonly Wire[]): Wire {
  invariant(members.length === candidates.length, 'gather needs one candidate per member')
  return circuit.affine(members.map((member, index) => [circuit.multiply(member, candidates[index]!), 1] as const))
}

// value * bit for an exact 0/1 bit, as one ReGLU whose left side is the composed value.
export function emitGated(circuit: Circuit, terms: Terms, bias: number, bit: Wire): Wire {
  return circuit.reglu(terms, bias, [[bit, 1]], 0)
}

// AND of exact bits, optionally with negated bits: relu(Σ bits - Σ negated - (count - 1)).
export function emitAnd(circuit: Circuit, bits: readonly Wire[], negatedBits: readonly Wire[] = []): Wire {
  const result = circuit.reglu([], 1, [
    ...bits.map(bit => [bit, 1] as const),
    ...negatedBits.map(bit => [bit, -1] as const),
  ], 1 - bits.length)
  circuit.assumeRange(result, 0, 1)
  return result
}

// Exact select between two wires by a 0/1 gate, keeping both operands as rounding points.
export function emitSelectWire(circuit: Circuit, gate: Wire, off: Wire, on: Wire): Wire {
  return circuit.select(gate, off, on)
}

// min(a, b) = a - relu(a - b), composed into consumers.
export function emitMinimum(circuit: Circuit, a: Wire, b: Wire): Wire {
  return circuit.affine([[a, 1], [circuit.reglu([], 1, [[a, 1], [b, -1]], 0), -1]])
}

export function emitMinimumConstant(circuit: Circuit, a: Wire, constant: number): Wire {
  return circuit.affine([[a, 1], [circuit.reglu([], 1, [[a, 1]], -constant), -1]])
}

// max(a, b) = b + relu(a - b), composed into consumers.
export function emitMaximum(circuit: Circuit, a: Wire, b: Wire): Wire {
  return circuit.affine([[b, 1], [circuit.reglu([], 1, [[a, 1], [b, -1]], 0), 1]])
}

export function emitMaximumTree(circuit: Circuit, values: readonly Wire[]): Wire {
  invariant(values.length > 0, 'maximum of nothing')
  let level = [...values]
  while (level.length > 1) {
    const next: Wire[] = []
    for (let index = 0; index < level.length; index += 2) {
      const right = level[index + 1]
      next.push(right === undefined ? level[index]! : emitMaximum(circuit, level[index]!, right))
    }
    level = next
  }
  return level[0]!
}

// The first set bit among exact 0/1 candidates, gated by an exact bit, as a tournament with
// OR on the way up and routing on the way down: 2 * ceil(log2 n) layers and about 2n ReLUs.
// The library's emitFirstActive accepts fractional masses and pays a preserved maximum per node.
export function emitFirstSetBit(circuit: Circuit, gate: Wire, bits: readonly Wire[]): Wire[] {
  type Node = {mass: Wire, item: number} | {mass: Wire, left: Node, right: Node}
  let level: Node[] = bits.map((mass, item) => ({mass, item}))
  while (level.length > 1) {
    const next: Node[] = []
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!
      const right = level[index + 1]
      next.push(right === undefined ? left : {mass: emitMaximum(circuit, left.mass, right.mass), left, right})
    }
    level = next
  }
  const selected = Array<Wire>(bits.length)
  const route = (node: Node, routeWire: Wire) => {
    if ('item' in node) {
      selected[node.item] = routeWire
      return
    }
    const leftRoute = emitAnd(circuit, [routeWire, node.left.mass])
    const rightRoute = circuit.affine([[routeWire, 1], [leftRoute, -1]])
    circuit.assumeRange(rightRoute, 0, 1)
    route(node.left, leftRoute)
    route(node.right, rightRoute)
  }
  route(level[0]!, emitAnd(circuit, [gate, level[0]!.mass]))
  return selected
}

// ---------------------------------------------------------------------------
// Prefix sums

export type PrefixMode = 'triangle' | 'brent-kung'

// sums[k] = bias + step * k + Σ_(j<k) values[j], for k = 0..values.length.
// 'triangle' writes each output as its own roundAffine fold: one layer, n^2/2 weights.
// 'brent-kung' is the parallel scan: about 2n pair sums over 2 log2 n layers.
export function emitPrefixSums(circuit: Circuit, values: readonly Wire[], bias: number, step: number, mode: PrefixMode): Wire[] {
  const sums: Wire[] = []
  if (mode === 'triangle') {
    for (let k = 0; k <= values.length; k++) {
      sums.push(circuit.roundAffine(values.slice(0, k).map(value => [value, 1] as const), bias + step * k))
    }
    return sums
  }
  const inclusive = [...values]
  const count = values.length
  let span = 1
  for (; span < count; span *= 2) {
    for (let index = 2 * span - 1; index < count; index += 2 * span) {
      inclusive[index] = circuit.roundAffine([[inclusive[index - span]!, 1], [inclusive[index]!, 1]])
    }
  }
  for (span = span / 4; span >= 1; span /= 2) {
    for (let index = 3 * span - 1; index < count; index += 2 * span) {
      inclusive[index] = circuit.roundAffine([[inclusive[index - span]!, 1], [inclusive[index]!, 1]])
    }
  }
  for (let k = 0; k <= count; k++) {
    sums.push(k === 0 ? circuit.roundAffine([], bias) : circuit.roundAffine([[inclusive[k - 1]!, 1]], bias + step * k))
  }
  return sums
}

// ---------------------------------------------------------------------------
// Springs: fixed 4ms semi-implicit Euler steps as shared matrix powers

export type SpringConstants = {stiffness: number, damping: number, stepMilliseconds: number}

// On displacement x = pos - dest and velocity v, one step is v' = v + (-k x - b v) dt, x' = x + v' dt.
export function springStepMatrix({stiffness, damping, stepMilliseconds}: SpringConstants): Matrix {
  const dt = stepMilliseconds / 1000
  return [1 - stiffness * dt * dt, dt * (1 - damping * dt), -stiffness * dt, 1 - damping * dt]
}

export function multiplyMatrices(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3]]
}

export function matrixPower(matrix: Matrix, exponent: number): Matrix {
  let result: Matrix = [1, 0, 0, 1]
  let square = matrix
  for (let remaining = exponent; remaining > 0; remaining = Math.floor(remaining / 2)) {
    if (remaining % 2 === 1) result = multiplyMatrices(result, square)
    square = multiplyMatrices(square, square)
  }
  return result
}

export type StepMatrix = {
  matrix: WireMatrix
  leftover: Wire
  steps: Wire
  maximumSteps: number
  entryMinimums: Matrix
  entryMaximums: Matrix
}

// Splits `elapsed` milliseconds (0 <= elapsed < stepMs * base^digitCount) into whole steps and a
// leftover, digit by digit from the most significant: each digit is a count of `base - 1` exact
// threshold bits on the remaining time, and the remaining time drops by the digit's value
// (exact in FP32, because only multiples of powers of two are subtracted). Each digit selects a
// constant matrix power from a table through its one-hot members, and the shared matrix is the
// product of the digit matrices. The members are materialized so each entry's FP32 fold adds the
// selected table value once and zeros otherwise. Written over the threshold bits instead, the entry
// telescopes as T[0] + Σ bit_j (T[j] - T[j-1]), whose partial sums are of order 1, so a decayed power
// like M^224 (entries near 1e-6) would carry about 10% rounding error.
export function emitStepMatrix(
  circuit: Circuit,
  elapsed: Wire,
  constants: SpringConstants,
  options: {base?: number, digitCount?: number} = {},
): StepMatrix {
  const base = options.base ?? 16
  const digitCount = options.digitCount ?? 3
  const oneStep = springStepMatrix(constants)
  let remaining = elapsed
  const digitMatrices: WireMatrix[] = []
  const stepTerms: [Wire, number][] = []
  for (let digit = digitCount - 1; digit >= 0; digit--) {
    const stepsPerUnit = base ** digit
    const unitMilliseconds = constants.stepMilliseconds * stepsPerUnit
    const thresholdBits: Wire[] = []
    for (let value = 1; value < base; value++) {
      const difference = circuit.roundAffine([[remaining, 1]], -value * unitMilliseconds)
      thresholdBits.push(emitAll(circuit, [atLeastZero(difference)]))
    }
    const table = Array.from({length: base}, (_, value) => matrixPower(oneStep, value * stepsPerUnit))
    const members = Array.from({length: base}, (_, value) => {
      const terms: [Wire, number][] = []
      if (value > 0) terms.push([thresholdBits[value - 1]!, 1])
      if (value < base - 1) terms.push([thresholdBits[value]!, -1])
      const member = circuit.roundAffine(terms, value === 0 ? 1 : 0)
      circuit.assumeRange(member, 0, 1)
      return member
    })
    digitMatrices.push([0, 1, 2, 3].map(entry =>
      circuit.roundAffine(members.map((member, value) => [member, table[value]![entry]!] as const))) as WireMatrix)
    remaining = circuit.roundAffine([[remaining, 1], ...thresholdBits.map(bit => [bit, -unitMilliseconds] as const)])
    for (const bit of thresholdBits) stepTerms.push([bit, stepsPerUnit])
  }
  const multiplyWireMatrices = (a: WireMatrix, b: WireMatrix): WireMatrix => {
    const product = (left: Wire, right: Wire) => circuit.multiply(left, right)
    return [
      circuit.affine([[product(a[0], b[0]), 1], [product(a[1], b[2]), 1]]),
      circuit.affine([[product(a[0], b[1]), 1], [product(a[1], b[3]), 1]]),
      circuit.affine([[product(a[2], b[0]), 1], [product(a[3], b[2]), 1]]),
      circuit.affine([[product(a[2], b[1]), 1], [product(a[3], b[3]), 1]]),
    ]
  }
  let level = digitMatrices
  while (level.length > 1) {
    const next: WireMatrix[] = []
    for (let index = 0; index < level.length; index += 2) {
      const right = level[index + 1]
      next.push(right === undefined ? level[index]! : multiplyWireMatrices(level[index]!, right))
    }
    level = next
  }
  const maximumSteps = base ** digitCount - 1
  const entryMinimums: Matrix = [0, 0, 0, 0]
  const entryMaximums: Matrix = [0, 0, 0, 0]
  let power: Matrix = [1, 0, 0, 1]
  for (let steps = 0; steps <= maximumSteps; steps++) {
    for (let entry = 0; entry < 4; entry++) {
      entryMinimums[entry] = Math.min(entryMinimums[entry]!, power[entry]!)
      entryMaximums[entry] = Math.max(entryMaximums[entry]!, power[entry]!)
    }
    power = multiplyMatrices(power, oneStep)
  }
  const matrix = level[0]!
  for (let entry = 0; entry < 4; entry++) {
    circuit.assumeRange(matrix[entry]!, entryMinimums[entry]! - 1e-3, entryMaximums[entry]! + 1e-3)
  }
  return {matrix, leftover: remaining, steps: circuit.affine(stepTerms), maximumSteps, entryMinimums, entryMaximums}
}

// How each spring multiplies its state by the shared matrix entries m:
// - 'signed': x * m = x * relu(m) - x * relu(-m), two ReGLUs per product, rounding error ~ |m x| 2^-24.
// - 'offset': x * m = x * (m - c) + c * x with c a negative power of two below min(m), one ReGLU per
//   product. The two terms nearly cancel when m has decayed, so the rounding error is ~ |c x| 2^-23,
//   e.g. 0.05px/s of velocity noise for a 50,000px jump, which keeps springs above the 0.01 settle
//   threshold for extra frames.
export type SpringProducts = 'signed' | 'offset'

export type SpringBank = {
  products: SpringProducts
  entries: WireMatrix
  offsets: Matrix
}

export function emitSpringBank(circuit: Circuit, stepMatrix: StepMatrix, enabled: Wire, products: SpringProducts = 'signed'): SpringBank {
  const offsets = products === 'signed'
    ? [0, 0, 0, 0] as Matrix
    : stepMatrix.entryMinimums.map(minimum => minimum >= 0 ? 0 : -(2 ** Math.ceil(Math.log2(-minimum + 1e-3)))) as Matrix
  const entries = stepMatrix.matrix.map((entry, index) => {
    const gated = emitGated(circuit, [[entry, 1]], 0, enabled)
    circuit.assumeRange(gated, Math.min(0, stepMatrix.entryMinimums[index]! - 1e-3), stepMatrix.entryMaximums[index]! + 1e-3)
    if (products === 'signed') return gated
    const wire = circuit.roundAffine([[gated, 1]], -offsets[index]!)
    circuit.assumeRange(wire, 0, stepMatrix.entryMaximums[index]! - offsets[index]! + 1e-3)
    return wire
  }) as WireMatrix
  return {products, entries, offsets}
}

// One spring on its displacement from the destination: returns the next displacement, next velocity,
// and the exact "still animating" bit. Settling matches index.ts: the spring snaps to its
// destination (displacement and velocity become 0) when |x| < 0.01 and |v| < 0.01.
export function emitSpring(circuit: Circuit, bank: SpringBank, displacement: Wire, velocity: Wire) {
  const row = (first: number, second: number) => {
    const terms: [Wire, number][] = []
    for (const [value, entry] of [[displacement, first], [velocity, second]] as const) {
      const entryWire = bank.entries[entry]!
      terms.push([circuit.reglu([[value, 1]], 0, [[entryWire, 1]], 0), 1])
      if (bank.products === 'signed') terms.push([circuit.reglu([[value, 1]], 0, [[entryWire, -1]], 0), -1])
      else terms.push([value, bank.offsets[entry]!])
    }
    return circuit.affine(terms)
  }
  const nextDisplacement = row(0, 1)
  const nextVelocity = row(2, 3)
  const settleThreshold = 0.01
  const active = emitAny(circuit, [
    atLeastZero(circuit.roundAffine([[nextDisplacement, 1]], -settleThreshold)),
    atLeastZero(circuit.roundAffine([[nextDisplacement, -1]], -settleThreshold)),
    atLeastZero(circuit.roundAffine([[nextVelocity, 1]], -settleThreshold)),
    atLeastZero(circuit.roundAffine([[nextVelocity, -1]], -settleThreshold)),
  ])
  return {
    displacement: emitGated(circuit, [[nextDisplacement, 1]], 0, active),
    velocity: emitGated(circuit, [[nextVelocity, 1]], 0, active),
    active,
  }
}
