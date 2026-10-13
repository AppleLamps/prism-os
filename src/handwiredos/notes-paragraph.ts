// The Notes paragraph: the text the note starts with, the options the flow is built
// with, and a baked default measurement of the starting text, so that
// createWindowManagerMachine() starts from the same table in every process without a
// canvas. The program itself is the same for every text and every font: its size
// follows from notesCapacity and notesWindow. notes-text.ts measures the text that
// the visitor types.
import type {FastParagraph} from './notes-walker.ts'

export const notesText =
  'This paragraph is laid out by the same circuit that runs the windows. Drag Files or Photos over this note, ' +
  'and every line narrows around them. Words move straight to their new places in one frame, and the lines break ' +
  'where pretext would break them.'

export const notesFont = '14px Georgia, "Times New Roman", serif'

// The paragraph's segments are its words and the single spaces between them, so
// the break-after bits alternate. The default widths were measured once with a
// deterministic fake canvas ("14px Test Serif", the rule in notes.test.ts) under
// @chenglou/pretext@0.0.9; notes.test.ts checks that the measurement still gives
// them. The browser measures the real font at mount instead, see prepareNotesText
// in notes-text.ts, which rounds each width to 1/64 px so that prefix sums in the
// circuit stay exact in FP32. pretext itself keeps the unrounded widths, so a
// browser line whose span lies within 1/128 px of the limit can break differently
// there.
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

export type NotesOptions = {
  // How many segment cells the flow has.
  capacity: number
  epsilon: number
  // The fast walker's window: how many segments a line can hold.
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

// How many segment cells the flow has. A segment is a word or the space after it,
// so the starting paragraph's 45 words take 89 cells, and 160 cells hold 80 words.
// A text with more segments is cut at the capacity, see the machine's notesText in
// window-manager.ts. Every cell is paid on every evaluation, whether or not the
// text uses it, and when the machine is built: at 160 cells and a window of 40 the
// machine builds in about 0.2 s in Bun, and 192 cells with a window of 48 take
// about 0.3 s, which the page would spend before it shows its windows.
export const notesCapacity = 160
// How many segments one line can hold, e.g. 20 words and the 20 spaces after them.
// The starting paragraph's longest line in the widest column holds 25 segments at
// the baked widths. A line with more segments wraps after 40, and the flow's
// windowOverflow output counts such lines.
export const notesWindow = 40

// The flow's structural constants, e.g. the walker window and the narrowest slot a
// band may use. The circuit's size follows from them, and none depends on the text.
export function notesOptionsFor(epsilon: number): NotesOptions {
  return {
    capacity: notesCapacity,
    epsilon,
    window: notesWindow,
    // Segments that break after themselves never follow each other: pretext collapses
    // white space into single spaces, and a host that measures other text keeps runs
    // apart, e.g. by merging a space and a zero-width space into one segment. The
    // flow's runOverflow output counts the runs that do occur.
    runLimit: 1,
    bands: 16,
    lineHeight: 22,
    padding: 24,
    maximumColumnWidth: 440,
    horizontalPadding: 10,
    verticalPadding: 4,
    // A segment wider than its band's slot is laid out whole and reaches past the
    // slot's edge, e.g. a 120 px word in an 85 px slot beside a window. pretext would
    // break such a word between two letters.
    minimumSlotWidth: 80,
  }
}
