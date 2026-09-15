// An interpreter over codegen's flattened program steps, with accumulation
// modes that perturb how each row adds up its terms.
//
// The production executor computes every row as
//   value = bias, then value = fround(value + fround(weight * input)) per term,
// in stored term order. A GPU compiler, a framework sparse kernel, or a
// parallel prefix network may add the same terms in another order, fuse a
// product into the sum without rounding it first, or keep more precision. The
// modes below model those changes one at a time, and two modes keep the stored
// order only at rounding points: the rows whose own FP32 rounding decides a bit.
import type {Circuit, Wire} from '../../../numeric-ui-core.ts'
import {flattenProgram, type FlatProgram, type Step, type TensorProgram} from './copies/codegen/codegen.ts'

const f = Math.fround

export const modes = ['stored', 'reversed', 'balanced', 'fused', 'balancedFused', 'float64', 'roundingStrict', 'float64RoundingStrict'] as const
export type Mode = (typeof modes)[number]
export const perturbedModes: readonly Mode[] = modes.filter(mode => mode !== 'stored')

export const modeDescriptions: Record<Mode, string> = {
  stored: 'stored term order, every product and partial sum rounded to FP32 (the production executor)',
  reversed: 'terms added in reverse order',
  balanced: 'pairwise sums over bias and products, like a parallel prefix network',
  fused: 'each product added without rounding it first (fused multiply-add), stored order',
  balancedFused: 'pairwise sums whose first level fuses one product into each pair',
  float64: 'every value in float64, boolean atom as score >= 0.5, no rounding anywhere',
  roundingStrict: 'stored order at rounding points, balanced and fused everywhere else',
  float64RoundingStrict: 'stored FP32 order at rounding points (inputs rounded to FP32), float64 everywhere else',
}

// How one row adds up its terms.
export const rule = {stored: 0, reversed: 1, balanced: 2, fused: 3, balancedFused: 4, float64: 5, storedFromFloat64: 6} as const

const kindCode = {affine: 0, reglu: 1, boolean: 2, gather: 3} as const

export type PackedProgram = {
  flat: FlatProgram
  sourceSize: number
  valueCount: number
  rowCount: number
  gatherSlotCount: number
  // Execution order. An entry r >= 0 is row r; an entry -1 - k is gather compute k.
  steps: Int32Array
  kind: Uint8Array
  position: Int32Array
  bias: Float64Array
  gateBias: Float64Array
  leftStart: Int32Array
  leftEnd: Int32Array
  gateStart: Int32Array
  gateEnd: Int32Array
  weights: Float64Array
  inputs: Int32Array
  slot: Int32Array
  masked: Uint8Array
  candidateStart: Int32Array
  candidateEnd: Int32Array
  candidates: Int32Array
  computeSlot: Int32Array
  bitStart: Int32Array
  bitEnd: Int32Array
  bits: Int32Array
  maximumTerms: number
  // Row index of each packed position, or -1 for source cells.
  rowOfPosition: Int32Array
  storedWeights: number
}

