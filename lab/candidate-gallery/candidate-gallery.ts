import {
  Circuit,
  type Wire,
  assertFiniteValues,
  assertNonNegativeFinite,
  assertUnitInterval,
  asWire,
  emitArgmax,
  emitFirstActive,
  emitMinimum,
  emitMultiply,
  emitRelu,
  invariant,
  validateCircuit,
  validateTensorProgram,
  validateWireView,
} from '../../numeric-ui-core.ts'

export const photoCount = 12

export const layoutNames = ['Cinema', 'Contact', 'Story'] as const

export const layout = {
  cinema: 0,
  contact: 1,
  story: 2,
} as const

export const sourceField = {
  viewportWidth: asWire(0),
  viewportHeight: asWire(1),
  gap: asWire(2),
  clickActive: asWire(3),
  clickX: asWire(4),
  clickY: asWire(5),
  focusStart: 6,
  unit: asWire(18),
  contactCellScale: asWire(19),
  cinemaHeroWidthScale: asWire(20),
  cinemaHeroHeightScale: asWire(21),
  cinemaThumbnailScale: asWire(22),
  storyHeroWidthScale: asWire(23),
  storyHeroHeightScale: asWire(24),
  storyThumbnailScale: asWire(25),
  cinemaRailMaximum: asWire(26),
  size: 27,
} as const

export const geometryField = {
  left: 0,
  top: 1,
  width: 2,
  height: 3,
  size: 4,
} as const

type Geometry = {
  left: Wire
  top: Wire
  width: Wire
  height: Wire
}

type Candidate = {
  score: Wire
  thumbnails: Geometry[]
  hero: Geometry
  heroPresent: Wire
}

export type CandidateGalleryOutput = {
  nextSource: Wire[]
  selectedLayout: Wire[]
  scores: Wire[]
  winningScore: Wire
  focus: Wire[]
  thumbnails: Wire[]
  hero: Wire[]
  heroPresent: Wire
}

const photoNames = [
  'Misty Lake',
  'Desert Light',
  'Pacific Edge',
  'Midnight City',
  'Forest Path',
  'Alpine Dawn',
  'Amalfi Morning',
  'North Falls',
  'Lavender Hour',
  'Concrete Curve',
  'Blue Lagoon',
  'Autumn Road',
] as const

export function focusField(item: number) {
  invariant(Number.isInteger(item) && item >= 0 && item < photoCount, 'photo index is invalid')
  return asWire(sourceField.focusStart + item)
}

