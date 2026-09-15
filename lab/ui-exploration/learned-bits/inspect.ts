// Reads hardened networks: which units some output depends on, what each live
// unit is as a named construction, and which live units compute exactly one of
// a task's named intermediate predicates over every case.

import {evaluateHard, gateCoefficients, gateNames, SourceMode, type HardLayer, type HardNetwork, type Network} from './network.ts'
import type {Task} from './tasks.ts'

// For every output bit, the inputs it depends on: input i is needed by output
// bit b when some pair of cases differs only in input i and differs in bit b.
// Pairs that aren't both cases (e.g. two focused controls) are skipped, so this
// can miss dependencies but never adds a false one.
export function neededInputs(task: Task): Set<number>[] {
  if (task.inputCount > 52) throw new Error('neededInputs keys cases by a float64 integer, so at most 52 inputs')
  const powers = Array.from({length: task.inputCount}, (_, input) => 2 ** input)
  const keys = new Float64Array(task.caseCount)
  const caseOfKey = new Map<number, number>()
  for (let caseIndex = 0; caseIndex < task.caseCount; caseIndex++) {
    let key = 0
    for (let input = 0; input < task.inputCount; input++) if (task.inputs[caseIndex * task.inputCount + input] === 1) key += powers[input]!
    keys[caseIndex] = key
    caseOfKey.set(key, caseIndex)
  }
  const needed = Array.from({length: task.outputCount}, () => new Set<number>())
  for (let caseIndex = 0; caseIndex < task.caseCount; caseIndex++) {
    for (let input = 0; input < task.inputCount; input++) {
      if (task.inputs[caseIndex * task.inputCount + input] === 1) continue
      const other = caseOfKey.get(keys[caseIndex]! + powers[input]!)
      if (other === undefined) continue
      for (let bit = 0; bit < task.outputCount; bit++) {
        if (task.targets[caseIndex * task.outputCount + bit] !== task.targets[other * task.outputCount + bit]) needed[bit]!.add(input)
      }
    }
  }
  return needed
}

// Whether the wiring alone lets each output bit read every input it needs,
// following every wire a unit reads whatever its logits are. An output bit whose
// wiring misses a needed input can't be right on every case, so a network with
// uncovered output bits can't learn its task exactly.
export function wiringCoverage(network: Network, task: Task, needed: readonly Set<number>[] = neededInputs(task)) {
  const I = task.inputCount
  const reach = new Uint8Array(network.wireCount * I)
  for (let wire = 0; wire < network.sourceCount; wire++) {
    const mode = network.sourceMode[wire]!
    if (mode === SourceMode.input || mode === SourceMode.complement) reach[wire * I + network.sourceInput[wire]!] = 1
  }
  for (const layer of network.layers) {
    for (let unit = 0; unit < layer.width; unit++) {
      const row = (layer.offset + unit) * I
      for (let k = 0; k < layer.fanIn; k++) {
        const read = layer.wires[unit * layer.fanIn + k]! * I
        for (let input = 0; input < I; input++) reach[row + input] = reach[row + input]! | reach[read + input]!
      }
    }
  }
  const last = network.layers[network.layers.length - 1]!
  const groupSize = network.options.groupSize
  const missing: {output: string, inputs: string[]}[] = []
  for (let bit = 0; bit < task.outputCount; bit++) {
    const lacking = [...needed[bit]!].filter(input => {
      for (let member = 0; member < groupSize; member++) if (reach[(last.offset + bit * groupSize + member) * I + input] === 1) return false
      return true
    })
    if (lacking.length > 0) missing.push({output: task.outputNames[bit]!, inputs: lacking.map(input => task.inputNames[input]!)})
  }
  return {coveredOutputs: task.outputCount - missing.length, outputCount: task.outputCount, missing}
}

function readsWire(hard: HardNetwork, layer: HardLayer, unit: number, k: number) {
  if (hard.kind === 'count') return layer.weights[unit * layer.fanIn + k] !== 0
  const [, c1, c2, c3] = gateCoefficients[layer.gates[unit]!]!
  return k === 0 ? c1 !== 0 || c3 !== 0 : c2 !== 0 || c3 !== 0
}

