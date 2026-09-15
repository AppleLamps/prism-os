// Scripted drags for measuring the solver: seeded random drags across edge categories, each
// delivered as several frames whose target moves linearly from the edge's start to start + delta,
// the way pointer moves arrive during a real drag. Each frame starts from the previous frame's knobs.
import {authoredKnobs, cardCount, knobNames, knobSpecs} from './app-shell.ts'
import type {AppDrag, EdgeSide} from './app-drag.ts'
import {createRandom} from './circuit-tools.ts'
import {edgeValue, type DragSolver, type EdgeTerms, type FrameResult} from './drag-solver.ts'
import {galleryKnobNames, type GalleryDrag} from './gallery-drag.ts'

export const appDragCategories = [
  'card right edge',
  'card left edge',
  'card bottom edge',
  'card title bottom edge',
  'sidebar right edge',
  'second section top edge',
] as const
export type AppDragCategory = typeof appDragCategories[number]

export const galleryDragCategories = [
  'hero right edge',
  'hero bottom edge',
  'thumbnail right edge',
  'thumbnail bottom edge',
  'thumbnail left edge',
] as const
export type GalleryDragCategory = typeof galleryDragCategories[number]

export type ScriptedDrag = {
  index: number
  category: string
  node: string
  side: EdgeSide
  delta: number
  viewportWidth: number
  viewportHeight: number
  startKnobs: Record<string, number>
  // 'all' when every knob is unlocked, otherwise a random subset of one or two knobs.
  unlockMode: 'all' | 'subset'
  unlocked: string[]
  frames: number
}

const pickSubset = (random: () => number, names: readonly string[]) => {
  const shuffled = [...names].sort(() => random() - 0.5)
  return shuffled.slice(0, 1 + Math.floor(random() * 2))
}

export function scriptAppDrags(count: number, seed: number, frames = 6): ScriptedDrag[] {
  const random = createRandom(seed)
  return Array.from({length: count}, (_, index): ScriptedDrag => {
    const category = appDragCategories[index % appDragCategories.length]!
    const card = `card${Math.floor(random() * cardCount)}`
    const [node, side]: [string, EdgeSide] = category === 'card right edge' ? [card, 'right']
      : category === 'card left edge' ? [card, 'left']
      : category === 'card bottom edge' ? [card, 'bottom']
      : category === 'card title bottom edge' ? [`${card}.title`, 'bottom']
      : category === 'sidebar right edge' ? ['sidebar', 'right']
      : ['shared', 'top']
    const startKnobs: Record<string, number> = {...authoredKnobs}
    if (random() < 0.5) {
      for (const name of knobNames) {
        const spec = knobSpecs[name]
        // Somewhere in the middle 60% of the range.
        startKnobs[name] = spec.minimum + (0.2 + 0.6 * random()) * (spec.maximum - spec.minimum)
      }
    }
    const unlockMode = random() < 0.5 ? 'all' : 'subset'
    return {
      index,
      category,
      node,
      side,
      delta: (random() < 0.5 ? -1 : 1) * (4 + random() * 92),
      viewportWidth: 700 + Math.floor(random() * 1200),
      viewportHeight: 820,
      startKnobs,
      unlockMode,
      unlocked: unlockMode === 'all' ? [...knobNames] : pickSubset(random, knobNames),
      frames,
    }
  })
}

export function scriptGalleryDrags(count: number, seed: number, authored: Readonly<Record<string, number>>, frames = 6): ScriptedDrag[] {
  const random = createRandom(seed)
  return Array.from({length: count}, (_, index): ScriptedDrag => {
    const category = galleryDragCategories[index % galleryDragCategories.length]!
    const thumbnail = Math.floor(random() * 12)
    const [node, side]: [string, EdgeSide] = category === 'hero right edge' ? ['hero', 'right']
      : category === 'hero bottom edge' ? ['hero', 'bottom']
      : category === 'thumbnail right edge' ? [`thumbnail${thumbnail}`, 'right']
      : category === 'thumbnail bottom edge' ? [`thumbnail${thumbnail}`, 'bottom']
      : [`thumbnail${thumbnail}`, 'left']
    const roll = random()
    const unlockMode = roll < 0.5 ? 'all' : 'subset'
    const unlocked = roll < 0.5 ? [...galleryKnobNames] : roll < 0.75 ? ['gap', 'cinemaRailMaximum'] : pickSubset(random, galleryKnobNames)
    return {
      index,
      category,
      node,
      side,
      delta: (random() < 0.5 ? -1 : 1) * (4 + random() * 92),
      viewportWidth: 640 + Math.floor(random() * 1280),
      viewportHeight: 480 + Math.floor(random() * 620),
      startKnobs: {...authored},
      unlockMode,
      unlocked,
      frames,
    }
  })
}

