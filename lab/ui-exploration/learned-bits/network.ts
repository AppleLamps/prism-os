// Bit-level networks with two unit types, trained through a relaxation and then
// hardened into exact bits.
//
// - 'gate': a 2-input gate holding a softmax over the 16 two-input functions,
//   each written as c0 + c1 a + c2 b + c3 ab (Petersen et al., "Deep
//   Differentiable Logic Gate Networks", 2022). 16 logits per unit.
// - 'count': a counting unit that reads C candidate wires, learns a weight in
//   {-1, 0, +1} per candidate through a 3-way softmax, and a threshold t in
//   1..T through a T-way softmax. Hardened, it is the bit [Σ w x >= t], which
//   the runtime computes exactly as relu(s - t + 1) - relu(s - t) for an
//   integer sum s. 3C + T logits per unit, so with C = T = 8 one counting unit
//   has as many logits as two gates.
//
// Wires are numbered globally: the sources (the task's input bits, their
// complements when enabled, and with sharing a boundary marker per position
// and a constant 0), then every layer's units in order. A layer reads the
// sources plus the previous layer ('previous') or plus every earlier layer
// ('all-earlier'). The last layer holds `groupSize` units per output bit, and
// an output bit is the majority vote of its group: the bit 2 * count >= groupSize.
//
// Relaxations for counting units:
// - 'expectation': the expected output when every weight and the threshold are
//   drawn from their softmaxes and every wire value is read as the probability
//   of an independent 1. The 16-function gate relaxation is the same kind of
//   expectation. It is computed with a dynamic program over the distribution
//   of the sum, about C^2 multiplications per unit per case.
// - 'normal': the same expectation with the sum's distribution replaced by a
//   normal distribution of the same mean and variance, plus a variance floor so
//   a hardened unit on exact bits still has a slope. About C + T operations.
// - 'clamp': clamp01(s - t + 1), with s = Σ E[w] x and t = E[t], the form from
//   the brief. Its gradient is zero wherever the clamp saturates.
//
// Sharing ('sharing: true', for tasks whose bits have positions): every hidden
// layer is `channels × positionCount` units, and all units of one channel share
// their logits and read the same wires relative to their own position, e.g.
// "enabled at my position - 2" or "channel 5 of the previous layer at my
// position - 1". So one learned unit is a small program run at every position,
// like a shader run at every pixel. Relative reads wrap around for cyclic tasks
// and read the constant 0 past either end otherwise. The marker source is 1 at
// position 0 only, so a shared program can still tell where the controls start.
// When the outputs are one per position, the output groups are shared too.

import type {Task} from './tasks.ts'

export type UnitKind = 'gate' | 'count'
export type CountRelaxation = 'expectation' | 'normal' | 'clamp'
export type Wiring = 'random' | 'prefix' | 'doubling'
export type PoolKind = 'previous' | 'all-earlier'

export type NetworkOptions = {
  kind: UnitKind
  hiddenWidths: readonly number[]
  groupSize: number
  // Counting units only.
  candidates: number
  thresholds: number
  relaxation: CountRelaxation
  normalFloor: number
  // Pool and wiring.
  complements: boolean
  pool: PoolKind
  wiring: Wiring
  sharing: boolean
  // With sharing: 'task' wraps relative reads around for cyclic tasks, 'zero'
  // always reads the constant 0 past either end, e.g. so a shared unit can sum
  // "focus at any earlier control" without wrapping.
  padding: 'task' | 'zero'
  // With 'prefix' wiring, each wire is drawn with this probability from wires
  // at the unit's own position p or at p - 1, p - 2, p - 4, ... (and bits with
  // no position), otherwise from the whole pool.
  // 'doubling' wiring only changes shared layers: in layer l, even wires read
  // references at the unit's own position p and odd wires read references at
  // p - 2^l (at p when p - 2^l is past the end without wrapping), plus bits with
  // no position. So layers 0, 1, 2 can compose spans of 2, 4, 8 positions, the
  // way a parallel prefix circuit does. Other layers draw at random.
  prefixProbability: number
  // Initialization. The residual bias favors "pass the first wire through":
  // gate function "a", or weight +1 on candidate 0 with threshold 1. The zero
  // bias favors weight 0 on the other candidates.
  residualBias: number
  zeroBias: number
  initialSpread: number
  seed: number
}

export const defaultNetworkOptions: NetworkOptions = {
  kind: 'count',
  hiddenWidths: [32, 32],
  groupSize: 2,
  candidates: 8,
  thresholds: 8,
  relaxation: 'expectation',
  normalFloor: 0.3,
  complements: true,
  pool: 'previous',
  wiring: 'random',
  sharing: false,
  padding: 'task',
  prefixProbability: 0.75,
  residualBias: 2,
  zeroBias: 1,
  initialSpread: 0.1,
  seed: 1,
}

// The 16 two-input functions as [c0, c1, c2, c3] in c0 + c1 a + c2 b + c3 ab.
export const gateCoefficients: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 0, 0], [0, 0, 0, 1], [0, 1, 0, -1], [0, 1, 0, 0],
  [0, 0, 1, -1], [0, 0, 1, 0], [0, 1, 1, -2], [0, 1, 1, -1],
  [1, -1, -1, 1], [1, -1, -1, 2], [1, 0, -1, 0], [1, 0, -1, 1],
  [1, -1, 0, 0], [1, -1, 0, 1], [1, 0, 0, -1], [1, 0, 0, 0],
]
export const gateNames = [
  'false', 'a and b', 'a and not b', 'a', 'not a and b', 'b', 'a xor b', 'a or b',
  'nor', 'xnor', 'not b', 'a or not b', 'not a', 'not a or b', 'nand', 'true',
] as const
const passA = 3

// How a source wire gets its value.
export const SourceMode = {input: 0, complement: 1, zero: 2, one: 3} as const

