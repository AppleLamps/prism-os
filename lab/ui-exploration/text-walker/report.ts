// Measurements for the README: circuit sizes, rough CPU timings, and agreement with pretext.
// Run: bun lab/ui-exploration/text-walker/report.ts [fast] [ladder] [flow] [springs]
// With no arguments it runs every part. The 1023-segment builds take tens of seconds.
import {Circuit} from '../../../numeric-ui-core.ts'
import {lineFitEpsilon, loadPretext, makeParagraph, viewPrepared} from './fake-canvas.ts'
import {fastMismatches} from './fast-check.ts'
import {
  buildGatheredLines,
  buildPointerJumping,
  buildSegmentScan,
  buildSegmentWalker,
  buildSequentialLines,
  fastParagraph,
  fastWindow,
  type FastBuild,
} from './fast-walker.ts'
import {buildFlowCircuit, referenceFlow, writeFlowState, writeSpringState, type FlowState} from './flow.ts'
import {medianMicroseconds, SourceTable, compile} from './kit.ts'
import {buildRowTable, buildRowsCircuit} from './rows-circuit.ts'
import {ladderSamples, testFont} from './samples.ts'
import {defaultSpringConfig, emitStepMatrix, emitWordSpring, iterateSpring} from './word-springs.ts'

const pretext = await loadPretext()
const requested = new Set(process.argv.slice(2))
const runPart = (name: string) => requested.size === 0 || requested.has(name)
const format = (value: number) => value.toLocaleString('en-US')
const printRow = (cells: (string | number)[]) => console.log(`| ${cells.map(cell => typeof cell === 'number' ? format(cell) : cell).join(' | ')} |`)

function timingIterations(liveOperations: number) {
  return Math.max(3, Math.min(2000, Math.floor(2e6 / liveOperations)))
}

// Integer one-hots cost about 2 atoms per position. An executor instruction that reads a table at an
// integer wire would replace each group by one operation; this estimate keeps everything else.
function withIndexRead(circuit: Circuit, liveOperations: number, oneHotOperations: number) {
  return liveOperations - oneHotOperations + circuit.oneHotGroups.length
}

if (runPart('fast')) {
  console.log('\n## Fast path, maxWidth 160..320, widths and break-after bits as runtime cells\n')
  printRow(['Segments', 'Formulation', 'Live ops', 'Layers', 'Stored weights', 'Gather reads', 'Gather table entries', 'One-hot ops', 'Estimate with an index read', 'Circuit µs', 'Build ms', 'Mismatches / widths'])
  printRow(Array(12).fill('---'))
  for (const words of [32, 128, 512]) {
    const prepared = pretext.prepareWithSegments(makeParagraph(words, 7), testFont)
    const paragraph = fastParagraph(prepared)
    const segmentCount = paragraph.widths.length
    const window = fastWindow(paragraph, 320, lineFitEpsilon)
    const lineSlots = pretext.walkLineRanges(prepared, 160, () => {})
    const options = {window, lineSlots, epsilon: lineFitEpsilon}
    const variants: [string, () => FastBuild][] = [
      ['next-start table + sequential lines', () => buildSequentialLines(paragraph, options)],
      ['gathered lines (per-line widths possible)', () => buildGatheredLines(paragraph, {...options, perLineWidths: false, segmentGeometry: false})],
      ['gathered lines + per-segment line index and x', () => buildGatheredLines(paragraph, {...options, perLineWidths: false, segmentGeometry: true})],
      ['next-start table + segment scan', () => buildSegmentScan(paragraph, options)],
      ['next-start table + pointer jumping', () => buildPointerJumping(paragraph, options)],
      ['segment walker (unrolled loop)', () => buildSegmentWalker(paragraph, {epsilon: lineFitEpsilon})],
    ]
    for (const [name, create] of variants) {
      if (name.includes('pointer jumping') && segmentCount > 300) continue
      if (name.includes('per-segment') && segmentCount > 300) continue
      const started = performance.now()
      const build = create()
      const buildMilliseconds = Math.round(performance.now() - started)
      const table = build.fc.source.table()
      let checked = 0
      let mismatches = 0
      for (let quarter = 640; quarter <= 1280; quarter += 16) {
        const maxWidth = quarter / 4 + (quarter % 32 === 0 ? 0 : 0.125)
        // Compares whichever outputs the formulation has; see fast-check.ts.
        if (fastMismatches(pretext, build, table, prepared, paragraph, maxWidth).length > 0) mismatches++
        checked++
      }
      table[build.fc.maxWidth] = 240
      const size = build.compiled.size
      const microseconds = medianMicroseconds(() => { build.compiled.evaluate(table) }, timingIterations(size.liveOperations))
      const share = size.oneHotOperations === 0 ? '0' : `${format(size.oneHotOperations)} (${Math.round(100 * size.oneHotOperations / size.liveOperations)}%)`
      // Segment geometry reads the one-hot relus themselves, so the index read estimate doesn't apply there.
      const estimate = name.includes('per-segment') ? '-' : withIndexRead(build.fc.circuit, size.liveOperations, size.oneHotOperations)
      printRow([segmentCount, name, size.liveOperations, size.layers, size.storedWeights, size.gatherReads, size.gatherTableEntries, share, estimate, microseconds, buildMilliseconds, `${mismatches} / ${checked}`])
    }
    const pretextMicroseconds = medianMicroseconds(() => { pretext.walkLineRanges(prepared, 240, () => {}) }, 5000)
    console.log(`| ${segmentCount} | pretext walkLineRanges at 240px, for scale | | | | | | | | ${pretextMicroseconds} | | |`)
    console.log(`<!-- ${segmentCount} segments: window ${window}, line slots ${lineSlots} -->`)
  }
}

