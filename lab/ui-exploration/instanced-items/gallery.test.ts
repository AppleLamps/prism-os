import {describe, expect, test} from 'bun:test'
import {createExecutor} from './executor.ts'
import {createDuplicatedMachine, expandDuplicated, measureCircuit} from './expand.ts'
import {buildGalleryCircuit} from '../gallery/gallery-circuit.ts'
import {runScenario, scriptedTrace} from './gallery-differential.ts'
import {createDuplicatedEngine, createOriginalEngine, createStagedEngine, createTeeEngine, createTeeStats, summarizeTee} from './gallery-engine.ts'
import {buildStagedGallery} from './gallery-staged.ts'
import {photoGalleryData} from '../gallery/photo-data.ts'
import {stageStats} from './staged.ts'
import {syntheticPhotos} from './synthetic-photos.ts'

const staged = buildStagedGallery(photoGalleryData)
const original = buildGalleryCircuit(photoGalleryData)

test('the staged gallery has one program per photo: 233 live operations over its map stages, next to 48,411 operations for all 221 photos in gallery-circuit.ts', () => {
  let perPhoto = 0
  for (const step of staged.program.steps) {
    if (step.kind === 'stage' && step.stage.axis === 'photos') perPhoto += stageStats(staged.program, step.stage).liveOperations
  }
  expect(perPhoto).toBe(233)
  expect(measureCircuit(original.circuit, original.roots).liveOperations).toBe(48_411)
  const duplicated = expandDuplicated(staged.program)
  expect(measureCircuit(duplicated.circuit, duplicated.roots).liveOperations).toBe(55_627)
})

test('the staged executor matches the staged program\'s duplicated circuit bit for bit on every output and next value, every frame of a random trace', () => {
  const stats = createTeeStats()
  const machine = createDuplicatedMachine(expandDuplicated(staged.program))
  const engine = createTeeEngine(createStagedEngine(staged, createExecutor(staged.program)), createDuplicatedEngine(staged, machine), stats)
  const report = runScenario({seed: 11, frames: 150, width: 1024, height: 768, photos: photoGalleryData, engine, durations: 'dyadic'})
  const summary = summarizeTee(stats)
  expect(summary.compared).toBeGreaterThan(1_000_000)
  expect(summary.identical).toBe(summary.compared)
  expect(report.decisionMismatches).toBe(0)
  expect(report.framesIn1D).toBeGreaterThan(10)
})

test('scripted trace: no decision differs from index.ts, and every decision equals gallery-circuit.ts frame by frame', () => {
  const stats = createTeeStats()
  const engine = createTeeEngine(createStagedEngine(staged, createExecutor(staged.program)), createOriginalEngine(original), stats)
  const hashes: string[] = []
  const report = runScenario({
    seed: 0, frames: 420, width: 1440, height: 900, photos: photoGalleryData, engine, script: scriptedTrace,
    onFrame: ({frame, reference}) => {
      hashes[frame] = reference.browser.hash
    },
  })
  if (report.decisionMismatches > 0) console.log(report.firstMismatches)
  expect(report.decisionMismatches).toBe(0)
  expect(hashes[70]).toBe(`#${photoGalleryData[5]!.id}`)
  expect(hashes[320]).toBe(`#${photoGalleryData.at(-1)!.id}`)
  const summary = summarizeTee(stats)
  expect(summary.decisionMismatches).toBe(0)
  // Positions that pass through a different fold order drift: the strip's prefix sums fold the gap
  // into each value, where gallery-circuit.ts adds 52 × k as the bias of each row.
  expect(summary.identical / summary.compared).toBeGreaterThan(0.85)
  expect(summary.outputs['destX']!.maximumDifference).toBeLessThan(0.1)
  expect(summary.outputs['visible']!.identical).toBe(summary.outputs['visible']!.compared)
})

describe('random traces against index.ts', () => {
  const cases = [
    {seed: 2, width: 390, height: 844, resync: true, durations: 'dyadic'},
    {seed: 3, width: 2560, height: 1400, resync: false, durations: 'realistic'},
  ] as const
  for (const options of cases) {
    test(`seed ${options.seed}, ${options.width}x${options.height}, ${options.resync ? 'resync' : 'free-running'}, ${options.durations} frame times`, () => {
      const engine = createStagedEngine(staged, createExecutor(staged.program))
      const report = runScenario({...options, frames: 220, photos: photoGalleryData, engine})
      if (report.decisionMismatches > 0) console.log(report.firstMismatches)
      expect(report.decisionMismatches).toBe(0)
      expect(report.decisionChecks).toBeGreaterThan(40_000)
      expect(report.framesIn1D).toBeGreaterThan(20)
      expect(report.animatingFrames).toBeGreaterThan(60)
      for (const kind of ['mousemove', 'click', 'key', 'resize']) expect(report.events[kind] ?? 0).toBeGreaterThan(0)
      expect(report.errors['destination x']!.maximumAbsolute).toBeLessThan(0.5)
      expect(report.errors['style transform']!.maximumAbsolute).toBeLessThan(0.1)
    })
  }
})

test('1,000 synthetic photos: a random trace against index.ts running the same photos, with no decision mismatch', () => {
  const photos = syntheticPhotos(1000)
  const scaled = buildStagedGallery(photos)
  const engine = createStagedEngine(scaled, createExecutor(scaled.program))
  const report = runScenario({seed: 21, frames: 90, width: 1440, height: 900, photos, engine, durations: 'dyadic', eventRate: 2})
  if (report.decisionMismatches > 0) console.log(report.firstMismatches)
  expect(report.decisionMismatches).toBe(0)
  expect(report.decisionChecks).toBeGreaterThan(90_000)
  expect(report.events['click'] ?? 0).toBeGreaterThan(5)
})
