import {describe, expect, test} from 'bun:test'
import {validateGrids} from '../../../../../../numeric-ui-core.ts'
import {createBothEvaluators, createRandom, measureProgram, randomInteger} from './kit.ts'
import {buildDuplicatedList, buildListStages, listReference, runListStages, unpackDuplicatedOutputs, type ListRow} from './one-program-per-item.ts'

describe('one program per item', () => {
  test('the staged list in both evaluators equals the duplicated circuit in both evaluators and the plain loop', () => {
    const random = createRandom(31)
    const stages = buildListStages()
    let hoveredFrames = 0
    let edgeFrames = 0
    for (const rowCount of [1, 2, 7, 64]) {
      const duplicated = buildDuplicatedList(rowCount)
      const evaluateDuplicated = createBothEvaluators(duplicated.circuit, duplicated.roots)
      for (let trial = 0; trial < 40; trial++) {
        const rows: ListRow[] = Array.from({length: rowCount}, () => ({
          lineCount: random() < 0.2 ? 0 : randomInteger(random, 1, 12),
          expanded: random() < 0.6 ? 1 : 0,
        }))
        // A fifth of the trials have no header, so collapsed rows are 0 px tall.
        const headerHeight = trial % 5 === 0 ? 0 : randomInteger(random, 64, 160) / 4
        const lineHeight = randomInteger(random, 64, 96) / 4
        const layout = listReference({headerHeight, lineHeight, scrollTop: 0, viewportHeight: 0, pointerY: 0}, rows)
        const edges = layout.rowTops.flatMap((rowTop, row) => [rowTop, rowTop + layout.rowHeights[row]!])
        const contentHeight = edges.at(-1)!
        // Half the time scrollTop and pointerY land on a row edge, or one quarter pixel to either side.
        const nearEdge = () => edges[randomInteger(random, 0, edges.length - 1)]! + randomInteger(random, -1, 1) / 4
        const scrollTop = Math.max(0, random() < 0.5 ? nearEdge() : randomInteger(random, 0, contentHeight * 4) / 4)
        const viewportHeight = trial % 7 === 0 ? 0 : randomInteger(random, 0, 600 * 4) / 4
        const pointerY = random() < 0.5 ? nearEdge() : randomInteger(random, -160, (contentHeight + 40) * 4) / 4
        if (edges.includes(pointerY) || edges.includes(scrollTop)) edgeFrames++
        const shared = {headerHeight, lineHeight, scrollTop, viewportHeight, pointerY}
        const expected = listReference(shared, rows)
        if (expected.anyHovered === 1) hoveredFrames++
        expect(runListStages(stages, shared, rows, 'reference')).toEqual(expected)
        expect(runListStages(stages, shared, rows, 'compiled')).toEqual(expected)
        const source = Float32Array.from([headerHeight, lineHeight, scrollTop, viewportHeight, pointerY, ...rows.flatMap(row => [row.lineCount, row.expanded])])
        const {outputs, values} = evaluateDuplicated(source)
        expect(unpackDuplicatedOutputs(outputs, rowCount)).toEqual(expected)
        if (trial % 10 === 0) validateGrids(duplicated.circuit, values)
      }
    }
    expect(hoveredFrames).toBeGreaterThan(40)
    expect(edgeFrames).toBeGreaterThan(40)
  })

  test('sizes quoted in the doc', () => {
    const stages = buildListStages()
    expect(measureProgram(stages.rowHeightStage.circuit, stages.rowHeightStage.roots)).toMatchObject({liveOperations: 3, layers: 3})
    expect(measureProgram(stages.placementStage.circuit, stages.placementStage.roots)).toMatchObject({liveOperations: 12, layers: 4})
    expect(stages.placementStage.circuit.roundingPoints().every(point => point.kind === 'integer bit')).toBe(true)
    for (const [rowCount, liveOperations, layers] of [[8, 117, 15], [64, 901, 71], [512, 7173, 519]] as const) {
      const duplicated = buildDuplicatedList(rowCount)
      expect(measureProgram(duplicated.circuit, duplicated.roots)).toMatchObject({liveOperations, layers})
      expect(duplicated.circuit.roundingPoints().every(point => point.kind === 'integer bit')).toBe(true)
    }
  })
})
