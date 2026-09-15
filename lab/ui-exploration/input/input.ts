// The JS side of the queue, following vibescript's event handling doctrine:
// event handlers only push raw input and schedule a render; the render function
// turns the frame's pending input into queued events and splits them into as
// many evaluations as the circuit's capacity requires.

import {coordinateLimit, eventTimeLimit, timeSubdivisions, type KeyName, type PointerKind, type QueuedEvent} from './events.ts'

export type RawInput =
  | {kind: PointerKind, clientX: number, clientY: number, timeStamp: number}
  | {kind: 'key', key: KeyName, shift: boolean, timeStamp: number}

export function keyNameOf(key: string): KeyName | null {
  switch (key) {
    case 'Tab':
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown':
    case 'Enter':
    case 'Escape':
      return key
    case ' ':
      return 'Space'
    default:
      return null
  }
}

// Milliseconds relative to the frame time on the 1/16 ms grid, clamped to
// -4096..0. Events arrive before the requestAnimationFrame callback, so their
// relative times are normally negative. `+ 0` turns -0 into 0.
export function quantizeEventTime(timeStamp: number, frameTime: number) {
  const ticks = Math.round((timeStamp - frameTime) * timeSubdivisions)
  return Math.min(0, Math.max(-eventTimeLimit * timeSubdivisions, ticks)) / timeSubdivisions + 0
}

export function quantizeFrameDelta(frameTime: number, previousFrameTime: number | null) {
  if (previousFrameTime === null) return 0
  const ticks = Math.round((frameTime - previousFrameTime) * timeSubdivisions)
  return Math.min(eventTimeLimit * timeSubdivisions, Math.max(0, ticks)) / timeSubdivisions
}

function whole(value: number) {
  return Math.max(-coordinateLimit, Math.min(coordinateLimit, Math.round(value))) + 0
}

export function toQueuedEvents(raw: readonly RawInput[], frameTime: number, toWorld: (clientX: number, clientY: number) => {x: number, y: number}): QueuedEvent[] {
  return raw.map((input): QueuedEvent => {
    const time = quantizeEventTime(input.timeStamp, frameTime)
    if (input.kind === 'key') return {kind: 'key', key: input.key, shift: input.shift, time}
    const world = toWorld(input.clientX, input.clientY)
    return {kind: input.kind, x: whole(world.x), y: whole(world.y), time}
  })
}

// Keeps the pointer stream legal for the circuits: an up without a press is
// dropped, and a down while pressed first gets a synthesized up at the same
// point (e.g. after a lost pointerup). Returns the pressed state afterward.
export function legalizePointerStream(events: readonly QueuedEvent[], pressed: boolean) {
  const legal: QueuedEvent[] = []
  let isPressed = pressed
  for (const event of events) {
    if (event.kind === 'up') {
      if (!isPressed) continue
      isPressed = false
    } else if (event.kind === 'down') {
      if (isPressed) legal.push({kind: 'up', x: event.x, y: event.y, time: event.time})
      isPressed = true
    }
    legal.push(event)
  }
  return {events: legal, pressed: isPressed}
}

// Splits a frame's events into evaluations of at most `capacity` events and at
// most `maximumDowns` downs each, in order. A frame always evaluates at least
// once, so time still advances without input.
export function splitIntoEvaluations(events: readonly QueuedEvent[], capacity: number, maximumDowns = Number.POSITIVE_INFINITY): QueuedEvent[][] {
  const evaluations: QueuedEvent[][] = [[]]
  let downs = 0
  for (const event of events) {
    let current = evaluations[evaluations.length - 1]!
    const isDown = event.kind === 'down'
    if (current.length === capacity || (isDown && downs === maximumDowns)) {
      current = []
      evaluations.push(current)
      downs = 0
    }
    current.push(event)
    if (isDown) downs++
  }
  return evaluations
}
