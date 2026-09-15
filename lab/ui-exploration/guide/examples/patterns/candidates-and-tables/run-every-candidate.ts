// Run every candidate, then pick one. Three complete gallery layouts are computed on every
// evaluation, each layout gets a score, emitArgmax picks the highest score, and every output reads
// the picked layout through the argmax's one-hot. A smaller version of the repo root's
// candidate-gallery.ts, the Dynamic UI demo. Sizes here lie on quarter and eighth pixel grids, and
// target sizes are powers of two, so every score is exact both in FP32 and in float64, and the plain
// JavaScript version below picks the same layout at every viewport.
//
// Host contract: the viewport width and height are whole pixels within 0..4096.
import {Circuit, type Wire, emitArgmax, emitMinimum, emitMultiply, emitRelu} from '../../../../../../numeric-ui-core.ts'

export const photoCount = 8
export const gap = 16
export const viewportLimit = 4096
export const layoutNames = ['hero', 'grid', 'strip'] as const

export type Rect = {left: number, top: number, width: number, height: number}
export type Layout = {score: number, hero: Rect, heroPresent: number, thumbnails: Rect[]}

const relu = (value: number) => Math.max(0, value)
// How close a size is to the layout's target size, e.g. a 384 px wide photo against a 512 px target is 0.75.
const quality = (size: number, targetSize: number) => Math.min(1, size / targetSize)
const noHero: Rect = {left: 0, top: 0, width: 0, height: 0}

// A large photo on the left, and a rail of thumbnails, 2 across and 4 down, on the right.
export function heroLayout(viewportWidth: number, viewportHeight: number): Layout {
  const railWidth = Math.min(320, viewportWidth / 4)
  const heroWidth = relu(viewportWidth - railWidth - 3 * gap)
  const heroHeight = relu(viewportHeight - 2 * gap)
  const thumbnailWidth = relu(railWidth - gap) / 2
  const thumbnailHeight = relu(viewportHeight - 5 * gap) / 4
  return {
    score: Math.min(quality(heroWidth, 1024), quality(heroHeight, 512), quality(thumbnailWidth, 128), quality(thumbnailHeight, 128)),
    hero: {left: gap, top: gap, width: heroWidth, height: heroHeight},
    heroPresent: 1,
    thumbnails: Array.from({length: photoCount}, (_, item) => ({
      left: 2 * gap + heroWidth + (item % 2) * (thumbnailWidth + gap),
      top: gap + Math.floor(item / 2) * (thumbnailHeight + gap),
      width: thumbnailWidth,
      height: thumbnailHeight,
    })),
  }
}

// Every photo the same size, 4 across and 2 down, and no large photo.
export function gridLayout(viewportWidth: number, viewportHeight: number): Layout {
  const cellWidth = relu(viewportWidth - 5 * gap) / 4
  const cellHeight = relu(viewportHeight - 3 * gap) / 2
  return {
    score: Math.min(quality(cellWidth, 256), quality(cellHeight, 256)),
    hero: noHero,
    heroPresent: 0,
    thumbnails: Array.from({length: photoCount}, (_, item) => ({
      left: gap + (item % 4) * (cellWidth + gap),
      top: gap + Math.floor(item / 4) * (cellHeight + gap),
      width: cellWidth,
      height: cellHeight,
    })),
  }
}

// A large photo on top, and one row of 8 thumbnails below it.
export function stripLayout(viewportWidth: number, viewportHeight: number): Layout {
  const heroHeight = Math.min(viewportWidth / 2, viewportHeight / 2)
  const heroWidth = relu(viewportWidth - 2 * gap)
  const thumbnailWidth = relu(viewportWidth - 9 * gap) / 8
  const thumbnailHeight = relu(viewportHeight - heroHeight - 3 * gap)
  return {
    score: Math.min(quality(heroWidth, 512), quality(heroHeight, 256), quality(thumbnailWidth, 64), quality(thumbnailHeight, 64)),
    hero: {left: gap, top: gap, width: heroWidth, height: heroHeight},
    heroPresent: 1,
    thumbnails: Array.from({length: photoCount}, (_, item) => ({
      left: gap + item * (thumbnailWidth + gap),
      top: 2 * gap + heroHeight,
      width: thumbnailWidth,
      height: thumbnailHeight,
    })),
  }
}

