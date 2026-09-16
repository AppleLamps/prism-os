import {describe, expect, test} from 'bun:test'
import {validateOneHotGroups} from '../../../numeric-ui-core.ts'
import {runScenario, scriptedTrace} from './differential.ts'
import {probeEdges} from './edge-probe.ts'
import {createGalleryMachine, initializeSource} from './gallery-app.ts'
import {buildGalleryCircuit} from './gallery-circuit.ts'
import {measureProgram} from './kit.ts'
import {photoGalleryData} from './photo-data.ts'
import {createReferenceGallery, loadFixturePhotos} from './reference.ts'
import {FakeBrowser} from './fake-dom.ts'

const built = buildGalleryCircuit(photoGalleryData)

test('photo-data.ts is the fixture data, 221 photos', () => {
  expect(photoGalleryData).toEqual(loadFixturePhotos())
  expect(photoGalleryData.length).toBe(221)
})

test('column count and box width match index.ts at every column boundary width', () => {
  const reference = createReferenceGallery(new FakeBrowser(1440, 900))
  const machine = createGalleryMachine(built)
  // The full program folds the box width into its consumers, so the box width is evaluated as its own root.
  const evaluateBoxWidth = built.circuit.createTensorEvaluator([built.outputs.boxMaxSizeX])
  const widths = [0, 23, 24, 100, 320, 390]
  for (let columns = 1; columns <= 8; columns++) widths.push(24 + 244 * columns - 1, 24 + 244 * columns, 24 + 244 * columns + 1)
  widths.push(512, 756, 1000, 1244, 1488, 1732, 2560, 3840, 16384)
  let largestRelativeError = 0
  for (const width of widths) {
    initializeSource(machine, photoGalleryData, Math.max(width, 1), 900, 0)
    machine.source[built.cells.windowSizeX] = width
    machine.source[built.cells.previousWindowSizeX] = width
    machine.source[built.cells.windowSizeY] = 900
    const boxWidth = evaluateBoxWidth(machine.source)[0]!
    machine.step()
    const expected = reference.colsBoxMaxSizeXF(width)
    expect(machine.read(built.outputs.columns)).toBe(expected.cols)
    // index.ts divides in float64; the circuit multiplies by an FP32 reciprocal, which rounds.
    largestRelativeError = Math.max(largestRelativeError, Math.abs(boxWidth - expected.boxMaxSizeX) / expected.boxMaxSizeX)
  }
  expect(largestRelativeError).toBeLessThan(2 ** -21)
})

test('2D hover and click differ from index.ts only for pointers between index.ts\'s box edge and the circuit\'s', () => {
  // One column at 500px, scrolled to the bottom, where row tops near 98,000px drift by about 0.18px.
  const result = probeEdges({built, width: 500, height: 900, scrollFraction: 1, maximumClickTrials: 8})
  expect(result.largestEdgeDrift).toBeGreaterThan(0.1)
  expect(result.pointsBetweenEdges).toBeGreaterThan(0)
  // Between the two versions of an edge, the circuit follows its own edge, so every such pointer disagrees.
  expect(result.hoverMismatchesBetweenEdges).toBe(result.pointsBetweenEdges)
  expect(result.clickTrialsBetweenEdges).toBe(result.pointsBetweenEdges)
  expect(result.clickMismatchesBetweenEdges).toBe(result.clickTrialsBetweenEdges)
  // Everywhere else the decisions agree.
  expect(result.hoverMismatches).toBe(result.hoverMismatchesBetweenEdges)
  expect(result.clickTrials).toBeGreaterThan(result.clickTrialsBetweenEdges)
  expect(result.clickMismatches).toBe(result.clickMismatchesBetweenEdges)
})

test('declared one-hot groups hold on evaluated values, and gathers are lowered', () => {
  const {stats} = measureProgram(built.circuit, built.roots)
  expect(stats.gatherReads).toBeGreaterThan(400)
  const machine = createGalleryMachine(built)
  initializeSource(machine, photoGalleryData, 1440, 900, 0)
  machine.source[built.cells.focusedIndex] = 17
  machine.source[built.cells.focusedPresent] = 1
  machine.source[built.cells.anchor] = 35
  machine.source[built.cells.keyArrowRight] = 1
  validateOneHotGroups(built.circuit, built.circuit.evaluateTensor(machine.source))
})

