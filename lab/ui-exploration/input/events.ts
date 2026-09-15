// The event queue in the source table: a fixed number of slots, each holding
// one event of the frame in arrival order. A slot has four kind bits (down,
// move, up, key; all zero for an empty slot), integer coordinates, a timestamp
// relative to the frame on a 1/16 ms grid, one bit per key the app
// understands, and the Shift modifier state at the time of the key event.

import {invariant} from '../../../numeric-ui-core.ts'
import type {SourceLayout, Wire} from './kit.ts'

export const keyNames = ['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Space', 'Escape'] as const
export type KeyName = (typeof keyNames)[number]

export type PointerKind = 'down' | 'move' | 'up'
export type QueuedPointer = {kind: PointerKind, x: number, y: number, time: number}
export type QueuedKey = {kind: 'key', key: KeyName, shift: boolean, time: number}
export type QueuedEvent = QueuedPointer | QueuedKey

// Coordinates are whole pixels inside ±4096. Event times are milliseconds
// relative to the frame time, inside -4096..0, on a 1/16 ms grid, so 16 * time
// is an exact integer in FP32.
export const coordinateLimit = 4096
export const eventTimeLimit = 4096
export const timeSubdivisions = 16

export type EventSlot = {
  down: Wire
  move: Wire
  up: Wire
  key: Wire
  x: Wire
  y: Wire
  time: Wire
  keys: Record<KeyName, Wire>
  shift: Wire
}

export function allocateEventQueue(layout: SourceLayout, capacity: number): EventSlot[] {
  invariant(Number.isInteger(capacity) && capacity >= 1, 'queue capacity must be a positive integer')
  return Array.from({length: capacity}, (_, index) => {
    const bit = (name: string) => layout.cell(`event[${index}].${name}`, 0, 1)
    const slot = {
      down: bit('down'),
      move: bit('move'),
      up: bit('up'),
      key: bit('key'),
      x: layout.cell(`event[${index}].x`, -coordinateLimit, coordinateLimit),
      y: layout.cell(`event[${index}].y`, -coordinateLimit, coordinateLimit),
      time: layout.cell(`event[${index}].time`, -eventTimeLimit, 0),
      keys: {} as Record<KeyName, Wire>,
      shift: 0,
    }
    for (const key of keyNames) slot.keys[key] = bit(`key.${key}`)
    slot.shift = bit('shift')
    return slot
  })
}

export function isOnTimeGrid(value: number) {
  return Number.isInteger(value * timeSubdivisions)
}

export function validateQueuedEvent(event: QueuedEvent) {
  invariant(isOnTimeGrid(event.time) && event.time >= -eventTimeLimit && event.time <= 0, `event time ${event.time} is off the grid or outside -4096..0`)
  if (event.kind === 'key') return
  invariant(Number.isInteger(event.x) && Math.abs(event.x) <= coordinateLimit, `event x ${event.x} must be an integer inside ±4096`)
  invariant(Number.isInteger(event.y) && Math.abs(event.y) <= coordinateLimit, `event y ${event.y} must be an integer inside ±4096`)
}

// Writes events into the first slots and clears the rest.
export function writeEventQueue(source: Float32Array, slots: readonly EventSlot[], events: readonly QueuedEvent[]) {
  invariant(events.length <= slots.length, `${events.length} events exceed the queue capacity ${slots.length}`)
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index]!
    const event = events[index]
    if (event !== undefined) validateQueuedEvent(event)
    source[slot.down] = event?.kind === 'down' ? 1 : 0
    source[slot.move] = event?.kind === 'move' ? 1 : 0
    source[slot.up] = event?.kind === 'up' ? 1 : 0
    source[slot.key] = event?.kind === 'key' ? 1 : 0
    source[slot.x] = event !== undefined && event.kind !== 'key' ? event.x : 0
    source[slot.y] = event !== undefined && event.kind !== 'key' ? event.y : 0
    source[slot.time] = event?.time ?? 0
    for (const key of keyNames) source[slot.keys[key]] = event?.kind === 'key' && event.key === key ? 1 : 0
    source[slot.shift] = event?.kind === 'key' && event.shift ? 1 : 0
  }
}