export type Layer = {
  width: number
  fanIn: number
  logitsPerUnit: number
  offset: number // global wire number of unit 0
  wires: Int32Array // [unit * fanIn + k]: global wire numbers
  logits: Float64Array // [unit * logitsPerUnit + j]
  positions: Int32Array
  // leaders[unit] is the unit whose logits this unit shares (itself when untied).
  leaders: Int32Array
}

export type Network = {
  options: NetworkOptions
  inputCount: number
  outputCount: number
  sourceCount: number
  sourceInput: Int32Array
  sourceMode: Uint8Array
  wireCount: number
  layers: Layer[]
}

export function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

// Logits that training changes independently (shared logits count once).
export function logitCount(network: Network) {
  return network.layers.reduce((total, layer) => total + layer.leaders.filter((leader, unit) => leader === unit).length * layer.logitsPerUnit, 0)
}

function prefixOffsets(positionCount: number) {
  const offsets = new Set<number>()
  for (let distance = 0; distance < positionCount; distance = distance === 0 ? 1 : distance * 2) offsets.add(-distance)
  return offsets
}

function relatedPositions(position: number, positionCount: number, cyclic: boolean) {
  const related = new Set<number>()
  for (const offset of prefixOffsets(positionCount)) {
    const shifted = position + offset
    if (cyclic) related.add(((shifted % positionCount) + positionCount) % positionCount)
    else if (shifted >= 0) related.add(shifted)
  }
  return related
}

// Draws `fanIn` distinct items, each from `preferred` with probability
// `preferredProbability` (when it is not empty), otherwise from `all`.
function drawDistinct<T>(random: () => number, fanIn: number, all: readonly T[], preferred: readonly T[], preferredProbability: number, keyOf: (item: T) => string) {
  const chosen: T[] = []
  const used = new Set<string>()
  for (let k = 0; k < fanIn; k++) {
    const fromPreferred = preferred.length > 0 && random() < preferredProbability
    let item = all[0]!
    for (let attempt = 0; attempt < 64; attempt++) {
      item = fromPreferred ? preferred[Math.floor(random() * preferred.length)]! : all[Math.floor(random() * all.length)]!
      if (!used.has(keyOf(item))) break
    }
    used.add(keyOf(item))
    chosen.push(item)
  }
  return chosen
}

function initializeLogits(random: () => number, logits: Float64Array, unit: number, logitsPerUnit: number, fanIn: number, options: NetworkOptions) {
  const base = unit * logitsPerUnit
  for (let index = 0; index < logitsPerUnit; index++) logits[base + index] = (random() - 0.5) * options.initialSpread
  if (options.kind === 'gate') {
    logits[base + passA] = logits[base + passA]! + options.residualBias
  } else {
    logits[base + 2] = logits[base + 2]! + options.residualBias
    for (let k = 1; k < fanIn; k++) logits[base + 3 * k + 1] = logits[base + 3 * k + 1]! + options.zeroBias
    logits[base + 3 * fanIn] = logits[base + 3 * fanIn]! + options.residualBias
  }
}

// A read relative to a unit's position.
type Reference =
  | {kind: 'source', group: number, offset: number}
  | {kind: 'global', wire: number}
  | {kind: 'unit', layer: number, channel: number, offset: number}

function referenceKey(reference: Reference) {
  return reference.kind === 'global' ? `g${reference.wire}` : reference.kind === 'source' ? `s${reference.group},${reference.offset}` : `u${reference.layer},${reference.channel},${reference.offset}`
}

