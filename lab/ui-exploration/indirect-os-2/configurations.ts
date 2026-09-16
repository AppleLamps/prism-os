// The option sets the report attributes differences to, from window-manager.ts
// to the whole program. Each step changes one thing.
import type {FastParagraph} from './fast-walker.ts'
import {type IndirectOSOptions, originalOptions} from './indirect-os.ts'
import {notesOptionsFor} from './paragraph.ts'

export type Configuration = {label: string, options: IndirectOSOptions}

export const queueInput = {kind: 'queue', capacity: 8, maximumDowns: 2, keyGates: 'per-phase'} as const

export function configurations(paragraph: FastParagraph, epsilon: number) {
  const declared: IndirectOSOptions = {...originalOptions, declareTimestep: true}
  const bank: IndirectOSOptions = {...originalOptions, springs: 'bank'}
  const bankStepped: IndirectOSOptions = {...bank, photosViewport: 'stepped-springs'}
  const queue: IndirectOSOptions = {...bankStepped, input: queueInput}
  const notes: IndirectOSOptions = {...queue, notes: notesOptionsFor(paragraph, epsilon)}
  const notesCurrent: IndirectOSOptions = {...queue, notes: notesOptionsFor(paragraph, epsilon, {obstacles: 'current-frame'})}
  const notesStepped: IndirectOSOptions = {...queue, notes: notesOptionsFor(paragraph, epsilon, {obstacles: 'stepped-springs'})}
  return {
    // Cumulative, one change per step.
    steps: [
      {label: 'original window-manager.ts (notation rewrite)', options: originalOptions},
      {label: '1. timestep declared nonnegative', options: declared},
      {label: '2a. spring bank', options: bank},
      {label: '2b. Photos reads stepped springs', options: bankStepped},
      {label: '3. event queue, 8 slots, 2 downs, key routing', options: queue},
      {label: '4. Notes flow around the windows\' destinations', options: notes},
    ] satisfies Configuration[],
    alternatives: [
      {label: 'queue with 1 down per evaluation', options: {...queue, input: {...queueInput, maximumDowns: 1}}},
      {label: 'queue with 16 slots', options: {...queue, input: {...queueInput, capacity: 16}}},
      {label: 'queue with gathered key gates', options: {...queue, input: {...queueInput, keyGates: 'gather'}}},
      {label: 'Notes around current-frame obstacles', options: notesCurrent},
      {label: 'Notes around stepped-springs obstacles', options: notesStepped},
      {label: 'Notes around destinations, 1 down per evaluation', options: {...notes, input: {...queueInput, maximumDowns: 1}}},
    ] satisfies Configuration[],
    // Changes applied in other orders, to see whether savings add up.
    interference: [
      {label: 'queue with original springs (timestep declared)', options: {...declared, input: queueInput}},
      {label: 'queue, bank, Photos at current frame', options: {...bank, input: queueInput}},
      {label: 'Notes with original springs (timestep declared)', options: {...declared, input: queueInput, notes: notesOptionsFor(paragraph, epsilon)}},
    ] satisfies Configuration[],
    final: notes,
  }
}
