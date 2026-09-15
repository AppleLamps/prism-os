import {describe, expect, test} from 'bun:test'
import {createRandom, emitPrefixSums, measure, SourceLayout, type PrefixMode} from './common.ts'
import {checkList, demoRowHeights} from './checks.ts'
import {buildList} from './list.ts'

describe('virtualized list', () => {
  test('uniform rows: 10,000 rows into 24 stable slots match the occlusion loop, and the circuit does not grow with the row count', () => {
    const large = buildList({kind: 'uniform', rowCount: 10_000, rowHeight: 40, dataRead: 'js'})
    const small = buildList({kind: 'uniform', rowCount: 1_000, rowHeight: 40, dataRead: 'js'})
    const result = checkList(large, Array.from({length: 10_000}, () => 40), 600, 1)
    expect(result.firstMismatch).toBeUndefined()
    expect(result.averageVisibleRows).toBeGreaterThan(5)
    expect(measure(large.circuit, large.roots).liveOperations).toBe(measure(small.circuit, small.roots).liveOperations)
  })

  test('uniform rows with row data read through the slot one-hot', () => {
    const list = buildList({kind: 'uniform', rowCount: 2_000, rowHeight: 40, dataRead: 'oneHot'})
    expect(checkList(list, Array.from({length: 2_000}, () => 40), 300, 2).firstMismatch).toBeUndefined()
  })

  test('variable heights with a Brent-Kung prefix sum inside the circuit', () => {
    const list = buildList({kind: 'variable', rowCount: 2_000, minimumHeight: 36, maximumHeight: 72, prefix: 'brentKung', dataRead: 'js'})
    expect(checkList(list, demoRowHeights(2_000, 3, 36, 72), 300, 3).firstMismatch).toBeUndefined()
  })

  test('variable heights with bottoms from JS and row data through the one-hot', () => {
    const list = buildList({kind: 'variable', rowCount: 2_000, minimumHeight: 36, maximumHeight: 72, prefix: 'js', dataRead: 'oneHot'})
    expect(checkList(list, demoRowHeights(2_000, 4, 36, 72), 300, 4).firstMismatch).toBeUndefined()
  })
})

test('every prefix-sum mode is exact on quarter pixels, for counts that are not powers of two', () => {
  const random = createRandom(9)
  for (const count of [1, 2, 3, 7, 16, 33, 70]) {
    for (const mode of ['brentKung', 'chain', 'wide', 'blocked'] as PrefixMode[]) {
      const layout = new SourceLayout()
      const values = layout.cells(count, 0, 1024)
      const circuit = layout.createCircuit()
      const sums = emitPrefixSums(circuit, values, mode)
      const run = circuit.createTensorEvaluator(sums)
      for (let trial = 0; trial < 20; trial++) {
        const source = Float32Array.from({length: count}, () => Math.floor(random() * 4096) / 4)
        const outputs = run(source)
        let running = 0
        for (let index = 0; index < count; index++) {
          running += source[index]!
          expect(outputs[index]).toBe(running)
        }
      }
    }
  }
})
