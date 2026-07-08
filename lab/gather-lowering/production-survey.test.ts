import {expect, test} from 'bun:test'
import {
  validateOneHotGroups,
  validateTensorEvaluation,
  validateTensorProgram,
} from '../../numeric-ui-core.ts'
import {createCandidateGalleryMachine} from '../../candidate-gallery.ts'
import {
  createWindowManagerMachine,
  stackSourceField,
  sourceField as windowSourceField,
  windowCount,
} from '../../window-manager.ts'
import {createRandom, gatherStatistics, randomInteger} from './measure.ts'

// Production impact: compile the real circuits with recognition enabled, count
// what lowers, and confirm the lowered programs stay bit-identical to the
// reference across interaction traces.

test('candidate-gallery declares its argmax group but lowers nothing', () => {
  const machine = createCandidateGalleryMachine()
  const {circuit} = machine
  const lowered = gatherStatistics(machine.tensorProgram)
  const plain = gatherStatistics(
    circuit.compileTensorProgram([...machine.tensorProgram.roots], false),
  )
  // Only the argmax winner group is declared: the click selection's gate is a
  // product of 0..1-range wires, not a provably exact bit, so emitFirstActive
  // leaves it undeclared. The 22 distinct selectValue sums (53 call sites
  // minus deduplication and the hero sums that constant folding truncates)
  // match the masked-read shape over the argmax group, but every candidate is
  // viewport-derived geometry with a declared range of 0..Infinity, and the
  // finiteness rule refuses unbounded candidates — with the value infinite
  // and its bit 0, the dense sum computes fround(Infinity * 0) = NaN that a
  // gather would not reproduce. The same shape with finite ranges lowers (see
  // the argmax-inlining test in gather-recognition.test.ts), so declaring
  // finite viewport bounds inside the builder would re-enable all 22 reads.
  expect(circuit.oneHotGroups.length).toBe(1)
  expect(lowered.readCount).toBe(0)
  expect(lowered.storedWeightCount).toBe(plain.storedWeightCount)
  console.log(
    `[survey] candidate-gallery: groups=${circuit.oneHotGroups.length}`
      + ` gatherReads=${lowered.readCount}`
      + ` storedWeights=${lowered.storedWeightCount}`
      + ` (dense compile of the same roots: ${plain.storedWeightCount})`,
  )

  // Interaction trace: resizes and clicks, every frame compared wire-for-wire
  // against the reference evaluator, with the declared group checked exactly.
  machine.circuit.tensorProgram = machine.tensorProgram
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

test('window-manager as committed declares no groups and lowers nothing', () => {
  const machine = createWindowManagerMachine()
  const statistics = gatherStatistics(machine.tensorProgram)
  // The photo gallery's click selection gates on a product of 0..1-range
  // wires, which is not a provably exact bit, so its first-active group stays
  // undeclared. The real dynamic lookups (frontmost-window selection, the
  // stacking updates) run over source-table contracts that nothing declares.
  expect(machine.circuit.oneHotGroups.length).toBe(0)
  expect(statistics.readCount).toBe(0)
  console.log(
    `[survey] window-manager (as committed): groups=${machine.circuit.oneHotGroups.length}`
      + ` gatherReads=${statistics.readCount}`
      + ` storedWeights=${statistics.storedWeightCount}`,
  )
})

test('declaring the stack permutation contracts lowers the frontmost reads', () => {
  // The window manager's stacking state is a permutation matrix in the source
  // table: each rank holds exactly one window and each window one rank, which
  // the production validators already assert every frame. Declaring those rows
  // and columns as one-hot groups — without touching window-manager.ts — lets
  // recognition lower the frontmost-window selection sums.
  const machine = createWindowManagerMachine()
  const {circuit, output} = machine
  for (let rank = 0; rank < windowCount; rank++) {
    circuit.assumeOneHot(Array.from(
      {length: windowCount},
      (_, windowIndex) => stackSourceField(rank, windowIndex),
    ))
  }
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex++) {
    circuit.assumeOneHot(Array.from(
      {length: windowCount},
      (_, rank) => stackSourceField(rank, windowIndex),
    ))
  }
  const roots = [
    ...output.nextSource,
    ...output.windows,
    ...output.dockItems,
    output.animationActive,
    output.photos.backdropOpacity,
    ...output.photos.photos,
    ...output.photos.thumbnails,
    ...output.photos.previousControl,
    ...output.photos.nextControl,
  ]
  const program = circuit.compileTensorProgram(roots)
  validateTensorProgram(circuit, program)
  circuit.tensorProgram = program
  const statistics = gatherStatistics(program)
  const baseline = gatherStatistics(circuit.compileTensorProgram(roots, false))
  expect(statistics.readCount).toBeGreaterThan(0)
  console.log(
    `[survey] window-manager (stack groups declared): groups=${circuit.oneHotGroups.length}`
      + ` gatherReads=${statistics.readCount} slots=${statistics.slotCount}`
      + ` storedWeights=${statistics.storedWeightCount}`
      + ` (dense: ${baseline.storedWeightCount})`,
  )
  // Compiling the dense baseline above does not assign the circuit's program,
  // so the trace below still runs on the gathered one.
  circuit.tensorProgram = program

  // A full interaction trace on the gathered program: window drags, title-bar
  // clicks that restack, dock clicks that minimize and restore, and photo
  // events, all compared wire-for-wire against the reference every frame.
  const random = createRandom(0x57ac)
  let frameTime = 0
  const compareStep = (width: number, height: number) => {
    frameTime += 16
    machine.source[windowSourceField.viewportWidth] = width
    machine.source[windowSourceField.viewportHeight] = height
    machine.source[windowSourceField.frameTime] = frameTime
    const reference = circuit.evaluateReference(machine.source)
    validateOneHotGroups(circuit, reference)
    const values = circuit.evaluateTensor(machine.source)
    validateTensorEvaluation(machine.source, circuit, values)
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
  for (let item = 0; item < windowCount; item++) {
    const x = 640 - 90 + item * 62
    machine.pointerDown(x, 800 - 38)
    compareStep(1280, 800)
    machine.pointerUp(x, 800 - 38)
    compareStep(1280, 800)
  }
  // Photo gallery interactions and viewport churn while springs animate.
  machine.photoClick(200, 150)
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
})