test('scripted trace: hover, open, arrows, resize while open, close, scroll, anchor, prompt click, edge rubber band', () => {
  const hashes: string[] = []
  const cursors: string[] = []
  const widths: number[] = []
  const scrollCalls: number[] = []
  let promptSelections = 0
  let edgeVelocity = 0
  const report = runScenario({
    seed: 0, frames: 420, width: 1440, height: 900, resync: false, built, script: scriptedTrace,
    onFrame: ({frame, reference}) => {
      hashes[frame] = reference.browser.hash
      cursors[frame] = String(reference.body.styleValues.get('cursor'))
      widths[frame] = reference.browser.clientWidth
      scrollCalls[frame] = reference.browser.scrollToCalls
      promptSelections = reference.browser.selectedNodes.length
      if (frame === 340) edgeVelocity = reference.data[photoGalleryData.length - 1]!.x.v
    },
  })
  if (report.decisionMismatches > 0) console.log(report.firstMismatches)
  expect(report.decisionMismatches).toBe(0)
  // The script must have done what it says, in the original.
  expect(cursors[60]).toBe('zoom-in')
  expect(hashes[70]).toBe(`#${photoGalleryData[5]!.id}`)
  expect(hashes[110]).toBe(`#${photoGalleryData[7]!.id}`)
  expect(hashes[120]).toBe(`#${photoGalleryData[6]!.id}`)
  expect(widths[130]).toBe(1024)
  expect(hashes[160]).toBe(`#${photoGalleryData[7]!.id}`)
  expect(cursors[190]).toBe('zoom-in')
  expect(hashes[200]).toBe('')
  expect(scrollCalls[260]!).toBeGreaterThan(scrollCalls[259]!)
  expect(promptSelections).toBe(1)
  expect(hashes[320]).toBe(`#${photoGalleryData.at(-1)!.id}`)
  expect(edgeVelocity).not.toBe(0)
  expect(hashes[380]).toBe('')
  expect(scrollCalls[380]!).toBeGreaterThan(scrollCalls[379]!)
  expect(hashes[400]).toBe(`#${photoGalleryData[10]!.id}`)
  expect(hashes[410]).toBe('')
  expect(report.errors['style transform']!.maximumAbsolute).toBeLessThan(0.1)
})

describe('differential traces against the native fixture', () => {
  const cases = [
    {seed: 1, width: 1440, height: 900, resync: false, durations: 'dyadic'},
    {seed: 2, width: 390, height: 844, resync: true, durations: 'dyadic'},
    {seed: 3, width: 2560, height: 1400, resync: false, durations: 'realistic'},
  ] as const
  for (const options of cases) {
    test(`seed ${options.seed}, ${options.width}x${options.height}, ${options.resync ? 'resync' : 'free-running'}, ${options.durations} frame times`, () => {
      const report = runScenario({...options, frames: 220, built})
      if (report.decisionMismatches > 0) console.log(report.firstMismatches)
      expect(report.decisionMismatches).toBe(0)
      expect(report.decisionChecks).toBeGreaterThan(40000)
      // The trace must actually exercise both modes, animation, and every event kind.
      expect(report.framesIn1D).toBeGreaterThan(20)
      expect(report.frames - report.framesIn1D).toBeGreaterThan(20)
      expect(report.animatingFrames).toBeGreaterThan(60)
      for (const kind of ['mousemove', 'click', 'key', 'resize']) expect(report.events[kind] ?? 0).toBeGreaterThan(0)
      // Continuous values drift by FP32 rounding. Strip and row positions are differences of prefix sums
      // that reach 100,000-260,000px, where FP32 values are 1/128-1/64px apart, so the bounds are absolute.
      expect(report.errors['destination x']!.maximumAbsolute).toBeLessThan(0.5)
      expect(report.errors['destination y']!.maximumAbsolute).toBeLessThan(0.5)
      expect(report.errors['style transform']!.maximumAbsolute).toBeLessThan(0.1)
      // Scroll adjustments come from row tops and anchors near 40,000px, where FP32 values are 1/256px apart.
      expect(report.errors['scroll position']!.maximumAbsolute).toBeLessThan(0.1)
      expect(report.errors['style width']!.maximumAbsolute).toBeLessThan(0.01)
    })
  }
})
