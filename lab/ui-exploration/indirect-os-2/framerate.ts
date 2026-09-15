// Replays the scripted session at 60 and 120 fps and compares the two at the
// timestamps both render. Every event of the session sits on a 60 fps frame time,
// which 120 fps also renders, so both runs apply each event at its own time.
// Positions are compared separately for windows, thumbnails, and words.
import type {QueuedEvent} from './events.ts'
import {type IndirectOSMachine, type IndirectOSOptions, createIndirectOSMachine} from './indirect-os.ts'
import {sessionEvents, sessionFrameCount, sessionViewport} from './session.ts'
import {read} from './wires.ts'

// The session with the latch machine's API: presses act on the down there, and a
// Photos click also needs the DOM click at local coordinates.
export function stepSessionFrame(machine: IndirectOSMachine, events: readonly QueuedEvent[], frameTime: number, photoClick: {x: number, y: number} | null) {
  if (machine.options.input.kind === 'queue') return machine.stepFrame(sessionViewport.width, sessionViewport.height, frameTime, events).values
  for (const event of events) {
    if (event.kind === 'key') {
      if (event.key === 'ArrowRight') machine.photoNext()
      else if (event.key === 'ArrowLeft') machine.photoPrevious()
      else machine.photoClose()
    } else if (event.kind === 'down') machine.pointerDown(event.x, event.y)
    else if (event.kind === 'move') machine.pointerMove(event.x, event.y)
    else machine.pointerUp(event.x, event.y)
  }
  if (photoClick !== null) machine.photoClick(photoClick.x, photoClick.y)
  return machine.step(sessionViewport.width, sessionViewport.height, frameTime)
}

type Snapshot = {windows: number[], thumbnails: number[], words: number[], discrete: string, animating: boolean}

export function replaySessionAtRate(options: IndirectOSOptions, framesPerSixtyFrame: number) {
  const machine = createIndirectOSMachine(options, {validate: false})
  const snapshots = new Map<number, Snapshot>()
  for (let frame = 0; frame < sessionFrameCount * framesPerSixtyFrame; frame++) {
    const time = 1000 + frame * 16.6875 / framesPerSixtyFrame
    const onSixty = frame % framesPerSixtyFrame === 0
    const sixtyFrame = frame / framesPerSixtyFrame
    const values = stepSessionFrame(machine, onSixty ? sessionEvents(sixtyFrame) : [], time, onSixty && sixtyFrame === 170 ? {x: 472, y: 309} : null)
    if (!onSixty) continue
    const output = read(values, machine.output)
    const {source, cells} = machine
    snapshots.set(time, {
      windows: output.windows.flatMap(window => [window.translateX, window.translateY, window.width, window.height, window.scale, window.opacity]),
      thumbnails: output.photos.thumbnails.flatMap(thumbnail => [thumbnail.left, thumbnail.top, thumbnail.width, thumbnail.opacity]),
      words: output.notes?.words.flatMap(word => [word.x, word.y]) ?? [],
      discrete: JSON.stringify([
        cells.stack.map(row => row.map(wire => source[wire])),
        cells.windows.map(window => [source[window.open], source[window.minimized], source[window.maximized]]),
        cells.photoState.focus.map(wire => source[wire]),
        output.notes?.words.map(word => word.visible) ?? [],
      ]),
      animating: output.animationActive > 0,
    })
  }
  return snapshots
}

export function compareFrameRates(options: IndirectOSOptions) {
  const sixty = replaySessionAtRate(options, 1)
  const hundredTwenty = replaySessionAtRate(options, 2)
  const result = {sharedFrames: 0, windows: 0, thumbnails: 0, words: 0, worstWordTime: -1, discreteMismatches: 0, animationMismatches: 0}
  const maximumDifference = (left: readonly number[], right: readonly number[]) => left.reduce((maximum, value, index) => Math.max(maximum, Math.abs(value - right[index]!)), 0)
  for (const [time, snapshot] of sixty) {
    const other = hundredTwenty.get(time)
    if (other === undefined) continue
    result.sharedFrames++
    result.windows = Math.max(result.windows, maximumDifference(snapshot.windows, other.windows))
    result.thumbnails = Math.max(result.thumbnails, maximumDifference(snapshot.thumbnails, other.thumbnails))
    const words = maximumDifference(snapshot.words, other.words)
    if (words > result.words) {
      result.words = words
      result.worstWordTime = time
    }
    if (snapshot.discrete !== other.discrete) result.discreteMismatches++
    if (snapshot.animating !== other.animating) result.animationMismatches++
  }
  return result
}
