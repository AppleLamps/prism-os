// Checks every example in atoms.ts against the plain JavaScript it replaces, and pins the compiled sizes the guide quotes.
import {expect, test} from 'bun:test'
import {Circuit, asWire} from '../../../../../numeric-ui-core.ts'
import * as atoms from './atoms.ts'
import {emitAtLeast, measure} from './helpers.ts'

// Both evaluators on the same inputs. The inputs pass through a Float32Array first, like a real source table.
function evaluate(example: {circuit: Circuit, output: number}, inputs: readonly number[]) {
  const source = Float32Array.from(inputs)
  const tensor = example.circuit.evaluateTensor(source)[example.output]!
  const reference = example.circuit.evaluateReference(source)[example.output]!
  expect(tensor === reference || (Number.isNaN(tensor) && Number.isNaN(reference))).toBe(true)
  return {value: tensor, stored: [...source]}
}

function* grid(...axes: readonly (readonly number[])[]): Generator<number[]> {
  if (axes.length === 0) {
    yield []
    return
  }
  for (const value of axes[0]!) for (const rest of grid(...axes.slice(1))) yield [value, ...rest]
}

const float32 = new Float32Array(1)
const float32Bits = new Uint32Array(float32.buffer)
// The neighboring FP32 value above (direction 1) or below (direction -1) a nonzero FP32 value.
function neighborFloat32(value: number, direction: 1 | -1) {
  float32[0] = value
  float32Bits[0] = float32Bits[0]! + ((value > 0) === (direction > 0) ? 1 : -1)
  return float32[0]
}

function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 2 ** 32
  }
}

test('an affine sum, a ReLU, a masked product and the boolean atom are one operation each', () => {
  const trackCenter = atoms.trackCenter()
  for (const inputs of grid([0, 12.5, 614, 16_384], [0, 52, 1024])) {
    const {value, stored} = evaluate(trackCenter, inputs)
    expect(value).toBe(trackCenter.reference(stored[0]!, stored[1]!))
  }
  const scrollOverflow = atoms.scrollOverflow()
  for (const inputs of grid([0, 800, 1200.25, 1_048_576], [0, 800, 16_384])) {
    const {value, stored} = evaluate(scrollOverflow, inputs)
    expect(value).toBe(scrollOverflow.reference(stored[0]!, stored[1]!))
  }
  const hoverOpacity = atoms.hoverOpacity()
  for (const inputs of grid([0, 1], [0, Math.fround(0.4), 1])) {
    const {value, stored} = evaluate(hoverOpacity, inputs)
    expect(value).toBe(hoverOpacity.reference(stored[0]!, stored[1]!))
  }
  const roundScore = atoms.roundScore()
  const belowHalf = neighborFloat32(0.5, -1)
  for (const score of [0, 0.25, belowHalf, 0.5, 0.75, 1]) {
    expect(evaluate(roundScore, [score]).value).toBe(roundScore.reference(Math.fround(score)))
  }
  expect(evaluate(roundScore, [0.5]).value).toBe(1)
  expect(evaluate(roundScore, [belowHalf]).value).toBe(0)
  for (const example of [trackCenter, scrollOverflow, hoverOpacity, roundScore]) {
    const size = measure(example.circuit, [example.output])
    expect([size.liveOperations, size.layers]).toEqual([1, 1])
  }
  // The track center stores its 2 coefficients.
  expect(measure(trackCenter.circuit, [trackCenter.output]).storedWeights).toBe(2)
})

test('select returns exactly one side at a 0 or 1 gate, in 4 operations and 3 layers', () => {
  const thumbColor = atoms.thumbColor()
  for (const inputs of grid([0, 1], [-1e30, 0.1, 210], [1e-7, 45, 1e30])) {
    const {value, stored} = evaluate(thumbColor, inputs)
    expect(value).toBe(thumbColor.reference(stored[0]!, stored[1]!, stored[2]!))
  }
  expect(measure(thumbColor.circuit, [thumbColor.output])).toEqual({liveOperations: 4, layers: 3, storedWeights: 7})
})