export function packProgram(flat: FlatProgram): PackedProgram {
  const rows = flat.steps.flatMap(step => step.kind === 'row' ? [step.row] : [])
  const computes = flat.steps.flatMap(step => step.kind === 'gatherCompute' ? [step.compute] : [])
  const rowCount = rows.length
  let termCount = 0
  let candidateCount = 0
  let maximumTerms = 1
  for (const row of rows) {
    termCount += row.terms.length + row.gateTerms.length
    candidateCount += row.candidates.length
    maximumTerms = Math.max(maximumTerms, row.terms.length + 1, row.gateTerms.length + 1)
  }
  const packed: PackedProgram = {
    flat,
    sourceSize: flat.sourceSize,
    valueCount: flat.valueCount,
    rowCount,
    gatherSlotCount: flat.gatherSlotCount,
    steps: new Int32Array(flat.steps.length),
    kind: new Uint8Array(rowCount),
    position: new Int32Array(rowCount),
    bias: new Float64Array(rowCount),
    gateBias: new Float64Array(rowCount),
    leftStart: new Int32Array(rowCount),
    leftEnd: new Int32Array(rowCount),
    gateStart: new Int32Array(rowCount),
    gateEnd: new Int32Array(rowCount),
    weights: new Float64Array(termCount),
    inputs: new Int32Array(termCount),
    slot: new Int32Array(rowCount),
    masked: new Uint8Array(rowCount),
    candidateStart: new Int32Array(rowCount),
    candidateEnd: new Int32Array(rowCount),
    candidates: new Int32Array(candidateCount),
    computeSlot: new Int32Array(computes.length),
    bitStart: new Int32Array(computes.length),
    bitEnd: new Int32Array(computes.length),
    bits: new Int32Array(computes.reduce((total, compute) => total + compute.bits.length, 0)),
    maximumTerms,
    rowOfPosition: new Int32Array(flat.valueCount).fill(-1),
    storedWeights: flat.storedWeights,
  }
  let term = 0
  let candidate = 0
  rows.forEach((row, index) => {
    packed.kind[index] = kindCode[row.kind]
    packed.position[index] = row.position
    packed.rowOfPosition[row.position] = index
    packed.bias[index] = row.bias
    packed.gateBias[index] = row.gateBias
    packed.leftStart[index] = term
    for (const {weight, position} of row.terms) {
      packed.weights[term] = weight
      packed.inputs[term++] = position
    }
    packed.leftEnd[index] = term
    packed.gateStart[index] = term
    for (const {weight, position} of row.gateTerms) {
      packed.weights[term] = weight
      packed.inputs[term++] = position
    }
    packed.gateEnd[index] = term
    packed.slot[index] = row.slot
    packed.masked[index] = row.masked ? 1 : 0
    packed.candidateStart[index] = candidate
    for (const position of row.candidates) packed.candidates[candidate++] = position
    packed.candidateEnd[index] = candidate
  })
  let bit = 0
  computes.forEach((compute, index) => {
    packed.computeSlot[index] = compute.slot
    packed.bitStart[index] = bit
    for (const position of compute.bits) packed.bits[bit++] = position
    packed.bitEnd[index] = bit
  })
  let rowIndex = 0
  let computeIndex = 0
  flat.steps.forEach((step, index) => {
    packed.steps[index] = step.kind === 'row' ? rowIndex++ : -1 - computeIndex++
  })
  return packed
}

export function compilePacked(circuit: Circuit, roots?: readonly Wire[]): {program: TensorProgram, packed: PackedProgram} {
  const program = circuit.compileTensorProgram(roots)
  return {program, packed: packProgram(flattenProgram(program))}
}

// Exact FP32 rounding of addend + weight · input, as a fused multiply-add
// followed by one rounding to FP32 would give. The double product of two FP32
// values is exact (48 significant bits). The double sum can round, but TwoSum
// recovers its error, and the error only changes the FP32 result when the
// double sum sits exactly on a midpoint between two FP32 values.
export function fusedMultiplyAdd32(addend: number, weight: number, input: number): number {
  const product = weight * input
  const sum = addend + product
  const rounded = f(sum)
  if (rounded === sum || !Number.isFinite(sum)) return rounded
  const productPart = sum - addend
  const error = (addend - (sum - productPart)) + (product - productPart)
  if (error === 0) return rounded
  const mirror = 2 * sum - rounded
  if (f(mirror) === mirror && (error > 0) === (sum > rounded)) return mirror
  return rounded
}

export type Workspace = {
  values: Float64Array
  gatherIndex: Int32Array
  gatherMass: Float64Array
  scratch: Float64Array
}

export function createWorkspace(packed: PackedProgram): Workspace {
  return {
    values: new Float64Array(packed.valueCount),
    gatherIndex: new Int32Array(Math.max(1, packed.gatherSlotCount)),
    gatherMass: new Float64Array(Math.max(1, packed.gatherSlotCount)),
    scratch: new Float64Array(packed.maximumTerms + 1),
  }
}

