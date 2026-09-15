// Stage 3: the event queue, checked against the one-event-at-a-time oracle.
import {describe, expect, test} from 'bun:test'
import {validateOneHotGroups} from '../../../numeric-ui-core.ts'
import type {QueuedEvent} from './events.ts'
import {type IndirectOSMachine, type IndirectOSOptions, createIndirectOSMachine, originalOptions} from './indirect-os.ts'
import {readBit, readOneHot} from './input-kit.ts'
import {type OracleState, createOracleState, focusedWindow, oracleEvaluation} from './oracle.ts'
import {generateQueueTrace} from './queue-traces.ts'

export const queueOptions: IndirectOSOptions = {...originalOptions, springs: 'bank', photosViewport: 'stepped-springs', input: {kind: 'queue', capacity: 8, maximumDowns: 2}}

export function readQueueState(machine: IndirectOSMachine): OracleState {
  const {source, cells} = machine
  const queue = cells.queue!
  const bitAt = (wire: number) => readBit(source[wire]!, `wire ${wire}`)
  return {
    windows: cells.windows.map(window => ({
      left: source[window.left]!, top: source[window.top]!, width: source[window.width]!, height: source[window.height]!,
      open: bitAt(window.open), minimized: bitAt(window.minimized), maximized: bitAt(window.maximized),
    })),
    order: cells.stack.map((row, rank) => readOneHot(source, row, `stack rank ${rank}`)),
    press: {
      active: bitAt(queue.press.active),
      x: source[queue.press.x]!,
      y: source[queue.press.y]!,
      window: readOneHot(source, queue.press.window, 'press window'),
      region: readOneHot(source, queue.press.region, 'press region'),
      dock: readOneHot(source, queue.press.dock, 'press dock'),
      grab: {left: source[queue.press.grab.left]!, top: source[queue.press.grab.top]!, width: source[queue.press.grab.width]!, height: source[queue.press.grab.height]!},
      slop: bitAt(queue.press.slop),
    },
    pointer: {x: source[queue.pointer.x]!, y: source[queue.pointer.y]!},
    photoFocus: readOneHot(source, cells.photoState.focus, 'photo focus'),
  }
}

const machine = createIndirectOSMachine(queueOptions)
let frameTime = 0
function runFrames(frames: readonly (readonly QueuedEvent[])[], viewport = {width: 1280, height: 800}) {
  const oracle = createOracleState()
  const fresh = createIndirectOSMachine(queueOptions)
  for (const events of frames) {
    oracleEvaluation(oracle, viewport, events)
    const {values} = fresh.stepFrame(viewport.width, viewport.height, frameTime += 16.6875, events)
    expect(readQueueState(fresh)).toEqual(oracle)
    expect(values[fresh.output.windows[Math.max(0, focusedWindow(oracle))]!.focused]).toBe(focusedWindow(oracle) >= 0 ? 1 : 0)
  }
  return {oracle, machine: fresh}
}
const down = (x: number, y: number): QueuedEvent => ({kind: 'down', x, y})
const move = (x: number, y: number): QueuedEvent => ({kind: 'move', x, y})
const up = (x: number, y: number): QueuedEvent => ({kind: 'up', x, y})
const key = (name: 'ArrowLeft' | 'ArrowRight' | 'Escape'): QueuedEvent => ({kind: 'key', key: name})
// At 1280×800: Files (window 0) is 54,54 520×340, its close button is centered
// at 555,76 and its maximize button at 527,76. Photos (window 3) is 650,190
// 560×430; its content starts at 651,235 and grid cell 0 is 70 px into it.
const filesClose = {x: 555, y: 76}
const filesMaximize = {x: 527, y: 76}
const photoCell = (item: number) => ({x: 651 + 18 + 58 + item % 4 * (117 + 18), y: 235 + 18 + 52 + Math.floor(item / 4) * (104 + 18)})

