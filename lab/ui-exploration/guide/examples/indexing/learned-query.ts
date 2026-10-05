// A toy that learns the weights that compute a query, through a soft attention read.
//
// The UI rule, in plain JS: a paged carousel with 8 pages settles, on release, on the
// page nearest to where the flick would come to rest, releasePage + releaseVelocity / 4.5.
// That projection is decayRestPos from chenguini's gesture-flick-snap-target demo,
// whose decayFriction is 4.5.
//
// The circuit computes a query from the release with three weights held in source cells,
//   query = clamp(weightRelease * (releasePage - 3.5) + weightVelocity * releaseVelocity + bias, 0, 7),
// and scores every page against the query with parabola keys. Training reads a table of
// per-page losses with a softmax over those scores (soft attention). The circuit a UI would
// run picks the highest score with emitArgmax (hard attention). The authored weights are
// weightRelease 1, weightVelocity 1 / 4.5 and bias 3.5.
import {Circuit, emitArgmax, type Wire, asWire} from '../../../../../src/runtime/numeric-ui-core.ts'
import {createRandom} from './measure.ts'
import {sharpnessSchedule} from './query-descent.ts'
import {emitSoftAttentionRead, maximumSharpness, minimumSharpness} from './soft-attention.ts'

export const pageCount = 8
const lastPage = pageCount - 1
const middlePage = lastPage / 2
export const decayFriction = 4.5
// Pages per second.
export const maximumReleaseVelocity = 6

export type QueryWeights = {weightRelease: number, weightVelocity: number, bias: number}
export type Release = {releasePage: number, releaseVelocity: number}

export const authoredWeights: QueryWeights = {weightRelease: 1, weightVelocity: 1 / decayFriction, bias: middlePage}

// Plain JS: the page nearest to the rest position, within 0..7.
export function snapPageReference(releasePage: number, releaseVelocity: number): number {
  const restPage = releasePage + releaseVelocity / decayFriction
  return Math.min(lastPage, Math.max(0, Math.round(restPage)))
}

// Source table: the release, the three weights, then, for training only, the
// sharpness and one loss per page (or the target page, for the squared-error control).
export const cells = {releasePage: 0, releaseVelocity: 1, weightRelease: 2, weightVelocity: 3, bias: 4, sharpness: 5, firstPageLoss: 6}

function declareReleaseAndWeights(circuit: Circuit) {
  circuit.assumeRange(asWire(cells.releasePage), 0, lastPage)
  circuit.assumeRange(asWire(cells.releaseVelocity), -maximumReleaseVelocity, maximumReleaseVelocity)
  circuit.assumeRange(asWire(cells.weightRelease), -2, 2)
  circuit.assumeRange(asWire(cells.weightVelocity), -2, 2)
  circuit.assumeRange(asWire(cells.bias), -8, 8)
}

// Measuring the release position from the middle page keeps the gradients of the
// three weights on similar scales, so one learning rate works for all three.
function emitQuery(circuit: Circuit): Wire {
  const releaseOffset = circuit.roundAffine([[asWire(cells.releasePage), 1]], -middlePage)
  circuit.assumeRange(releaseOffset, -middlePage, middlePage)
  const projectedPage = circuit.roundAffine([
    [circuit.multiply(asWire(cells.weightRelease), releaseOffset), 1],
    [circuit.multiply(asWire(cells.weightVelocity), asWire(cells.releaseVelocity)), 1],
    [asWire(cells.bias), 1],
  ])
  const aboveFirstPage = circuit.reglu([], 1, [[projectedPage, 1]], 0)
  const aboveLastPage = circuit.reglu([], 1, [[projectedPage, 1]], -lastPage)
  const query = circuit.roundAffine([[aboveFirstPage, 1], [aboveLastPage, -1]])
  circuit.assumeRange(query, 0, lastPage)
  return query
}

function releaseAndWeights(release: Release, weights: QueryWeights) {
  return [release.releasePage, release.releaseVelocity, weights.weightRelease, weights.weightVelocity, weights.bias]
}

