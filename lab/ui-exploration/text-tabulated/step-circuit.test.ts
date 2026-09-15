import {expect, test} from 'bun:test'
import {createRandom, float32Bits, float32FromBits} from './float32.ts'
import {SourceLayout, emitAtLeast, maximumWidth, smallestExactThreshold} from './step-circuit.ts'

test('[width >= threshold] is exact within 3 ulps of every threshold, for thresholds 0 and 2^-10..8192', () => {
  const random = createRandom(4)
  const raw = [0, smallestExactThreshold, maximumWidth]
  for (let exponent = -10; exponent <= 13; exponent++) for (const offset of [-1, 0, 1]) raw.push(float32FromBits(float32Bits(2 ** exponent) + offset))
  for (let index = 0; index < 300; index++) raw.push(2 ** (-10 + random() * 3))
  for (let index = 0; index < 300; index++) raw.push(maximumWidth * random())
  const thresholds = [...new Set(raw.map(value => Math.fround(value)))]
    .filter(value => value === 0 || (value >= smallestExactThreshold && value <= maximumWidth))
  const source = new SourceLayout()
  const width = source.cell('width', 0, 0, maximumWidth)
  const circuit = source.createCircuit()
  const bits = thresholds.map(threshold => emitAtLeast(circuit, width, threshold))
  const evaluate = circuit.createTensorEvaluator(bits)
  const input = source.table()
  const widths = new Set<number>([0, maximumWidth])
  for (const threshold of thresholds) {
    for (let offset = -3; offset <= 3; offset++) {
      const candidateBits = float32Bits(threshold) + offset
      if (candidateBits < 0) continue
      const candidate = float32FromBits(candidateBits)
      if (candidate >= 0 && candidate <= maximumWidth) widths.add(candidate)
    }
  }
  let wrong = 0
  for (const testWidth of widths) {
    input[width] = testWidth
    const output = evaluate(input)
    for (let index = 0; index < thresholds.length; index++) if (output[index] !== (testWidth >= thresholds[index]! ? 1 : 0)) wrong++
  }
  expect(thresholds.length).toBeGreaterThan(600)
  expect(wrong).toBe(0)
  // Below the bound the builder refuses: at 2^-11, one ulp under the threshold rounds to a score of 0.5.
  expect(() => emitAtLeast(source.createCircuit(), width, 2 ** -11)).toThrow()
})