export function createNetwork(task: Task, options: NetworkOptions): Network {
  const random = createRandom(options.seed * 7919 + 17)
  const P = task.positionCount
  const sharing = options.sharing && P > 0
  const sourceInput: number[] = []
  const sourceMode: number[] = []
  const sourcePositions: number[] = []
  const addSource = (input: number, mode: number, position: number) => {
    sourceInput.push(input)
    sourceMode.push(mode)
    sourcePositions.push(position)
  }
  for (let input = 0; input < task.inputCount; input++) addSource(input, SourceMode.input, task.inputPositions[input]!)
  if (options.complements) for (let input = 0; input < task.inputCount; input++) addSource(input, SourceMode.complement, task.inputPositions[input]!)
  if (sharing) {
    for (let position = 0; position < P; position++) addSource(-1, position === 0 ? SourceMode.one : SourceMode.zero, position)
    addSource(-1, SourceMode.zero, -1)
  }
  const sourceCount = sourceInput.length
  const zeroWire = sourceCount - 1
  const widths = [...options.hiddenWidths, task.outputCount * options.groupSize]
  const wireCount = sourceCount + widths.reduce((total, width) => total + width, 0)
  const positions = new Int32Array(wireCount)
  positions.set(sourcePositions)

  // For relative reads: the k-th source at a position belongs to group k.
  const sourceAt: number[][] = []
  const globalSources: number[] = []
  const groupsAtPosition = new Map<number, number>()
  sourcePositions.forEach((position, wire) => {
    if (position < 0) {
      globalSources.push(wire)
      return
    }
    const group = groupsAtPosition.get(position) ?? 0
    groupsAtPosition.set(position, group + 1)
    ;(sourceAt[group] ??= new Array<number>(P).fill(-1))[position] = wire
  })
  if (sharing && sourceAt.some(row => row.some(wire => wire < 0))) throw new Error('sharing needs the same inputs at every position')
  const wraps = task.cyclic && options.padding === 'task'
  const offsetsAll = wraps ? Array.from({length: P}, (_, index) => -index) : Array.from({length: 2 * P - 1}, (_, index) => index - (P - 1))
  const preferredOffsets = prefixOffsets(P)

  const layers: Layer[] = []
  let offset = sourceCount
  widths.forEach((width, layerIndex) => {
    const last = layerIndex === widths.length - 1
    const unitPositions = Int32Array.from({length: width}, (_, unit) => last
      ? task.outputPositions[Math.floor(unit / options.groupSize)]!
      : P > 0 ? unit % P : -1)
    positions.set(unitPositions, offset)
    const leaders = Int32Array.from({length: width}, (_, unit) => unit)
    const earlier = layerIndex === 0 ? [] : options.pool === 'previous' ? [layerIndex - 1] : Array.from({length: layerIndex}, (_, index) => index)
    const outputsPerPosition = task.outputCount === P && Array.from(task.outputPositions).every((position, bit) => position === bit)
    if (sharing && !last && width % P !== 0) throw new Error(`with sharing, hidden widths must be multiples of ${P}`)
    const tied = sharing && (!last || outputsPerPosition)
    const references: Reference[] = tied
      ? [
        ...sourceAt.flatMap((_, group) => offsetsAll.map(relative => ({kind: 'source', group, offset: relative}) as const)),
        ...globalSources.filter(wire => wire !== zeroWire).map(wire => ({kind: 'global', wire}) as const),
        ...earlier.flatMap(m => Array.from({length: layers[m]!.width / P}, (_, channel) => offsetsAll.map(relative => ({kind: 'unit', layer: m, channel, offset: relative}) as const)).flat()),
      ]
      : []
    const pool = tied
      ? []
      : [
        ...Array.from({length: sourceCount}, (_, wire) => wire).filter(wire => !(sharing && wire === zeroWire)),
        ...earlier.flatMap(m => Array.from({length: layers[m]!.width}, (_, unit) => layers[m]!.offset + unit)),
      ]
    // candidates = 0 means a counting unit reads every reference (or every pool wire).
    const readsEverything = options.kind === 'count' && options.candidates === 0
    const fanIn = options.kind === 'gate' ? 2 : readsEverything ? (tied ? references.length : pool.length) : options.candidates
    const logitsPerUnit = options.kind === 'gate' ? 16 : 3 * fanIn + options.thresholds
    const wires = new Int32Array(width * fanIn)
    const logits = new Float64Array(width * logitsPerUnit)
    if (tied) {
      const channelCount = last ? options.groupSize : width / P
      const unitAt = (channel: number, position: number) => (last ? position * options.groupSize + channel : channel * P + position)
      const preferred = options.wiring === 'prefix' ? references.filter(reference => reference.kind === 'global' || preferredOffsets.has(reference.offset)) : []
      // 'doubling': references at p for even wires, at p - 2^layer for odd wires.
      const span = 2 ** layerIndex
      const doublingOffset = wraps ? -(span % P) : span < P ? -span : 0
      const atOffset = (relative: number) => references.filter(reference => reference.kind === 'global' || reference.offset === relative)
      const doublingPools = options.wiring === 'doubling' ? [atOffset(0), atOffset(doublingOffset)] : []
      const drawDoubling = () => {
        const chosen: Reference[] = []
        const used = new Set<string>()
        for (let k = 0; k < fanIn; k++) {
          const pool = doublingPools[k % 2]!
          let item = pool[0]!
          for (let attempt = 0; attempt < 64; attempt++) {
            item = pool[Math.floor(random() * pool.length)]!
            if (!used.has(referenceKey(item))) break
          }
          used.add(referenceKey(item))
          chosen.push(item)
        }
        return chosen
      }
      const resolve = (reference: Reference, position: number) => {
        if (reference.kind === 'global') return reference.wire
        let shifted = position + reference.offset
        if (wraps) shifted = ((shifted % P) + P) % P
        else if (shifted < 0 || shifted >= P) return zeroWire
        return reference.kind === 'source' ? sourceAt[reference.group]![shifted]! : layers[reference.layer]!.offset + reference.channel * P + shifted
      }
      for (let channel = 0; channel < channelCount; channel++) {
        const template = readsEverything ? references : options.wiring === 'doubling' ? drawDoubling() : drawDistinct(random, fanIn, references, preferred, options.prefixProbability, referenceKey)
        const leader = unitAt(channel, 0)
        initializeLogits(random, logits, leader, logitsPerUnit, fanIn, options)
        for (let position = 0; position < P; position++) {
          const unit = unitAt(channel, position)
          leaders[unit] = leader
          template.forEach((reference, k) => { wires[unit * fanIn + k] = resolve(reference, position) })
          logits.copyWithin(unit * logitsPerUnit, leader * logitsPerUnit, (leader + 1) * logitsPerUnit)
        }
      }
    } else {
      for (let unit = 0; unit < width; unit++) {
        let preferred: number[] = []
        if (options.wiring === 'prefix' && unitPositions[unit]! >= 0) {
          const allowed = relatedPositions(unitPositions[unit]!, P, task.cyclic)
          preferred = pool.filter(wire => positions[wire] === -1 || allowed.has(positions[wire]!))
        }
        const chosen = readsEverything ? pool : drawDistinct(random, fanIn, pool, preferred, options.prefixProbability, String)
        chosen.forEach((wire, k) => { wires[unit * fanIn + k] = wire })
        initializeLogits(random, logits, unit, logitsPerUnit, fanIn, options)
      }
    }
    layers.push({width, fanIn, logitsPerUnit, offset, wires, logits, positions: unitPositions, leaders})
    offset += width
  })
  return {
    options,
    inputCount: task.inputCount,
    outputCount: task.outputCount,
    sourceCount,
    sourceInput: Int32Array.from(sourceInput),
    sourceMode: Uint8Array.from(sourceMode),
    wireCount,
    layers,
  }
}

