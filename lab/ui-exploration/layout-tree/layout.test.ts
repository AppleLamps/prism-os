import {describe as suite, expect, test} from 'bun:test'
import {allocateLayoutSources, buildLayout, createLayoutReader, writeLayoutSources} from './builder.ts'
import {createRandom, SourceTable} from './circuit-tools.ts'
import {compareLayouts} from './compare.ts'
import {waterFill} from './ops.ts'
import {randomInputs, randomScene} from './random-tree.ts'
import {layoutReference, lineCount, solveWaterLevel} from './reference.ts'
import {greedyLineCount, greedyTextTable} from './text-table.ts'
import {grow, padding, row, text, validateTree, type TextTable} from './tree.ts'

suite('water filling', () => {
  test('matches a sorted-breakpoint solve on random children', () => {
    const random = createRandom(11)
    let worst = 0
    for (let trial = 0; trial < 300; trial++) {
      const count = 1 + Math.floor(random() * 7)
      // FP32 values, so the reference sees exactly what the source table holds.
      const lows = Array.from({length: count}, () => Math.fround(Math.floor(random() * 200) + (random() < 0.5 ? random() : 0)))
      const highs = lows.map(low => random() < 0.4 ? Number.POSITIVE_INFINITY : Math.fround(low + Math.floor(random() * 300)))
      const excess = Math.fround(-100 + random() * 900)
      const table = new SourceTable()
      const lowCells = lows.map((_, index) => table.cell(`low${index}`, lows[index]!, 0, 1000))
      const highCells = highs.map((high, index) => Number.isFinite(high) ? table.cell(`high${index}`, high, 0, 2000) : null)
      const excessCell = table.cell('excess', excess, -2000, 2000)
      const circuit = table.createCircuit()
      const sizes = waterFill(circuit, lowCells.map((low, index) => ({low, high: highCells[index]!})), [[excessCell, 1]], 0)
      const values = circuit.evaluateTensor(table.createValues())
      const expected = solveWaterLevel(lows, highs, lows.reduce((sum, low) => sum + low, 0) + excess)
      sizes.forEach((wire, index) => { worst = Math.max(worst, Math.abs(values[wire]! - expected[index]!)) })
    }
    expect(worst).toBeLessThan(1e-3)
  })
})

suite('text tables', () => {
  test('a tabulated greedy word wrap agrees with the word wrap itself', () => {
    const random = createRandom(21)
    let checked = 0
    let mismatches = 0
    for (let trial = 0; trial < 40; trial++) {
      const wordWidths = Array.from({length: 1 + Math.floor(random() * 20)}, () => 10 + random() * 90)
      const spaceWidth = 3 + random() * 3
      const table = greedyTextTable(wordWidths, spaceWidth)
      expect(table.thresholds.length).toBeLessThanOrEqual(wordWidths.length - 1)
      for (let sample = 0; sample < 200; sample++) {
        const width = table.minWidth + random() * (table.naturalWidth + 20 - table.minWidth)
        checked++
        if (lineCount(table, width) !== greedyLineCount(wordWidths, spaceWidth, width)) mismatches++
      }
    }
    expect(checked).toBe(8000)
    expect(mismatches).toBe(0)
  })
})

suite('random widget trees', () => {
  test('the circuit matches the JS reference on random trees and viewports', () => {
    const random = createRandom(5)
    let worstDrift = 0
    let worstLabel = ''
    const mismatches: string[] = []
    let discreteCompared = 0
    for (let seed = 1; seed <= 60; seed++) {
      const scene = randomScene(seed)
      validateTree(scene.root)
      const table = new SourceTable()
      const sources = allocateLayoutSources(table, scene.root, {inputBounds: scene.inputBounds})
      const circuit = table.createCircuit()
      const reader = createLayoutReader(buildLayout(circuit, scene.root, sources))
      const evaluate = circuit.createTensorEvaluator(reader.roots)
      for (let trial = 0; trial < 15; trial++) {
        const inputs = randomInputs(scene, random)
        const values = table.createValues()
        writeLayoutSources(values, sources, inputs, scene.tables)
        const difference = compareLayouts(layoutReference(scene.root, inputs, scene.tables), reader.read(evaluate(values)))
        discreteCompared += difference.discreteCompared
        if (difference.maxDrift > worstDrift) {
          worstDrift = difference.maxDrift
          worstLabel = `seed ${seed} ${JSON.stringify(inputs)} ${difference.worst}`
        }
        mismatches.push(...difference.discreteMismatches.map(label => `seed ${seed}: ${label}`))
      }
    }
    expect(mismatches).toEqual([])
    expect(discreteCompared).toBeGreaterThan(500)
    if (worstDrift >= 0.01) console.log(worstLabel)
    expect(worstDrift).toBeLessThan(0.01)
  })
})

suite('water filling in a wide row', () => {
  test('16 grow texts match the JS reference over a sweep of widths, with free children in both fills', () => {
    const count = 16
    const maxWidthOf = (index: number) => index % 3 === 0 ? Number.POSITIVE_INFINITY : 60 + (index * 53) % 200
    const tables = new Map<string, TextTable>()
    const root = row({name: 'root', width: grow(), height: grow(), padding: padding(8), gap: 8},
      Array.from({length: count}, (_, index) => {
        const naturalWidth = 20 + (index * 7) % 30
        tables.set(`text${index}`, {naturalWidth, minWidth: 10, baseLines: 1, thresholds: [13, (10 + naturalWidth) / 2]})
        return text(`child${index}`, `text${index}`, {width: grow(0, maxWidthOf(index)), lineHeight: 20, capacity: 2})
      }))
    const table = new SourceTable()
    const sources = allocateLayoutSources(table, root)
    const circuit = table.createCircuit()
    const reader = createLayoutReader(buildLayout(circuit, root, sources))
    const evaluate = circuit.createTensorEvaluator(reader.roots)
    let worstDrift = 0
    let discreteCompared = 0
    const mismatches: string[] = []
    // Widths at which some text sits strictly between its min and natural width (shrink),
    // or strictly between its natural width and its max (grow).
    let shrinkWidths = 0
    let growWidths = 0
    for (let viewportWidth = 100; viewportWidth <= 3000; viewportWidth += 7.25) {
      const inputs = {viewportWidth, viewportHeight: 400}
      const values = table.createValues()
      writeLayoutSources(values, sources, inputs, tables)
      const expected = layoutReference(root, inputs, tables)
      const difference = compareLayouts(expected, reader.read(evaluate(values)))
      worstDrift = Math.max(worstDrift, difference.maxDrift)
      discreteCompared += difference.discreteCompared
      mismatches.push(...difference.discreteMismatches)
      const widths = Array.from({length: count}, (_, index) => expected.rects.get(`child${index}`)!.width)
      const naturalOf = (index: number) => tables.get(`text${index}`)!.naturalWidth
      if (widths.some((width, index) => width > 10 + 1e-6 && width < naturalOf(index) - 1e-6)) shrinkWidths++
      if (widths.some((width, index) => width > naturalOf(index) + 1e-6 && width < maxWidthOf(index) - 1e-6)) growWidths++
    }
    expect(mismatches).toEqual([])
    expect(discreteCompared).toBeGreaterThan(5000)
    expect(worstDrift).toBeLessThan(0.01)
    expect(shrinkWidths).toBeGreaterThan(20)
    expect(growWidths).toBeGreaterThan(100)
  })
})
