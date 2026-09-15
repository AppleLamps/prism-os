// The prepare step: everything that stays outside the circuit and runs once per
// thread. HTML parsing, pretext's prepare, breakpoint tabulation, and the static
// tree tables. Its results are numbers: thresholds and deltas that become circuit
// weights, and table entries that become wiring.

import {parseHNCommentHTML, type HNCommentDoc} from '../hn-thread/comment-doc.ts'
import type {HNComment} from '../hn-thread/hn-data.ts'
import {commentTextHeight, commentWidthAt, prepareComment, tabulateStaircase, type PreparedComment, type Staircase} from '../hn-thread/text-heights.ts'
import {containerWidthF, type ThreadState} from './thread-frame.ts'
import {buildThreadTables, threadLayout, type ThreadTables} from '../hn-thread/thread-model.ts'

export type PreparedThread = {
  comments: readonly HNComment[]
  docs: HNCommentDoc[]
  preparedComments: PreparedComment[]
  tables: ThreadTables
  staircases: Staircase[]
  // pretext itself, cached per row and width. The reference uses this; the circuit uses the staircases.
  textHeightAt(row: number, commentWidth: number): number
  prepareMilliseconds: number
  tabulateMilliseconds: number
}

export function prepareThread(comments: readonly HNComment[], sampleStep = 4): PreparedThread {
  const prepareStart = performance.now()
  const docs = comments.map(comment => parseHNCommentHTML(comment.comment))
  const preparedComments = docs.map(prepareComment)
  const tables = buildThreadTables(comments.map(comment => comment.indent))
  const prepareMilliseconds = performance.now() - prepareStart
  const caches = comments.map(() => new Map<number, number>())
  const textHeightAt = (row: number, commentWidth: number) => {
    const cache = caches[row]!
    let height = cache.get(commentWidth)
    if (height === undefined) {
      height = commentTextHeight(preparedComments[row]!, commentWidth)
      cache.set(commentWidth, height)
    }
    return height
  }
  const tabulateStart = performance.now()
  const staircases = comments.map((comment, row) =>
    tabulateStaircase(containerWidth => commentTextHeight(preparedComments[row]!, commentWidthAt(containerWidth, comment.indent)), sampleStep))
  const tabulateMilliseconds = performance.now() - tabulateStart
  return {comments, docs, preparedComments, tables, staircases, textHeightAt, prepareMilliseconds, tabulateMilliseconds}
}

export function naturalHeightsAt(prepared: PreparedThread, windowWidth: number) {
  const containerWidth = containerWidthF(windowWidth)
  return prepared.comments.map((comment, row) => prepared.textHeightAt(row, commentWidthAt(containerWidth, comment.indent)) + threadLayout.rowHeightExtra)
}

export function initialThreadState(prepared: PreparedThread, windowWidth: number): ThreadState {
  const naturalHeights = naturalHeightsAt(prepared, windowWidth)
  return {
    scrollTopPrevious: 0,
    scrollDeltaPrevious: 0,
    scrollerPeekUp: 0,
    containerWidthPrevious: containerWidthF(windowWidth),
    collapsed: naturalHeights.map(() => 0),
    restHeights: [...naturalHeights],
    heights: [...naturalHeights],
    restTargetsPrevious: [...naturalHeights],
  }
}
