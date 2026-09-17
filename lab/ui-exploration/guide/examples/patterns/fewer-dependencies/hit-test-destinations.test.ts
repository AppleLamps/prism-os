// Checks the toast stack's press hit test in toast-stack.ts, against the toasts'
// destinations and against their drawn positions, with the JavaScript findIndex loops it
// replaces, over random and adversarial tables in both evaluators. Pins the sizes
// that guide/patterns/hit-test-destinations.md quotes, and scripts what a user sees
// differently. Run from the repo root:
// bun test lab/ui-exploration/guide/examples/patterns/fewer-dependencies
import {expect, test} from 'bun:test'
import {type Circuit, validateGrids} from '../../../../../../src/runtime/numeric-ui-core.ts'
import {springMatrixPower, springStepMatrix} from '../../../../../../src/runtime/host-timing.ts'
import {evaluateBoth, frameTimesAt, measureProgram, nextFloat32, seededRandom} from './helpers.ts'
import {
  type HitTestSource,
  type ToastEvent,
  buildToastStack,
  initialToastTable,
  pressedToastByDestination,
  pressedToastByDrawnPosition,
  runToastStack,
  toastCell,
  toastCells,
  toastLayout,
  toastOutput,
  toastSpring,
  toastsFromTable,
} from './toast-stack.ts'

const sources: readonly HitTestSource[] = ['destinations', 'drawn positions']
const powers = Array.from({length: 301}, (_, steps) => springMatrixPower(springStepMatrix(toastSpring), steps))

function roundingPointKinds(circuit: Circuit) {
  const kinds: Record<string, number> = {}
  for (const point of circuit.roundingPoints()) kinds[point.kind] = (kinds[point.kind] ?? 0) + 1
  return kinds
}

const onPointerGrid = (value: number) => Math.round(value * 64) / 64

function presentBits(table: Float32Array) {
  return Array.from({length: toastLayout.count}, (_, index) => table[toastCells(index).present]!)
}

// The toast the circuit dismissed, or -1, after checking that the pressed bits are exact and at most one is 1.
function pressedIndex(outputs: Float32Array): number | 'invalid' {
  const bits = Array.from(outputs.subarray(toastOutput.pressedStart, toastOutput.pressedStart + toastLayout.count))
  if (!bits.every(bit => bit === 0 || bit === 1) || bits.filter(bit => bit === 1).length > 1) return 'invalid'
  return bits.indexOf(1)
}

function expectedIndex(source: HitTestSource, table: Float32Array): number {
  if (table[toastCell.pressActive] !== 1) return -1
  const toasts = toastsFromTable(table)
  const pointerX = table[toastCell.pressX]!
  const pointerY = table[toastCell.pressY]!
  return source === 'destinations'
    ? pressedToastByDestination(toasts, pointerX, pointerY)
    : pressedToastByDrawnPosition(toasts, pointerX, pointerY)
}

test('sizes: testing destinations is 35 operations in 5 layers up to the pressed bits, against 205 operations in 34 layers for drawn positions', () => {
  const destinations = buildToastStack('destinations')
  const drawn = buildToastStack('drawn positions')
  expect(measureProgram(destinations.circuit, destinations.pressed)).toEqual({operations: 35, layers: 5})
  expect(measureProgram(drawn.circuit, drawn.pressed)).toEqual({operations: 205, layers: 34})
  // The whole app, with the springs of 4 toasts and the next state.
  expect(measureProgram(destinations.circuit, destinations.roots)).toEqual({operations: 171, layers: 17})
  expect(measureProgram(drawn.circuit, drawn.roots)).toEqual({operations: 313, layers: 45})
  // Destinations and pointers lie on grids, so every comparison is an integer bit.
  // Drawn tops come out of spring arithmetic, so their comparisons are sign cascades.
  expect(roundingPointKinds(destinations.circuit)).toEqual({'integer bit': 20, marked: 4, boolean: 4})
  expect(roundingPointKinds(drawn.circuit)).toEqual({'integer bit': 4, 'sign cascade': 140, marked: 4, boolean: 4})
})

test('the pressed toast equals the JavaScript findIndex over random tables, in both evaluators', () => {
  for (const source of sources) {
    const {circuit, roots} = buildToastStack(source)
    const evaluate = circuit.createTensorEvaluator(roots)
    const random = seededRandom(source === 'destinations' ? 11 : 12)
    let mismatches = 0
    let presses = 0
    for (let sample = 0; sample < 3000; sample++) {
      const table = initialToastTable()
      table.set(powers[Math.floor(random() * powers.length)]!, toastCell.matrixStart)
      table[toastCell.settleCheck] = random() < 0.5 ? 1 : 0
      table[toastCell.pressActive] = random() < 0.9 ? 1 : 0
      table[toastCell.pressX] = onPointerGrid(random() * 400 - 40)
      table[toastCell.pressY] = onPointerGrid(random() * 240 - 20)
      table[toastCell.showAllActive] = random() < 0.1 ? 1 : 0
      for (let index = 0; index < toastLayout.count; index++) {
        const cells = toastCells(index)
        table[cells.present] = random() < 0.7 ? 1 : 0
        table[cells.displacement] = (random() * 2 - 1) * 200
        table[cells.velocity] = (random() * 2 - 1) * 3000
      }
      const outputs = evaluateBoth(circuit, evaluate, roots, table)
      validateGrids(circuit, circuit.evaluateReference(table))
      const expected = expectedIndex(source, table)
      if (expected >= 0) presses++
      if (pressedIndex(outputs) !== expected) mismatches++
    }
    expect(mismatches).toBe(0)
    // Enough presses land on a toast for the comparison to mean something.
    expect(presses).toBeGreaterThan(900)
  }
})

