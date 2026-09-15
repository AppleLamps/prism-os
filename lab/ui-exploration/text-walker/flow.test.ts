import {expect, test} from 'bun:test'
import {SourceTable, compile} from './kit.ts'
import {lineFitEpsilon, loadPretext, makeParagraph} from './fake-canvas.ts'
import {fastParagraph, fastWindow} from './fast-walker.ts'
import {buildFlowCircuit, referenceFlow, writeFlowState, writeSpringState, type FlowBuild, type FlowOutputs, type FlowState} from './flow.ts'
import {defaultSpringConfig, emitStepMatrix, stepMatrixPowers} from './word-springs.ts'
import {testFont} from './samples.ts'

const pretext = await loadPretext()
const prepared = pretext.prepareWithSegments(makeParagraph(48, 3), testFont)
const paragraph = fastParagraph(prepared)
const textSegments = paragraph.breakAfter.flatMap((bit, index) => bit === 0 ? [index] : [])
const columnWidth = 360
const geometry = {top: 0, lineHeight: 20, bandCount: 18, horizontalPadding: 8, verticalPadding: 4, minimumSlotWidth: 80}
const window = fastWindow(paragraph, columnWidth, lineFitEpsilon)

function nextRandomFrom(seed: number) {
  let random = seed
  return () => (random = (Math.imul(random, 1103515245) + 12345) >>> 0) / 2 ** 32
}

function randomState(nextRandom: () => number): FlowState {
  return {
    columnLeft: 20,
    columnWidth,
    obstacleX: Math.floor(nextRandom() * 420) - 60,
    obstacleY: Math.floor(nextRandom() * 400) - 60,
    obstacleWidth: 40 + Math.floor(nextRandom() * 200),
    obstacleHeight: 20 + Math.floor(nextRandom() * 160),
  }
}

function settle(build: FlowBuild, table: Float32Array): {outputs: FlowOutputs, frames: number} {
  table[build.cells.stepCount] = 4
  for (let frames = 1; frames <= 1000; frames++) {
    const outputs = build.decode(build.compiled.evaluate(table))
    writeSpringState(build, table, outputs)
    if (outputs.springs.every(spring => spring.active === 0)) return {outputs, frames}
  }
  throw new Error('springs did not settle')
}

test('a paragraph flowing around a rectangle matches dynamic-layout layoutColumn', () => {
  const build = buildFlowCircuit(paragraph, {...geometry, window, epsilon: lineFitEpsilon, springSegments: null})
  const table = build.fc.source.table()
  const nextRandom = nextRandomFrom(99)
  const failures: unknown[] = []
  for (let trial = 0; trial < 60; trial++) {
    const state = randomState(nextRandom)
    writeFlowState(build, table, state)
    const outputs = build.decode(build.compiled.evaluate(table))
    const reference = referenceFlow(pretext.layoutNextLineRange as never, prepared, paragraph, state, geometry)
    const problems: string[] = []
    if (outputs.windowOverflow !== 0) problems.push('window overflow')
    if (outputs.runOverflow !== 0) problems.push('run overflow')
    reference.bands.forEach((band, index) => {
      const actual = outputs.bands[index]!
      if (actual.usable !== (band.usable ? 1 : 0)) problems.push(`band ${index} usable`)
      if (band.usable && (actual.left !== band.left || actual.slotWidth !== band.slotWidth)) problems.push(`band ${index} slot`)
      if (band.line !== null && (actual.start !== band.line.start.segmentIndex || actual.lineWidth !== Math.fround(band.line.width))) problems.push(`band ${index} line`)
    })
    for (const segment of textSegments) {
      const expected = reference.segments[segment]!
      const actual = outputs.segments[segment]!
      if (actual.visible !== (expected.visible ? 1 : 0) || (expected.visible && (actual.x !== Math.fround(expected.x) || actual.y !== expected.y))) problems.push(`segment ${segment}`)
    }
    if (problems.length > 0) failures.push({state, problems: problems.slice(0, 4)})
  }
  expect(failures).toEqual([])
})