test('min matches Math.min on integers, and drifts by less than one FP32 step on mixed magnitudes', () => {
  const panelWidth = atoms.panelWidth()
  for (const inputs of grid([0, 32, 360, 1248, 16_384], [0, 31, 360, 1280, 16_384])) {
    const {value, stored} = evaluate(panelWidth, inputs)
    expect(value).toBe(panelWidth.reference(stored[0]!, stored[1]!))
  }
  // min(1000.37, 0.3) rebuilds 0.3 through the difference 1000.07, which FP32 holds on a grid of 2^-14.
  const {value} = evaluate(panelWidth, [1000.37, 0.3])
  expect(value).toBe(0.29998779296875)
  expect(value).not.toBe(Math.fround(0.3))
  expect(Math.abs(value - Math.fround(0.3))).toBeLessThan(2 ** -14)
  expect(measure(panelWidth.circuit, [panelWidth.output])).toEqual({liveOperations: 3, layers: 3, storedWeights: 5})
})

test('a clamp between runtime bounds costs 7 operations, because min and max keep the constant 0 as its own wire', () => {
  const clampWindowLeft = atoms.clampWindowLeft()
  for (const inputs of grid([-500, 0, 300, 1000, 16_384], [0, 728, 16_384])) {
    const {value, stored} = evaluate(clampWindowLeft, inputs)
    expect(value).toBe(clampWindowLeft.reference(stored[0]!, stored[1]!))
  }
  expect(measure(clampWindowLeft.circuit, [clampWindowLeft.output])).toEqual({liveOperations: 7, layers: 7, storedWeights: 10})
  const fillAmount = atoms.fillAmount()
  for (const position of [-1_048_576, -5, -0.25, 0, 0.3, 1, 1.5, 1_048_576]) {
    const {value, stored} = evaluate(fillAmount, [position])
    expect(value).toBe(fillAmount.reference(stored[0]!))
  }
  expect(measure(fillAmount.circuit, [fillAmount.output])).toEqual({liveOperations: 3, layers: 2, storedWeights: 4})
})

test('an exact comparison on continuous values gives the correct bit for neighboring FP32 values, in 4 operations and 3 layers', () => {
  const pointerPastTrackLeft = atoms.pointerPastTrackLeft()
  let compared = 0
  const check = (pointerX: number, trackLeft: number) => {
    const {value, stored} = evaluate(pointerPastTrackLeft, [pointerX, trackLeft])
    expect(value).toBe(pointerPastTrackLeft.reference(stored[0]!, stored[1]!))
    compared++
  }
  for (const trackLeft of [0.5, 614, 8166.5, 16_384]) {
    for (const pointerX of [trackLeft, neighborFloat32(trackLeft, 1), neighborFloat32(trackLeft, -1), trackLeft - 1 / 64, trackLeft + 1 / 64, -16_384, 16_384]) {
      if (Math.abs(pointerX) <= 16_384) check(pointerX, trackLeft)
    }
  }
  check(1 / 64, 0)
  check(-1 / 64, 0)
  check(0, 0)
  // Random pointers on the 1/64 px grid the host quantizes to.
  const random = seededRandom(7)
  for (let sample = 0; sample < 20_000; sample++) {
    const trackLeft = Math.round(random() * 16_384 * 2) / 2
    const pointerX = Math.min(16_384, Math.max(-16_384, trackLeft + Math.round((random() - 0.5) * 64 * 64) / 64))
    check(pointerX, trackLeft)
  }
  expect(compared).toBe(20_029)
  expect(measure(pointerPastTrackLeft.circuit, [pointerPastTrackLeft.output])).toEqual({liveOperations: 4, layers: 3, storedWeights: 6})
  // Without declared ranges there is no bound on the difference, so the helper throws while building.
  expect(() => emitAtLeast(new Circuit(2), asWire(0), asWire(1), 64)).toThrow()
})