// Training: the loss is a soft read of pageLosses, i.e. the average per-page loss under
// the softmax weights.
export function buildTrainingCircuit() {
  const circuit = new Circuit(cells.firstPageLoss + pageCount)
  declareReleaseAndWeights(circuit)
  circuit.assumeRange(asWire(cells.sharpness), minimumSharpness, maximumSharpness)
  const pageLosses = Array.from({length: pageCount}, (_, page) => circuit.source(cells.firstPageLoss + page))
  for (const wire of pageLosses) circuit.assumeRange(wire, 0, 1)
  const query = emitQuery(circuit)
  const {read} = emitSoftAttentionRead(circuit, query, asWire(cells.sharpness), pageLosses)
  const source = (release: Release, weights: QueryWeights, sharpness: number, pageLossValues: readonly number[]) =>
    Float32Array.from([...releaseAndWeights(release, weights), sharpness, ...pageLossValues])
  return {circuit, query, read, source}
}

// The control: the same query, and the squared error between the query and the target
// page as the loss, with no read at all.
export function buildSquaredErrorCircuit() {
  const targetPage = cells.sharpness
  const circuit = new Circuit(targetPage + 1)
  declareReleaseAndWeights(circuit)
  circuit.assumeRange(asWire(targetPage), 0, lastPage)
  const query = emitQuery(circuit)
  const error = circuit.roundAffine([[query, 1], [asWire(targetPage), -1]])
  circuit.assumeRange(error, -lastPage, lastPage)
  const loss = circuit.multiply(error, error)
  const source = (release: Release, weights: QueryWeights, targetPageValue: number) =>
    Float32Array.from([...releaseAndWeights(release, weights), targetPageValue])
  return {circuit, query, loss, source}
}

// What a UI would run: the highest parabola score, as a one-hot, and its page number.
export function buildSnapCircuit() {
  const circuit = new Circuit(cells.sharpness)
  declareReleaseAndWeights(circuit)
  const query = emitQuery(circuit)
  const unit = circuit.affine([], 1)
  // score[page] + 7² lies within 0..2 × 7², and a power-of-two scale keeps the scaling exact.
  const scoreOffset = lastPage ** 2
  const scale = 2 ** -Math.ceil(Math.log2(2 * scoreOffset))
  const scores = Array.from({length: pageCount}, (_, page) => {
    const score = circuit.roundAffine([[query, 2 * page * scale]], (scoreOffset - page * page) * scale)
    circuit.assumeRange(score, 0, 1)
    return score
  })
  const {selected} = emitArgmax(circuit, scores, unit)
  const snapPage = circuit.roundAffine(selected.slice(1).map((bit, index) => [bit, index + 1] as const))
  const source = (release: Release, weights: QueryWeights) => Float32Array.from(releaseAndWeights(release, weights))
  return {circuit, query, selected, snapPage, source}
}

export function randomReleases(seed: number, count: number): Release[] {
  const random = createRandom(seed)
  return Array.from({length: count}, () => ({
    releasePage: Math.fround(random() * lastPage),
    releaseVelocity: Math.fround((random() * 2 - 1) * maximumReleaseVelocity),
  }))
}

export type LearningOptions = {
  start: QueryWeights
  steps: number
  batchSize: number
  learningRate: number
  // Seeds the 512 random training releases.
  seed: number
}

function clampWeights(weights: QueryWeights) {
  weights.weightRelease = Math.min(Math.max(weights.weightRelease, -2), 2)
  weights.weightVelocity = Math.min(Math.max(weights.weightVelocity, -2), 2)
  weights.bias = Math.min(Math.max(weights.bias, -8), 8)
}

