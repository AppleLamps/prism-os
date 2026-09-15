// The JS side of the event queue, following vibescript's event handling doctrine
// (docs/ui.md): event handlers only push raw input and schedule a render; the
// render function turns the frame's input into queued events, keeps the pointer
// stream legal, splits it into as many evaluations as the circuit's capacity
// needs, and writes each evaluation's events into the queue slots.
import {invariant} from '../../../numeric-ui-core.ts'
import {type QueueCells, coordinateLimit} from './desktop-queue.ts'

export const keyNames = ['ArrowLeft', 'ArrowRight', 'Escape'] as const
export type KeyName = (typeof keyNames)[number]
export type PointerKind = 'down' | 'move' | 'up'
export type QueuedEvent = {kind: PointerKind, x: number, y: number} | {kind: 'key', key: KeyName}

export function keyNameOf(key: string): KeyName | null {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Escape' ? key : null
}

// Whole pixels inside the queue's coordinate range. `+ 0` turns -0 into 0.
export function wholePixel(value: number) {
  return Math.max(-coordinateLimit, Math.min(coordinateLimit, Math.round(value))) + 0
}

// Keeps the pointer stream legal for the folded circuit: an up without a press is
// dropped, and a down while pressed first gets a synthesized up at the same point
// (e.g. after a lost pointerup). Returns the pressed state afterward.
export function legalizePointerStream(events: readonly QueuedEvent[], pressed: boolean) {
  const legal: QueuedEvent[] = []
  let isPressed = pressed
  for (const event of events) {
    if (event.kind === 'up') {
      if (!isPressed) continue
      isPressed = false
    } else if (event.kind === 'down') {
      if (isPressed) legal.push({kind: 'up', x: event.x, y: event.y})
      isPressed = true
    }
    legal.push(event)
  }
  return {events: legal, pressed: isPressed}
}

// Splits a frame's events into evaluations of at most `capacity` events and at
// most `maximumDowns` downs each, in order. A frame always evaluates at least
// once, so time still advances without input.
export function splitIntoEvaluations(events: readonly QueuedEvent[], capacity: number, maximumDowns: number): QueuedEvent[][] {
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

// Writes events into the first slots and clears the rest.
export function writeQueue(source: Float32Array, queue: QueueCells, events: readonly QueuedEvent[]) {
  invariant(events.length <= queue.slots.length, `${events.length} events exceed the queue capacity ${queue.slots.length}`)
  queue.slots.forEach((slot, index) => {
    const event = events[index]
    const pointer = event !== undefined && event.kind !== 'key' ? event : null
    if (pointer !== null) {
      invariant(Number.isInteger(pointer.x) && Number.isInteger(pointer.y) && Math.abs(pointer.x) <= coordinateLimit && Math.abs(pointer.y) <= coordinateLimit, `event coordinates ${pointer.x}, ${pointer.y} must be whole pixels inside ±${coordinateLimit}`)
    }
    source[slot.down] = pointer?.kind === 'down' ? 1 : 0
    source[slot.move] = pointer?.kind === 'move' ? 1 : 0
    source[slot.up] = pointer?.kind === 'up' ? 1 : 0
    source[slot.x] = pointer?.x ?? 0
    source[slot.y] = pointer?.y ?? 0
    source[slot.arrowLeft] = event?.kind === 'key' && event.key === 'ArrowLeft' ? 1 : 0
    source[slot.arrowRight] = event?.kind === 'key' && event.key === 'ArrowRight' ? 1 : 0
    source[slot.escape] = event?.kind === 'key' && event.key === 'Escape' ? 1 : 0
  })
}