test('the pressed toast equals the JavaScript findIndex with pointers on every edge and next to it, in both evaluators', () => {
  const {left, width, height} = toastLayout
  for (const source of sources) {
    const {circuit, roots} = buildToastStack(source)
    const evaluate = circuit.createTensorEvaluator(roots)
    const random = seededRandom(source === 'destinations' ? 21 : 22)
    let mismatches = 0
    let checks = 0
    const check = (table: Float32Array) => {
      const outputs = evaluateBoth(circuit, evaluate, roots, table)
      validateGrids(circuit, circuit.evaluateReference(table))
      checks++
      if (pressedIndex(outputs) !== expectedIndex(source, table)) mismatches++
    }
    for (let presentMask = 0; presentMask < 2 ** toastLayout.count; presentMask++) {
      const base = initialToastTable()
      base[toastCell.pressActive] = 1
      for (let index = 0; index < toastLayout.count; index++) base[toastCells(index).present] = (presentMask >> index) & 1
      const toasts = toastsFromTable(base)
      for (let index = 0; index < toastLayout.count; index++) {
        const {destinationTop} = toasts[index]!
        for (const pointerX of [left - 1 / 64, left, left + 1 / 64, left + 100, left + width - 1 / 64, left + width]) {
          if (source === 'destinations') {
            // Pointers on a destination's top and bottom edges, and one grid step to either side.
            for (const edge of [destinationTop, destinationTop + height]) {
              for (const offset of [-1 / 64, 0, 1 / 64]) {
                const table = Float32Array.from(base)
                table[toastCell.pressX] = pointerX
                table[toastCell.pressY] = edge + offset
                check(table)
              }
            }
          } else {
            // Drawn tops on the pointer, on the pointer less the toast's height, and the
            // FP32 values next to those, after a random number of steps.
            const pointerY = onPointerGrid(destinationTop + random() * 60 - 10)
            for (const edge of [pointerY, pointerY - height]) {
              for (const target of [nextFloat32(edge, -1), edge, nextFloat32(edge, 1)]) {
                const table = Float32Array.from(base)
                table[toastCell.pressX] = pointerX
                table[toastCell.pressY] = pointerY
                // With the identity matrix, the stepped displacement is the stored displacement.
                const identity = random() < 0.5
                if (!identity) table.set(powers[Math.floor(random() * powers.length)]!, toastCell.matrixStart)
                const cells = toastCells(index)
                table[cells.velocity] = identity ? 0 : (random() * 2 - 1) * 100
                table[cells.displacement] = target - destinationTop
                check(table)
              }
            }
          }
        }
      }
    }
    expect(mismatches).toBe(0)
    // 16 present patterns × 4 toasts × 6 pointer x positions × 2 edges × 3 offsets.
    expect(checks).toBe(2304)
  }
})

test('three quick presses on the top toast dismiss three toasts when the hit test uses destinations, and one when it uses drawn positions', () => {
  const frames = frameTimesAt(60, 2000)
  // 80 ms apart, 4 px below the top edge of the top slot.
  const presses: ToastEvent[] = [1000, 1080, 1160].map(timeStamp => ({timeStamp, kind: 'press', x: 116, y: 4}))
  const destinations = runToastStack(frames, presses, 'events and settle checks', 'destinations')
  const drawn = runToastStack(frames, presses, 'events and settle checks', 'drawn positions')
  expect(presentBits(destinations.finalState)).toEqual([0, 0, 0, 1])
  expect(presentBits(drawn.finalState)).toEqual([0, 1, 1, 1])
  // In the frame right after the second press, toast 1 is still sliding up and drawn
  // 26.65 px down, so the press at 4 px lands above it.
  const frameAfterSecondPress = frames.find(time => time > 1080)!
  expect(drawn.drawnTops.get(frameAfterSecondPress)![1]).toBeCloseTo(26.65, 2)
})

test('a press on a toast that is still sliding up dismisses the toast whose destination is under the pointer, which can be the next toast', () => {
  const frames = frameTimesAt(60, 2000)
  // Dismiss toast 0, then press at 60 px while toast 1 is drawn around 26.65..66.65 px.
  const presses: ToastEvent[] = [{timeStamp: 1000, kind: 'press', x: 116, y: 4}, {timeStamp: 1080, kind: 'press', x: 116, y: 60}]
  const destinations = runToastStack(frames, presses, 'events and settle checks', 'destinations')
  const drawn = runToastStack(frames, presses, 'events and settle checks', 'drawn positions')
  // Toast 2's destination is 48..88 px, so testing destinations dismisses toast 2.
  expect(presentBits(destinations.finalState)).toEqual([0, 1, 0, 1])
  // Testing drawn positions dismisses toast 1, the one drawn under the pointer.
  expect(presentBits(drawn.finalState)).toEqual([0, 0, 1, 1])
})