// Gradient descent through the soft read. The sharpness is 0.25 for the first half of
// the steps, grows to 8 over the next quarter, and stays at 8. As in query-descent.ts,
// the learning rate is divided by the sharpness.
export function learnQueryWeights(options: LearningOptions): QueryWeights {
  const training = buildTrainingCircuit()
  const releases = randomReleases(options.seed, 512)
  const schedule = sharpnessSchedule(minimumSharpness, maximumSharpness, options.steps / 2, options.steps / 4)
  const weights = {...options.start}
  for (let step = 0; step < options.steps; step++) {
    const sharpness = schedule(step)
    const gradientSums = {weightRelease: 0, weightVelocity: 0, bias: 0}
    for (let item = 0; item < options.batchSize; item++) {
      const release = releases[(step * options.batchSize + item) % releases.length]!
      const targetPage = snapPageReference(release.releasePage, release.releaseVelocity)
      const pageLosses = Array.from({length: pageCount}, (_, page) => page === targetPage ? 0 : 1)
      const values = training.circuit.evaluateReference(training.source(release, weights, sharpness, pageLosses))
      const outputGradients = new Float32Array(values.length)
      outputGradients[training.read] = 1
      const gradients = training.circuit.backpropagateReference(values, outputGradients)
      gradientSums.weightRelease += gradients[cells.weightRelease]!
      gradientSums.weightVelocity += gradients[cells.weightVelocity]!
      gradientSums.bias += gradients[cells.bias]!
    }
    const rate = options.learningRate / sharpness / options.batchSize
    weights.weightRelease -= rate * gradientSums.weightRelease
    weights.weightVelocity -= rate * gradientSums.weightVelocity
    weights.bias -= rate * gradientSums.bias
    clampWeights(weights)
  }
  return weights
}

// Gradient descent on the squared-error control, over the same releases in the same order.
export function learnQueryWeightsBySquaredError(options: LearningOptions): QueryWeights {
  const control = buildSquaredErrorCircuit()
  const releases = randomReleases(options.seed, 512)
  const weights = {...options.start}
  for (let step = 0; step < options.steps; step++) {
    const gradientSums = {weightRelease: 0, weightVelocity: 0, bias: 0}
    for (let item = 0; item < options.batchSize; item++) {
      const release = releases[(step * options.batchSize + item) % releases.length]!
      const targetPage = snapPageReference(release.releasePage, release.releaseVelocity)
      const values = control.circuit.evaluateReference(control.source(release, weights, targetPage))
      const outputGradients = new Float32Array(values.length)
      outputGradients[control.loss] = 1
      const gradients = control.circuit.backpropagateReference(values, outputGradients)
      gradientSums.weightRelease += gradients[cells.weightRelease]!
      gradientSums.weightVelocity += gradients[cells.weightVelocity]!
      gradientSums.bias += gradients[cells.bias]!
    }
    const rate = options.learningRate / options.batchSize
    weights.weightRelease -= rate * gradientSums.weightRelease
    weights.weightVelocity -= rate * gradientSums.weightVelocity
    weights.bias -= rate * gradientSums.bias
    clampWeights(weights)
  }
  return weights
}

// releasePage on odd multiples of 1/128 and releaseVelocity on multiples of 1/4, from
// -6 to 6. Times 1152, the rest position is 9 × an odd number plus 64 × an integer,
// which is odd, while a boundary between two pages, j + 0.5, is 1152j + 576, which is
// even. So every rest position is at least 1/1152 page from a boundary, and FP32
// rounding can't change which page is nearest.
export function releaseGrid(): Release[] {
  const releases: Release[] = []
  for (let releaseStep = 1; releaseStep < lastPage * 128; releaseStep += 4) {
    for (let velocityStep = -4 * maximumReleaseVelocity; velocityStep <= 4 * maximumReleaseVelocity; velocityStep++) {
      releases.push({releasePage: releaseStep / 128, releaseVelocity: velocityStep / 4})
    }
  }
  return releases
}

// Runs the snap circuit with the given weights over releaseGrid and compares its page
// with snapPageReference. largestMismatchDistance is the largest distance, in pages,
// between a mismatching release's rest position and the nearest boundary between pages.
export function countSnapMatches(weights: QueryWeights) {
  const snap = buildSnapCircuit()
  let matches = 0
  let largestMismatchDistance = 0
  const releases = releaseGrid()
  for (const release of releases) {
    const values = snap.circuit.evaluateReference(snap.source(release, weights))
    if (values[snap.snapPage] === snapPageReference(release.releasePage, release.releaseVelocity)) {
      matches++
      continue
    }
    const restPage = Math.min(Math.max(release.releasePage + release.releaseVelocity / decayFriction, 0), lastPage)
    largestMismatchDistance = Math.max(largestMismatchDistance, Math.abs(restPage - Math.floor(restPage) - 0.5))
  }
  return {matches, total: releases.length, largestMismatchDistance}
}
