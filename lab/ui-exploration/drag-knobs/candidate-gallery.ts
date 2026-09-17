// A copy of the repo root's candidate-gallery.ts (circuit and machine only, no DOM), with one
// addition: rawScores, each layout's quality bottleneck without the clamp at 1. The clamped
// scores decide the selected layout. When two layouts both reach 1, the tie resolves to the
// leftmost, and the clamped margin between them is 0 with a gradient of 0. The raw score is
// the unclamped output next to the clamped one, which flip queries need: rival i takes over
// from winner w exactly when rawScores[w] drops below scores[i] (strictly for i > w, or to
// equality for i < w), whether or not either score is clamped.
import {
  Circuit,
  type Wire,
  emitArgmax,
  emitFirstActive,
  emitMinimum,
  emitMultiply,
  emitRelu,
  invariant,
  validateCircuit,
  validateTensorProgram,
} from '../../../src/runtime/numeric-ui-core.ts'

export const photoCount = 12

export const layoutNames = ['Cinema', 'Contact', 'Story'] as const

export const sourceField = {
  viewportWidth: 0,
  viewportHeight: 1,
  gap: 2,
  clickActive: 3,
  clickX: 4,
  clickY: 5,
  focusStart: 6,
  unit: 18,
  contactCellScale: 19,
  cinemaHeroWidthScale: 20,
  cinemaHeroHeightScale: 21,
  cinemaThumbnailScale: 22,
  storyHeroWidthScale: 23,
  storyHeroHeightScale: 24,
  storyThumbnailScale: 25,
  cinemaRailMaximum: 26,
  size: 27,
} as const

type Geometry = {
  left: Wire
  top: Wire
  width: Wire
  height: Wire
}

type Candidate = {
  score: Wire
  rawScore: Wire
  thumbnails: Geometry[]
  hero: Geometry
  heroPresent: Wire
}

export type CandidateGalleryOutput = {
  nextSource: Wire[]
  selectedLayout: Wire[]
  scores: Wire[]
  rawScores: Wire[]
  winningScore: Wire
  focus: Wire[]
  thumbnails: Wire[]
  hero: Wire[]
  heroPresent: Wire
}

export function focusField(item: number) {
  invariant(Number.isInteger(item) && item >= 0 && item < photoCount, 'photo index is invalid')
  return sourceField.focusStart + item
}