function accumulate(ruleCode: number, bias: number, start: number, end: number, packed: PackedProgram, values: Float64Array, scratch: Float64Array): number {
  const {weights, inputs} = packed
  switch (ruleCode) {
    case rule.stored: {
      let total = f(bias)
      for (let term = start; term < end; term++) total = f(total + f(weights[term]! * values[inputs[term]!]!))
      return total
    }
    case rule.reversed: {
      let total = f(bias)
      for (let term = end - 1; term >= start; term--) total = f(total + f(weights[term]! * values[inputs[term]!]!))
      return total
    }
    case rule.fused: {
      let total = f(bias)
      for (let term = start; term < end; term++) total = fusedMultiplyAdd32(total, weights[term]!, values[inputs[term]!]!)
      return total
    }
    case rule.float64: {
      let total = bias
      for (let term = start; term < end; term++) total += weights[term]! * values[inputs[term]!]!
      return total
    }
    case rule.storedFromFloat64: {
      let total = f(bias)
      for (let term = start; term < end; term++) total = f(total + f(weights[term]! * f(values[inputs[term]!]!)))
      return total
    }
    case rule.balanced:
    case rule.balancedFused: {
      // Leaves are the bias and each term; the first level pairs (bias, term 0),
      // (term 1, term 2), and so on.
      let count = 0
      if (ruleCode === rule.balanced) {
        scratch[count++] = f(bias)
        for (let term = start; term < end; term++) scratch[count++] = f(weights[term]! * values[inputs[term]!]!)
      } else {
        let term = start
        scratch[count++] = term < end ? fusedMultiplyAdd32(f(bias), weights[term]!, values[inputs[term++]!]!) : f(bias)
        for (; term + 1 < end; term += 2) {
          scratch[count++] = fusedMultiplyAdd32(f(weights[term]! * values[inputs[term]!]!), weights[term + 1]!, values[inputs[term + 1]!]!)
        }
        if (term < end) scratch[count++] = f(weights[term]! * values[inputs[term]!]!)
      }
      while (count > 1) {
        let next = 0
        for (let index = 0; index + 1 < count; index += 2) scratch[next++] = f(scratch[index]! + scratch[index + 1]!)
        if (count % 2 === 1) scratch[next++] = scratch[count - 1]!
        count = next
      }
      return scratch[0]!
    }
  }
  throw new Error(`unknown rule ${ruleCode}`)
}

// Evaluate every step, or only the listed step entries (for instance programs).
export function evaluate(packed: PackedProgram, rules: Uint8Array, source: ArrayLike<number>, workspace: Workspace, steps: Int32Array = packed.steps): Float64Array {
  const {values, gatherIndex, gatherMass, scratch} = workspace
  if (steps === packed.steps) for (let cell = 0; cell < packed.sourceSize; cell++) values[cell] = source[cell]!
  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex]!
    if (step < 0) {
      const compute = -1 - step
      let index = 0
      let mass = 0
      const start = packed.bitStart[compute]!
      for (let bit = start; bit < packed.bitEnd[compute]!; bit++) {
        const value = values[packed.bits[bit]!]!
        index += (bit - start) * value
        mass += value
      }
      gatherIndex[packed.computeSlot[compute]!] = index
      gatherMass[packed.computeSlot[compute]!] = mass
      continue
    }
    const row = step
    const ruleCode = rules[row]!
    const float64 = ruleCode === rule.float64
    let value: number
    switch (packed.kind[row]) {
      case kindCode.affine:
        value = accumulate(ruleCode, packed.bias[row]!, packed.leftStart[row]!, packed.leftEnd[row]!, packed, values, scratch)
        break
      case kindCode.reglu: {
        const left = accumulate(ruleCode, packed.bias[row]!, packed.leftStart[row]!, packed.leftEnd[row]!, packed, values, scratch)
        const gate = accumulate(ruleCode, packed.gateBias[row]!, packed.gateStart[row]!, packed.gateEnd[row]!, packed, values, scratch)
        value = float64 ? left * Math.max(0, gate) : f(left * Math.max(0, gate))
        break
      }
      case kindCode.boolean: {
        const score = accumulate(ruleCode, packed.bias[row]!, packed.leftStart[row]!, packed.leftEnd[row]!, packed, values, scratch)
        value = float64 ? (score >= 0.5 ? 1 : 0) : f(f(f(score) + 8_388_609) - 8_388_609)
        break
      }
      default: {
        const start = packed.candidateStart[row]!
        const limit = packed.candidateEnd[row]! - start - 1
        const slot = packed.slot[row]!
        const selectedIndex = Math.min(Math.max(gatherIndex[slot]!, 0), limit)
        let selected = values[packed.candidates[start + selectedIndex]!]!
        if (float64) {
          value = packed.bias[row]! + (packed.masked[row] === 1 ? gatherMass[slot]! * selected : selected)
        } else {
          if (ruleCode === rule.storedFromFloat64) selected = f(selected)
          const contribution = packed.masked[row] === 1 ? f(f(gatherMass[slot]!) * selected) : selected
          value = f(packed.bias[row]! + contribution)
        }
      }
    }
    values[packed.position[row]!] = value
  }
  return values
}