// live[wire] is true when some output bit depends on the wire.
export function liveWires(hard: HardNetwork): boolean[] {
  const live = new Array<boolean>(hard.wireCount).fill(false)
  const last = hard.layers[hard.layers.length - 1]!
  for (let unit = 0; unit < last.width; unit++) live[last.offset + unit] = true
  for (let l = hard.layers.length - 1; l >= 0; l--) {
    const layer = hard.layers[l]!
    for (let unit = 0; unit < layer.width; unit++) {
      if (!live[layer.offset + unit]!) continue
      for (let k = 0; k < layer.fanIn; k++) {
        if (readsWire(hard, layer, unit, k)) live[layer.wires[unit * layer.fanIn + k]!] = true
      }
    }
  }
  return live
}

// A counting unit [Σ P - Σ N >= t] as a named construction.
export function describeCountUnit(weights: ArrayLike<number>, threshold: number) {
  let positive = 0
  let negative = 0
  for (let k = 0; k < weights.length; k++) {
    if (weights[k] === 1) positive++
    else if (weights[k] === -1) negative++
  }
  if (positive < threshold) return 'constant 0'
  if (negative === 0) {
    if (positive === 1) return 'pass one wire'
    if (threshold === 1) return `or over ${positive}`
    if (threshold === positive) return `and over ${positive}`
    return `at least ${threshold} of ${positive}`
  }
  if (threshold === positive) return positive === 1 ? `one wire and none of ${negative}` : `and over ${positive}, none of ${negative}`
  return `${positive} positive, ${negative} negative, t = ${threshold}`
}

export function describeUnits(hard: HardNetwork) {
  const live = liveWires(hard)
  const totals: Record<string, number> = {}
  let liveCount = 0
  let widestRead = 0
  for (const layer of hard.layers) {
    for (let unit = 0; unit < layer.width; unit++) {
      if (!live[layer.offset + unit]!) continue
      liveCount++
      let name: string
      if (hard.kind === 'gate') {
        name = gateNames[layer.gates[unit]!]!
      } else {
        const weights = layer.weights.subarray(unit * layer.fanIn, (unit + 1) * layer.fanIn)
        name = describeCountUnit(weights, layer.thresholds[unit]!)
        widestRead = Math.max(widestRead, weights.reduce((total, weight) => total + (weight === 0 ? 0 : 1), 0))
      }
      totals[name] = (totals[name] ?? 0) + 1
    }
  }
  const kinds = Object.fromEntries(Object.entries(totals).sort((a, b) => b[1] - a[1]))
  return {liveUnits: liveCount, totalUnits: hard.layers.reduce((total, layer) => total + layer.width, 0), widestRead, kinds}
}

