// The Notes paragraph and the options the flow is built with.
import {type FastParagraph, fastWindow} from './fast-walker.ts'
import type {NotesOptions} from './notes.ts'

export const notesText =
  'This paragraph is laid out by the same circuit that runs the windows. Drag Files or Photos over this note, ' +
  'and every line narrows around them. Words move straight to their new places in one frame, and the lines break ' +
  'where pretext would break them.'

export const notesFont = '14px Georgia, "Times New Roman", serif'
export const testFont = '14px Test Serif'

export function notesOptionsFor(paragraph: FastParagraph, epsilon: number, overrides: Partial<NotesOptions> = {}): NotesOptions {
  const maximumColumnWidth = overrides.maximumColumnWidth ?? 440
  return {
    paragraph,
    epsilon,
    window: fastWindow(paragraph, maximumColumnWidth, epsilon),
    bands: 16,
    lineHeight: 22,
    padding: 24,
    maximumColumnWidth,
    horizontalPadding: 10,
    verticalPadding: 4,
    // Every slot fits the widest word, so the fast path never needs an emergency break.
    minimumSlotWidth: Math.max(80, Math.ceil(Math.max(...paragraph.widths)) + 1),
    // Words flow around where the windows are going, so the text reflows once, when
    // an event changes a destination, instead of at every frame of a window animation.
    obstacles: 'destinations',
    ...overrides,
  }
}
