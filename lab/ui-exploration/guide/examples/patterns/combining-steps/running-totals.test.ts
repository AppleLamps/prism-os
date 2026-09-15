// Checks running-totals.ts against the loop over random and adversarial heights, in
// both evaluators, and pins the sizes that patterns/running-totals.md quotes.
// Run from the repo root: bun test lab/ui-exploration/guide/examples/patterns/combining-steps
import {describe, expect, test} from 'bun:test'
import {createRandom, evaluateBoth, measureProgram} from './measure.ts'
import {type RunningTotalsForm, buildRunningTotals, runningTotalsBrentKungLoop, runningTotalsLoop} from './running-totals.ts'

const forms: readonly RunningTotalsForm[] = ['chain', 'wide sums', 'brent-kung']

// Builds a form once for a row count, and returns a function that evaluates a list of
// heights in both evaluators and returns the totals.
function createRunner(rowCount: number, form: RunningTotalsForm) {
  const built = buildRunningTotals(rowCount, form)
  const evaluate = built.circuit.createTensorEvaluator(built.totals)
  return (heights: ArrayLike<number>) => evaluateBoth(built.circuit, evaluate, built.totals, Float32Array.from(heights)).outputs
}

function compareTotals(actual: readonly number[], expected: readonly number[]) {
  let differing = 0
  let largest = 0
  actual.forEach((total, row) => {
    if (total !== expected[row]) differing++
    largest = Math.max(largest, Math.abs(total - expected[row]!))
  })
  return {differing, largest}
}

describe('running totals', () => {
  test('on quarter-pixel heights with totals up to 2^22 px, every form equals the loop bit for bit', () => {
    const random = createRandom(1)
    for (const rowCount of [1, 2, 3, 5, 8, 17, 64, 200]) {
      // The largest quarter-pixel height that keeps the content height within 2^22 px.
      const tallest = Math.floor((2 ** 22 / rowCount) * 4) / 4
      const lists: number[][] = [
        Array<number>(rowCount).fill(0),
        Array<number>(rowCount).fill(tallest),
        Array<number>(rowCount).fill(0.25),
        Array.from({length: rowCount}, (_, row) => (row % 2 === 0 ? tallest : 0)),
        Array.from({length: rowCount}, (_, row) => (row === rowCount - 1 ? 2 ** 22 : 0)),
      ]
      for (let trial = 0; trial < 30; trial++) {
        lists.push(Array.from({length: rowCount}, () => Math.round(random() * 600) / 4))
      }
      for (const form of forms) {
        const run = createRunner(rowCount, form)
        for (const heights of lists) expect(run(heights)).toEqual(runningTotalsLoop(heights))
      }
    }
  })

  test('on fractional heights, the chain and the wide sums equal the loop bit for bit, and Brent-Kung equals the same network in JavaScript', () => {
    const random = createRandom(3)
    for (const rowCount of [5, 17, 64, 200]) {
      const lists: Float32Array[] = []
      for (let trial = 0; trial < 20; trial++) {
        lists.push(Float32Array.from({length: rowCount}, () => Math.fround(10 + 150 * random())))
      }
      // Mixed magnitudes, where every addition rounds.
      const mixed = Float32Array.from({length: rowCount}, (_, row) => Math.fround(row % 2 === 0 ? 1e6 * random() : 0.1 * random()))
      const runs = Object.fromEntries(forms.map(form => [form, createRunner(rowCount, form)] as const))
      let brentKungDiffering = 0
      let brentKungLargest = 0
      for (const heights of [...lists, mixed]) {
        const loop = runningTotalsLoop(heights)
        expect(runs['chain']!(heights)).toEqual(loop)
        expect(runs['wide sums']!(heights)).toEqual(loop)
        const brentKung = runs['brent-kung']!(heights)
        expect(brentKung).toEqual(runningTotalsBrentKungLoop(heights))
        if (heights !== mixed) {
          const {differing, largest} = compareTotals(brentKung, loop)
          brentKungDiffering += differing
          brentKungLargest = Math.max(brentKungLargest, largest)
        }
      }
      if (rowCount >= 64) expect(brentKungDiffering).toBeGreaterThan(0)
      expect(brentKungLargest).toBeLessThan(0.01)
    }
  })

  test('the grouping example: heights 229, 167.4, 208.5 and 194.4 px', () => {
    const heights = [229, 167.4, 208.5, 194.4]
    expect(runningTotalsLoop(Float32Array.from(heights))[3]).toBe(799.300048828125)
    expect(createRunner(4, 'chain')(heights)[3]).toBe(799.300048828125)
    expect(createRunner(4, 'wide sums')(heights)[3]).toBe(799.300048828125)
    expect(createRunner(4, 'brent-kung')(heights)[3]).toBe(799.2999877929688)
  })

  test('past 2^24, integer heights depend on the grouping too', () => {
    // 2^24 + 1 isn't an FP32 value, so the loop drops every 1, while Brent-Kung adds 1 + 1 first.
    const heights = [2 ** 24, 1, 1, 1]
    expect(runningTotalsLoop(heights)).toEqual([2 ** 24, 2 ** 24, 2 ** 24, 2 ** 24])
    expect(createRunner(4, 'chain')(heights)).toEqual([2 ** 24, 2 ** 24, 2 ** 24, 2 ** 24])
    expect(createRunner(4, 'brent-kung')(heights)).toEqual([2 ** 24, 2 ** 24, 2 ** 24, 2 ** 24 + 2])
  })

  test('at 10,000 rows, Brent-Kung drifts less from float64 sums than the loop', () => {
    const random = createRandom(11)
    const rowCount = 10_000
    const heights = Float32Array.from({length: rowCount}, () => Math.fround(20 + 280 * random()))
    const exactTotals: number[] = []
    let exact = 0
    for (const height of heights) exactTotals.push(exact += height)
    const chain = createRunner(rowCount, 'chain')(heights)
    const brentKung = createRunner(rowCount, 'brent-kung')(heights)
    expect(chain).toEqual(runningTotalsLoop(heights))
    expect(Math.round(exact)).toBe(1_598_516)
    expect(compareTotals(chain, exactTotals).largest.toFixed(2)).toBe('5.67')
    expect(compareTotals(brentKung, exactTotals).largest.toFixed(2)).toBe('0.26')
  })

  test('sizes quoted in the doc', () => {
    const size = (rowCount: number, form: RunningTotalsForm) => {
      const built = buildRunningTotals(rowCount, form)
      const {operations, layers, storedWeights} = measureProgram(built.circuit, built.totals)
      return `${rowCount} rows, ${form}: ${operations} operations, ${layers} layers, ${storedWeights} weights`
    }
    expect([size(8, 'chain'), size(8, 'brent-kung')]).toEqual([
      '8 rows, chain: 7 operations, 7 layers, 14 weights',
      '8 rows, brent-kung: 11 operations, 4 layers, 22 weights',
    ])
    expect([64, 1024].flatMap(rowCount => forms.map(form => size(rowCount, form)))).toEqual([
      '64 rows, chain: 63 operations, 63 layers, 126 weights',
      '64 rows, wide sums: 63 operations, 1 layers, 2079 weights',
      '64 rows, brent-kung: 120 operations, 10 layers, 240 weights',
      '1024 rows, chain: 1023 operations, 1023 layers, 2046 weights',
      '1024 rows, wide sums: 1023 operations, 1 layers, 524799 weights',
      '1024 rows, brent-kung: 2036 operations, 18 layers, 4072 weights',
    ])
  })
})
