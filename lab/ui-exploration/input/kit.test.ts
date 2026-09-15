import {expect, test} from 'bun:test'
import {Circuit} from '../../../numeric-ui-core.ts'
import {createKit, createRandom, randomInteger} from './kit.ts'

test('integer decisions, picks, and clamps are exact across the coordinate range', () => {
  const circuit = new Circuit(3)
  circuit.assumeRange(0, -4096, 4096)
  circuit.assumeRange(1, -4096, 4096)
  circuit.assumeRange(2, 0, 1)
  const kit = createKit(circuit)
  const atLeast = kit.atLeast([[0, 1], [1, -1]], 1)
  const equal = kit.equals([[0, 1], [1, -1]], 0)
  const picked = kit.pick(2, 0, 1)
  const clamped = kit.clamp(0, [[kit.one, -100]], 1)
  const chebyshev = kit.chebyshev(0, 1)
  const random = createRandom(5)
  for (let trial = 0; trial < 2000; trial++) {
    const a = randomInteger(random, -4096, 4096)
    const b = randomInteger(random, -4096, 4096)
    const gate = randomInteger(random, 0, 1)
    const values = circuit.evaluateTensor(new Float32Array([a, b, gate]))
    expect(values[atLeast]).toBe(a > b ? 1 : 0)
    expect(values[equal]).toBe(a === b ? 1 : 0)
    expect(values[picked]).toBe(gate === 1 ? b : a)
    expect(values[clamped]).toBe(Math.min(Math.max(a, -100), b))
    expect(values[chebyshev]).toBe(Math.max(Math.abs(a), Math.abs(b)))
  }
})

// A bit written as relu(v + 1 - t) - relu(v - t) is a small affine, so the
// builder copies its two relu terms into every consumer. A consumer that scales
// the bit scales the relus too. For v around 2^18 and a scale of 2^18, the
// consumer's partial sums pass 2^24 and round, so `score + 2^18 * (1 - bit)`
// is no longer an exact integer. Replacing the score with `pick` never scales
// a relu, and stays exact.
test('scaling a composed bit by 2^18 rounds; picking the replacement stays exact', () => {
  const penalty = 262144
  const circuit = new Circuit(2)
  circuit.assumeRange(0, -24576, 24576)
  circuit.assumeRange(1, 0, 300000)
  const kit = createKit(circuit)
  const threshold = penalty + 1
  const bit = kit.atLeast([[1, 1]], threshold)
  const added = circuit.affine([[0, 1], [bit, -penalty]], penalty)
  const picked = kit.pick(bit, [[kit.one, penalty]], 0)
  const random = createRandom(9)
  let addedWrong = 0
  let pickedWrong = 0
  for (let trial = 0; trial < 2000; trial++) {
    const score = randomInteger(random, -24576, 24576)
    const measure = randomInteger(random, 0, 300000)
    const reached = measure >= threshold
    const values = circuit.evaluateTensor(new Float32Array([score, measure]))
    if (values[added] !== score + penalty * (reached ? 0 : 1)) addedWrong++
    if (values[picked] !== (reached ? score : penalty)) pickedWrong++
  }
  expect(addedWrong).toBeGreaterThan(100)
  expect(pickedWrong).toBe(0)
})

// kit.atLeast keeps a bit as its own rounding point when its relus can pass
// 2^19, so a consumer may scale it by up to 16. The same bit composed into the
// consumer rounds.
test('a large-range bit scaled by 16 is exact only when it is its own rounding point', () => {
  const circuit = new Circuit(2)
  circuit.assumeRange(0, -24576, 24576)
  circuit.assumeRange(1, 0, 4000000)
  const kit = createKit(circuit)
  const threshold = 1000
  const composedBit = circuit.affine([
    [circuit.reglu([], 1, [[1, 1]], 1 - threshold), 1],
    [circuit.reglu([], 1, [[1, 1]], -threshold), -1],
  ])
  const guardedBit = kit.atLeast([[1, 1]], threshold)
  const composed = circuit.affine([[0, 1], [composedBit, 16]])
  const guarded = circuit.affine([[0, 1], [guardedBit, 16]])
  const random = createRandom(13)
  let composedWrong = 0
  let guardedWrong = 0
  for (let trial = 0; trial < 2000; trial++) {
    const score = randomInteger(random, -24576, 24576)
    const measure = randomInteger(random, 0, 4000000)
    const expected = score + (measure >= threshold ? 16 : 0)
    const values = circuit.evaluateTensor(new Float32Array([score, measure]))
    if (values[composed] !== expected) composedWrong++
    if (values[guarded] !== expected) guardedWrong++
  }
  expect(composedWrong).toBeGreaterThan(100)
  expect(guardedWrong).toBe(0)
})