if (runPart('ladder')) {
  console.log('\n## Feature ladder: rows circuit with per-line widths\n')
  printRow(['Step', 'Segments', 'Cursor units', 'Candidates per row (max)', 'Line slots', 'Live ops', 'Layers', 'Stored weights', 'Gather table entries', 'One-hot ops', 'Circuit µs', 'Mismatches, uniform widths', 'Mismatches, per-line widths'])
  printRow(Array(13).fill('---'))
  for (const sample of ladderSamples) {
    const prepared = pretext.prepareWithSegments(sample.text, testFont, sample.options)
    const view = viewPrepared(prepared)
    const table = buildRowTable(view, {emergencyFromWidth: sample.minWidth, maximumWidth: sample.maxWidth, epsilon: lineFitEpsilon})
    const lineSlots = pretext.walkLineRanges(prepared, sample.minWidth, () => {}) + 2
    const build = buildRowsCircuit(table, {lineSlots, epsilon: lineFitEpsilon, perLineWidths: true})
    const source = build.source.table()
    const {units} = table
    const compareLines = (widths: number[]) => {
      widths.forEach((width, line) => { source[build.lineWidthCells[line]!] = width })
      const expected: number[][] = []
      let cursor = {segmentIndex: 0, graphemeIndex: 0}
      for (const width of widths) {
        const range = pretext.layoutNextLineRange(prepared, cursor, width)
        if (range === null) break
        expected.push([units.index(range.start), units.index(range.end), Math.fround(range.width)])
        cursor = range.end
      }
      while (expected.length < lineSlots) expected.push([units.count, units.count, 0])
      const output = build.decode(build.compiled.evaluate(source))
      return output.moreLinesThanSlots !== 0 || JSON.stringify(output.lines.map(line => [line.start, line.end, line.width])) !== JSON.stringify(expected)
    }
    let uniformChecked = 0
    let uniformMismatches = 0
    const stride = Math.max(1, Math.floor((sample.maxWidth - sample.minWidth) * 4 / 300))
    for (let quarter = sample.minWidth * 4; quarter <= sample.maxWidth * 4; quarter += stride) {
      const width = quarter / 4 + (uniformChecked % 2 === 0 ? 0 : 0.125)
      // Uniform widths through the same per-line cells; sequential layoutNextLineRange at one width
      // gives the same lines as walkLineRanges.
      const walked: number[][] = []
      pretext.walkLineRanges(prepared, width, line => walked.push([units.index(line.start), units.index(line.end), Math.fround(line.width)]))
      const mismatch = compareLines(build.lineWidthCells.map(() => width))
      const stepped: number[][] = []
      let cursor = {segmentIndex: 0, graphemeIndex: 0}
      for (;;) {
        const range = pretext.layoutNextLineRange(prepared, cursor, width)
        if (range === null) break
        stepped.push([units.index(range.start), units.index(range.end), Math.fround(range.width)])
        cursor = range.end
      }
      uniformChecked++
      if (mismatch || JSON.stringify(walked) !== JSON.stringify(stepped)) uniformMismatches++
    }
    let random = 777
    const nextRandom = () => (random = (Math.imul(random, 1103515245) + 12345) >>> 0) / 2 ** 32
    let perLineMismatches = 0
    const trials = 200
    for (let trial = 0; trial < trials; trial++) {
      const widths = build.lineWidthCells.map(() => Math.floor(sample.minWidth * 4 + nextRandom() * (sample.maxWidth - sample.minWidth) * 4) / 4 + (trial % 2 === 0 ? 0 : 0.125))
      if (compareLines(widths)) perLineMismatches++
    }
    const size = build.compiled.size
    const microseconds = medianMicroseconds(() => { build.compiled.evaluate(source) }, timingIterations(size.liveOperations))
    printRow([sample.step, view.widths.length, units.count, table.steps, lineSlots, size.liveOperations, size.layers, size.storedWeights, size.gatherTableEntries, `${format(size.oneHotOperations)} (${Math.round(100 * size.oneHotOperations / size.liveOperations)}%)`, microseconds, `${uniformMismatches} / ${uniformChecked}`, `${perLineMismatches} / ${trials}`])
  }
}