// ----- Rounding points -----

export type RoundingPoints = {
  // Per row: 1 when the row keeps stored order in the rounding-strict modes.
  isRoundingPoint: Uint8Array
  roundingPointRows: number
  seeds: {booleanAtoms: number, roundChains: number, signTests: number}
  // Rows whose result can change under reordering or fusion: three or more
  // addends counting a nonzero bias, or two or more addends with a weight that
  // isn't a power of two.
  orderSensitiveRows: number
  orderSensitiveRoundingPoints: number
}

function isPowerOfTwo(value: number) {
  const magnitude = Math.abs(value)
  return magnitude > 0 && 2 ** Math.round(Math.log2(magnitude)) === magnitude
}

function sideIsOrderSensitive(packed: PackedProgram, bias: number, start: number, end: number) {
  const addends = (bias !== 0 ? 1 : 0) + (end - start)
  if (addends >= 3) return true
  if (addends < 2) return false
  for (let term = start; term < end; term++) if (!isPowerOfTwo(packed.weights[term]!)) return true
  return false
}

export function isOrderSensitive(packed: PackedProgram, row: number) {
  if (packed.kind[row] === kindCode.gather) return false
  return sideIsOrderSensitive(packed, packed.bias[row]!, packed.leftStart[row]!, packed.leftEnd[row]!)
    || sideIsOrderSensitive(packed, packed.gateBias[row]!, packed.gateStart[row]!, packed.gateEnd[row]!)
}