export function createCandidateGalleryCircuit() {
  const circuit = new Circuit(sourceField.size)
  // Pixel-space sources carry an honest finite ceiling: 16384 covers the
  // largest real displays (8K is 7680 wide) with headroom while staying far
  // inside FP32's exact-integer band (execution-model.md's macro contracts
  // keep min, max and clamp operands under 2^23). Finite bounds are also what
  // lets the compiler lower the layout selection reads to gather operations:
  // a range that admits Infinity would let a non-selected candidate poison
  // the masked sum to NaN, so such reads must stay dense (see
  // execution-model.md, "One-hot groups and gathers").
  for (const field of [
    sourceField.viewportWidth,
    sourceField.viewportHeight,
    sourceField.clickX,
    sourceField.clickY,
    sourceField.cinemaRailMaximum,
  ]) {
    circuit.assumeRange(field, 0, 16_384)
  }
  // The gap is a spacing constant in the tens of pixels; 1024 is generous.
  circuit.assumeRange(sourceField.gap, 0, 1024)
  // The quality scales are behavior parameters (reciprocals of target sizes),
  // not pixel geometry; their products are clamped to 0..1 downstream, so
  // their range stays open.
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

  const zero = circuit.constant(0)
  const unit = sourceField.unit
  const focus = Array.from({length: photoCount}, (_, item) => focusField(item))

  function clampQuality(value: Wire) {
    return emitMinimum(circuit, unit, value)
  }

  function scaledQuality(size: Wire, scale: Wire) {
    return clampQuality(emitMultiply(circuit, size, scale))
  }

  function bottleneck(values: readonly Wire[]) {
    invariant(values.length > 0, 'layout quality needs at least one value')
    let result = values[0]!
    for (let index = 1; index < values.length; index++) {
      result = emitMinimum(circuit, result, values[index]!)
    }
    circuit.assumeRange(result, 0, 1)
    return result
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
  const emptyHero = {
    left: zero,
    top: zero,
    width: zero,
    height: zero,
  }
  const contact: Candidate = {
    score: bottleneck([
      scaledQuality(contactCellWidth, sourceField.contactCellScale),
      scaledQuality(contactCellHeight, sourceField.contactCellScale),
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
    score: bottleneck([
      scaledQuality(cinemaHero.width, sourceField.cinemaHeroWidthScale),
      scaledQuality(cinemaHero.height, sourceField.cinemaHeroHeightScale),
      scaledQuality(cinemaThumbnailWidth, sourceField.cinemaThumbnailScale),
      scaledQuality(cinemaThumbnailHeight, sourceField.cinemaThumbnailScale),
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
    score: bottleneck([
      scaledQuality(storyHero.width, sourceField.storyHeroWidthScale),
      scaledQuality(storyHero.height, sourceField.storyHeroHeightScale),
      scaledQuality(storyThumbnailWidth, sourceField.storyThumbnailScale),
      scaledQuality(storyThumbnailHeight, sourceField.storyThumbnailScale),
    ]),
    thumbnails: storySlots,
    hero: storyHero,
    heroPresent: unit,
  }

  const candidates = [cinema, contact, story]
  const scores = candidates.map(candidate => candidate.score)
  const winner = emitArgmax(circuit, scores, unit)
  for (const candidate of candidates) {
    invariant(
      candidate.thumbnails.length === photoCount,
      'every layout needs one thumbnail slot per photo',
    )
  }

  function selectValue(values: readonly Wire[]) {
    const terms: [Wire, number][] = []
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      terms.push([
        emitMultiply(
          circuit,
          winner.selected[candidateIndex]!,
          values[candidateIndex]!,
        ),
        1,
      ])
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
    thumbnails.push(selectGeometry(
      candidates.map(candidate => candidate.thumbnails[item]!),
    ))
  }
  const hero = selectGeometry(candidates.map(candidate => candidate.hero))
  const heroPresent = selectValue(candidates.map(candidate => candidate.heroPresent))
  circuit.assumeRange(heroPresent, 0, 1)
  const thumbnailHits = thumbnails.map(thumbnail =>
    emitRectangleHit(circuit, sourceField.clickX, sourceField.clickY, thumbnail))
  const clicked = emitFirstActive(
    circuit,
    sourceField.clickActive,
    thumbnailHits,
  )
  const clickedMass = circuit.affine(clicked.map(wire => [wire, 1]))
  circuit.assumeRange(clickedMass, 0, 1)
  const keepFocus = circuit.affine([[clickedMass, -1]], 1)
  const nextFocus = focus.map((wire, item) => circuit.affine([
    [clicked[item]!, 1],
    [emitMultiply(circuit, keepFocus, wire), 1],
  ]))
  const nextSource = Array.from({length: sourceField.size}, (_, field) => circuit.source(field))
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
      winningScore: winner.score,
      focus: nextFocus,
      thumbnails: flattenGeometries(thumbnails),
      hero: flattenGeometries([hero]),
      heroPresent,
    },
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
  const wireCount = validateCircuit(circuit)
  validateOutputWires(output, wireCount)
  const tensorProgram = circuit.tensorProgram = circuit.compileTensorProgram([
    ...output.nextSource,
    ...output.selectedLayout,
    ...output.scores,
    output.winningScore,
    ...output.thumbnails,
    ...output.hero,
    output.heroPresent,
  ])
  validateTensorProgram(circuit, tensorProgram)

  return {
    circuit,
    output,
    source,
    tensorProgram,
    step(viewportWidth: number, viewportHeight: number) {
      source[sourceField.viewportWidth] = viewportWidth
      source[sourceField.viewportHeight] = viewportHeight
      validateSource(source)
      const values = circuit.evaluateTensor(source)
      validateOutput(values, output)
      for (let field = 0; field < source.length; field++) {
        source[field] = values[output.nextSource[field]!]!
      }
      return values
    },
    click(x: number, y: number) {
      source[sourceField.clickActive] = 1
      source[sourceField.clickX] = x
      source[sourceField.clickY] = y
    },
  }
}

function flattenGeometries(geometries: readonly Geometry[]) {
  const result: Wire[] = []
  for (const geometry of geometries) {
    result.push(
      geometry.left,
      geometry.top,
      geometry.width,
      geometry.height,
    )
  }
  return result
}

function emitRectangleHit(
  circuit: Circuit,
  x: Wire,
  y: Wire,
  geometry: Geometry,
) {
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

function validateSource(values: Float32Array) {
  invariant(values.length === sourceField.size, 'candidate source table has the wrong length')
  assertFiniteValues(values, 'candidate source table')
  assertNonNegativeFinite(values[sourceField.viewportWidth], 'viewport width')
  assertNonNegativeFinite(values[sourceField.viewportHeight], 'viewport height')
  assertUnitInterval(values[sourceField.clickActive], 'click event')
  invariant(values[sourceField.unit] === 1, 'unit constant must equal one')
  let focusMass = 0
  for (let item = 0; item < photoCount; item++) {
    const value = values[focusField(item)]!
    assertUnitInterval(value, 'photo focus')
    focusMass += value
  }
  invariant(focusMass === 1, 'exactly one photo must be focused')
}

function validateOutputWires(output: CandidateGalleryOutput, wireCount: number) {
  validateWireView(output.nextSource, sourceField.size, wireCount)
  validateWireView(output.selectedLayout, layoutNames.length, wireCount)
  validateWireView(output.scores, layoutNames.length, wireCount)
  validateWireView(output.focus, photoCount, wireCount)
  validateWireView(output.thumbnails, photoCount * geometryField.size, wireCount)
  validateWireView(output.hero, geometryField.size, wireCount)
  invariant(
    output.heroPresent >= 0 && output.heroPresent < wireCount,
    'hero presence wire is invalid',
  )
  invariant(output.winningScore >= 0 && output.winningScore < wireCount, 'winning score wire is invalid')
}

function validateOutput(values: Float32Array, output: CandidateGalleryOutput) {
  let winnerMass = 0
  for (const wire of output.selectedLayout) {
    assertUnitInterval(values[wire], 'selected layout')
    winnerMass += values[wire]
  }
  invariant(winnerMass === 1, 'exactly one layout must win')
  for (const wire of output.scores) assertUnitInterval(values[wire], 'layout score')
  assertUnitInterval(values[output.winningScore], 'winning score')
  assertUnitInterval(values[output.heroPresent], 'hero presence')
  let focusMass = 0
  for (let item = 0; item < photoCount; item++) {
    const focus = values[output.focus[item]!]!
    assertUnitInterval(focus, 'focused projection')
    focusMass += focus
    const outputStart = item * geometryField.size
    for (let field = 0; field < geometryField.size; field++) {
      assertNonNegativeFinite(
        values[output.thumbnails[outputStart + field]!],
        'thumbnail projection',
      )
    }
  }
  invariant(focusMass === 1, 'exactly one projected photo must be focused')
  for (const wire of output.hero) {
    assertNonNegativeFinite(values[wire], 'hero projection')
  }
}

type ScoreCardDom = {
  root: HTMLElement
  value: HTMLElement
}

type CandidateGalleryDomCache = {
  stage: HTMLElement
  heroLayer: HTMLElement
  hero: HTMLElement
  heroTitle: HTMLElement
  winnerName: HTMLElement
  winnerScore: HTMLElement
  scoreCards: ScoreCardDom[]
  thumbnails: HTMLElement[]
}

function createCandidateGalleryDomCache(document: Document): CandidateGalleryDomCache {
  function requireElement(selector: string, message: string) {
    const element = document.querySelector<HTMLElement>(selector)
    invariant(element !== null, message)
    return element
  }

  const stage = requireElement('#candidate-stage', 'candidate gallery stage is missing')
  const heroLayer = requireElement('#candidate-hero-layer', 'candidate hero layer is missing')
  const hero = requireElement('#candidate-hero', 'candidate hero is missing')
  const heroTitle = requireElement('#candidate-hero-title', 'candidate hero title is missing')
  const winnerName = requireElement('#winner-name', 'winner name is missing')
  const winnerScore = requireElement('#winner-score', 'winner score is missing')
  const scoreCardRoots = Array.from(
    document.querySelectorAll<HTMLElement>('.candidate-scores article'),
  )
  invariant(scoreCardRoots.length === layoutNames.length, 'layout score cards are missing')
  const scoreCards = scoreCardRoots.map(root => {
    const value = root.querySelector<HTMLElement>('b')
    invariant(value !== null, 'layout score value is missing')
    return {root, value}
  })

  function createThumbnailElements() {
    return photoNames.map((name, item) => {
      const element = document.createElement('div')
      element.className = `candidate-photo candidate-thumbnail image-${item}`
      const title = document.createElement('span')
      title.textContent = name
      element.appendChild(title)
      stage.appendChild(element)
      return element
    })
  }

  return {
    stage, // cache lifetime: mount
    heroLayer, // cache lifetime: mount
    hero, // cache lifetime: mount
    heroTitle, // cache lifetime: mount
    winnerName, // cache lifetime: mount
    winnerScore, // cache lifetime: mount
    scoreCards, // cache lifetime: mount
    thumbnails: createThumbnailElements(), // cache lifetime: mount
  }
}

function createCandidateGalleryRenderer(domCache: CandidateGalleryDomCache) {
  function projectGeometry(
    element: HTMLElement,
    values: Float32Array,
    output: readonly Wire[],
    outputStart = 0,
  ) {
    const left = values[output[outputStart + geometryField.left]!]!
    const top = values[output[outputStart + geometryField.top]!]!
    element.style.width = `${values[output[outputStart + geometryField.width]!]!}px`
    element.style.height = `${values[output[outputStart + geometryField.height]!]!}px`
    element.style.transform = `translate3d(${left}px,${top}px,0)`
  }

  return {
    render(values: Float32Array, output: CandidateGalleryOutput) {
      const winnerIndex = output.selectedLayout.findIndex(wire => values[wire] === 1)
      invariant(winnerIndex >= 0, 'layout winner is missing')
      domCache.stage.dataset['layout'] = layoutNames[winnerIndex]!.toLowerCase()
      domCache.winnerName.textContent = layoutNames[winnerIndex]!
      domCache.winnerScore.textContent = values[output.winningScore]!.toFixed(3)
      for (let candidateIndex = 0; candidateIndex < layoutNames.length; candidateIndex++) {
        const card = domCache.scoreCards[candidateIndex]!
        const score = values[output.scores[candidateIndex]!]!
        card.root.style.setProperty('--score', `${score}`)
        card.root.style.setProperty(
          '--winner',
          `${values[output.selectedLayout[candidateIndex]!]}`,
        )
        card.value.textContent = score.toFixed(3)
      }
      let focusedItem = -1
      for (let item = 0; item < photoCount; item++) {
        const focus = values[output.focus[item]!]!
        if (focus === 1) focusedItem = item
        const thumbnail = domCache.thumbnails[item]!
        projectGeometry(
          thumbnail,
          values,
          output.thumbnails,
          item * geometryField.size,
        )
        thumbnail.style.setProperty('--focused', `${focus}`)
      }
      invariant(focusedItem >= 0, 'focused photo is missing')
      domCache.hero.className = `candidate-photo candidate-hero image-${focusedItem}`
      domCache.heroTitle.textContent = photoNames[focusedItem]!
      projectGeometry(domCache.heroLayer, values, output.hero)
      domCache.heroLayer.style.opacity = `${values[output.heroPresent]}`
    },
  }
}

if (typeof document !== 'undefined') {
  const domCache = createCandidateGalleryDomCache(document)
  const machine = createCandidateGalleryMachine()
  const renderer = createCandidateGalleryRenderer(domCache)
  let scheduledFrame: number | null = null
  let pendingPointer: {clientX: number, clientY: number} | null = null

  function renderCandidateGallery() {
    scheduledFrame = null
    const viewportWidth = domCache.stage.clientWidth
    const viewportHeight = domCache.stage.clientHeight
    if (pendingPointer !== null) {
      const bounds = domCache.stage.getBoundingClientRect()
      machine.click(
        pendingPointer.clientX - bounds.left - domCache.stage.clientLeft,
        pendingPointer.clientY - bounds.top - domCache.stage.clientTop,
      )
      pendingPointer = null
    }
    const values = machine.step(viewportWidth, viewportHeight)
    renderer.render(values, machine.output)
  }

  function scheduleRender() {
    if (scheduledFrame !== null) return
    scheduledFrame = requestAnimationFrame(renderCandidateGallery)
  }

  new ResizeObserver(scheduleRender).observe(domCache.stage)
  domCache.stage.addEventListener('pointerdown', event => {
    pendingPointer = {
      clientX: event.clientX,
      clientY: event.clientY,
    }
    scheduleRender()
  })
  renderCandidateGallery()
}