// The loop the circuit replaces: build every layout, and keep the first one with the highest score.
export function chooseLayout(viewportWidth: number, viewportHeight: number) {
  const layouts = [heroLayout, gridLayout, stripLayout].map(buildLayout => buildLayout(viewportWidth, viewportHeight))
  let chosenLayout = 0
  for (let index = 1; index < layouts.length; index++) {
    if (layouts[index]!.score > layouts[chosenLayout]!.score) chosenLayout = index
  }
  return {chosenLayout, scores: layouts.map(layout => layout.score), layout: layouts[chosenLayout]!}
}

// The outputs in the order buildCandidateGallery returns its roots.
export function flattenChoice(choice: ReturnType<typeof chooseLayout>): number[] {
  const {chosenLayout, scores, layout} = choice
  const rect = ({left, top, width, height}: Rect) => [left, top, width, height]
  return [
    ...layoutNames.map((_, index) => (index === chosenLayout ? 1 : 0)),
    chosenLayout,
    ...scores,
    ...rect(layout.hero),
    layout.heroPresent,
    ...layout.thumbnails.flatMap(rect),
  ]
}

type RectWires = {left: Wire, top: Wire, width: Wire, height: Wire}
type CandidateWires = {score: Wire, hero: RectWires, heroPresent: Wire, thumbnails: RectWires[]}

