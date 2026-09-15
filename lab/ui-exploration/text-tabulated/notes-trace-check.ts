// Drives the whole Notes machine through scripted resize traces and checks every frame: each block's
// outputs against pretext (reference.ts), and the drag, springs, and stacking against a float64 mirror
// (geometry-reference.ts). notes-machine.test.ts runs it with the dyadic fake canvas, and
// `report.ts nondyadic` runs it with non-dyadic advances.

import {createGeometryReference} from './geometry-reference.ts'
import {createNotesMachine, type NotesBlock} from './notes-machine.ts'
import {compareBlock} from './reference.ts'
import {createResizeTrace} from './resize-trace.ts'

export type NotesTraceCheck = {
  frames: number
  comparisons: number
  // The first 20 wrong line counts, tight widths, cursors, or line texts, and the total count.
  decisionProblems: string[]
  decisionProblemCount: number
  framesWithDecisionProblem: number
  // Delta row width drift against pretext, and how many frames had any.
  maxLineWidthDrift: number
  framesWithMaxLineWidthDrift: number
  lineXDrift: number
  // Springs and stacking against the float64 mirror.
  geometryDrift: number
  narrowestContentWidth: number
  widestContentWidth: number
  settled: boolean
}

export function checkNotesTraces(blocks: readonly NotesBlock[], seeds: readonly number[]): NotesTraceCheck {
  const machine = createNotesMachine(blocks)
  const initial = {
    height: blocks.map((_, index) => machine.readBlock(index).height),
    bubbleWidth: blocks.map((_, index) => machine.readBlock(index).bubbleWidth),
  }
  const geometry = createGeometryReference(blocks, initial)
  const result: NotesTraceCheck = {
    frames: 0,
    comparisons: 0,
    decisionProblems: [],
    decisionProblemCount: 0,
    framesWithDecisionProblem: 0,
    maxLineWidthDrift: 0,
    framesWithMaxLineWidthDrift: 0,
    lineXDrift: 0,
    geometryDrift: 0,
    narrowestContentWidth: Infinity,
    widestContentWidth: -Infinity,
    settled: false,
  }
  for (const seed of seeds) {
    for (const frame of createResizeTrace(seed, machine.readWindow().width)) {
      for (const event of frame.events) {
        if (event.kind === 'down') machine.pointerDown(event.x, event.y)
        else if (event.kind === 'move') machine.pointerMove(event.x)
        else machine.pointerUp(event.x)
      }
      machine.step(frame.steps)
      result.frames++
      const view = machine.readWindow()
      result.narrowestContentWidth = Math.min(result.narrowestContentWidth, view.contentWidth)
      result.widestContentWidth = Math.max(result.widestContentWidth, view.contentWidth)
      geometry.step(frame.steps, frame.events, view.contentWidth)
      result.geometryDrift = Math.max(result.geometryDrift, Math.abs(view.width - geometry.state.windowWidth), Math.abs(view.height - geometry.state.windowHeight))
      const tops = geometry.tops()
      let frameHasDecisionProblem = false
      let frameHasWidthDrift = false
      for (let index = 0; index < blocks.length; index++) {
        const blockView = machine.readBlock(index)
        const comparison = compareBlock(blocks[index]!, blockView, view.contentWidth)
        result.comparisons++
        for (const problem of comparison.decisionProblems) {
          if (result.decisionProblems.length < 20) result.decisionProblems.push(`frame ${result.frames} block ${index}: ${problem}`)
          result.decisionProblemCount++
          frameHasDecisionProblem = true
        }
        if (comparison.maxLineWidthDrift > 0) frameHasWidthDrift = true
        result.maxLineWidthDrift = Math.max(result.maxLineWidthDrift, comparison.maxLineWidthDrift)
        result.lineXDrift = Math.max(result.lineXDrift, comparison.lineXDrift)
        result.geometryDrift = Math.max(result.geometryDrift, Math.abs(blockView.height - geometry.state.heights[index]!), Math.abs(blockView.top - tops[index]!))
        if (blockView.bubbleWidth !== null) result.geometryDrift = Math.max(result.geometryDrift, Math.abs(blockView.bubbleWidth - geometry.state.bubbleWidths[index]!))
      }
      if (frameHasDecisionProblem) result.framesWithDecisionProblem++
      if (frameHasWidthDrift) result.framesWithMaxLineWidthDrift++
    }
  }
  result.settled = machine.readWindow().animationActive === 0
  return result
}