export function setCountUnit(layer: Layer, unit: number, terms: readonly (readonly [wire: number, weight: -1 | 0 | 1])[], threshold: number, thresholdCount: number) {
  const fanIn = layer.fanIn
  const base = unit * layer.logitsPerUnit
  if (terms.length > fanIn) throw new Error(`a counting unit reads at most ${fanIn} wires`)
  for (let k = 0; k < fanIn; k++) {
    const term = terms[k]
    if (term !== undefined) layer.wires[unit * fanIn + k] = term[0]
    const weight = term?.[1] ?? 0
    for (let index = 0; index < 3; index++) layer.logits[base + 3 * k + index] = index === weight + 1 ? 40 : -40
  }
  for (let t = 1; t <= thresholdCount; t++) layer.logits[base + 3 * fanIn + t - 1] = t === threshold ? 40 : -40
}

function sourceValue(network: {inputCount: number, sourceInput: Int32Array, sourceMode: Uint8Array}, task: Task, wire: number, caseIndex: number) {
  const mode = network.sourceMode[wire]!
  if (mode === SourceMode.zero) return 0
  if (mode === SourceMode.one) return 1
  const value = task.inputs[caseIndex * network.inputCount + network.sourceInput[wire]!]!
  return mode === SourceMode.complement ? 1 - value : value
}

function softmaxInto(logits: Float64Array, probabilities: Float64Array, offset: number, size: number, temperature: number) {
  let maximum = -Infinity
  for (let index = 0; index < size; index++) maximum = Math.max(maximum, logits[offset + index]! / temperature)
  let total = 0
  for (let index = 0; index < size; index++) total += Math.exp(logits[offset + index]! / temperature - maximum)
  for (let index = 0; index < size; index++) probabilities[offset + index] = Math.exp(logits[offset + index]! / temperature - maximum) / total
}

const inverseSqrtTwoPi = 1 / Math.sqrt(2 * Math.PI)

// The standard normal distribution function, through Abramowitz and Stegun
// 7.1.26 for erf (error below 1.5e-7).
function normalDistribution(z: number) {
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const polynomial = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  const erf = 1 - polynomial * Math.exp(-x * x)
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf)
}

export type LossKind = 'squared' | 'cross-entropy'
export type Trainer = ReturnType<typeof createTrainer>

