// Random circuits for differential tests of the backends in this folder.
import {
  Circuit,
  type Wire,
  emitArgmax,
  emitFirstActive,
  emitMaximum,
  emitMinimum,
  emitRelu,
} from '../../../src/runtime/numeric-ui-core.ts'

export function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

export function clampZeroOne(circuit: Circuit, value: Wire, unit: Wire) {
  const positive = emitRelu(circuit, value)
  const aboveOne = emitRelu(circuit, circuit.affine([[value, 1], [unit, -1]]))
  const result = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(result, 0, 1)
  return result
}

export const randomSourceSize = 12

// A random circuit over every atom and macro, with one declared one-hot group
// in the source table plus argmax and first-active selections, so gather
// lowering, gates, booleans and preserved rounding all show up in the program.
// Source layout: 0..3 one-hot group, 4..7 values in -1000..1000, 8 and 9 in
// 0..1, 10 the unit, 11 an open range (Infinity and huge values allowed).
//
// With keepContracts, clamp scores only read wires whose declared magnitude is
// at most 2^18, so every clamp holds its 0..1 plateau, booleans are exact bits,
// and declared one-hot groups are true. Without it, a clamp over a product of
// products can leave 0..1 (the composed clamp plateau ends at 2^23), a "bit"
// can be 2, and a gather read then differs from the dense sum the reference
// evaluator computes. The executor and generated code must still agree then.
export function buildRandomCircuit(seed: number, options: {operationCount?: number, keepContracts?: boolean, allowInfiniteSource?: boolean} = {}) {
  const operationCount = options.operationCount ?? 70
  const keepContracts = options.keepContracts ?? true
  const allowInfiniteSource = options.allowInfiniteSource ?? !keepContracts
  const random = createRandom(seed)
  const circuit = new Circuit(randomSourceSize)
  const oneHot = [0, 1, 2, 3]
  circuit.assumeOneHot(oneHot)
  for (let wire = 4; wire < 8; wire++) circuit.assumeRange(wire, -1000, 1000)
  circuit.assumeRange(8, 0, 1)
  circuit.assumeRange(9, 0, 1)
  circuit.assumeRange(10, 1, 1)
  const unit = 10
  const bounded: Wire[] = [4, 5, 6, 7, 8, 9]
  const small: Wire[] = [4, 5, 6, 7, 8, 9]
  const unitInterval: Wire[] = [8, 9]
  const all: Wire[] = [...bounded, 11]
  const scoreInputs = keepContracts ? small : bounded
  const pick = (wires: readonly Wire[]) => wires[Math.floor(random() * wires.length)]!
  const coefficient = () => {
    const choice = random()
    if (choice < 0.3) return 1
    if (choice < 0.45) return -1
    if (choice < 0.55) return 0.5
    return Math.fround((random() - 0.5) * 8)
  }
  const bias = () => {
    const choice = random()
    if (choice < 0.4) return 0
    if (choice < 0.5) return -0
    return Math.fround((random() - 0.5) * 100)
  }
  const terms = (wires: readonly Wire[], count: number) =>
    Array.from({length: count}, () => [pick(wires), coefficient()] as [Wire, number])
  const remember = (wire: Wire) => {
    all.push(wire)
    const range = circuit.ranges[wire]!
    if (Number.isFinite(range.minimum) && Number.isFinite(range.maximum)) bounded.push(wire)
    if (Math.max(Math.abs(range.minimum), Math.abs(range.maximum)) <= 2 ** 18) small.push(wire)
    if (range.minimum >= 0 && range.maximum <= 1) unitInterval.push(wire)
    return wire
  }
  for (let operation = 0; operation < operationCount; operation++) {
    const choice = Math.floor(random() * 11)
    switch (choice) {
      case 0: remember(circuit.affine(terms(all, 1 + Math.floor(random() * 6)), bias())); break
      case 1: remember(circuit.roundAffine(terms(all, 1 + Math.floor(random() * 6)), bias())); break
      case 2: remember(circuit.reglu(terms(all, Math.floor(random() * 3)), bias(), terms(all, 1 + Math.floor(random() * 3)), bias())); break
      case 3: remember(circuit.multiply(pick(all), pick(all))); break
      case 4: remember(circuit.select(pick(unitInterval), pick(all), pick(all))); break
      case 5: remember(emitMinimum(circuit, pick(all), pick(all))); break
      case 6: remember(emitMaximum(circuit, pick(all), pick(all))); break
      case 7: remember(circuit.boolean(clampZeroOne(circuit, circuit.roundAffine(terms(scoreInputs, 2), bias()), unit))); break
      case 8: {
        // A masked read of the source one-hot group, which lowers to a gather.
        const readTerms = oneHot.map(bit => [circuit.multiply(bit, pick(bounded)), 1] as [Wire, number])
        remember(circuit.affine(readTerms))
        break
      }
      case 9: {
        const scores = Array.from({length: 3}, () => clampZeroOne(circuit, circuit.roundAffine(terms(scoreInputs, 2)), unit))
        const {selected} = emitArgmax(circuit, scores, unit)
        remember(circuit.affine(selected.map(bit => [circuit.multiply(bit, pick(bounded)), 1] as [Wire, number])))
        break
      }
      case 10: {
        const candidates = Array.from({length: 3}, () => circuit.boolean(clampZeroOne(circuit, circuit.roundAffine(terms(scoreInputs, 2)), unit)))
        const selected = emitFirstActive(circuit, circuit.boolean(pick([8, 9])), candidates)
        remember(circuit.affine(selected.map(bit => [circuit.multiply(bit, pick(bounded)), 1] as [Wire, number])))
        break
      }
    }
  }
  const sources = Array.from({length: 16}, () => randomSource(random, !allowInfiniteSource))
  return {circuit, sources, all}
}

// The builder's ranges don't track NaN: Math.max(0, NaN) is NaN, yet relu of a
// wire with an unbounded range gets the range 0..Infinity, and a later product
// with a finite left side gets a finite range while holding NaN. Gather
// lowering trusts finite ranges, so a NaN candidate makes the executor and the
// reference differ. With finiteOpenSource the open source cell stays within
// ±1e6, which keeps Infinity (and so NaN) out of most circuits.
export function randomSource(random: () => number, finiteOpenSource = false) {
  const source = new Float32Array(randomSourceSize)
  source[Math.floor(random() * 4)] = 1
  for (let wire = 4; wire < 8; wire++) {
    const choice = random()
    source[wire] = choice < 0.1 ? -0 : choice < 0.2 ? 0 : Math.fround((random() - 0.5) * 2000)
  }
  source[8] = random() < 0.5 ? Math.round(random()) : Math.fround(random())
  source[9] = Math.fround(random())
  source[10] = 1
  const openChoice = random()
  source[11] = finiteOpenSource
    ? Math.fround((random() - 0.5) * 2e6)
    : openChoice < 0.1 ? Number.POSITIVE_INFINITY : openChoice < 0.2 ? -3e38 : Math.fround((random() - 0.5) * 1e6)
  return source
}
