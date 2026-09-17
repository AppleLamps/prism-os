// Comment text heights from pretext, and their tabulation into width breakpoints.
//
// A comment is laid out the way the vibescript port does it
// (hn-comment-layout.ts): each paragraph is a rich inline flow of text, italic and
// link runs, each code block is pre-wrap monospace, lines are 14px, and blocks are
// separated by 8px. Its height is a step function of the comment width. The
// circuit never runs pretext: the prepare step below finds every container width
// where a comment's height changes, and the circuit adds one comparison per change.

import {measureLineStats, prepareWithSegments, type PreparedTextWithSegments} from '../text-tabulated/pretext/layout.ts'
import {measureRichInlineStats, prepareRichInline, type PreparedRichInline} from '../text-tabulated/pretext/rich-inline.ts'
import type {HNCommentDoc} from './comment-doc.ts'
import {threadLayout} from './thread-model.ts'

export const commentLineHeight = 14
export const commentBlockGap = 8
export const commentBodyFont = '12px Verdana, Geneva, sans-serif'
export const commentItalicFont = 'italic 12px Verdana, Geneva, sans-serif'
export const commentCodeFont = '12px monospace'

export type PreparedComment = {
  blocks: ({kind: 'paragraph', flow: PreparedRichInline} | {kind: 'codeBlock', prepared: PreparedTextWithSegments})[]
}

export function prepareComment(doc: HNCommentDoc): PreparedComment {
  return {
    blocks: doc.blocks.map(block => block.kind === 'paragraph'
      ? {kind: 'paragraph', flow: prepareRichInline(block.runs.map(run => ({text: run.text, font: run.kind === 'italic' ? commentItalicFont : commentBodyFont})))}
      : {kind: 'codeBlock', prepared: prepareWithSegments(block.text, commentCodeFont, {whiteSpace: 'pre-wrap'})}),
  }
}

export function commentTextHeight(prepared: PreparedComment, commentWidth: number): number {
  const safeWidth = Math.max(1, commentWidth)
  let height = 0
  for (let blockIndex = 0; blockIndex < prepared.blocks.length; blockIndex++) {
    const block = prepared.blocks[blockIndex]!
    if (blockIndex > 0) height += commentBlockGap
    const lineCount = block.kind === 'paragraph'
      ? measureRichInlineStats(block.flow, safeWidth).lineCount
      : measureLineStats(block.prepared, safeWidth).lineCount
    height += lineCount * commentLineHeight
  }
  return height
}

export function commentWidthAt(containerWidth: number, indent: number) {
  return containerWidth - indent * threadLayout.indentWidth - threadLayout.commentLeftGap - threadLayout.commentRightGap
}

// height(containerWidth) = baseHeight + sum over steps of delta * [containerWidth >= step.containerWidth],
// for containerWidth in the tabulated range, by default minimumContainerWidth..maximumContainerWidth.
export type Staircase = {
  baseHeight: number
  steps: {containerWidth: number, delta: number}[]
}

// The container widths a staircase covers, and how close the bisection gets to
// each change. The defaults are hn-thread's container widths, 375..1200, and 1e-6px.
export type StaircaseRange = {
  minimumContainerWidth?: number
  maximumContainerWidth?: number
  tolerance?: number
}

// Samples every `sampleStep` px from the minimum width to the maximum width, then
// bisects each interval whose endpoints differ until it is under the tolerance. A
// height that changes and changes back within one sampling step would be missed;
// report.ts checks that with a 1/4px sweep.
export function tabulateStaircase(heightAt: (containerWidth: number) => number, sampleStep = 4, range: StaircaseRange = {}): Staircase {
  const {
    minimumContainerWidth: minimum = threadLayout.minimumContainerWidth,
    maximumContainerWidth: maximum = threadLayout.maximumContainerWidth,
    tolerance = 1e-6,
  } = range
  const steps: {containerWidth: number, delta: number}[] = []
  const refine = (low: number, lowHeight: number, high: number, highHeight: number) => {
    if (lowHeight === highHeight) return
    if (high - low <= tolerance) {
      steps.push({containerWidth: high, delta: highHeight - lowHeight})
      return
    }
    const middle = (low + high) / 2
    const middleHeight = heightAt(middle)
    refine(low, lowHeight, middle, middleHeight)
    refine(middle, middleHeight, high, highHeight)
  }
  const baseHeight = heightAt(minimum)
  let previousWidth = minimum
  let previousHeight = baseHeight
  while (previousWidth < maximum) {
    const width = Math.min(maximum, previousWidth + sampleStep)
    const height = heightAt(width)
    refine(previousWidth, previousHeight, width, height)
    previousWidth = width
    previousHeight = height
  }
  return {baseHeight, steps}
}

export function staircaseHeight(staircase: Staircase, containerWidth: number) {
  let height = staircase.baseHeight
  for (const step of staircase.steps) if (containerWidth >= step.containerWidth) height += step.delta
  return height
}