// A forward and backward pass over a batch of up to `capacity` cases. Values
// are laid out [wire * capacity + n], so every unit reads contiguous rows.
// Logit gradients are per unit; trainNetwork sums them over shared units.
export function createTrainer(network: Network, task: Task, capacity: number, loss: LossKind = 'squared') {
  const {layers, sourceCount, outputCount, wireCount} = network
  const {kind, groupSize, thresholds, relaxation, normalFloor} = network.options
  const B = capacity
  const last = layers[layers.length - 1]!
  const values = new Float64Array(wireCount * B)
  const gradients = new Float64Array(wireCount * B)
  const finalGradients = new Float64Array(last.width * B)
  const probabilities = layers.map(layer => new Float64Array(layer.logits.length))
  const logitGradients = layers.map(layer => new Float64Array(layer.logits.length))
  const gateCache = layers.map(layer => new Float64Array(kind === 'gate' ? 4 * layer.width : 0))
  const targets = new Float64Array(outputCount * B)
  let batch = 0

  const maximumFanIn = Math.max(...layers.map(layer => layer.fanIn))
  const S = 2 * maximumFanIn + 3
  const O = maximumFanIn + 1
  let current = new Float64Array(S)
  let next = new Float64Array(S)
  const rows = new Float64Array((maximumFanIn + 1) * S)
  let adjoint = new Float64Array(S)
  let adjointNext = new Float64Array(S)
  const qp = new Float64Array(maximumFanIn)
  const qm = new Float64Array(maximumFanIn)
  const expectedWeight = new Float64Array(maximumFanIn)
  const cumulative = new Float64Array(maximumFanIn + 1)
  const thresholdProbabilities = new Float64Array(thresholds)
  const offsets = new Int32Array(maximumFanIn)
  const dqp = new Float64Array(maximumFanIn)
  const dqm = new Float64Array(maximumFanIn)
  const dThreshold = new Float64Array(thresholds)

  function load(cases: ArrayLike<number>, start: number, count: number) {
    if (count > B) throw new Error('batch exceeds trainer capacity')
    batch = count
    for (let wire = 0; wire < sourceCount; wire++) {
      for (let n = 0; n < count; n++) values[wire * B + n] = sourceValue(network, task, wire, cases[start + n]!)
    }
    for (let bit = 0; bit < outputCount; bit++) {
      for (let n = 0; n < count; n++) targets[bit * B + n] = task.targets[cases[start + n]! * outputCount + bit]!
    }
  }

  function softmaxLayer(layer: Layer, p: Float64Array, temperature: number) {
    for (let unit = 0; unit < layer.width; unit++) {
      const base = unit * layer.logitsPerUnit
      if (kind === 'gate') {
        softmaxInto(layer.logits, p, base, 16, temperature)
      } else {
        for (let k = 0; k < layer.fanIn; k++) softmaxInto(layer.logits, p, base + 3 * k, 3, temperature)
        softmaxInto(layer.logits, p, base + 3 * layer.fanIn, thresholds, temperature)
      }
    }
  }

  // Loads a counting unit's probabilities into the scratch arrays. Returns E[t].
  function readCountUnit(layer: Layer, p: Float64Array, unit: number) {
    const C = layer.fanIn
    const base = unit * layer.logitsPerUnit
    for (let k = 0; k < C; k++) {
      qm[k] = p[base + 3 * k]!
      qp[k] = p[base + 3 * k + 2]!
      expectedWeight[k] = qp[k]! - qm[k]!
      offsets[k] = layer.wires[unit * C + k]! * B
    }
    let meanThreshold = 0
    for (let t = 1; t <= thresholds; t++) {
      thresholdProbabilities[t - 1] = p[base + 3 * C + t - 1]!
      meanThreshold += t * thresholdProbabilities[t - 1]!
    }
    cumulative[0] = 0
    for (let j = 1; j <= C; j++) cumulative[j] = cumulative[j - 1]! + (j <= thresholds ? thresholdProbabilities[j - 1]! : 0)
    return meanThreshold
  }

  function forward(temperature: number) {
    for (let l = 0; l < layers.length; l++) {
      const layer = layers[l]!
      const p = probabilities[l]!
      softmaxLayer(layer, p, temperature)
      const C = layer.fanIn
      for (let unit = 0; unit < layer.width; unit++) {
        const o = (layer.offset + unit) * B
        if (kind === 'gate') {
          let c0 = 0
          let c1 = 0
          let c2 = 0
          let c3 = 0
          for (let k = 0; k < 16; k++) {
            const probability = p[16 * unit + k]!
            const coefficients = gateCoefficients[k]!
            c0 += probability * coefficients[0]
            c1 += probability * coefficients[1]
            c2 += probability * coefficients[2]
            c3 += probability * coefficients[3]
          }
          const cache = gateCache[l]!
          cache[4 * unit] = c0
          cache[4 * unit + 1] = c1
          cache[4 * unit + 2] = c2
          cache[4 * unit + 3] = c3
          const a = layer.wires[2 * unit]! * B
          const b = layer.wires[2 * unit + 1]! * B
          for (let n = 0; n < batch; n++) {
            const valueA = values[a + n]!
            const valueB = values[b + n]!
            values[o + n] = c0 + c1 * valueA + c2 * valueB + c3 * valueA * valueB
          }
          continue
        }
        const meanThreshold = readCountUnit(layer, p, unit)
        if (relaxation === 'clamp') {
          for (let n = 0; n < batch; n++) {
            let sum = 0
            for (let k = 0; k < C; k++) sum += expectedWeight[k]! * values[offsets[k]! + n]!
            const value = sum - meanThreshold + 1
            values[o + n] = value <= 0 ? 0 : value >= 1 ? 1 : value
          }
          continue
        }
        if (relaxation === 'normal') {
          for (let n = 0; n < batch; n++) {
            let mean = 0
            let variance = normalFloor * normalFloor
            for (let k = 0; k < C; k++) {
              const x = values[offsets[k]! + n]!
              const weight = expectedWeight[k]!
              mean += weight * x
              variance += (qp[k]! + qm[k]!) * x - weight * weight * x * x
            }
            const deviation = Math.sqrt(variance)
            let y = 0
            for (let t = 1; t <= thresholds; t++) y += thresholdProbabilities[t - 1]! * normalDistribution((mean - t + 0.5) / deviation)
            values[o + n] = y
          }
          continue
        }
        for (let n = 0; n < batch; n++) {
          current.fill(0)
          next.fill(0)
          current[O] = 1
          for (let k = 0; k < C; k++) {
            const x = values[offsets[k]! + n]!
            const plus = qp[k]! * x
            const minus = qm[k]! * x
            const zero = 1 - plus - minus
            for (let s = O - k - 1; s <= O + k + 1; s++) {
              next[s] = zero * current[s]! + plus * current[s - 1]! + minus * current[s + 1]!
            }
            const swap = current
            current = next
            next = swap
          }
          let y = 0
          for (let j = 1; j <= C; j++) y += current[O + j]! * cumulative[j]!
          values[o + n] = y
        }
      }
    }
    let total = 0
    for (let bit = 0; bit < outputCount; bit++) {
      for (let n = 0; n < batch; n++) {
        let mean = 0
        for (let member = 0; member < groupSize; member++) mean += values[(last.offset + bit * groupSize + member) * B + n]!
        mean /= groupSize
        const target = targets[bit * B + n]!
        let gradient: number
        if (loss === 'squared') {
          const difference = mean - target
          total += difference * difference
          gradient = (2 * difference) / (batch * groupSize)
        } else {
          const clamped = Math.min(1 - 1e-7, Math.max(1e-7, mean))
          total -= target * Math.log(clamped) + (1 - target) * Math.log(1 - clamped)
          gradient = clamped === mean ? (mean - target) / (mean * (1 - mean) * batch * groupSize) : 0
        }
        for (let member = 0; member < groupSize; member++) finalGradients[(bit * groupSize + member) * B + n] = gradient
      }
    }
    return total / batch
  }

  function backward(temperature: number) {
    gradients.fill(0)
    gradients.set(finalGradients, last.offset * B)
    for (let l = layers.length - 1; l >= 0; l--) {
      const layer = layers[l]!
      const p = probabilities[l]!
      const logitGradient = logitGradients[l]!
      const C = layer.fanIn
      logitGradient.fill(0)
      for (let unit = 0; unit < layer.width; unit++) {
        const o = (layer.offset + unit) * B
        const base = unit * layer.logitsPerUnit
        if (kind === 'gate') {
          const cache = gateCache[l]!
          const c1 = cache[4 * unit + 1]!
          const c2 = cache[4 * unit + 2]!
          const c3 = cache[4 * unit + 3]!
          const a = layer.wires[2 * unit]! * B
          const b = layer.wires[2 * unit + 1]! * B
          let d0 = 0
          let d1 = 0
          let d2 = 0
          let d3 = 0
          for (let n = 0; n < batch; n++) {
            const g = gradients[o + n]!
            if (g === 0) continue
            const valueA = values[a + n]!
            const valueB = values[b + n]!
            d0 += g
            d1 += g * valueA
            d2 += g * valueB
            d3 += g * valueA * valueB
            gradients[a + n] = gradients[a + n]! + g * (c1 + c3 * valueB)
            gradients[b + n] = gradients[b + n]! + g * (c2 + c3 * valueA)
          }
          let weighted = 0
          for (let k = 0; k < 16; k++) {
            const coefficients = gateCoefficients[k]!
            weighted += p[base + k]! * (coefficients[0] * d0 + coefficients[1] * d1 + coefficients[2] * d2 + coefficients[3] * d3)
          }
          for (let k = 0; k < 16; k++) {
            const coefficients = gateCoefficients[k]!
            const probabilityGradient = coefficients[0] * d0 + coefficients[1] * d1 + coefficients[2] * d2 + coefficients[3] * d3
            logitGradient[base + k] = (p[base + k]! * (probabilityGradient - weighted)) / temperature
          }
          continue
        }
        const meanThreshold = readCountUnit(layer, p, unit)
        dqp.fill(0)
        dqm.fill(0)
        dThreshold.fill(0)
        if (relaxation === 'clamp') {
          let dMeanThreshold = 0
          for (let n = 0; n < batch; n++) {
            const g = gradients[o + n]!
            if (g === 0) continue
            let sum = 0
            for (let k = 0; k < C; k++) sum += expectedWeight[k]! * values[offsets[k]! + n]!
            const value = sum - meanThreshold + 1
            if (value <= 0 || value >= 1) continue
            for (let k = 0; k < C; k++) {
              const x = values[offsets[k]! + n]!
              gradients[offsets[k]! + n] = gradients[offsets[k]! + n]! + g * expectedWeight[k]!
              dqp[k] = dqp[k]! + g * x
              dqm[k] = dqm[k]! - g * x
            }
            dMeanThreshold -= g
          }
          for (let t = 1; t <= thresholds; t++) dThreshold[t - 1] = dMeanThreshold * t
        } else if (relaxation === 'normal') {
          for (let n = 0; n < batch; n++) {
            const g = gradients[o + n]!
            if (g === 0) continue
            let mean = 0
            let variance = normalFloor * normalFloor
            for (let k = 0; k < C; k++) {
              const x = values[offsets[k]! + n]!
              const weight = expectedWeight[k]!
              mean += weight * x
              variance += (qp[k]! + qm[k]!) * x - weight * weight * x * x
            }
            const deviation = Math.sqrt(variance)
            let dMean = 0
            let dDeviation = 0
            for (let t = 1; t <= thresholds; t++) {
              const z = (mean - t + 0.5) / deviation
              const density = inverseSqrtTwoPi * Math.exp(-0.5 * z * z)
              const probability = thresholdProbabilities[t - 1]!
              dThreshold[t - 1] = dThreshold[t - 1]! + g * normalDistribution(z)
              dMean += (g * probability * density) / deviation
              dDeviation -= (g * probability * density * z) / deviation
            }
            const dVariance = dDeviation / (2 * deviation)
            for (let k = 0; k < C; k++) {
              const x = values[offsets[k]! + n]!
              const weight = expectedWeight[k]!
              gradients[offsets[k]! + n] = gradients[offsets[k]! + n]! + dMean * weight + dVariance * (qp[k]! + qm[k]! - 2 * weight * weight * x)
              dqp[k] = dqp[k]! + dMean * x + dVariance * (x - 2 * weight * x * x)
              dqm[k] = dqm[k]! - dMean * x + dVariance * (x + 2 * weight * x * x)
            }
          }
        } else {
          for (let n = 0; n < batch; n++) {
            const g = gradients[o + n]!
            if (g === 0) continue
            rows.fill(0)
            rows[O] = 1
            for (let k = 0; k < C; k++) {
              const x = values[offsets[k]! + n]!
              const plus = qp[k]! * x
              const minus = qm[k]! * x
              const zero = 1 - plus - minus
              const previousRow = k * S
              const row = (k + 1) * S
              for (let s = O - k - 1; s <= O + k + 1; s++) {
                rows[row + s] = zero * rows[previousRow + s]! + plus * rows[previousRow + s - 1]! + minus * rows[previousRow + s + 1]!
              }
            }
            const finalRow = C * S
            let tail = 0
            for (let j = C; j >= 1; j--) {
              tail += rows[finalRow + O + j]!
              if (j <= thresholds) dThreshold[j - 1] = dThreshold[j - 1]! + g * tail
            }
            adjoint.fill(0)
            for (let j = 1; j <= C; j++) adjoint[O + j] = g * cumulative[j]!
            for (let k = C - 1; k >= 0; k--) {
              const x = values[offsets[k]! + n]!
              const plus = qp[k]! * x
              const minus = qm[k]! * x
              const zero = 1 - plus - minus
              const row = k * S
              let gradientPlus = 0
              let gradientMinus = 0
              let gradientZero = 0
              for (let s = O - k; s <= O + k; s++) {
                const probability = rows[row + s]!
                const up = adjoint[s + 1]!
                const same = adjoint[s]!
                const down = adjoint[s - 1]!
                gradientPlus += probability * up
                gradientMinus += probability * down
                gradientZero += probability * same
                adjointNext[s] = zero * same + plus * up + minus * down
              }
              const swap = adjoint
              adjoint = adjointNext
              adjointNext = swap
              gradients[offsets[k]! + n] = gradients[offsets[k]! + n]! + gradientPlus * qp[k]! + gradientMinus * qm[k]! - gradientZero * (qp[k]! + qm[k]!)
              dqp[k] = dqp[k]! + x * (gradientPlus - gradientZero)
              dqm[k] = dqm[k]! + x * (gradientMinus - gradientZero)
            }
          }
        }
        for (let k = 0; k < C; k++) {
          const minus = p[base + 3 * k]!
          const zero = p[base + 3 * k + 1]!
          const plus = p[base + 3 * k + 2]!
          const weighted = minus * dqm[k]! + plus * dqp[k]!
          logitGradient[base + 3 * k] = (minus * (dqm[k]! - weighted)) / temperature
          logitGradient[base + 3 * k + 1] = (zero * -weighted) / temperature
          logitGradient[base + 3 * k + 2] = (plus * (dqp[k]! - weighted)) / temperature
        }
        let weighted = 0
        for (let t = 0; t < thresholds; t++) weighted += thresholdProbabilities[t]! * dThreshold[t]!
        for (let t = 0; t < thresholds; t++) {
          logitGradient[base + 3 * C + t] = (thresholdProbabilities[t]! * (dThreshold[t]! - weighted)) / temperature
        }
      }
    }
  }

  // The relaxed output bits: each group's mean, [bit * capacity + n].
  function relaxedOutputs() {
    const result = new Float64Array(outputCount * B)
    for (let bit = 0; bit < outputCount; bit++) {
      for (let n = 0; n < batch; n++) {
        let mean = 0
        for (let member = 0; member < groupSize; member++) mean += values[(last.offset + bit * groupSize + member) * B + n]!
        result[bit * B + n] = mean / groupSize
      }
    }
    return result
  }

  return {capacity: B, load, forward, backward, logitGradients, relaxedOutputs}
}