export function createCandidateGalleryCircuit() {
  const circuit = new Circuit(sourceField.size)
  for (const field of [
    sourceField.viewportWidth,
    sourceField.viewportHeight,
    sourceField.clickX,
    sourceField.clickY,
    sourceField.cinemaRailMaximum,
  ]) {
    circuit.assumeRange(field, 0, 16_384)
  }
  circuit.assumeRange(sourceField.gap, 0, 1024)
  for (const field of [
    sourceField.contactCellScale,
    sourceField.cinemaHeroWidthScale,
    sourceField.cinemaHeroHeightScale,
    sourceField.cinemaThumbnailScale,
    sourceField.storyHeroWidthScale,
    sourceField.storyHeroHeightScale,
    sourceField.storyThumbnailScale,
  ]) {
    circuit.assumeRange(field, 0, Number.POSITIVE_INFINITY)
  }
  circuit.assumeRange(sourceField.clickActive, 0, 1)
  circuit.assumeRange(sourceField.unit, 1, 1)
  for (let item = 0; item < photoCount; item++) {
    circuit.assumeRange(focusField(item), 0, 1)
  }

  const zero = circuit.affine([])
  const unit = sourceField.unit
  const focus = Array.from({length: photoCount}, (_, item) => focusField(item))

  // Each quality term is size × scale clamped to 1. The layout's score is the smallest
  // clamped term, and its raw score is the smallest unclamped term.
  function quality(pairs: readonly (readonly [size: Wire, scale: Wire])[]) {
    const products: Wire[] = []
    const clamped: Wire[] = []
    for (const [size, scale] of pairs) {
      const product = emitMultiply(circuit, size, scale)
      products.push(product)
      clamped.push(emitMinimum(circuit, unit, product))
    }
    let score = clamped[0]!
    for (let index = 1; index < clamped.length; index++) score = emitMinimum(circuit, score, clamped[index]!)
    circuit.assumeRange(score, 0, 1)
    let rawScore = products[0]!
    for (let index = 1; index < products.length; index++) rawScore = emitMinimum(circuit, rawScore, products[index]!)
    return {score, rawScore}
  }

  const contactInnerWidth = emitRelu(circuit, circuit.affine([
    [sourceField.viewportWidth, 1],
    [sourceField.gap, -5],
  ]))
  const contactInnerHeight = emitRelu(circuit, circuit.affine([
    [sourceField.viewportHeight, 1],
    [sourceField.gap, -4],
  ]))
  const contactCellWidth = circuit.affine([[contactInnerWidth, 1 / 4]])
  const contactCellHeight = circuit.affine([[contactInnerHeight, 1 / 3]])
  const contactThumbnails: Geometry[] = []
  for (let item = 0; item < photoCount; item++) {
    const column = item % 4
    const row = Math.floor(item / 4)
    contactThumbnails.push({
      left: circuit.affine([
        [sourceField.gap, 1 + column],
        [contactCellWidth, column],
      ]),
      top: circuit.affine([
        [sourceField.gap, 1 + row],
        [contactCellHeight, row],
      ]),
      width: contactCellWidth,
      height: contactCellHeight,
    })
  }
  const emptyHero = {left: zero, top: zero, width: zero, height: zero}
  const contact: Candidate = {
    ...quality([
      [contactCellWidth, sourceField.contactCellScale],
      [contactCellHeight, sourceField.contactCellScale],
    ]),
    thumbnails: contactThumbnails,
    hero: emptyHero,
    heroPresent: zero,
  }

  const cinemaRailWidth = emitMinimum(
    circuit,
    sourceField.cinemaRailMaximum,
    circuit.affine([[sourceField.viewportWidth, 0.28]]),
  )
  const cinemaHero: Geometry = {
    left: sourceField.gap,
    top: sourceField.gap,
    width: emitRelu(circuit, circuit.affine([
      [sourceField.viewportWidth, 1],
      [cinemaRailWidth, -1],
      [sourceField.gap, -3],
    ])),
    height: emitRelu(circuit, circuit.affine([
      [sourceField.viewportHeight, 1],
      [sourceField.gap, -2],
    ])),
  }
  const cinemaThumbnailWidth = emitRelu(circuit, circuit.affine([
    [cinemaRailWidth, 0.5],
    [sourceField.gap, -0.5],
  ]))
  const cinemaThumbnailHeight = emitRelu(circuit, circuit.affine([
    [sourceField.viewportHeight, 1 / 6],
    [sourceField.gap, -7 / 6],
  ]))
  const cinemaRailLeft = circuit.affine([
    [cinemaHero.left, 1],
    [cinemaHero.width, 1],
    [sourceField.gap, 1],
  ])
  const cinemaSlots = Array.from({length: photoCount}, (_, slot): Geometry => {
    const column = slot % 2
    const row = Math.floor(slot / 2)
    return {
      left: circuit.affine([
        [cinemaRailLeft, 1],
        [cinemaThumbnailWidth, column],
        [sourceField.gap, column],
      ]),
      top: circuit.affine([
        [sourceField.gap, 1 + row],
        [cinemaThumbnailHeight, row],
      ]),
      width: cinemaThumbnailWidth,
      height: cinemaThumbnailHeight,
    }
  })
  const cinema: Candidate = {
    ...quality([
      [cinemaHero.width, sourceField.cinemaHeroWidthScale],
      [cinemaHero.height, sourceField.cinemaHeroHeightScale],
      [cinemaThumbnailWidth, sourceField.cinemaThumbnailScale],
      [cinemaThumbnailHeight, sourceField.cinemaThumbnailScale],
    ]),
    thumbnails: cinemaSlots,
    hero: cinemaHero,
    heroPresent: unit,
  }

  const storyHeroHeight = emitMinimum(
    circuit,
    circuit.affine([[sourceField.viewportWidth, 0.72]]),
    circuit.affine([[sourceField.viewportHeight, 0.58]]),
  )
  const storyHero: Geometry = {
    left: sourceField.gap,
    top: sourceField.gap,
    width: emitRelu(circuit, circuit.affine([
      [sourceField.viewportWidth, 1],
      [sourceField.gap, -2],
    ])),
    height: storyHeroHeight,
  }
  const storyThumbnailRegionTop = circuit.affine([
    [storyHeroHeight, 1],
    [sourceField.gap, 2],
  ])
  const storyThumbnailWidth = emitRelu(circuit, circuit.affine([
    [sourceField.viewportWidth, 1 / 3],
    [sourceField.gap, -4 / 3],
  ]))
  const storyThumbnailHeight = emitRelu(circuit, circuit.affine([
    [sourceField.viewportHeight, 1 / 4],
    [storyHeroHeight, -1 / 4],
    [sourceField.gap, -6 / 4],
  ]))
  const storySlots = Array.from({length: photoCount}, (_, slot): Geometry => {
    const column = slot % 3
    const row = Math.floor(slot / 3)
    return {
      left: circuit.affine([
        [sourceField.gap, 1 + column],
        [storyThumbnailWidth, column],
      ]),
      top: circuit.affine([
        [storyThumbnailRegionTop, 1],
        [sourceField.gap, row],
        [storyThumbnailHeight, row],
      ]),
      width: storyThumbnailWidth,
      height: storyThumbnailHeight,
    }
  })
  const story: Candidate = {
    ...quality([
      [storyHero.width, sourceField.storyHeroWidthScale],
      [storyHero.height, sourceField.storyHeroHeightScale],
      [storyThumbnailWidth, sourceField.storyThumbnailScale],
      [storyThumbnailHeight, sourceField.storyThumbnailScale],
    ]),
    thumbnails: storySlots,
    hero: storyHero,
    heroPresent: unit,
  }

  const candidates = [cinema, contact, story]
  const scores = candidates.map(candidate => candidate.score)
  const winner = emitArgmax(circuit, scores, unit)

  function selectValue(values: readonly Wire[]) {
    const terms: [Wire, number][] = []
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      terms.push([emitMultiply(circuit, winner.selected[candidateIndex]!, values[candidateIndex]!), 1])
    }
    return circuit.affine(terms)
  }

  function selectGeometry(geometries: readonly Geometry[]): Geometry {
    return {
      left: selectValue(geometries.map(geometry => geometry.left)),
      top: selectValue(geometries.map(geometry => geometry.top)),
      width: selectValue(geometries.map(geometry => geometry.width)),
      height: selectValue(geometries.map(geometry => geometry.height)),
    }
  }

  const thumbnails: Geometry[] = []
  for (let item = 0; item < photoCount; item++) {
    thumbnails.push(selectGeometry(candidates.map(candidate => candidate.thumbnails[item]!)))
  }
  const hero = selectGeometry(candidates.map(candidate => candidate.hero))
  const heroPresent = selectValue(candidates.map(candidate => candidate.heroPresent))
  circuit.assumeRange(heroPresent, 0, 1)
  const thumbnailHits = thumbnails.map(thumbnail => emitRectangleHit(circuit, sourceField.clickX, sourceField.clickY, thumbnail))
  const clicked = emitFirstActive(circuit, sourceField.clickActive, thumbnailHits)
  const clickedMass = circuit.affine(clicked.map((wire): [Wire, number] => [wire, 1]))
  circuit.assumeRange(clickedMass, 0, 1)
  const keepFocus = circuit.affine([[clickedMass, -1]], 1)
  const nextFocus = focus.map((wire, item) => circuit.affine([
    [clicked[item]!, 1],
    [emitMultiply(circuit, keepFocus, wire), 1],
  ]))
  const nextSource = Array.from({length: sourceField.size}, (_, field) => field)
  nextSource[sourceField.clickActive] = zero
  for (let item = 0; item < photoCount; item++) {
    nextSource[focusField(item)] = nextFocus[item]!
  }

  return {
    circuit,
    output: {
      nextSource,
      selectedLayout: winner.selected,
      scores,
      rawScores: candidates.map(candidate => candidate.rawScore),
      winningScore: winner.score,
      focus: nextFocus,
      thumbnails: flattenGeometries(thumbnails),
      hero: flattenGeometries([hero]),
      heroPresent,
    } satisfies CandidateGalleryOutput,
  }
}