if (runPart('flow')) {
  console.log('\n## Flow around a rectangle, with word springs\n')
  printRow(['Words', 'Segments', 'Bands', 'Springs', 'Live ops', 'Layers', 'Stored weights', 'Gather table entries', 'One-hot ops', 'Circuit µs', 'Mismatches / states', 'Frames to settle (first state)'])
  printRow(Array(12).fill('---'))
  for (const words of [48, 96]) {
    const prepared = pretext.prepareWithSegments(makeParagraph(words, 3), testFont)
    const paragraph = fastParagraph(prepared)
    const textSegments = paragraph.breakAfter.flatMap((bit, index) => bit === 0 ? [index] : [])
    const columnWidth = 360
    const geometry = {top: 0, lineHeight: 20, bandCount: words === 48 ? 18 : 32, horizontalPadding: 8, verticalPadding: 4, minimumSlotWidth: 80}
    const window = fastWindow(paragraph, columnWidth, lineFitEpsilon)
    for (const springs of [false, true]) {
      const build = buildFlowCircuit(paragraph, {...geometry, window, epsilon: lineFitEpsilon, springSegments: springs ? textSegments : null})
      const table = build.fc.source.table()
      let random = 99
      const nextRandom = () => (random = (Math.imul(random, 1103515245) + 12345) >>> 0) / 2 ** 32
      let mismatches = 0
      let framesToSettle = 0
      const states = springs ? 10 : 200
      for (let trial = 0; trial < states; trial++) {
        const state: FlowState = {
          columnLeft: 20,
          columnWidth,
          obstacleX: Math.floor(nextRandom() * 420) - 60,
          obstacleY: Math.floor(nextRandom() * geometry.bandCount * 20) - 60,
          obstacleWidth: 40 + Math.floor(nextRandom() * 200),
          obstacleHeight: 20 + Math.floor(nextRandom() * 160),
        }
        writeFlowState(build, table, state)
        let outputs = build.decode(build.compiled.evaluate(table))
        if (springs) {
          table[build.cells.stepCount] = 4
          let frames = 0
          for (; frames < 2000 && outputs.springs.some(spring => spring.active !== 0); frames++) {
            writeSpringState(build, table, outputs)
            outputs = build.decode(build.compiled.evaluate(table))
          }
          if (trial === 0) framesToSettle = frames
        }
        const reference = referenceFlow(pretext.layoutNextLineRange as never, prepared, paragraph, state, geometry)
        let bad = outputs.windowOverflow !== 0 || outputs.runOverflow !== 0
        reference.bands.forEach((band, index) => {
          const actual = outputs.bands[index]!
          if (actual.usable !== (band.usable ? 1 : 0)) bad = true
          if (band.line !== null && (actual.start !== band.line.start.segmentIndex || actual.lineWidth !== Math.fround(band.line.width))) bad = true
        })
        textSegments.forEach((segment, index) => {
          const expected = reference.segments[segment]!
          const actual = outputs.segments[segment]!
          if (actual.visible !== (expected.visible ? 1 : 0) || (expected.visible && (actual.x !== Math.fround(expected.x) || actual.y !== expected.y))) bad = true
          const spring = outputs.springs[index]
          if (springs && expected.visible && (spring!.x !== Math.fround(expected.x) || spring!.y !== expected.y)) bad = true
        })
        if (bad) mismatches++
      }
      const size = build.compiled.size
      const microseconds = medianMicroseconds(() => { build.compiled.evaluate(table) }, timingIterations(size.liveOperations))
      printRow([words, paragraph.widths.length, geometry.bandCount, springs ? textSegments.length * 2 : 0, size.liveOperations, size.layers, size.storedWeights, size.gatherTableEntries, `${format(size.oneHotOperations)} (${Math.round(100 * size.oneHotOperations / size.liveOperations)}%)`, microseconds, `${mismatches} / ${states}`, springs ? framesToSettle : '-'])
    }
  }
}