test('an integer comparison is 3 operations and 2 layers', () => {
  const atLeastThreeColumns = atoms.atLeastThreeColumns()
  for (let columnCount = 0; columnCount <= 64; columnCount++) {
    expect(evaluate(atLeastThreeColumns, [columnCount]).value).toBe(atLeastThreeColumns.reference(columnCount))
  }
  expect(measure(atLeastThreeColumns.circuit, [atLeastThreeColumns.output])).toEqual({liveOperations: 3, layers: 2, storedWeights: 4})
})

test('the side a select does not pick still computes, so an overflow turns into NaN', () => {
  const selectAfterOverflow = atoms.selectAfterOverflow()
  expect(Number.isNaN(evaluate(selectAfterOverflow, [0, 1e30]).value)).toBe(true)
  expect(selectAfterOverflow.reference(0, Math.fround(1e30))).toBe(1)
  expect(evaluate(selectAfterOverflow, [1, 1e30]).value).toBe(Number.POSITIVE_INFINITY)
  expect(evaluate(selectAfterOverflow, [0, 1000]).value).toBe(1)
})

test('declaring the timestep nonnegative turns a 3-operation product into 1 operation with the same values', () => {
  const declared = atoms.velocityTimesTimestep(true)
  const open = atoms.velocityTimesTimestep(false)
  expect(measure(declared.circuit, [declared.output])).toEqual({liveOperations: 1, layers: 1, storedWeights: 2})
  expect(measure(open.circuit, [open.output])).toEqual({liveOperations: 3, layers: 2, storedWeights: 6})
  for (const inputs of grid([-1_048_576, -250.5, 0, 3.25, 1_048_576], [0, Math.fround(0.004), Math.fround(0.008)])) {
    const {value, stored} = evaluate(declared, inputs)
    expect(value).toBe(declared.reference(stored[0]!, stored[1]!))
    // Equal apart from the sign of zero: the signed form computes -0 - (-0) = +0 where the one-operation form gives -0.
    expect(evaluate(open, inputs).value === value).toBe(true)
  }
  expect(evaluate(open, [100, -0.5]).value).toBe(-50)
})

test('a duration computed from absolute timestamps in FP32 cells is a multiple of 0.5 ms from about 70 minutes after load', () => {
  const duration = atoms.frameDurationFromTimestamps()
  expect(measure(duration.circuit, [duration.output])).toEqual({liveOperations: 1, layers: 1, storedWeights: 2})
  // 2^22 ms is 69.9 minutes. From there, a Float32Array stores timestamps on a 0.5 ms grid.
  expect(Math.fround(2 ** 22 + 0.3)).toBe(2 ** 22 + 0.5)
  expect(evaluate(duration, [4_194_320.9, 4_194_304.3]).value).toBe(16.5)
  expect(duration.reference(4_194_320.9, 4_194_304.3)).toBeCloseTo(16.6, 6)
  // One minute after load the grid is 1/256 ms, so the same frame measures within 1/256 ms of 16.6.
  expect(Math.abs(evaluate(duration, [60_016.6, 60_000]).value - 16.6)).toBeLessThan(1 / 256)
})

test('a small affine is copied into the ordinary affine that reads it, and an identical expression returns the same wire', () => {
  const {circuit, windowTop, buttonTop, closeBottom, sameButtonTop} = atoms.buttonTopReadTwice()
  expect(sameButtonTop).toBe(buttonTop)
  const operation = circuit.operations[closeBottom - circuit.sourceSize]!
  expect(operation.leftTerms).toEqual([[windowTop, 1]])
  expect(operation.leftBias).toBe(31)
  expect(measure(circuit, [closeBottom]).liveOperations).toBe(1)
})
