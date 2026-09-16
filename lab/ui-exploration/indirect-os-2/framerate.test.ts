// Frame-rate independence in the combined circuit: the scripted session at 60 and
// 120 fps, compared at the timestamps both render.
import {expect, test} from 'bun:test'
import {configurations} from './configurations.ts'
import {lineFitEpsilon, loadPretext} from '../text-walker/fake-canvas.ts'
import {fastParagraph} from './fast-walker.ts'
import {compareFrameRates} from './framerate.ts'
import {notesOptionsFor, notesText, testFont} from './paragraph.ts'

const pretext = await loadPretext()
const paragraph = fastParagraph(pretext.prepareWithSegments(notesText, testFont))
const queue = configurations(paragraph, lineFitEpsilon).steps[4]!.options

test('with Notes flowing around the windows\' destinations, windows, thumbnails and words agree at 60 and 120 fps, and words move only in frames with events', () => {
  const result = compareFrameRates({...queue, notes: notesOptionsFor(paragraph, lineFitEpsilon, {obstacles: 'destinations'})})
  expect(result.sharedFrames).toBe(400)
  expect(result.windows).toBeLessThan(0.01)
  expect(result.thumbnails).toBeLessThan(0.01)
  expect(result.words).toBeLessThan(0.01)
  expect(result.discreteMismatches).toBe(0)
  // Frame 175, the same frame as in steps 2b and 3: the 60 fps run has stopped
  // animating and the 120 fps run hasn't yet. Before the word springs were
  // removed, the words were still settling at that frame in both runs.
  expect(result.animationMismatches).toBe(1)
  expect(result.wordMovesWithoutEvents).toBe(0)
})

test('for contrast: words laid out around the windows\' animated geometry reflow in frames with no event, while the windows animate', () => {
  const result = compareFrameRates({...queue, notes: notesOptionsFor(paragraph, lineFitEpsilon, {obstacles: 'current-frame'})})
  expect(result.windows).toBeLessThan(0.01)
  expect(result.wordMovesWithoutEvents).toBeGreaterThan(0)
  expect(result.discreteMismatches).toBe(0)
})