export function buildCandidateGallery() {
  // Source cells: the viewport width and height.
  const circuit = new Circuit(2)
  const viewportWidth: Wire = 0
  const viewportHeight: Wire = 1
  circuit.assumeRange(viewportWidth, 0, viewportLimit)
  circuit.assumeRange(viewportHeight, 0, viewportLimit)
  const constant = (value: number) => circuit.affine([], value)
  const zero = constant(0)
  const one = constant(1)
  const reluOf = (terms: [Wire, number][], bias = 0) => emitRelu(circuit, circuit.affine(terms, bias))
  // JS: Math.min(1, size / targetSize). The target is a power of two, so the ratio is exact.
  const quality = (size: Wire, targetSize: number) => {
    const excess = reluOf([[size, 1 / targetSize]], -1)
    return circuit.affine([[size, 1 / targetSize], [excess, -1]])
  }
  // JS: Math.min(...qualities). Sizes are never negative, so the score lies within 0..1, which emitArgmax needs.
  const bottleneck = (qualities: readonly Wire[]) => {
    let score = qualities[0]!
    for (const next of qualities.slice(1)) score = emitMinimum(circuit, score, next)
    circuit.assumeRange(score, 0, 1)
    return score
  }
  const noHero: RectWires = {left: zero, top: zero, width: zero, height: zero}

  // heroLayout
  const railWidth = emitMinimum(circuit, constant(320), circuit.affine([[viewportWidth, 1 / 4]]))
  const heroWidth = reluOf([[viewportWidth, 1], [railWidth, -1]], -3 * gap)
  const heroHeight = reluOf([[viewportHeight, 1]], -2 * gap)
  const railThumbnailWidth = circuit.affine([[reluOf([[railWidth, 1]], -gap), 1 / 2]])
  const railThumbnailHeight = circuit.affine([[reluOf([[viewportHeight, 1]], -5 * gap), 1 / 4]])
  const hero: CandidateWires = {
    score: bottleneck([quality(heroWidth, 1024), quality(heroHeight, 512), quality(railThumbnailWidth, 128), quality(railThumbnailHeight, 128)]),
    hero: {left: constant(gap), top: constant(gap), width: heroWidth, height: heroHeight},
    heroPresent: one,
    thumbnails: Array.from({length: photoCount}, (_, item) => ({
      left: circuit.affine([[heroWidth, 1], [railThumbnailWidth, item % 2]], 2 * gap + (item % 2) * gap),
      top: circuit.affine([[railThumbnailHeight, Math.floor(item / 2)]], gap + Math.floor(item / 2) * gap),
      width: railThumbnailWidth,
      height: railThumbnailHeight,
    })),
  }

  // gridLayout
  const cellWidth = circuit.affine([[reluOf([[viewportWidth, 1]], -5 * gap), 1 / 4]])
  const cellHeight = circuit.affine([[reluOf([[viewportHeight, 1]], -3 * gap), 1 / 2]])
  const grid: CandidateWires = {
    score: bottleneck([quality(cellWidth, 256), quality(cellHeight, 256)]),
    hero: noHero,
    heroPresent: zero,
    thumbnails: Array.from({length: photoCount}, (_, item) => ({
      left: circuit.affine([[cellWidth, item % 4]], gap + (item % 4) * gap),
      top: circuit.affine([[cellHeight, Math.floor(item / 4)]], gap + Math.floor(item / 4) * gap),
      width: cellWidth,
      height: cellHeight,
    })),
  }

  // stripLayout
  const stripHeroHeight = emitMinimum(circuit, circuit.affine([[viewportWidth, 1 / 2]]), circuit.affine([[viewportHeight, 1 / 2]]))
  const stripHeroWidth = reluOf([[viewportWidth, 1]], -2 * gap)
  const stripThumbnailWidth = circuit.affine([[reluOf([[viewportWidth, 1]], -9 * gap), 1 / 8]])
  const stripThumbnailHeight = reluOf([[viewportHeight, 1], [stripHeroHeight, -1]], -3 * gap)
  const strip: CandidateWires = {
    score: bottleneck([quality(stripHeroWidth, 512), quality(stripHeroHeight, 256), quality(stripThumbnailWidth, 64), quality(stripThumbnailHeight, 64)]),
    hero: {left: constant(gap), top: constant(gap), width: stripHeroWidth, height: stripHeroHeight},
    heroPresent: one,
    thumbnails: Array.from({length: photoCount}, (_, item) => ({
      left: circuit.affine([[stripThumbnailWidth, item]], gap + item * gap),
      top: circuit.affine([[stripHeroHeight, 1]], 2 * gap),
      width: stripThumbnailWidth,
      height: stripThumbnailHeight,
    })),
  }

  // Pick one: a tournament over the scores. On an exact tie, the left layout is kept.
  const candidates = [hero, grid, strip]
  const scores = candidates.map(candidate => candidate.score)
  const argmax = emitArgmax(circuit, scores, one)
  // JS: layouts[chosenLayout].field, as a masked sum over the argmax's one-hot. Every value has a finite
  // declared range, so the compiler turns each masked sum into one gather.
  const pick = (field: (candidate: CandidateWires) => Wire) => circuit.affine(
    candidates.map((candidate, index) => [emitMultiply(circuit, argmax.selected[index]!, field(candidate)), 1] as [Wire, number]),
  )
  const pickRect = (rect: (candidate: CandidateWires) => RectWires) => [
    pick(candidate => rect(candidate).left),
    pick(candidate => rect(candidate).top),
    pick(candidate => rect(candidate).width),
    pick(candidate => rect(candidate).height),
  ]
  const chosenLayout = circuit.affine(argmax.selected.map((bit, index) => [bit, index] as [Wire, number]))
  const pickedOutputs = [
    ...pickRect(candidate => candidate.hero),
    pick(candidate => candidate.heroPresent),
    ...Array.from({length: photoCount}, (_, item) => pickRect(candidate => candidate.thumbnails[item]!)).flat(),
  ]
  const roots = [...argmax.selected, chosenLayout, ...scores, ...pickedOutputs]
  return {circuit, scores, selected: argmax.selected, roots}
}

export function candidateSource(viewportWidth: number, viewportHeight: number) {
  return Float32Array.from([viewportWidth, viewportHeight])
}