// Rounding points recovered from the compiled rows and the builder's metadata.
// Seeds are the rows where FP32 rounding turns a value into a decision:
// - boolean atoms,
// - round and floor chains: a roundAffine row whose bias is between 2^22 and
//   2^24, e.g. (x + 2^23 + 2^22) and the row that subtracts it again,
// - sign tests that aren't boolean atoms: a ReLU of one runtime value scaled by
//   a power of two of at least 2^8, e.g. gallery's relu(2^40 · difference + 0.5).
// From each seed the walk goes back through rows with one runtime input (scales
// and clamp stages) and through clamp shapes (every runtime input is a ReLU),
// marking each row, and stops after marking the first row that combines several
// runtime values: the comparison difference. Source cells whose declared range
// is a single value (e.g. unit = 1) count as constants.
export function findRoundingPoints(circuit: Circuit, packed: PackedProgram): RoundingPoints {
  const isRoundingPoint = new Uint8Array(packed.rowCount)
  const seeds = {booleanAtoms: 0, roundChains: 0, signTests: 0}
  const isConstantSource = (position: number) => {
    if (position >= packed.sourceSize) return false
    const range = circuit.ranges[position]!
    return range.minimum === range.maximum
  }
  const runtimeInputs = (row: number) => {
    const inputs = new Set<number>()
    if (packed.kind[row] === kindCode.gather) {
      for (let candidate = packed.candidateStart[row]!; candidate < packed.candidateEnd[row]!; candidate++) inputs.add(packed.candidates[candidate]!)
      inputs.add(-1)
      return [...inputs]
    }
    for (let term = packed.leftStart[row]!; term < packed.gateEnd[row]!; term++) {
      const position = packed.inputs[term]!
      if (!isConstantSource(position)) inputs.add(position)
    }
    return [...inputs]
  }
  const isRelu = (row: number) => packed.kind[row] === kindCode.reglu && packed.leftStart[row] === packed.leftEnd[row] && packed.bias[row] === 1
  const pending: number[] = []
  const visit = (row: number) => {
    if (isRoundingPoint[row] === 1) return
    isRoundingPoint[row] = 1
    pending.push(row)
  }
  const operationOf = (row: number) => circuit.operations[packed.flat.wireOrder[packed.position[row]!]! - circuit.sourceSize]!
  for (let row = 0; row < packed.rowCount; row++) {
    const kind = packed.kind[row]
    if (kind === kindCode.boolean) {
      seeds.booleanAtoms++
      visit(row)
    } else if (kind === kindCode.affine && operationOf(row).preserveRounding === true && Math.abs(packed.bias[row]!) >= 2 ** 22 && Math.abs(packed.bias[row]!) <= 2 ** 24) {
      seeds.roundChains++
      visit(row)
    } else if (isRelu(row)) {
      const inputs = runtimeInputs(row)
      if (inputs.length !== 1) continue
      let scale = 0
      for (let term = packed.gateStart[row]!; term < packed.gateEnd[row]!; term++) {
        if (packed.inputs[term] === inputs[0]) scale += packed.weights[term]!
      }
      if (isPowerOfTwo(scale) && Math.abs(scale) >= 2 ** 8) {
        seeds.signTests++
        visit(row)
      }
    }
  }
  while (pending.length > 0) {
    const row = pending.pop()!
    const inputs = runtimeInputs(row)
    const inputRows = inputs.map(position => position < 0 ? -1 : packed.rowOfPosition[position]!)
    if (inputs.length === 1 && inputRows[0]! >= 0) {
      visit(inputRows[0]!)
    } else if (inputs.length >= 2 && inputRows.every(inputRow => inputRow >= 0 && isRelu(inputRow))) {
      for (const inputRow of inputRows) visit(inputRow)
    }
  }
  let roundingPointRows = 0
  let orderSensitiveRows = 0
  let orderSensitiveRoundingPoints = 0
  for (let row = 0; row < packed.rowCount; row++) {
    const sensitive = isOrderSensitive(packed, row)
    if (isRoundingPoint[row] === 1) roundingPointRows++
    if (sensitive) orderSensitiveRows++
    if (sensitive && isRoundingPoint[row] === 1) orderSensitiveRoundingPoints++
  }
  return {isRoundingPoint, roundingPointRows, seeds, orderSensitiveRows, orderSensitiveRoundingPoints}
}

export function rulesFor(mode: Mode, points: RoundingPoints): Uint8Array {
  const rules = new Uint8Array(points.isRoundingPoint.length)
  const uniform = (code: number) => rules.fill(code)
  switch (mode) {
    case 'stored': return uniform(rule.stored)
    case 'reversed': return uniform(rule.reversed)
    case 'balanced': return uniform(rule.balanced)
    case 'fused': return uniform(rule.fused)
    case 'balancedFused': return uniform(rule.balancedFused)
    case 'float64': return uniform(rule.float64)
    case 'roundingStrict':
      points.isRoundingPoint.forEach((point, row) => { rules[row] = point === 1 ? rule.stored : rule.balancedFused })
      return rules
    case 'float64RoundingStrict':
      points.isRoundingPoint.forEach((point, row) => { rules[row] = point === 1 ? rule.storedFromFloat64 : rule.float64 })
      return rules
  }
}

