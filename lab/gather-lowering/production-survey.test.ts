import {expect, test} from 'bun:test'
import {
  validateOneHotGroups,
  validateTensorEvaluation,
} from '../../numeric-ui-core.ts'
import {createCandidateGalleryMachine} from '../../candidate-gallery.ts'
import {createWindowManagerMachine} from '../../window-manager.ts'
import {createRandom, gatherStatistics, randomInteger} from './measure.ts'

// Production impact: the builders now declare finite pixel-space ranges and
// the window manager declares its stack permutation contracts, so recognition
// engages on the committed circuits. These tests pin the counts and confirm
// the lowered programs stay bit-identical to the reference across interaction
// traces.

test('candidate-gallery lowers its 26 layout selection reads', () => {
  const machine = createCandidateGalleryMachine()
  const {circuit} = machine
  const lowered = gatherStatistics(machine.tensorProgram)
  const plain = gatherStatistics(
    circuit.compileTensorProgram([...machine.tensorProgram.roots], false),
  )
  // One declared group: the argmax winner (the click selection's gate is a
  // product of 0..1-range wires, not a provably exact bit, so emitFirstActive
  // leaves it undeclared). Preserved multiplication metadata also retains the
  // constant-zero Contact member of the hero sums, so those reads now lower.
  expect(circuit.oneHotGroups.length).toBe(1)
  expect(lowered.readCount).toBe(26)
  expect(lowered.slotCount).toBe(1)
  expect(lowered.storedWeightCount).toBeLessThan(plain.storedWeightCount)
  console.log(
    `[survey] candidate-gallery: groups=${circuit.oneHotGroups.length}`
      + ` gatherReads=${lowered.readCount} slots=${lowered.slotCount}`
      + ` storedWeights=${lowered.storedWeightCount}`
      + ` (dense compile of the same roots: ${plain.storedWeightCount})`,
  )

  // Interaction trace: resizes and clicks, every frame compared wire-for-wire
  // against the reference evaluator, with the declared group checked exactly.
  const random = createRandom(0xca11)
  const viewports = [
    [1280, 800], [700, 900], [420, 700], [1600, 500], [900, 900],
  ] as const
  for (let step = 0; step < 60; step++) {
    const [width, height] = viewports[step % viewports.length]!
    if (step % 4 === 2) {
      machine.click(randomInteger(random, width), randomInteger(random, height))
    }
    machine.source[0] = width
    machine.source[1] = height
    const reference = circuit.evaluateReference(machine.source)
    validateOneHotGroups(circuit, reference)
    const values = circuit.evaluateTensor(machine.source)
    validateTensorEvaluation(machine.source, circuit, values)
    machine.step(width, height)
  }
})

test('window-manager lowers its 12 stacking reads and its Notes flow reads, and stays exact in use', () => {
  const machine = createWindowManagerMachine()
  const {circuit} = machine
  const statistics = gatherStatistics(machine.tensorProgram)
  const baseline = gatherStatistics(
    circuit.compileTensorProgram([...machine.tensorProgram.roots], false),
  )
  // The builder declares the 4 stack rows and 4 stack columns as one-hot
  // groups (the permutation contract its validators already assert every
  // frame), which lowers the frontmost-window selection sums: 4 rank-hit
  // reads over rows, 4 selected-window reads over columns, 4 selected-rank
  // reads over rows. The photo gallery's click selection still gates on a
  // product that is not a provably exact bit, so it declares nothing. Since
  // September 15, 2026, the Notes flow (notes.ts and notes-walker.ts) declares
  // 32 more groups, two per line band: the set of other windows that block the
  // band, one of the 8 subsets of the 3 other windows, and the segment that the
  // band's line starts at, one of 89. Reads over those groups bring the total
  // from 12 to 908.
  expect(circuit.oneHotGroups.length).toBe(40)
  expect(statistics.readCount).toBe(908)
  expect(statistics.slotCount).toBe(40)
  expect(statistics.storedWeightCount).toBeLessThan(baseline.storedWeightCount)
  console.log(
    `[survey] window-manager: groups=${circuit.oneHotGroups.length}`
      + ` gatherReads=${statistics.readCount} slots=${statistics.slotCount}`
      + ` storedWeights=${statistics.storedWeightCount}`
      + ` (dense compile of the same roots: ${baseline.storedWeightCount})`,
  )

  // A full interaction trace on the gathered program: window drags, title-bar
  // clicks that restack, dock clicks that minimize and restore, and photo
  // events, all compared wire-for-wire against the reference. A step runs one
  // evaluation per event timestamp, settle checks and the frame, so the observer
  // checks the table of every evaluation.
  const random = createRandom(0x57ac)
  let frameTime = 0
  let evaluations = 0
  machine.observe({
    beforeEvaluate(table) {
      const reference = circuit.evaluateReference(table)
      validateOneHotGroups(circuit, reference)
      const values = circuit.evaluateTensor(table)
      validateTensorEvaluation(table, circuit, values)
      evaluations++
    },
  })
  const compareStep = (width: number, height: number) => {
    frameTime += 16
    machine.step(width, height, frameTime)
  }

  compareStep(1280, 800)
  // Drag window 0 by its title bar.
  machine.pointerDown(300, 70)
  compareStep(1280, 800)
  for (let move = 0; move < 6; move++) {
    machine.pointerMove(300 + move * 25, 70 + move * 12)
    compareStep(1280, 800)
  }
  machine.pointerUp(450, 142)
  compareStep(1280, 800)
  // Click around: window bodies, dock, and empty desktop, restacking windows.
  for (let click = 0; click < 12; click++) {
    const x = randomInteger(random, 1280)
    const y = randomInteger(random, 800)
    machine.pointerDown(x, y)
    compareStep(1280, 800)
    machine.pointerUp(x, y)
    compareStep(1280, 800)
  }
  // Dock sits at the bottom center; click item positions directly.
  for (let item = 0; item < 4; item++) {
    const x = 640 - 90 + item * 62
    machine.pointerDown(x, 800 - 38)
    compareStep(1280, 800)
    machine.pointerUp(x, 800 - 38)
    compareStep(1280, 800)
  }
  // Photo gallery interactions and viewport churn while springs animate.
  // A press and a release at viewport coordinates inside Photos' initial content box
  // at (651, 235), which Photos takes as a click where Photos is frontmost.
  machine.pointerDown(851, 385)
  machine.pointerUp(851, 385)
  compareStep(1280, 800)
  machine.photoNext()
  compareStep(1280, 800)
  machine.photoPrevious()
  compareStep(1280, 800)
  for (let settle = 0; settle < 30; settle++) {
    compareStep(settle % 2 === 0 ? 1280 : 1180, 800)
  }
  machine.photoClose()
  for (let settle = 0; settle < 10; settle++) compareStep(1280, 800)
  // 84 steps, plus event and settle check evaluations between frames.
  expect(evaluations).toBeGreaterThan(84)
})
