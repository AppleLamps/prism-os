// Checks pointer-jumping.ts against the walk over random and adversarial paragraphs,
// in both evaluators, and pins the sizes and the table that patterns/pointer-jumping.md quotes.
// Run from the repo root: bun test lab/ui-exploration/guide/examples/patterns/combining-steps
import {describe, expect, test} from 'bun:test'
import {validateIndexReads} from '../../../../../../numeric-ui-core.ts'
import {createRandom, evaluateBoth, measureProgram} from './measure.ts'
import {type LineStartsForm, buildLineStarts, greedyNextStarts, jumpLineStarts, walkLineStarts} from './pointer-jumping.ts'

const forms: readonly LineStartsForm[] = ['walk', 'pointer jumping']

function randomWidths(random: () => number, segmentCount: number) {
  return Array.from({length: segmentCount}, () => 20 + Math.floor(random() * 61))
}

// Adversarial next-start tables for a paragraph of segmentCount segments.
function adversarialTables(segmentCount: number): number[][] {
  return [
    // Every segment on its own line, e.g. words wider than the line.
    Array.from({length: segmentCount}, (_, segment) => segment + 1),
    // One line holds the whole paragraph.
    Array<number>(segmentCount).fill(segmentCount),
    // Segments that fill a 160 px line exactly: 4 × 40 px.
    greedyNextStarts(Array<number>(segmentCount).fill(40), 160),
    // A long line, then lines of one segment.
    Array.from({length: segmentCount}, (_, segment) => (segment === 0 ? Math.min(segmentCount, 5) : segment + 1)),
  ]
}

function expectMatchesWalk(segmentCount: number, lineSlots: number, tables: readonly number[][]) {
  for (const form of forms) {
    const built = buildLineStarts(segmentCount, lineSlots, form)
    const evaluate = built.circuit.createTensorEvaluator(built.roots)
    for (const [index, nextStart] of tables.entries()) {
      const {outputs, values} = evaluateBoth(built.circuit, evaluate, built.roots, Float32Array.from(nextStart))
      if (index < 4) validateIndexReads(built.circuit, values)
      const expected = walkLineStarts(nextStart, lineSlots)
      expect(outputs).toEqual([...expected.starts, expected.lineCount])
    }
  }
}

describe('following links by doubling', () => {
  test('pointer jumping in plain JavaScript matches the walk', () => {
    const random = createRandom(11)
    for (let paragraph = 0; paragraph < 300; paragraph++) {
      const segmentCount = 1 + Math.floor(random() * 80)
      const lineSlots = 1 + Math.floor(random() * 40)
      const nextStart = greedyNextStarts(randomWidths(random, segmentCount), 160)
      const jumped = jumpLineStarts(nextStart, lineSlots)
      expect({starts: jumped.starts, lineCount: jumped.lineCount}).toEqual(walkLineStarts(nextStart, lineSlots))
    }
  })

  test('both circuits match the walk on random and adversarial paragraphs, with more and fewer line slots than lines', () => {
    const random = createRandom(13)
    for (const [segmentCount, lineSlotCounts] of [[1, [1, 2, 3]], [2, [1, 2, 5]], [10, [1, 2, 5, 8, 12]], [15, [8]], [63, [8, 32, 40]]] as const) {
      const tables = adversarialTables(segmentCount)
      for (let paragraph = 0; paragraph < 60; paragraph++) {
        tables.push(greedyNextStarts(randomWidths(random, segmentCount), 160))
      }
      for (const lineSlots of lineSlotCounts) expectMatchesWalk(segmentCount, lineSlots, tables)
    }
  })

  test('1,023 segments into 157 line slots', () => {
    const random = createRandom(19)
    const tables = adversarialTables(1023)
    for (let paragraph = 0; paragraph < 8; paragraph++) {
      // Wider lines, so the paragraph has about as many lines as slots.
      tables.push(greedyNextStarts(randomWidths(random, 1023), 320))
    }
    expectMatchesWalk(1023, 157, tables)
  })

  test("the doc's table: 10 segments, 5 line slots", () => {
    const nextStart = [3, 3, 4, 6, 6, 8, 9, 9, 10, 10]
    const jumped = jumpLineStarts(nextStart, 5)
    expect(jumped.jumps).toEqual([
      [3, 3, 4, 6, 6, 8, 9, 9, 10, 10, 10],
      [6, 6, 6, 9, 9, 10, 10, 10, 10, 10, 10],
      [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
    ])
    expect(jumped.starts).toEqual([0, 3, 6, 9, 10])
    // The circuit's tables hold the same positions, without the past-the-end entry.
    const built = buildLineStarts(10, 5, 'pointer jumping')
    const values = built.circuit.evaluateReference(Float32Array.from(nextStart))
    expect(built.jumps.map(level => level.map(wire => values[wire]))).toEqual(jumped.jumps.map(level => level.slice(0, 10)))
    expect(built.roots.map(wire => values[wire])).toEqual([0, 3, 6, 9, 10, 4])
  })

  test('sizes quoted in the doc', () => {
    const size = (segmentCount: number, lineSlots: number, form: LineStartsForm) => {
      const built = buildLineStarts(segmentCount, lineSlots, form)
      const {operations, layers, indexReads} = measureProgram(built.circuit, built.roots)
      return `${segmentCount} segments, ${lineSlots} line slots, ${form}: ${operations} operations, ${layers} layers, ${indexReads} index reads`
    }
    expect([[63, 32], [1023, 157]].flatMap(([segmentCount, lineSlots]) => forms.map(form => size(segmentCount!, lineSlots!, form)))).toEqual([
      '63 segments, 32 line slots, walk: 94 operations, 32 layers, 30 index reads',
      '63 segments, 32 line slots, pointer jumping: 342 operations, 7 layers, 278 index reads',
      '1023 segments, 157 line slots, walk: 469 operations, 157 layers, 155 index reads',
      '1023 segments, 157 line slots, pointer jumping: 7623 operations, 10 layers, 7309 index reads',
    ])
  })
})