// A compiled program with its rounding points and one rule table per mode.
export type ModeProgram = {
  program: TensorProgram
  packed: PackedProgram
  points: RoundingPoints
  rules: Record<Mode, Uint8Array>
}

export function prepareModeProgram(circuit: Circuit, program: TensorProgram): ModeProgram {
  const packed = packProgram(flattenProgram(program))
  const points = findRoundingPoints(circuit, packed)
  const rules = Object.fromEntries(modes.map(mode => [mode, rulesFor(mode, points)])) as Record<Mode, Uint8Array>
  return {program, packed, points, rules}
}

// ----- Replacing a circuit's evaluators -----

export type EvaluationCall = {
  circuit: Circuit
  modeProgram: ModeProgram
  source: Float32Array
  // Packed values of this evaluation, in the session's mode.
  values: Float64Array
  workspace: Workspace
}

export type InterpreterSession = {
  mode: Mode
  onEvaluate?: (call: EvaluationCall) => void
}

const modeProgramCache = new WeakMap<Circuit, Map<string, ModeProgram>>()

// Replace createTensorEvaluator and evaluateTensor on one Circuit instance, so an
// app built on the production runtime runs through this interpreter in the
// session's mode. Source ranges aren't validated: a perturbed mode may drive
// state out of its declared range, and the measurement counts that instead.
// restore() puts the production evaluators back.
export function installInterpreter(circuit: Circuit, session: InterpreterSession) {
  const saved = {createTensorEvaluator: circuit.createTensorEvaluator, evaluateTensor: circuit.evaluateTensor}
  const original = {
    createTensorEvaluator: saved.createTensorEvaluator.bind(circuit),
    evaluateTensor: saved.evaluateTensor.bind(circuit),
  }
  let compiledByKey = modeProgramCache.get(circuit)
  if (compiledByKey === undefined) {
    compiledByKey = new Map()
    modeProgramCache.set(circuit, compiledByKey)
  }
  const cache = compiledByKey
  const modeProgramFor = (roots: readonly Wire[] | undefined, program?: TensorProgram) => {
    const key = roots === undefined ? '*' : roots.join(',')
    let compiled = cache.get(key)
    if (compiled === undefined) {
      compiled = prepareModeProgram(circuit, program ?? circuit.compileTensorProgram(roots))
      cache.set(key, compiled)
    }
    return compiled
  }
  circuit.createTensorEvaluator = (roots: readonly Wire[]) => {
    const modeProgram = modeProgramFor(roots)
    const workspace = createWorkspace(modeProgram.packed)
    const positions = Int32Array.from(roots, root => modeProgram.packed.flat.positionOfWire[root]!)
    const outputs = new Float32Array(roots.length)
    return (source: Float32Array) => {
      const values = evaluate(modeProgram.packed, modeProgram.rules[session.mode], source, workspace)
      for (let index = 0; index < positions.length; index++) outputs[index] = values[positions[index]!]!
      session.onEvaluate?.({circuit, modeProgram, source, values, workspace})
      return outputs
    }
  }
  circuit.evaluateTensor = (source: Float32Array) => {
    const program = circuit.tensorProgram ??= circuit.compileTensorProgram()
    const modeProgram = modeProgramFor([...program.roots], program)
    const workspace = createWorkspace(modeProgram.packed)
    const values = evaluate(modeProgram.packed, modeProgram.rules[session.mode], source, workspace)
    const byWire = new Float32Array(program.width)
    const {wireOrder} = modeProgram.packed.flat
    for (let position = 0; position < modeProgram.packed.valueCount; position++) byWire[wireOrder[position]!] = values[position]!
    session.onEvaluate?.({circuit, modeProgram, source, values, workspace})
    return byWire
  }
  return {
    original,
    modeProgramFor,
    restore() {
      circuit.createTensorEvaluator = saved.createTensorEvaluator
      circuit.evaluateTensor = saved.evaluateTensor
    },
  }
}

export type {Step}