// Adds every shared unit's logit gradients into its leader's, so the leader's
// slots hold the gradient of the shared logits.
export function sumSharedGradients(network: Network, logitGradients: readonly Float64Array[]) {
  network.layers.forEach((layer, l) => {
    const gradients = logitGradients[l]!
    for (let unit = 0; unit < layer.width; unit++) {
      const leader = layer.leaders[unit]!
      if (leader === unit) continue
      for (let index = 0; index < layer.logitsPerUnit; index++) {
        gradients[leader * layer.logitsPerUnit + index] = gradients[leader * layer.logitsPerUnit + index]! + gradients[unit * layer.logitsPerUnit + index]!
      }
    }
  })
}

export function copySharedLogits(network: Network) {
  for (const layer of network.layers) {
    for (let unit = 0; unit < layer.width; unit++) {
      const leader = layer.leaders[unit]!
      if (leader !== unit) layer.logits.copyWithin(unit * layer.logitsPerUnit, leader * layer.logitsPerUnit, (leader + 1) * layer.logitsPerUnit)
    }
  }
}

export type TrainOptions = {
  steps: number
  learningRate: number
  // 0 means every training case in every step.
  batchSize: number
  temperatureStart: number
  temperatureEnd: number
  loss: LossKind
  beta1: number
  beta2: number
  epsilon: number
  seed: number
}

