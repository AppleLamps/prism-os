import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {buildSource, defaultContext} from './fields.ts'
import {createFlowLayoutMachine} from './flow-layout.ts'
import {extractSnapshot, scoreFitness, selectionScore, type FitnessWeights} from './fitness.ts'
import {ascendFitness} from './optimize.ts'
import {createRandom, percentile, runSearch, sampleFieldVector} from './search.ts'
import {ascentConfig, searchConfig} from './experiments.ts'

const machine = createFlowLayoutMachine()

test('search over 4000 seeded samples finds high-fitness valid layouts, deterministically', () => {
  const search = runSearch(machine, defaultContext, searchConfig)
  // The numbers the README reports. Everything downstream of the seed is
  // FP32/float64 deterministic, so the counts are exact.
  assert.equal(search.sampleCount, 4000)
  assert.equal(search.validCount, 1078)
  // Violation categories across the samples: overlap is structurally
  // unreachable, vertical overflow dominates, minimum sizes fire rarely.
  assert.equal(search.overlapViolationSamples, 0)
  assert.equal(search.containViolationSamples, 2886)
  assert.equal(search.sizeViolationSamples, 44)
  assert.ok(search.top[0]!.snapshot.valid)
  assert.ok(search.top[0]!.fitness > 0.87 && search.top[0]!.fitness < 0.88)
  // Every kept candidate is scored consistently and sorted.
  for (let index = 1; index < search.top.length; index++) {
    assert.ok(search.top[index - 1]!.score >= search.top[index]!.score)
  }
  // Re-running with the same seed reproduces the result exactly.
  const rerun = runSearch(machine, defaultContext, {...searchConfig, keep: 3})
  assert.equal(rerun.validCount, search.validCount)
  assert.equal(rerun.top[0]!.score, search.top[0]!.score)
  assert.equal(rerun.top[0]!.sampleIndex, search.top[0]!.sampleIndex)
})

test('gradient ascent: all 12 seeded starts improve to valid layouts, statistics pinned', () => {
  const random = createRandom(ascentConfig.startSeed)
  const scores: number[] = []
  let bestScore = Number.NEGATIVE_INFINITY
  let bestFields: Float64Array | null = null
  for (let start = 0; start < ascentConfig.startCount; start++) {
    const startFields = sampleFieldVector(random)
    const startSource = buildSource(startFields, defaultContext)
    const startSnapshot = extractSnapshot(
      machine.evaluate(startSource),
      machine.output,
      startSource,
    )
    const startScore = selectionScore(startSnapshot, scoreFitness(startSnapshot).value)
    const result = ascendFitness(machine, defaultContext, startFields, {
      steps: ascentConfig.steps,
      learningRate: ascentConfig.learningRate,
    })
    assert.ok(result.valid, `start ${start} must end on a valid layout`)
    assert.ok(result.score > startScore + 0.05, `start ${start} must improve substantially`)
    scores.push(result.score)
    if (result.score > bestScore) {
      bestScore = result.score
      bestFields = result.fields
    }
  }
  // The exact statistics the README reports, over all 12 starts.
  scores.sort((a, b) => a - b)
  assert.equal(scores.at(-1), 0.9221303314045608)
  assert.equal(percentile(scores, 0.5), 0.8874679161032203)
  assert.equal(scores[0], 0.865156753559304)

  // The characterized bias: the best ascent beats search's best (0.875) on
  // the scalar objective while showing few slots. Both facts are the finding;
  // see the README.
  const search = runSearch(machine, defaultContext, {...searchConfig, keep: 1})
  assert.ok(bestScore > search.top[0]!.score)
  const bestSource = buildSource(bestFields!, defaultContext)
  const bestSnapshot = extractSnapshot(machine.evaluate(bestSource), machine.output, bestSource)
  assert.equal(bestSnapshot.visible.filter(Boolean).length, 6)
})

test('removing the content richness term reproduces the reward-hacking collapse', () => {
  // The weighting the fitness function had before the richness term existed.
  // Ascending it collapses layouts into two viewport-filling slabs that
  // saturate every term (single-row evenness included), scoring near-perfect
  // while showing almost nothing.
  const preRichnessWeights: FitnessWeights = {
    fill: 0.3,
    verticalFit: 0.2,
    importanceMatch: 0.2,
    balanceX: 0.1,
    sizeComfort: 0.1,
    rowEvenness: 0.1,
    contentRichness: 0,
  }
  const random = createRandom(0xBEEF)
  let bestScore = Number.NEGATIVE_INFINITY
  let bestFields: Float64Array | null = null
  for (let start = 0; start < 6; start++) {
    const result = ascendFitness(machine, defaultContext, sampleFieldVector(random), {
      steps: 150,
      learningRate: 0.02,
      weights: preRichnessWeights,
    })
    if (result.score > bestScore) {
      bestScore = result.score
      bestFields = result.fields
    }
  }
  assert.equal(bestScore, 0.9979177581787108)
  const source = buildSource(bestFields!, defaultContext)
  const snapshot = extractSnapshot(machine.evaluate(source), machine.output, source)
  assert.ok(snapshot.valid)
  assert.equal(snapshot.visible.filter(Boolean).length, 2)
})
