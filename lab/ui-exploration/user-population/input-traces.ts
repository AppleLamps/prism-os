// input's seeded random window traces, copied from
// lab/ui-exploration/input/traces.ts (generateWindowsTrace, randomEventTimes and
// the frame durations) with no change besides the import of the original
// windows copy. The lifted build is checked against the original over these
// traces.

import type {QueuedEvent} from './events.ts'
import {createRandom, randomInteger} from './kit.ts'
import {createWindowsState, seenWindowRectangle, windowsOracleEvent, windowsOracleFrameStart, type WindowsConfig} from './input-windows.ts'

export type Frame = {frameDelta: number, events: QueuedEvent[]}

const frameDeltas = [0, 4, 8.3125, 16.6875, 16.6875, 16.6875, 33.375, 120, 480, 900]

// Sorted times on the 1/16 ms grid inside -span..0.
export function randomEventTimes(random: () => number, count: number, span: number) {
  const ticks = Math.max(0, Math.floor(span * 16))
  // `0 - x` rather than `-x`, so a zero tick is +0 and not -0.
  return Array.from({length: count}, () => (0 - randomInteger(random, 0, ticks)) / 16).sort((a, b) => a - b)
}

export function generateWindowsTrace(config: WindowsConfig, options: {seed: number, frames: number, capacity: number, maximumDowns: number}): Frame[] {
  const random = createRandom(options.seed)
  const shadow = createWindowsState(config)
  const frames: Frame[] = []
  const count = config.windows.length
  const clampCoordinate = (value: number) => Math.max(-512, Math.min(2048, Math.round(value)))
  let lastPressX = 400
  let lastPressY = 300

  function aimDown(): {x: number, y: number} {
    const roll = random()
    const index = randomInteger(random, 0, count - 1)
    const rectangle = seenWindowRectangle(config, shadow, index)
    const title = config.titleHeight
    const button = config.buttonWidth
    if (roll < 0.15) return {x: lastPressX + randomInteger(random, -3, 3), y: lastPressY + randomInteger(random, -3, 3)}
    if (roll < 0.45) {
      return {
        x: rectangle.left + randomInteger(random, 1, Math.max(1, rectangle.width - button - 1)),
        y: rectangle.top + randomInteger(random, 1, title - 1),
      }
    }
    if (roll < 0.6) {
      return {
        x: rectangle.left + rectangle.width - randomInteger(random, 1, button),
        y: rectangle.top + randomInteger(random, 1, title - 1),
      }
    }
    if (roll < 0.85) {
      return {
        x: rectangle.left + randomInteger(random, 1, rectangle.width - 1),
        y: rectangle.top + randomInteger(random, title, rectangle.height - 1),
      }
    }
    return {x: randomInteger(random, -40, config.workspace.width + 40), y: randomInteger(random, -40, config.workspace.height + 40)}
  }

  for (let frame = 0; frame < options.frames; frame++) {
    const frameDelta = frameDeltas[randomInteger(random, 0, frameDeltas.length - 1)]!
    windowsOracleFrameStart(shadow, frameDelta)
    const eventCount = random() < 0.25 ? 0 : 1 + Math.floor(random() ** 1.5 * options.capacity)
    const times = randomEventTimes(random, Math.min(eventCount, options.capacity), Math.min(frameDelta, 240))
    const events: QueuedEvent[] = []
    let downs = 0
    for (const time of times) {
      let event: QueuedEvent
      if (shadow.pressed) {
        const roll = random()
        if (roll < 0.6) {
          const reach = random() < 0.5 ? 3 : 60
          event = {kind: 'move', x: clampCoordinate(shadow.pointerX + randomInteger(random, -reach, reach)), y: clampCoordinate(shadow.pointerY + randomInteger(random, -reach, reach)), time}
        } else {
          const back = random() < 0.3
          event = {kind: 'up', x: back ? shadow.pressX : shadow.pointerX, y: back ? shadow.pressY : shadow.pointerY, time}
        }
      } else if (random() < 0.6 && downs < options.maximumDowns) {
        const target = aimDown()
        event = {kind: 'down', x: clampCoordinate(target.x), y: clampCoordinate(target.y), time}
        lastPressX = event.x
        lastPressY = event.y
        downs++
      } else {
        event = {kind: 'move', x: clampCoordinate(shadow.pointerX + randomInteger(random, -30, 30)), y: clampCoordinate(shadow.pointerY + randomInteger(random, -30, 30)), time}
      }
      windowsOracleEvent(config, shadow, event)
      events.push(event)
    }
    frames.push({frameDelta, events})
  }
  return frames
}
