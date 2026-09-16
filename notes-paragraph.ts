// The Notes paragraph: its text, how the host measures it with pretext, the
// options the flow is built with, and a baked default measurement so that
// createWindowManagerMachine() builds the same program in every process without
// a canvas.
import {type PreparedTextWithSegments, prepareWithSegments} from '@chenglou/pretext'
import {type FastParagraph, fastWindow, longestBreakAfterRun, maximumSegmentWidth} from './notes-walker.ts'
import {invariant} from './numeric-ui-core.ts'

export const notesText =
  'This paragraph is laid out by the same circuit that runs the windows. Drag Files or Photos over this note, ' +
  'and every line narrows around them. Words move straight to their new places in one frame, and the lines break ' +
  'where pretext would break them.'

export const notesFont = '14px Georgia, "Times New Roman", serif'

// The paragraph's segments are its words and the single spaces between them, so
// the break-after bits alternate. The default widths were measured once with a
// deterministic fake canvas ("14px Test Serif", the rule in notes.test.ts) under
// @chenglou/pretext@0.0.9; notes.test.ts checks that the measurement still gives
// them. The browser measures the real font at mount instead, see
// measureNotesParagraph.
export const notesWords = notesText.split(' ')
export const defaultNotesParagraph: FastParagraph = {
  widths: [
    28.4375, 4.375, 69.5625, 4.375, 14.875, 4.375, 28.875, 4.375, 22.53125, 4.375, 14.65625, 4.375, 23.1875, 4.375,
    31.5, 4.375, 51.625, 4.375, 31.0625, 4.375, 30.40625, 4.375, 23.1875, 4.375, 56, 4.375, 31.28125, 4.375,
    37.40625, 4.375, 15.96875, 4.375, 45.28125, 4.375, 30.625, 4.375, 29.75, 4.375, 36.96875, 4.375, 22.96875, 4.375,
    38.28125, 4.375, 29.09375, 4.375, 54.25, 4.375, 45.0625, 4.375, 35.21875, 4.375, 40.6875, 4.375, 29.53125, 4.375,
    63, 4.375, 16.40625, 4.375, 37.84375, 4.375, 22.3125, 4.375, 47.03125, 4.375, 13.78125, 4.375, 23.40625, 4.375,
    44.625, 4.375, 22.96875, 4.375, 23.1875, 4.375, 37.625, 4.375, 38.5, 4.375, 37.625, 4.375, 57.09375, 4.375,
    35.4375, 4.375, 38.5, 4.375, 35.21875,
  ],
  breakAfter: notesWords.flatMap((_, index) => index === 0 ? [0] : [1, 0]),
}

// pretext's line fit test is `lineWidth + width > maxWidth + lineFitEpsilon`, with
// an epsilon of 1/64 px on Safari and 0.005 px elsewhere. The package doesn't
// export its getEngineProfile, so this repeats @chenglou/pretext@0.0.9's rule.
// The circuit is built with the same epsilon, so the walker breaks lines where
// pretext does; a mismatch would only move a break whose span lies within 1/64 px
// of the limit.
export const defaultLineFitEpsilon = 0.005
export function lineFitEpsilonFor(navigator: {userAgent: string, vendor?: string}): number {
  const {userAgent, vendor} = navigator
  const safari = vendor === 'Apple Computer, Inc.'
    && userAgent.includes('Safari/')
    && !['Chrome/', 'Chromium/', 'CriOS/', 'FxiOS/', 'EdgiOS/'].some(engine => userAgent.includes(engine))
  return safari ? 1 / 64 : defaultLineFitEpsilon
}

// The paragraph as pretext segments and measures it in `font`, with each width
// rounded to 1/64 px so prefix sums in the circuit stay exact in FP32 (pretext
// itself keeps the unrounded widths, so a browser line whose span lies within
// 1/128 px of the limit can break differently there). Returns the prepared text
// too, so a test can run pretext's own layoutNextLineRange on the same measurement.
export function measureNotesParagraph(font = notesFont): {paragraph: FastParagraph, prepared: PreparedTextWithSegments} {
  const prepared = prepareWithSegments(notesText, font)
  invariant(prepared.simpleLineWalkFastPath && prepared.letterSpacing === 0, 'the walker needs pretext fast-path text')
  const breakAfter = prepared.kinds.map(kind => kind === 'space' || kind === 'zero-width-break' ? 1 : 0)
  const widths = prepared.widths.map(width => Math.round(width * 64) / 64)
  invariant(widths.every(width => width >= 0 && width <= maximumSegmentWidth), 'a segment is wider than the walker allows')
  return {paragraph: {widths, breakAfter}, prepared}
}

export type NotesOptions = {
  paragraph: FastParagraph
  epsilon: number
  // The fast walker's window: segments compared after a line start, see fastWindow.
  window: number
  runLimit: number
  // Line slots, each lineHeight px tall, starting `padding` px below the top of
  // the content box and `padding` px in from its left edge.
  bands: number
  lineHeight: number
  padding: number
  maximumColumnWidth: number
  // Space kept between the text and an obstacle, horizontally and vertically.
  horizontalPadding: number
  verticalPadding: number
  minimumSlotWidth: number
}

// The flow's structural constants for a paragraph, e.g. the walker window and the
// narrowest slot a band may use. The circuit's size follows from them, so a machine
// built from a live measurement fits that measurement's widths.
export function notesOptionsFor(paragraph: FastParagraph, epsilon: number): NotesOptions {
  const maximumColumnWidth = 440
  return {
    paragraph,
    epsilon,
    window: fastWindow(paragraph, maximumColumnWidth, epsilon),
    runLimit: longestBreakAfterRun(paragraph.breakAfter),
    bands: 16,
    lineHeight: 22,
    padding: 24,
    maximumColumnWidth,
    horizontalPadding: 10,
    verticalPadding: 4,
    // Every slot fits the widest word, so the fast path never needs an emergency break.
    minimumSlotWidth: Math.max(80, Math.ceil(Math.max(...paragraph.widths)) + 1),
  }
}