describe('named cases', () => {
  test('a click on a close button closes the window, and moving outward past slop and back cancels it, within one frame', () => {
    expect(runFrames([[down(filesClose.x, filesClose.y), up(filesClose.x, filesClose.y)]]).oracle.windows[0]!.open).toBe(false)
    const cancelled = runFrames([[down(filesClose.x, filesClose.y), move(filesClose.x + 20, filesClose.y), move(filesClose.x, filesClose.y), up(filesClose.x, filesClose.y)]])
    expect(cancelled.oracle.windows[0]!.open).toBe(true)
    expect(cancelled.oracle.order[3]).toBe(0)
  })

  test('down, up, down within one frame: the second down sees the maximized window', () => {
    // 600,300 is on Notes (window 1) until Files is maximized over it.
    const {oracle} = runFrames([[down(filesMaximize.x, filesMaximize.y), up(filesMaximize.x, filesMaximize.y), down(600, 300)]])
    expect(oracle.windows[0]!.maximized).toBe(true)
    expect(oracle.press).toMatchObject({active: true, window: 0})
  })

  test('a drag commit is visible to a later down in the same frame', () => {
    // Drag window 2 by its title bar 400 px right; 900,360 is then on window 2 instead of Photos.
    const {oracle} = runFrames([[down(300, 360), move(500, 360), up(700, 360), down(900, 360)]])
    expect(oracle.windows[2]!.left).toBe(574)
    expect(oracle.press.window).toBe(2)
  })

  test('a drag past the left edge and back returns the window to the pointer', () => {
    const {oracle} = runFrames([[down(300, 360)], [move(-500, 360)], [move(310, 370)], [up(310, 370)]])
    expect(oracle.windows[2]).toMatchObject({left: 184, top: 354})
  })

  test('a click on a Photos grid cell opens that photo, and keys go to Photos only while it is focused, in queue order', () => {
    const cell = photoCell(5)
    const {oracle} = runFrames([
      [down(cell.x, cell.y), up(cell.x, cell.y), key('ArrowRight')],
      // Files takes focus in the middle of the frame, so the second ArrowRight is ignored.
      [key('ArrowRight'), down(100, 70), up(100, 70), key('ArrowRight')],
    ])
    expect(oracle.photoFocus).toBe(7)
    const later = runFrames([
      [down(cell.x, cell.y), up(cell.x, cell.y)],
      [down(100, 70), up(100, 70), key('Escape'), down(700, 210), up(700, 210), key('ArrowLeft')],
    ])
    expect(later.oracle.photoFocus).toBe(4)
  })

  test('the machine splits a frame with more downs than the circuit handles into more evaluations', () => {
    const {values, evaluations} = machine.stepFrame(1280, 800, frameTime += 16.6875, [down(100, 70), up(100, 70), down(100, 70), up(100, 70), down(100, 70), up(100, 70)])
    expect(evaluations).toBe(2)
    expect(values[machine.output.windows[0]!.focused]).toBe(1)
  })
})

test('random traces match the one-event-at-a-time oracle after every frame, and declared one-hot groups hold', () => {
  const {frames, dropped} = generateQueueTrace({seed: 7, frames: 700, capacity: 8, maximumDowns: 2})
  const oracle = createOracleState()
  const traceMachine = createIndirectOSMachine(queueOptions)
  let time = 0
  const counts = {closes: 0, photoChanges: 0, drags: 0, keysToPhotos: 0}
  frames.forEach((frame, index) => {
    const before = structuredClone(oracle)
    oracleEvaluation(oracle, frame.viewport, frame.events)
    if (index % 50 === 0) validateOneHotGroups(traceMachine.circuit, traceMachine.circuit.evaluateTensor(traceMachine.source))
    traceMachine.stepFrame(frame.viewport.width, frame.viewport.height, time += frame.elapsed, frame.events)
    expect(readQueueState(traceMachine)).toEqual(oracle)
    counts.closes += oracle.windows.filter((window, window_index) => before.windows[window_index]!.open && !window.open).length
    if (oracle.photoFocus !== before.photoFocus) counts.photoChanges++
    if (oracle.windows.some((window, window_index) => window.left !== before.windows[window_index]!.left)) counts.drags++
  })
  expect(dropped).toBeLessThan(20)
  expect(counts.closes).toBeGreaterThan(5)
  expect(counts.photoChanges).toBeGreaterThan(10)
  expect(counts.drags).toBeGreaterThan(10)
})