test('word springs settle exactly on the positions layoutWithLines gives', () => {
  const build = buildFlowCircuit(paragraph, {...geometry, window, epsilon: lineFitEpsilon, springSegments: textSegments})
  const table = build.fc.source.table()
  // The rectangle sits outside the column, so every band is the full column width.
  writeFlowState(build, table, {columnLeft: 20, columnWidth, obstacleX: -2000, obstacleY: 0, obstacleWidth: 100, obstacleHeight: 100})
  const {outputs} = settle(build, table)
  const layout = pretext.layoutWithLines(prepared, columnWidth, geometry.lineHeight)
  const expected = new Map<number, [number, number]>()
  layout.lines.forEach((line, index) => {
    let x = 20
    for (let segment = line.start.segmentIndex; segment < line.end.segmentIndex; segment++) {
      expected.set(segment, [x, index * geometry.lineHeight])
      x += paragraph.widths[segment]!
    }
  })
  const failures: unknown[] = []
  textSegments.forEach((segment, index) => {
    const position = expected.get(segment)!
    const spring = outputs.springs[index]!
    if (spring.x !== Math.fround(position[0]) || spring.y !== position[1] || spring.velocityX !== 0 || spring.velocityY !== 0) failures.push({segment, spring, position})
  })
  expect(layout.lineCount).toBeLessThanOrEqual(geometry.bandCount)
  expect(failures).toEqual([])
})

test('word springs follow the flow when the rectangle moves, and settle on the reference', () => {
  const build = buildFlowCircuit(paragraph, {...geometry, window, epsilon: lineFitEpsilon, springSegments: textSegments})
  const table = build.fc.source.table()
  const nextRandom = nextRandomFrom(4242)
  const failures: unknown[] = []
  for (let trial = 0; trial < 3; trial++) {
    const state = randomState(nextRandom)
    writeFlowState(build, table, state)
    const {outputs} = settle(build, table)
    const reference = referenceFlow(pretext.layoutNextLineRange as never, prepared, paragraph, state, geometry)
    textSegments.forEach((segment, index) => {
      const expected = reference.segments[segment]!
      const spring = outputs.springs[index]!
      if (expected.visible && (spring.x !== Math.fround(expected.x) || spring.y !== expected.y)) failures.push({trial, segment})
    })
  }
  expect(failures).toEqual([])
})

test('the shared step matrix is within 1e-5 of float64 matrix powers for every step count', () => {
  const source = new SourceTable()
  const stepCount = source.cell(0, 0, 2 ** defaultSpringConfig.stepBits - 1)
  const circuit = source.createCircuit()
  const matrix = emitStepMatrix(circuit, source.unit, stepCount, defaultSpringConfig)
  const compiled = compile(circuit, [...matrix])
  const table = source.table()
  const powers = stepMatrixPowers(defaultSpringConfig)
  let worst = 0
  for (let steps = 0; steps < 2 ** defaultSpringConfig.stepBits; steps++) {
    let expected = [1, 0, 0, 1]
    for (let bit = 0; bit < defaultSpringConfig.stepBits; bit++) {
      if ((steps >> bit & 1) === 0) continue
      const power = powers[bit]!
      expected = [
        expected[0]! * power[0] + expected[1]! * power[2],
        expected[0]! * power[1] + expected[1]! * power[3],
        expected[2]! * power[0] + expected[3]! * power[2],
        expected[2]! * power[1] + expected[3]! * power[3],
      ]
    }
    table[stepCount] = steps
    const output = compiled.evaluate(table)
    for (let entry = 0; entry < 4; entry++) worst = Math.max(worst, Math.abs(output[entry]! - expected[entry]!))
  }
  expect(worst).toBeLessThan(1e-5)
})
