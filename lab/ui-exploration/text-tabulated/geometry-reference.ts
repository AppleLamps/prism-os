// A float64 JS mirror of the Notes machine's drag logic, springs, and stacking. Text decisions come
// from pretext directly (reference.ts), at the circuit's content width, so the two machines see the
// same line counts and any disagreement here is spring or stacking drift.

import {notesLayout, type NotesBlock} from './notes-machine.ts'
import {referenceBlock} from './reference.ts'
import {referenceSpringStep} from './springs.ts'
import type {TraceEvent} from './resize-trace.ts'

export function createGeometryReference(blocks: readonly NotesBlock[], initial: {height: number[], bubbleWidth: (number | null)[]}) {
  const state = {
    pointerX: 0,
    dragging: false,
    grabOffset: 0,
    targetWidth: notesLayout.initialWindowWidth,
    windowWidth: notesLayout.initialWindowWidth,
    windowVelocity: 0,
    windowHeight: 0,
    heights: [...initial.height],
    heightVelocities: blocks.map(() => 0),
    bubbleWidths: [...initial.bubbleWidth],
    bubbleVelocities: blocks.map(() => 0),
  }
  const gapSum = blocks.reduce((total, block) => total + block.gapAfter, 0)
  state.windowHeight = state.heights.reduce((total, height) => total + height, 0) + gapSum + notesLayout.titleBarHeight + 2 * notesLayout.padding
  let viewportWidth = 1280

  return {
    state,
    setViewportWidth(width: number) {
      viewportWidth = width
    },
    // Advances one frame. `circuitContentWidth` is only used to ask pretext for line counts and
    // bubble widths, so both machines spring toward the same targets.
    step(steps: number, events: readonly TraceEvent[], circuitContentWidth: number) {
      let down: {x: number, y: number} | null = null
      let moveX: number | null = null
      let upX: number | null = null
      for (const event of events) {
        if (event.kind === 'down') down = {x: event.x, y: event.y}
        else if (event.kind === 'move') moveX = event.x
        else upX = event.x
      }
      const windowRight = notesLayout.windowLeft + state.windowWidth
      const pointerX = upX ?? moveX ?? down?.x ?? state.pointerX
      const pressOnGrip = down !== null
        && down.x >= windowRight - notesLayout.gripWidth / 2 && down.x <= windowRight + notesLayout.gripWidth / 2
        && down.y >= notesLayout.windowTop && down.y <= notesLayout.windowTop + state.windowHeight
      const activeDrag = state.dragging || pressOnGrip
      if (pressOnGrip) state.grabOffset = down!.x - windowRight
      if (activeDrag) {
        const upper = Math.min(notesLayout.maxWindowWidth, viewportWidth - notesLayout.windowLeft - 20)
        state.targetWidth = Math.max(Math.min(pointerX - state.grabOffset - notesLayout.windowLeft, upper), notesLayout.minWindowWidth)
      }
      state.pointerX = pointerX
      state.dragging = activeDrag && upX === null
      const windowSpring = referenceSpringStep(state.windowWidth, state.windowVelocity, state.targetWidth, steps, notesLayout.spring)
      state.windowWidth = windowSpring.position
      state.windowVelocity = windowSpring.velocity
      blocks.forEach((block, index) => {
        const expected = referenceBlock(block, circuitContentWidth)
        const heightSpring = referenceSpringStep(state.heights[index]!, state.heightVelocities[index]!, expected.lineCount * block.lineHeight + 2 * block.paddingY, steps, notesLayout.spring)
        state.heights[index] = heightSpring.position
        state.heightVelocities[index] = heightSpring.velocity
        if (block.kind === 'bubble') {
          const widthSpring = referenceSpringStep(state.bubbleWidths[index]!, state.bubbleVelocities[index]!, Math.ceil(expected.maxLineWidth) + 2 * block.paddingX, steps, notesLayout.spring)
          state.bubbleWidths[index] = widthSpring.position
          state.bubbleVelocities[index] = widthSpring.velocity
        }
      })
      state.windowHeight = state.heights.reduce((total, height) => total + height, 0) + gapSum + notesLayout.titleBarHeight + 2 * notesLayout.padding
    },
    tops() {
      const tops: number[] = []
      let top = 0
      blocks.forEach((block, index) => {
        tops.push(top)
        top += state.heights[index]! + block.gapAfter
      })
      return tops
    },
  }
}
