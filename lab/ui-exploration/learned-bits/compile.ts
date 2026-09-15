// Compiles hardened networks and authored constructions into numeric-ui-core
// circuits, measures them, and checks every case with the tensor evaluator.

import {Circuit, type Wire} from '../../../numeric-ui-core.ts'
import {evaluateHard, gateCoefficients, SourceMode, type HardNetwork} from './network.ts'
import {dragSlop, hitRectangle, type Task} from './tasks.ts'

type Term = readonly [wire: Wire, coefficient: number]

export type ProgramMeasure = {
  liveOperations: number
  affine: number
  reglu: number
  boolean: number
  layers: number
  weights: number
  widestLayer: number
}

// Copied from input/kit.ts's measureProgram.
export function measureProgram(circuit: Circuit, roots: readonly Wire[]): ProgramMeasure {
  const program = circuit.compileTensorProgram(roots)
  const counts = {affine: 0, reglu: 0, boolean: 0}
  for (let position = circuit.sourceSize; position < program.wireOrder.length; position++) {
    counts[circuit.operations[program.wireOrder[position]! - circuit.sourceSize]!.kind]++
  }
  return {
    liveOperations: program.wireOrder.length - circuit.sourceSize,
    ...counts,
    layers: program.layers.length,
    weights: program.layers.reduce((total, layer) => total + layer.weights.length, 0),
    widestLayer: Math.max(0, ...program.layers.map(layer => layer.outputSize)),
  }
}

function termRange(circuit: Circuit, terms: readonly Term[], bias = 0) {
  let minimum = bias
  let maximum = bias
  for (const [wire, coefficient] of terms) {
    const range = circuit.ranges[wire]!
    if (coefficient > 0) {
      minimum += coefficient * range.minimum
      maximum += coefficient * range.maximum
    } else {
      minimum += coefficient * range.maximum
      maximum += coefficient * range.minimum
    }
  }
  return {minimum, maximum}
}

// The exact bit [Σ terms >= threshold] for an integer-valued sum s, written as
// relu(s - t + 1) - relu(s - t). A relu is left out when the declared ranges
// show it never clips: e.g. an AND over k bits (t = k) never needs the lower
// relu, and an OR (t = 1) never needs the upper one. So an AND, an OR, or "x
// and none of these" is one ReLU row, and a k-of-n threshold is two.
export function countingBit(circuit: Circuit, terms: readonly Term[], threshold: number): Wire {
  const {minimum, maximum} = termRange(circuit, terms)
  if (maximum < threshold) return circuit.affine([], 0)
  if (minimum >= threshold) return circuit.affine([], 1)
  const upper = minimum >= threshold - 1 ? circuit.affine(terms, 1 - threshold) : circuit.reglu([], 1, terms, 1 - threshold)
  const parts: Term[] = [[upper, 1]]
  if (maximum > threshold) parts.push([circuit.reglu([], 1, terms, -threshold), -1])
  const bit = circuit.affine(parts)
  circuit.assumeRange(bit, 0, 1)
  return bit
}

// A 2-input function of bits: c0 + c1 a + c2 b + c3 ab, with ab = relu(a + b - 1).
function gateWire(circuit: Circuit, functionIndex: number, a: Wire, b: Wire): Wire {
  const [c0, c1, c2, c3] = gateCoefficients[functionIndex]!
  const terms: Term[] = []
  if (c1 !== 0) terms.push([a, c1])
  if (c2 !== 0) terms.push([b, c2])
  if (c3 !== 0) {
    const constantA = circuit.constants[a]
    const constantB = circuit.constants[b]
    if (a === b) terms.push([a, c3])
    else if (constantA !== undefined) terms.push([b, c3 * constantA])
    else if (constantB !== undefined) terms.push([a, c3 * constantB])
    else {
      const product = circuit.reglu([], 1, [[a, 1], [b, 1]], -1)
      circuit.assumeRange(product, 0, 1)
      terms.push([product, c3])
    }
  }
  const wire = circuit.affine(terms, c0)
  circuit.assumeRange(wire, 0, 1)
  return wire
}