export const defaultTrainOptions: TrainOptions = {
  steps: 1000,
  learningRate: 0.05,
  batchSize: 0,
  temperatureStart: 1,
  temperatureEnd: 1,
  loss: 'squared',
  beta1: 0.9,
  beta2: 0.99,
  epsilon: 1e-8,
  seed: 1,
}

export type TrainProgress = {step: number, loss: number, temperature: number}

export function trainNetwork(network: Network, task: Task, trainCases: Int32Array, options: TrainOptions, onProgress: ((progress: TrainProgress) => void) | null = null) {
  const fullBatch = options.batchSize <= 0 || options.batchSize >= trainCases.length
  const batchSize = fullBatch ? trainCases.length : options.batchSize
  const trainer = createTrainer(network, task, batchSize, options.loss)
  const firstMoments = network.layers.map(layer => new Float64Array(layer.logits.length))
  const secondMoments = network.layers.map(layer => new Float64Array(layer.logits.length))
  const shared = network.layers.some(layer => layer.leaders.some((leader, unit) => leader !== unit))
  const order = Int32Array.from(trainCases)
  const random = createRandom(options.seed * 104729 + 3)
  const shuffle = () => {
    for (let index = order.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1))
      const swap = order[index]!
      order[index] = order[other]!
      order[other] = swap
    }
  }
  let cursor = 0
  if (fullBatch) trainer.load(order, 0, batchSize)
  else shuffle()
  let loss = 0
  const started = performance.now()
  for (let step = 0; step < options.steps; step++) {
    const progress = options.steps <= 1 ? 0 : step / (options.steps - 1)
    const temperature = options.temperatureStart * (options.temperatureEnd / options.temperatureStart) ** progress
    if (!fullBatch) {
      if (cursor + batchSize > order.length) {
        shuffle()
        cursor = 0
      }
      trainer.load(order, cursor, batchSize)
      cursor += batchSize
    }
    loss = trainer.forward(temperature)
    trainer.backward(temperature)
    if (shared) sumSharedGradients(network, trainer.logitGradients)
    const time = step + 1
    const correction1 = 1 - options.beta1 ** time
    const correction2 = 1 - options.beta2 ** time
    network.layers.forEach((layer, l) => {
      const gradients = trainer.logitGradients[l]!
      const m = firstMoments[l]!
      const v = secondMoments[l]!
      for (let unit = 0; unit < layer.width; unit++) {
        if (layer.leaders[unit] !== unit) continue
        for (let index = unit * layer.logitsPerUnit; index < (unit + 1) * layer.logitsPerUnit; index++) {
          const g = gradients[index]!
          m[index] = options.beta1 * m[index]! + (1 - options.beta1) * g
          v[index] = options.beta2 * v[index]! + (1 - options.beta2) * g * g
          layer.logits[index] = layer.logits[index]! - (options.learningRate * (m[index]! / correction1)) / (Math.sqrt(v[index]! / correction2) + options.epsilon)
        }
      }
    })
    if (shared) copySharedLogits(network)
    if (onProgress !== null) onProgress({step, loss, temperature})
  }
  return {loss, seconds: (performance.now() - started) / 1000}
}

// ---------------------------------------------------------------------------
// Hardening and exact evaluation

