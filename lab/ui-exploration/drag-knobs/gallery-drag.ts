// candidate-gallery as a DragProblem, using the same solver as the app shell. Knobs: the gap,
// the cinema rail's maximum width, and the 7 quality scales. Only the gap and the rail maximum
// move geometry. The quality scales only decide which layout wins, so their gradient on any
// edge is 0 except through the selected layout, and a drag that needs another layout has to
// come from search. Decisions: the selected layout one-hot and the hero's presence.
import type {Wire} from '../../../numeric-ui-core.ts'
import {createCandidateGalleryMachine, layoutNames, sourceField} from './candidate-gallery.ts'
import type {DragProblem, EdgeTerms, KnobSpec} from './drag-solver.ts'
import type {MarginQuery} from './flip-query.ts'

export const galleryKnobNames = [
  'gap',
  'cinemaRailMaximum',
  'contactCellScale',
  'cinemaHeroWidthScale',
  'cinemaHeroHeightScale',
  'cinemaThumbnailScale',
  'storyHeroWidthScale',
  'storyHeroHeightScale',
  'storyThumbnailScale',
] as const
export type GalleryKnobName = typeof galleryKnobNames[number]

export type GalleryDrag = ReturnType<typeof createGalleryDrag>

export function createGalleryDrag() {
  const machine = createCandidateGalleryMachine()
  const {circuit, output} = machine
  const authored = Object.fromEntries(galleryKnobNames.map(name => [name, machine.source[sourceField[name]]!])) as Record<GalleryKnobName, number>
  const knobs: KnobSpec[] = galleryKnobNames.map(name => {
    const cell = sourceField[name]
    if (name === 'gap') return {name, cell, minimum: 0, maximum: 64, magnitudeFloor: 1}
    if (name === 'cinemaRailMaximum') return {name, cell, minimum: 100, maximum: 600, magnitudeFloor: 1}
    const value = authored[name]
    return {name, cell, minimum: value / 3, maximum: value * 3, magnitudeFloor: value / 100}
  })
  const problem: DragProblem = {
    circuit,
    knobs,
    decisions: [...output.selectedLayout, output.heroPresent],
    violations: null,
    outputs: [...output.hero, ...output.thumbnails],
    margins: [...output.scores, ...output.rawScores],
  }
  const createSource = (viewportWidth: number, viewportHeight: number, knobValues: Readonly<Record<string, number>> = authored) => {
    const source = new Float32Array(machine.source)
    source[sourceField.viewportWidth] = viewportWidth
    source[sourceField.viewportHeight] = viewportHeight
    for (const name of galleryKnobNames) source[sourceField[name]] = knobValues[name] ?? authored[name]
    return source
  }
  // item -1 is the hero; 0..11 are thumbnails.
  const edge = (item: number, side: 'left' | 'right' | 'top' | 'bottom'): EdgeTerms => {
    const start = item < 0 ? 0 : item * 4
    const wires = item < 0 ? output.hero : output.thumbnails
    const [left, top, width, height] = [wires[start]!, wires[start + 1]!, wires[start + 2]!, wires[start + 3]!]
    switch (side) {
      case 'left': return [[left, 1]]
      case 'right': return [[left, 1], [width, 1]]
      case 'top': return [[top, 1]]
      case 'bottom': return [[top, 1], [height, 1]]
    }
  }
  const selectedIndex = (values: ArrayLike<number>) => output.selectedLayout.findIndex(wire => values[wire] === 1)
  // Rival i takes over from the winner w where rawScores[w] - scores[i] crosses 0.
  const layoutQueries = (values: ArrayLike<number>): MarginQuery[] => {
    const winner = selectedIndex(values)
    return layoutNames.flatMap((name, rival): MarginQuery[] => rival === winner ? [] : [{
      label: `${name} takes over from ${layoutNames[winner]}`,
      terms: [[output.rawScores[winner]!, 1], [output.scores[rival]!, -1]] as [Wire, number][],
      results: output.selectedLayout,
      expected: layoutNames.map((_, index) => index === rival ? 1 : 0),
    }])
  }
  // The clamped margin, for comparison: the winner's clamped score minus the rival's.
  const clampedMargin = (values: ArrayLike<number>, rival: number) => values[output.scores[selectedIndex(values)]!]! - values[output.scores[rival]!]!
  return {machine, problem, authored, createSource, edge, selectedIndex, layoutQueries, clampedMargin}
}