if (runPart('springs')) {
  console.log('\n## Word springs: marginal cost and drift\n')
  const config = defaultSpringConfig
  const sizes: number[] = []
  for (const springCount of [1, 64]) {
    const source = new SourceTable()
    const stepCount = source.cell(0, 0, 2 ** config.stepBits - 1)
    const springCells = Array.from({length: springCount}, () => [source.cell(0, -32768, 32768), source.cell(0, -1e6, 1e6), source.cell(0, -32768, 32768)] as const)
    const circuit = source.createCircuit()
    const matrix = emitStepMatrix(circuit, source.unit, stepCount, config)
    const roots = springCells.flatMap(([position, velocity, target]) => {
      const spring = emitWordSpring(circuit, matrix, position, velocity, target, config)
      return [spring.position, spring.velocity, spring.active]
    })
    const compiled = compile(circuit, roots)
    sizes.push(compiled.size.liveOperations)
    console.log(`${springCount} springs: ${format(compiled.size.liveOperations)} live ops, ${compiled.size.layers} layers, ${format(compiled.size.storedWeights)} stored weights`)
    if (springCount === 1) {
      // Drift of one spring against float64 iteration, with snapping off by comparing while active.
      const table = source.table()
      let random = 5
      const nextRandom = () => (random = (Math.imul(random, 1103515245) + 12345) >>> 0) / 2 ** 32
      let worst = 0
      for (let trial = 0; trial < 5000; trial++) {
        const displacement = Math.floor((nextRandom() * 2 - 1) * 2000)
        const velocity = Math.floor((nextRandom() * 2 - 1) * 20000)
        const steps = Math.floor(nextRandom() * 2 ** config.stepBits)
        table[springCells[0]![0]] = 1000 + displacement
        table[springCells[0]![1]] = velocity
        table[springCells[0]![2]] = 1000
        table[stepCount] = steps
        const output = compiled.evaluate(table)
        const [expectedDisplacement] = iterateSpring(displacement, velocity, steps, config)
        if (output[2] === 1) worst = Math.max(worst, Math.abs(output[0]! - 1000 - expectedDisplacement))
      }
      console.log(`largest position drift against float64 iteration over 5000 random states and step counts: ${worst.toPrecision(3)} px`)
    }
  }
  console.log(`marginal cost per spring: ${((sizes[1]! - sizes[0]!) / 63).toFixed(1)} live ops`)
}