export type DragRun = {drag: ScriptedDrag, startEdge: number, frames: FrameResult[]}

export function runScriptedDrag(
  solver: DragSolver,
  createSource: (viewportWidth: number, viewportHeight: number, knobs: Readonly<Record<string, number>>) => Float32Array,
  edgeOf: (drag: ScriptedDrag) => EdgeTerms,
  drag: ScriptedDrag,
  // Called after each frame with a copy of the source table as the frame started.
  onFrame?: (frame: number, sourceBefore: Float32Array, target: number, result: FrameResult) => void,
): DragRun {
  const source = createSource(drag.viewportWidth, drag.viewportHeight, drag.startKnobs)
  const edge = edgeOf(drag)
  const startEdge = edgeValue(solver.evaluate(source), edge)
  const unlocked = drag.unlocked.map(name => solver.problem.knobs.findIndex(knob => knob.name === name))
  const frames: FrameResult[] = []
  for (let frame = 1; frame <= drag.frames; frame++) {
    const target = startEdge + drag.delta * frame / drag.frames
    const sourceBefore = onFrame === undefined ? null : new Float32Array(source)
    const result = solver.solveFrame(source, unlocked, edge, target)
    frames.push(result)
    if (onFrame !== undefined) onFrame(frame, sourceBefore!, target, result)
  }
  return {drag, startEdge, frames}
}

export const appEdgeOf = (app: AppDrag) => (drag: ScriptedDrag) => app.edge(drag.node, drag.side)

export const galleryEdgeOf = (gallery: GalleryDrag) => (drag: ScriptedDrag) =>
  gallery.edge(drag.node === 'hero' ? -1 : Number(drag.node.replace('thumbnail', '')), drag.side)

export type FrameSummary = {
  frames: number
  // Frames whose target differed from the edge by more than the tolerance at the frame's start.
  moving: number
  solvedInOneStep: number
  solvedWithinThreeSteps: number
  // Moving frames whose first gradient step found no knob to move: every unlocked knob has gradient 0,
  // or every unlocked knob with a gradient sits at the range bound the step would push it past.
  zeroGradient: number
  blockedAtBound: number
  gradientChangedDecision: number
  searched: number
  solvedBySearch: number
  unsolved: number
  decisionFlips: number
  meanMicroseconds: number
  medianMicroseconds: number
  p90Microseconds: number
  maxMicroseconds: number
  // Mean frame time over frames that searched, and over frames that didn't.
  searchedMeanMicroseconds: number
  notSearchedMeanMicroseconds: number
}

export function summarizeFrames(frames: readonly FrameResult[], tolerance = 0.5): FrameSummary {
  const moving = frames.filter(frame => Math.abs(frame.startError) > tolerance)
  const frameTime = (frame: FrameResult) => frame.microseconds.gradient + frame.microseconds.search
  const times = frames.map(frameTime).sort((left, right) => left - right)
  const percentile = (fraction: number) => times.length === 0 ? 0 : times[Math.min(times.length - 1, Math.floor(fraction * times.length))]!
  const mean = (list: readonly FrameResult[]) => list.length === 0 ? 0 : list.reduce((sum, frame) => sum + frameTime(frame), 0) / list.length
  return {
    frames: frames.length,
    moving: moving.length,
    solvedInOneStep: moving.filter(frame => frame.solvedAtStep === 1).length,
    solvedWithinThreeSteps: moving.filter(frame => frame.solvedAtStep !== null && frame.solvedAtStep <= 3).length,
    zeroGradient: moving.filter(frame => frame.zeroGradient && frame.steps === 0).length,
    blockedAtBound: moving.filter(frame => frame.blockedAtBound && frame.steps === 0).length,
    gradientChangedDecision: moving.filter(frame => frame.gradientChangedDecision).length,
    searched: moving.filter(frame => frame.searched).length,
    solvedBySearch: moving.filter(frame => frame.outcome === 'search').length,
    unsolved: moving.filter(frame => frame.outcome === 'unsolved').length,
    decisionFlips: frames.filter(frame => frame.changedDecisions.length > 0).length,
    meanMicroseconds: mean(frames),
    medianMicroseconds: percentile(0.5),
    p90Microseconds: percentile(0.9),
    maxMicroseconds: times.at(-1) ?? 0,
    searchedMeanMicroseconds: mean(frames.filter(frame => frame.searched)),
    notSearchedMeanMicroseconds: mean(frames.filter(frame => !frame.searched)),
  }
}
