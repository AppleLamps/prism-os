// Scripted resize traces: frames of pointer events plus a step count, for headless checks and the
// demo's autopilot. A trace grabs the Notes window's right edge, drags it narrow and wide with
// jitter and uneven frame timing, releases, and waits for the springs to settle.

import {createRandom} from './float32.ts'
import {notesLayout} from './notes-machine.ts'

export type TraceEvent =
  | {kind: 'down', x: number, y: number}
  | {kind: 'move', x: number}
  | {kind: 'up', x: number}

export type TraceFrame = {steps: number, events: TraceEvent[]}

export function createResizeTrace(seed: number, initialWindowWidth = notesLayout.initialWindowWidth): TraceFrame[] {
  const random = createRandom(seed)
  const frames: TraceFrame[] = []
  // Mostly 60Hz (4 steps), some 120Hz (2), a few stalls.
  const stepsForFrame = () => {
    const roll = random()
    return roll < 0.7 ? 4 : roll < 0.9 ? 2 : roll < 0.97 ? 1 + Math.floor(random() * 12) : 30 + Math.floor(random() * 60)
  }
  for (let frame = 0; frame < 20; frame++) frames.push({steps: stepsForFrame(), events: []})
  let x = notesLayout.windowLeft + initialWindowWidth + (random() - 0.5) * 10
  frames.push({steps: stepsForFrame(), events: [{kind: 'down', x, y: notesLayout.windowTop + 60 + random() * 100}]})
  // Drag through a few targets, including past both clamps.
  const targets = [
    notesLayout.windowLeft + 200,
    notesLayout.windowLeft + 520 + random() * 60,
    notesLayout.windowLeft + 1250,
    notesLayout.windowLeft + 330 + random() * 40,
  ]
  for (const target of targets) {
    const frameCount = 25 + Math.floor(random() * 30)
    const start = x
    for (let frame = 1; frame <= frameCount; frame++) {
      x = start + (target - start) * (frame / frameCount) + (random() - 0.5) * 6
      frames.push({steps: stepsForFrame(), events: [{kind: 'move', x}]})
    }
    for (let frame = 0; frame < 8; frame++) frames.push({steps: stepsForFrame(), events: []})
  }
  frames.push({steps: stepsForFrame(), events: [{kind: 'up', x}]})
  for (let frame = 0; frame < 160; frame++) frames.push({steps: stepsForFrame(), events: []})
  return frames
}