export function compileHardNetwork(hard: HardNetwork, task: Task) {
  const circuit = new Circuit(task.inputCount)
  for (let wire = 0; wire < task.inputCount; wire++) circuit.assumeRange(wire, 0, 1)
  const wires: Wire[] = new Array<Wire>(hard.wireCount)
  for (let wire = 0; wire < hard.sourceCount; wire++) {
    const mode = hard.sourceMode[wire]!
    const input = hard.sourceInput[wire]!
    if (mode === SourceMode.input) {
      wires[wire] = input
    } else if (mode === SourceMode.complement) {
      const complement = circuit.affine([[input, -1]], 1)
      circuit.assumeRange(complement, 0, 1)
      wires[wire] = complement
    } else {
      wires[wire] = circuit.affine([], mode === SourceMode.one ? 1 : 0)
    }
  }
  for (const layer of hard.layers) {
    const read = (index: number) => wires[layer.wires[index]!]!
    for (let unit = 0; unit < layer.width; unit++) {
      if (hard.kind === 'gate') {
        wires[layer.offset + unit] = gateWire(circuit, layer.gates[unit]!, read(2 * unit), read(2 * unit + 1))
        continue
      }
      const terms: Term[] = []
      for (let k = 0; k < layer.fanIn; k++) {
        const weight = layer.weights[unit * layer.fanIn + k]!
        if (weight !== 0) terms.push([read(unit * layer.fanIn + k), weight])
      }
      wires[layer.offset + unit] = countingBit(circuit, terms, layer.thresholds[unit]!)
    }
  }
  const last = hard.layers[hard.layers.length - 1]!
  const roots = Array.from({length: task.outputCount}, (_, bit) => {
    if (hard.groupSize === 1) return wires[last.offset + bit]!
    const members: Term[] = Array.from({length: hard.groupSize}, (_, member) => [wires[last.offset + bit * hard.groupSize + member]!, 1] as const)
    return countingBit(circuit, members, Math.ceil(hard.groupSize / 2))
  })
  return {circuit, roots}
}

// Evaluates the circuit on every case with the tensor evaluator. `exact` counts
// cases whose output bits all equal the oracle's. When a hardened netlist is
// given, `agreesWithNetlist` counts cases whose outputs equal the JS netlist's.
export function certifyCircuit(circuit: Circuit, roots: readonly Wire[], task: Task, hard: HardNetwork | null = null) {
  const evaluate = circuit.createTensorEvaluator(roots)
  const netlist = hard === null ? null : evaluateHard(hard, task, null).outputs
  const source = new Float32Array(task.inputCount)
  let exact = 0
  let agreesWithNetlist = 0
  let firstMismatch = -1
  for (let caseIndex = 0; caseIndex < task.caseCount; caseIndex++) {
    for (let input = 0; input < task.inputCount; input++) source[input] = task.inputs[caseIndex * task.inputCount + input]!
    const values = evaluate(source)
    let matchesOracle = true
    let matchesNetlist = true
    for (let bit = 0; bit < task.outputCount; bit++) {
      const value = values[bit]!
      if (value !== task.targets[caseIndex * task.outputCount + bit]) matchesOracle = false
      if (netlist !== null && value !== netlist[caseIndex * task.outputCount + bit]) matchesNetlist = false
    }
    if (matchesOracle) exact++
    else if (firstMismatch === -1) firstMismatch = caseIndex
    if (netlist !== null && matchesNetlist) agreesWithNetlist++
  }
  return {exact, total: task.caseCount, firstMismatch, agreesWithNetlist: netlist === null ? null : agreesWithNetlist}
}

// ---------------------------------------------------------------------------
// Authored constructions, over the same input bits as the tasks.

type BitKit = {
  atLeast: (terms: readonly Term[], threshold: number) => Wire
  bitAffine: (terms: readonly Term[], bias?: number) => Wire
  declareOneHot: (members: readonly Wire[]) => void
}

// input/kit.ts's atLeast, bitAffine, and declareOneHot, copied: atLeast always
// builds both relus.
function inputKit(circuit: Circuit): BitKit {
  const bitAffine = (terms: readonly Term[], bias = 0) => {
    const wire = circuit.affine(terms, bias)
    circuit.assumeRange(wire, 0, 1)
    return wire
  }
  return {
    bitAffine,
    atLeast: (terms, threshold) => {
      const upper = circuit.reglu([], 1, terms, 1 - threshold)
      const lower = circuit.reglu([], 1, terms, -threshold)
      const gateRange = termRange(circuit, terms, 1 - threshold)
      const large = !(Math.max(Math.abs(gateRange.minimum), Math.abs(gateRange.maximum)) <= 2 ** 19)
      const bit = large ? circuit.roundAffine([[upper, 1], [lower, -1]]) : circuit.affine([[upper, 1], [lower, -1]])
      circuit.assumeRange(bit, 0, 1)
      return bit
    },
    declareOneHot: members => {
      if (members.length < 2 || new Set(members).size !== members.length) return
      for (const member of members) if (circuit.constants[member] !== undefined) return
      circuit.assumeOneHot(members, true)
    },
  }
}

function countingKit(circuit: Circuit): BitKit {
  return {
    ...inputKit(circuit),
    atLeast: (terms, threshold) => countingBit(circuit, terms, threshold),
  }
}