export function createCandidateGalleryMachine() {
  const source = new Float32Array(sourceField.size)
  source[sourceField.gap] = 14
  source[focusField(0)] = 1
  source[sourceField.unit] = 1
  source[sourceField.contactCellScale] = 1 / 240
  source[sourceField.cinemaHeroWidthScale] = 1 / 900
  source[sourceField.cinemaHeroHeightScale] = 1 / 560
  source[sourceField.cinemaThumbnailScale] = 1 / 90
  source[sourceField.storyHeroWidthScale] = 1 / 560
  source[sourceField.storyHeroHeightScale] = 1 / 440
  source[sourceField.storyThumbnailScale] = 1 / 60
  source[sourceField.cinemaRailMaximum] = 280
  const {circuit, output} = createCandidateGalleryCircuit()
  validateCircuit(circuit)
  const roots = [
    ...output.nextSource,
    ...output.selectedLayout,
    ...output.scores,
    output.winningScore,
    ...output.thumbnails,
    ...output.hero,
    output.heroPresent,
  ]
  const tensorProgram = circuit.tensorProgram = circuit.compileTensorProgram(roots)
  validateTensorProgram(circuit, tensorProgram)
  return {circuit, output, source, roots}
}

function flattenGeometries(geometries: readonly Geometry[]) {
  const result: Wire[] = []
  for (const geometry of geometries) result.push(geometry.left, geometry.top, geometry.width, geometry.height)
  return result
}

function emitRectangleHit(circuit: Circuit, x: Wire, y: Wire, geometry: Geometry) {
  const horizontal = emitMinimum(
    circuit,
    circuit.affine([[x, 1], [geometry.left, -1]]),
    circuit.affine([[geometry.left, 1], [geometry.width, 1], [x, -1]]),
  )
  const vertical = emitMinimum(
    circuit,
    circuit.affine([[y, 1], [geometry.top, -1]]),
    circuit.affine([[geometry.top, 1], [geometry.height, 1], [y, -1]]),
  )
  const distance = emitMinimum(circuit, horizontal, vertical)
  const positive = emitRelu(circuit, distance)
  const aboveOne = emitRelu(circuit, circuit.affine([[distance, 1]], -1))
  const score = circuit.affine([[positive, 1], [aboveOne, -1]])
  circuit.assumeRange(score, 0, 1)
  return circuit.boolean(score)
}