// With sharing, every live leader counting unit as a rule over positions
// relative to its own position p, e.g. "+x[p] -x[p-1] -x[p-2] >= 1". Hidden
// channels are named L<layer>c<channel>; the output groups are named by the
// output and member. Offsets come from comparing where members at different
// positions read (reads of the constant 0 past either end are skipped).
export function describeLeaders(hard: HardNetwork, task: Task) {
  if (hard.kind !== 'count') return []
  const P = task.positionCount
  const live = liveWires(hard)
  const markerStart = hard.sourceMode.findIndex((mode, wire) => wire >= task.inputCount && hard.sourceInput[wire] === -1 && (mode === SourceMode.one || mode === SourceMode.zero))
  const zeroWire = hard.sourceCount - 1
  const layerOf = (wire: number) => hard.layers.findIndex(layer => wire >= layer.offset && wire < layer.offset + layer.width)
  // A read wire as [name, position], position -1 for bits without one.
  const readOf = (wire: number): [string, number] | null => {
    if (wire < hard.sourceCount) {
      const input = hard.sourceInput[wire]!
      if (input >= 0) {
        const base = task.inputNames[input]!.replace(/\[\d+\]$/, '')
        return [hard.sourceMode[wire] === SourceMode.complement ? `not ${base}` : base, task.inputPositions[input]!]
      }
      if (markerStart >= 0 && wire !== zeroWire) return ['first control marker', wire - markerStart]
      return null
    }
    const m = layerOf(wire)
    const layer = hard.layers[m]!
    const unit = wire - layer.offset
    return [`L${m}c${Math.floor(unit / P)}`, layer.positions[unit]!]
  }
  const rules: string[] = []
  hard.layers.forEach((layer, l) => {
    const last = l === hard.layers.length - 1
    for (let unit = 0; unit < layer.width; unit++) {
      if (layer.leaders[unit] !== unit) continue
      const members = Array.from({length: layer.width}, (_, index) => index).filter(index => layer.leaders[index] === unit)
      if (members.length < 2 || !members.some(member => live[layer.offset + member]!)) continue
      const terms: string[] = []
      for (let k = 0; k < layer.fanIn; k++) {
        const weight = layer.weights[unit * layer.fanIn + k]!
        if (weight === 0) continue
        const reads: {name: string, relative: number | null}[] = []
        for (const member of members) {
          const read = readOf(layer.wires[member * layer.fanIn + k]!)
          if (read === null) continue
          const [name, position] = read
          reads.push({name, relative: position < 0 ? null : position - layer.positions[member]!})
        }
        if (reads.length === 0) continue
        // Raw offsets agree across members unless reads wrap around, e.g. a
        // cyclic read at offset -1 is position 3 for the member at position 0.
        const wraps = reads.some(read => read.relative !== reads[0]!.relative)
        const relative = reads[0]!.relative === null ? null : wraps ? (((reads[0]!.relative % P) + P) % P > P / 2 ? (((reads[0]!.relative % P) + P) % P) - P : ((reads[0]!.relative % P) + P) % P) : reads[0]!.relative
        const label = relative === null ? reads[0]!.name : `${reads[0]!.name}[p${relative === 0 ? '' : relative > 0 ? `+${relative}` : relative}]`
        terms.push(`${weight > 0 ? '+' : '-'}${label}`)
      }
      const name = last ? `output member ${unit % hard.groupSize}` : `L${l}c${Math.floor(unit / P)}`
      rules.push(`${name}: ${terms.join(' ')} >= ${layer.thresholds[unit]}`)
    }
  })
  return rules
}

function hashValues(values: Uint8Array, seed: number) {
  let hash = seed >>> 0
  for (let index = 0; index < values.length; index++) {
    hash ^= values[index]!
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash
}

function keyOf(values: Uint8Array) {
  return `${hashValues(values, 2166136261)}:${hashValues(values, 374761393)}`
}

// For every live unit, whether its values over every case equal a named
// predicate or its complement.
export function matchPredicates(hard: HardNetwork, task: Task) {
  const predicates = task.predicates()
  const byKey = new Map<string, {name: string, complement: boolean, values: Uint8Array}>()
  for (const predicate of predicates) {
    for (const complement of [false, true]) {
      const values = complement ? predicate.values.map(value => 1 - value) : predicate.values
      const key = keyOf(values)
      if (!byKey.has(key)) byKey.set(key, {name: predicate.name, complement, values})
    }
  }
  const {values} = evaluateHard(hard, task, null)
  const live = liveWires(hard)
  const matches: {layer: number, unit: number, name: string, complement: boolean}[] = []
  hard.layers.forEach((layer, l) => {
    for (let unit = 0; unit < layer.width; unit++) {
      if (!live[layer.offset + unit]!) continue
      const unitValues = values.subarray((layer.offset + unit) * task.caseCount, (layer.offset + unit + 1) * task.caseCount)
      const found = byKey.get(keyOf(unitValues))
      if (found === undefined || !found.values.every((value, index) => value === unitValues[index])) continue
      matches.push({layer: l, unit, name: found.name, complement: found.complement})
    }
  })
  const rediscovered = [...new Set(matches.map(match => match.name))]
  return {matchedUnits: matches.length, rediscovered, matches}
}