const sum = (wires: readonly Wire[]): Term[] => wires.map(wire => [wire, 1] as const)
const negated = (terms: readonly Term[]): Term[] => terms.map(([wire, coefficient]) => [wire, -coefficient] as const)

// input/keyboard.ts's cyclicNextAvailable, copied, over an injected kit.
function cyclicNextAvailable(kit: BitKit, current: readonly Wire[], available: readonly Wire[], backward: boolean): Wire[] {
  if (backward) return cyclicNextAvailable(kit, [...current].reverse(), [...available].reverse(), false).reverse()
  const count = current.length
  const candidateAfter = available.map((bit, index) => kit.atLeast([[bit, 1], ...sum(current.slice(0, index))], 2))
  const firstAfter = candidateAfter.map((bit, index) => kit.atLeast([[bit, 1], ...negated(sum(candidateAfter.slice(0, index)))], 1))
  const anyAfter = kit.bitAffine(sum(firstAfter))
  const firstOverall = available.map((bit, index) => kit.atLeast([[bit, 1], ...negated(sum(available.slice(0, index)))], 1))
  const result = Array.from({length: count}, (_, index) => kit.bitAffine([
    [firstAfter[index]!, 1],
    [kit.atLeast([[firstOverall[index]!, 1], [anyAfter, -1]], 1), 1],
  ]))
  kit.declareOneHot(result)
  return result
}

function inputCircuit(task: Task) {
  const circuit = new Circuit(task.inputCount)
  for (let wire = 0; wire < task.inputCount; wire++) circuit.assumeRange(wire, 0, 1)
  return circuit
}

export type AuthoredForm = 'input-kit' | 'counting'

export function authoredTab(task: Task, form: AuthoredForm) {
  const controls = task.outputCount
  const circuit = inputCircuit(task)
  const focus = Array.from({length: controls}, (_, index) => index)
  const enabled = Array.from({length: controls}, (_, index) => controls + index)
  const shift = 2 * controls
  circuit.assumeOneHot(focus, true)
  const kit = form === 'input-kit' ? inputKit(circuit) : countingKit(circuit)
  const forward = cyclicNextAvailable(kit, focus, enabled, false)
  const backward = cyclicNextAvailable(kit, focus, enabled, true)
  // input's scratch baseline selects on Shift with circuit.select; the counting
  // form selects with two counting bits, [forward - shift >= 1] + [backward + shift >= 2].
  const roots = form === 'input-kit'
    ? forward.map((bit, index) => circuit.select(shift, bit, backward[index]!))
    : forward.map((bit, index) => kit.bitAffine([[countingBit(circuit, [[bit, 1], [shift, -1]], 1), 1], [countingBit(circuit, [[backward[index]!, 1], [shift, 1]], 2), 1]]))
  return {circuit, roots}
}

export function authoredFirstActive(task: Task) {
  const circuit = inputCircuit(task)
  const roots = Array.from({length: task.outputCount}, (_, index) => countingBit(circuit, [[index, 1], ...negated(sum(Array.from({length: index}, (_, earlier) => earlier)))], 1))
  return {circuit, roots}
}

// Integer arithmetic over the bits: x = Σ 2^k bits, then comparisons and an AND.
export function authoredRectangleHit(task: Task) {
  const circuit = inputCircuit(task)
  const bits = task.inputCount / 2
  const value = (offset: number): Term[] => Array.from({length: bits}, (_, index) => [offset + index, 2 ** (bits - 1 - index)] as const)
  const x = value(0)
  const y = value(bits)
  const right = hitRectangle.left + hitRectangle.width
  const bottom = hitRectangle.top + hitRectangle.height
  const inside = countingBit(circuit, [
    [countingBit(circuit, x, hitRectangle.left + 1), 1],
    [countingBit(circuit, negated(x), 1 - right), 1],
    [countingBit(circuit, y, hitRectangle.top + 1), 1],
    [countingBit(circuit, negated(y), 1 - bottom), 1],
  ], 4)
  return {circuit, roots: [inside]}
}

// Two's complement deltas as signed sums, then four comparisons and an OR.
export function authoredDrag(task: Task) {
  const circuit = inputCircuit(task)
  const bits = task.inputCount / 2
  const value = (offset: number): Term[] => Array.from({length: bits}, (_, index) => [offset + index, index === 0 ? -(2 ** (bits - 1)) : 2 ** (bits - 1 - index)] as const)
  const dx = value(0)
  const dy = value(bits)
  const drag = countingBit(circuit, [
    [countingBit(circuit, dx, dragSlop + 1), 1],
    [countingBit(circuit, negated(dx), dragSlop + 1), 1],
    [countingBit(circuit, dy, dragSlop + 1), 1],
    [countingBit(circuit, negated(dy), dragSlop + 1), 1],
  ], 1)
  return {circuit, roots: [drag]}
}