export type HardLayer = {
  width: number
  fanIn: number
  offset: number
  wires: Int32Array
  gates: Uint8Array // gate units: the chosen function per unit
  weights: Int8Array // counting units: [unit * fanIn + k] in {-1, 0, 1}
  thresholds: Uint8Array // counting units: t per unit
  leaders: Int32Array
  positions: Int32Array
}

export type HardNetwork = {
  kind: UnitKind
  inputCount: number
  outputCount: number
  sourceCount: number
  sourceInput: Int32Array
  sourceMode: Uint8Array
  wireCount: number
  groupSize: number
  layers: HardLayer[]
}

function argmax(values: Float64Array, offset: number, size: number) {
  let best = 0
  for (let index = 1; index < size; index++) if (values[offset + index]! > values[offset + best]!) best = index
  return best
}

export function harden(network: Network): HardNetwork {
  const {kind, thresholds} = network.options
  return {
    kind,
    inputCount: network.inputCount,
    outputCount: network.outputCount,
    sourceCount: network.sourceCount,
    sourceInput: network.sourceInput,
    sourceMode: network.sourceMode,
    wireCount: network.wireCount,
    groupSize: network.options.groupSize,
    layers: network.layers.map(layer => {
      const gates = new Uint8Array(kind === 'gate' ? layer.width : 0)
      const weights = new Int8Array(kind === 'count' ? layer.width * layer.fanIn : 0)
      const thresholdValues = new Uint8Array(kind === 'count' ? layer.width : 0)
      for (let unit = 0; unit < layer.width; unit++) {
        const base = unit * layer.logitsPerUnit
        if (kind === 'gate') {
          gates[unit] = argmax(layer.logits, base, 16)
        } else {
          for (let k = 0; k < layer.fanIn; k++) weights[unit * layer.fanIn + k] = argmax(layer.logits, base + 3 * k, 3) - 1
          thresholdValues[unit] = argmax(layer.logits, base + 3 * layer.fanIn, thresholds) + 1
        }
      }
      return {width: layer.width, fanIn: layer.fanIn, offset: layer.offset, wires: Int32Array.from(layer.wires), gates, weights, thresholds: thresholdValues, leaders: layer.leaders, positions: layer.positions}
    }),
  }
}

// Evaluates the hardened network with integer arithmetic over the given cases
// (every case when `cases` is null). Returns output bits [n * outputs + bit]
// and every wire's values [wire * caseCount + n].
export function evaluateHard(hard: HardNetwork, task: Task, cases: Int32Array | null) {
  const N = cases === null ? task.caseCount : cases.length
  const values = new Uint8Array(hard.wireCount * N)
  for (let wire = 0; wire < hard.sourceCount; wire++) {
    for (let n = 0; n < N; n++) values[wire * N + n] = sourceValue(hard, task, wire, cases === null ? n : cases[n]!)
  }
  const maximumFanIn = Math.max(...hard.layers.map(layer => layer.fanIn))
  const offsets = new Int32Array(maximumFanIn)
  const weights = new Int8Array(maximumFanIn)
  for (const layer of hard.layers) {
    for (let unit = 0; unit < layer.width; unit++) {
      let reads = 0
      for (let k = 0; k < layer.fanIn; k++) {
        const weight = hard.kind === 'count' ? layer.weights[unit * layer.fanIn + k]! : 1
        if (weight === 0) continue
        offsets[reads] = layer.wires[unit * layer.fanIn + k]! * N
        weights[reads] = weight
        reads++
      }
      const o = (layer.offset + unit) * N
      if (hard.kind === 'gate') {
        const [c0, c1, c2, c3] = gateCoefficients[layer.gates[unit]!]!
        const offsetA = offsets[0]!
        const offsetB = offsets[1]!
        for (let n = 0; n < N; n++) {
          const valueA = values[offsetA + n]!
          const valueB = values[offsetB + n]!
          values[o + n] = c0 + c1 * valueA + c2 * valueB + c3 * valueA * valueB
        }
      } else {
        const threshold = layer.thresholds[unit]!
        for (let n = 0; n < N; n++) {
          let sum = 0
          for (let read = 0; read < reads; read++) sum += weights[read]! * values[offsets[read]! + n]!
          values[o + n] = sum >= threshold ? 1 : 0
        }
      }
    }
  }
  const last = hard.layers[hard.layers.length - 1]!
  const outputs = new Uint8Array(hard.outputCount * N)
  for (let bit = 0; bit < hard.outputCount; bit++) {
    for (let n = 0; n < N; n++) {
      let count = 0
      for (let member = 0; member < hard.groupSize; member++) count += values[(last.offset + bit * hard.groupSize + member) * N + n]!
      outputs[n * hard.outputCount + bit] = 2 * count >= hard.groupSize ? 1 : 0
    }
  }
  return {outputs, values}
}

export function countExactCases(hard: HardNetwork, task: Task, cases: Int32Array | null) {
  const {outputs} = evaluateHard(hard, task, cases)
  const N = cases === null ? task.caseCount : cases.length
  let exact = 0
  for (let n = 0; n < N; n++) {
    const caseIndex = cases === null ? n : cases[n]!
    let same = true
    for (let bit = 0; bit < task.outputCount; bit++) {
      if (outputs[n * task.outputCount + bit] !== task.targets[caseIndex * task.outputCount + bit]) {
        same = false
        break
      }
    }
    if (same) exact++
  }
  return exact
}

// A seeded split of every case into training and held-out cases.
export function splitCases(task: Task, trainFraction: number, seed: number) {
  const order = Int32Array.from({length: task.caseCount}, (_, index) => index)
  const random = createRandom(seed * 31337 + 11)
  for (let index = order.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    const swap = order[index]!
    order[index] = order[other]!
    order[other] = swap
  }
  const trainCount = Math.round(task.caseCount * trainFraction)
  return {train: order.slice(0, trainCount), heldOut: order.slice(trainCount)}
}
