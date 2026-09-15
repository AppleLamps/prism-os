// Heavy measurements for this folder. Prints markdown tables and writes
// results.json next to this file.
// Run from the repo root: bun lab/ui-exploration/user-population/report.ts [--quick]
// CPU timings share the machine with other agents, so read them as rough; the
// counts and rates are exact for these simulated users.

import {
  adaptivePopulationCircuit,
  buildAdaptiveWindowsCircuit,
  createAdaptiveOracle,
  createAdaptiveTracker,
  type AdaptiveTable,
} from './adaptive.ts'
import {chooseLevelThresholds, markdownHeader, markdownRow, paretoFront, percent, shareAtLeast, standardError} from './analysis.ts'
import {authoredBehavior, testWindowsConfig as config, withBehavior, type BehaviorSetting} from './fixtures.ts'
import {buildWindowsCircuit as buildInputCircuit} from '../input/windows.ts'
import {generateWindowsTrace} from './input-traces.ts'
import {measureProgram} from '../input/kit.ts'
import {compareLiftedWithInput} from './lifted.ts'
import {detectWithPopulation, detectWithTrace, mutationTargets} from './mutation.ts'
import {createLiftedOracle, liftedPopulationCircuit, populationFrameDelta, runPopulation, type PopulationCircuit} from './population.ts'
import {histogramBins, ratesOf, segmentCount, tremorSegmentBounds, type Rates} from './user-model.ts'
import {buildWindowsCircuit} from './windows.ts'

const quick = process.argv.includes('--quick')
const results: Record<string, unknown> = {quick, date: new Date().toISOString()}
const folded = {kind: 'folded', maximumDowns: 2, pressPoint: 'session'} as const
const segmentLabels = tremorSegmentBounds.slice(0, segmentCount).map((low, index) => `${low.toFixed(2)}-${tremorSegmentBounds[index + 1]!.toFixed(2)} px`)
const settingLabel = (setting: BehaviorSetting) => `${setting.slop} px / ${setting.doubleClickInterval} ms / ${setting.doubleClickDistance} px`
const log = (text: string) => console.log(text)
// Share of frames that last 3 to 7 normal frames in every population run below.
const jankProbability = 0.02
results['jankProbability'] = jankProbability

// ---------------------------------------------------------------------------
log('## Circuit sizes\n')
{
  const input = buildInputCircuit(config, 16, folded)
  const lifted = buildWindowsCircuit(config, 16, folded)
  const unrolled = buildWindowsCircuit(config, 16, {kind: 'unrolled'})
  const adaptive = buildAdaptiveWindowsCircuit(config, 16, 2)
  const rows = [
    ['input\'s folded window circuit, 16 slots, at most 2 downs', measureProgram(input.circuit, input.roots)],
    ['lifted build, same form', measureProgram(lifted.circuit, lifted.roots)],
    ['lifted build, unrolled, 16 slots', measureProgram(unrolled.circuit, unrolled.roots)],
    ['adaptive build (tremor estimate and per-segment table), folded, 16 slots', measureProgram(adaptive.circuit, adaptive.roots)],
  ] as const
  log(markdownHeader(['circuit', 'source cells', 'live operations', 'layers', 'stored weights', 'gather reads']))
  const sourceCells = [input.layout.size, lifted.layout.size, unrolled.layout.size, adaptive.layout.size]
  rows.forEach(([label, measure], index) => log(markdownRow([label, sourceCells[index]!, measure.liveOperations, measure.layers, measure.weights, measure.gatherReads])))
  results['sizes'] = Object.fromEntries(rows.map(([label, measure], index) => [label, {...measure, sourceCells: sourceCells[index]}]))
  const adaptiveSections = adaptive.sections.map(section => {
    const program = adaptive.circuit.compileTensorProgram(adaptive.roots)
    const live = Array.from(program.wireOrder).filter(wire => wire >= section.firstWire && wire < section.endWire).length
    return {name: section.name, liveOperations: live}
  })
  log('\nLive operations per section of the adaptive build:\n')
  log(markdownHeader(['section', 'live operations']))
  for (const section of adaptiveSections) log(markdownRow([section.name, section.liveOperations]))
  results['adaptiveSections'] = adaptiveSections
}

// ---------------------------------------------------------------------------
log('\n## The lifted build against input\'s original over input\'s random trace\n')
{
  const frames = generateWindowsTrace(config, {seed: 1002, frames: quick ? 2000 : 20000, capacity: 16, maximumDowns: 2})
  const comparison = compareLiftedWithInput(config, 16, folded, frames)
  log(markdownHeader(['frames', 'events', 'outputs compared', 'outputs with any differing bit', 'frames where the lifted build disagrees with the oracle', 'maximize toggles', 'drag commits']))
  log(markdownRow([comparison.frames, comparison.events, comparison.outputsCompared, comparison.differingOutputs, comparison.oracleMismatchedFrames, comparison.toggles, comparison.commits]))
  results['lifted'] = comparison
}

// ---------------------------------------------------------------------------
function liftedRun(settings: readonly BehaviorSetting[], usersPerGroup: number, frames: number, seed: number, extra: Partial<Parameters<typeof runPopulation>[0]> = {}) {
  const build = buildWindowsCircuit(config, 16, folded)
  const circuit: PopulationCircuit = liftedPopulationCircuit(build)
  const behaviorCells = [build.constants.slop, build.constants.doubleClickInterval, build.constants.doubleClickDistance]
  return runPopulation({
    circuit,
    perUserCells: behaviorCells,
    groupCount: settings.length,
    usersPerGroup,
    writeGroup: (table, base, columnOf, group) => {
      const setting = settings[group]!
      table[base + columnOf(build.constants.slop)] = setting.slop
      table[base + columnOf(build.constants.doubleClickInterval)] = setting.doubleClickInterval
      table[base + columnOf(build.constants.doubleClickDistance)] = setting.doubleClickDistance
    },
    frames,
    seed,
    checkedUsers: 32,
    jankProbability,
    createOracle: (_, group) => createLiftedOracle(circuit, withBehavior(config, settings[group]!)),
    ...extra,
  })
}

function summarizeRun(run: ReturnType<typeof runPopulation>) {
  return {
    userCount: run.userCount,
    frames: run.frames,
    userFrames: run.userFrames,
    jankFrames: run.jankFrames,
    counts: run.counts,
    timing: run.timing,
    oracle: run.oracle,
    checks: run.checks,
    maximumEventsPerFrame: run.model.maximumEventsPerFrame,
  }
}

function rateCells(rates: Rates) {
  return [
    percent(rates.cancelledClickRate), percent(rates.lostNudgeRate), percent(rates.missedDoubleClickRate), percent(rates.accidentalDoubleClickRate),
    percent(rates.mistakeSum), rates.dragEffectFrames.toFixed(2), percent(rates.earlyDragRate, 1), percent(rates.lostLongDragRate),
  ]
}
const rateHeader = ['cancelled clicks %', 'lost nudges %', 'missed double clicks %', 'accidental double clicks %', 'sum of the four %', 'drag frames to effect', 'early drags %', 'lost long drags %']

function runLine(label: string, run: ReturnType<typeof runPopulation>) {
  log(markdownHeader(['run', 'users', 'frames', 'janky frames', 'most events / downs in a frame', 'user-frames', 'per-user rows', 'per-user depth', 'circuit ns per user-frame (all frames / last 100)', 'policy ns', 'checks ns', 'sampled users', 'oracle comparisons', 'mismatches', 'one-hot bit error', 'one-hot mass error', 'rank violations', 'windows outside the workspace (user-frames, max px)']))
  log(markdownRow([
    label, run.userCount, run.frames, run.jankFrames, `${run.model.maximumEventsPerFrame.events} / ${run.model.maximumEventsPerFrame.downs}`, run.userFrames, run.counts.instanceRows, run.counts.instanceLayers,
    `${run.timing.circuitNanosecondsPerUserFrame.toFixed(0)} / ${run.timing.circuitNanosecondsPerUserFrameLastFrames.toFixed(0)}`,
    run.timing.policyNanosecondsPerUserFrame.toFixed(0), run.timing.checksNanosecondsPerUserFrame.toFixed(0),
    run.oracle.users.length, run.oracle.comparisons, run.oracle.mismatches,
    run.checks.oneHotBitError, run.checks.oneHotMassError, run.checks.rankViolatingUserFrames,
    `${run.checks.outsideWorkspaceUserFrames}, ${run.checks.outsideWorkspacePixels}`,
  ]))
}

// ---------------------------------------------------------------------------
log('\n## Stage 1: 64 settings\n')
const stage1Settings: BehaviorSetting[] = []
for (const slop of [2, 4, 6, 10]) {
  for (const doubleClickDistance of [2, 4, 8, 16]) {
    for (const doubleClickInterval of [300, 400, 500, 700]) stage1Settings.push({slop, doubleClickInterval, doubleClickDistance})
  }
}
const usersPerGroup = quick ? 32 : 1024
const stageFrames = quick ? 200 : 600
const stage1 = liftedRun(stage1Settings, usersPerGroup, stageFrames, 1)
runLine('stage 1', stage1)
{
  const eventTotal = stage1.model.eventHistogram.reduce((sum, value) => sum + value, 0)
  log('\nHow much of the queue the simulated users used, as shares of user-frames:\n')
  log(markdownHeader(['events in the frame', ...Array.from(stage1.model.eventHistogram, (_, events) => String(events))]))
  log(markdownRow(['share %', ...Array.from(stage1.model.eventHistogram, count => (100 * count / eventTotal).toPrecision(3))]))
  log(markdownRow(['user-frames', ...Array.from(stage1.model.eventHistogram)]))
  log(`\nUser-frames with 0, 1 and 2 downs: ${Array.from(stage1.model.downHistogram).map(count => count.toLocaleString('en-US')).join(', ')}.`)
  results['queueUse'] = {events: Array.from(stage1.model.eventHistogram), downs: Array.from(stage1.model.downHistogram)}
}
const stage1Pooled = stage1Settings.map((setting, group) => ({setting, group, rates: ratesOf(stage1.metrics, stage1Settings.length, candidate => candidate === group)}))
const objectives = (entry: {rates: Rates}) => [entry.rates.cancelledClickRate, entry.rates.lostNudgeRate, entry.rates.missedDoubleClickRate, entry.rates.accidentalDoubleClickRate, entry.rates.dragEffectFrames]
const front = new Set(paretoFront(stage1Pooled, objectives).map(entry => entry.group))
const frontClicksDrags = new Set(paretoFront(stage1Pooled, entry => [entry.rates.cancelledClickRate, entry.rates.lostNudgeRate]).map(entry => entry.group))
const frontDoubleClicks = new Set(paretoFront(stage1Pooled, entry => [entry.rates.missedDoubleClickRate, entry.rates.accidentalDoubleClickRate]).map(entry => entry.group))
{
  const sorted = [...stage1Pooled].sort((left, right) => left.rates.mistakeSum - right.rates.mistakeSum || left.rates.dragEffectFrames - right.rates.dragEffectFrames)
  log('\nEvery setting, all tremor segments pooled, sorted by the sum of the four mistake rates. "front" marks settings on the Pareto front of the four rates plus drag frames to effect; "clicks/nudges" and "double clicks" mark the two-objective fronts.\n')
  log(markdownHeader(['slop / interval / distance', ...rateHeader, 'front', 'clicks/nudges front', 'double clicks front']))
  for (const entry of sorted) {
    log(markdownRow([settingLabel(entry.setting), ...rateCells(entry.rates), front.has(entry.group) ? 'yes' : '', frontClicksDrags.has(entry.group) ? 'yes' : '', frontDoubleClicks.has(entry.group) ? 'yes' : '']))
  }
  const counts = sorted[0]!.rates.counts
  log(`\nCounts per setting, e.g. for the first row: ${counts.clicks} single clicks, ${counts.nudges} nudges, ${counts.doubleClicks} double clicks, ${counts.separatePairs} pairs of separate clicks, ${counts.longDrags} long drags. A rate of 10% over ${counts.nudges} trials has a standard error of ${percent(standardError(0.1, counts.nudges))} points.`)
  log(`\nPareto front (four rates plus drag frames): ${front.size} of ${stage1Settings.length} settings. Clicks against nudges: ${frontClicksDrags.size}. Missed against accidental double clicks: ${frontDoubleClicks.size}.`)
}
function bestPerSegment(metrics: Float64Array, settings: readonly BehaviorSetting[]) {
  return Array.from({length: segmentCount}, (_, tremorSegment) => {
    const entries = settings.map((setting, group) => ({setting, group, rates: ratesOf(metrics, settings.length, (candidate, segment) => candidate === group && segment === tremorSegment)}))
    entries.sort((left, right) => left.rates.mistakeSum - right.rates.mistakeSum || left.rates.dragEffectFrames - right.rates.dragEffectFrames)
    return entries[0]!
  })
}
const stage1BestOverall = [...stage1Pooled].sort((left, right) => left.rates.mistakeSum - right.rates.mistakeSum)[0]!
const stage1BestPerSegment = bestPerSegment(stage1.metrics, stage1Settings)
{
  log('\nBest setting per tremor segment (lowest sum of the four rates), against the authored setting (4 px / 500 ms / 4 px) and the best single setting:\n')
  log(markdownHeader(['tremor segment', 'setting', 'slop / interval / distance', ...rateHeader]))
  const authoredGroup = stage1Settings.findIndex(setting => setting.slop === authoredBehavior.slop && setting.doubleClickInterval === authoredBehavior.doubleClickInterval && setting.doubleClickDistance === authoredBehavior.doubleClickDistance)
  for (let tremorSegment = 0; tremorSegment < segmentCount; tremorSegment++) {
    const best = stage1BestPerSegment[tremorSegment]!
    log(markdownRow([segmentLabels[tremorSegment]!, 'best for this segment', settingLabel(best.setting), ...rateCells(best.rates)]))
    log(markdownRow([segmentLabels[tremorSegment]!, 'authored', settingLabel(authoredBehavior), ...rateCells(ratesOf(stage1.metrics, stage1Settings.length, (group, segment) => group === authoredGroup && segment === tremorSegment))]))
    log(markdownRow([segmentLabels[tremorSegment]!, 'best single setting', settingLabel(stage1BestOverall.setting), ...rateCells(ratesOf(stage1.metrics, stage1Settings.length, (group, segment) => group === stage1BestOverall.group && segment === tremorSegment))]))
  }
}
results['stage1'] = {
  run: summarizeRun(stage1),
  settings: stage1Pooled.map(entry => ({...entry.setting, rates: entry.rates, front: front.has(entry.group), frontClicksNudges: frontClicksDrags.has(entry.group), frontDoubleClicks: frontDoubleClicks.has(entry.group), perSegment: Array.from({length: segmentCount}, (_, tremorSegment) => ratesOf(stage1.metrics, stage1Settings.length, (group, segment) => group === entry.group && segment === tremorSegment))})),
  bestOverall: stage1BestOverall.setting,
  bestPerSegment: stage1BestPerSegment.map(entry => entry.setting),
}

// ---------------------------------------------------------------------------
log('\n## Stage 2: slop and distance per segment at the best interval\n')
const bestInterval = stage1BestOverall.setting.doubleClickInterval
const stage2Settings: BehaviorSetting[] = []
for (const slop of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14]) {
  for (const doubleClickDistance of [3, 6, 10, 16]) stage2Settings.push({slop, doubleClickInterval: bestInterval, doubleClickDistance})
}
const stage2 = liftedRun(stage2Settings, usersPerGroup, stageFrames, 2)
runLine('stage 2', stage2)
const stage2BestPerSegment = bestPerSegment(stage2.metrics, stage2Settings)
{
  log('\nBest setting per tremor segment:\n')
  log(markdownHeader(['tremor segment', 'slop / interval / distance', ...rateHeader]))
  stage2BestPerSegment.forEach((best, tremorSegment) => log(markdownRow([segmentLabels[tremorSegment]!, settingLabel(best.setting), ...rateCells(best.rates)])))
  log('\nSum of the four mistake rates (%) per slop, at each segment\'s best distance:\n')
  log(markdownHeader(['slop px', ...segmentLabels]))
  for (const slop of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14]) {
    log(markdownRow([slop, ...stage2BestPerSegment.map((best, tremorSegment) => {
      const group = stage2Settings.findIndex(setting => setting.slop === slop && setting.doubleClickDistance === best.setting.doubleClickDistance)
      return percent(ratesOf(stage2.metrics, stage2Settings.length, (candidate, segment) => candidate === group && segment === tremorSegment).mistakeSum, 1)
    })]))
  }
}

// Hold excursions per segment from what the simulated users emitted.
const histograms = Array.from({length: segmentCount}, (_, tremorSegment) => stage2.model.excursionHistogram.subarray(tremorSegment * histogramBins, (tremorSegment + 1) * histogramBins))
const levelThresholds = chooseLevelThresholds(histograms)
{
  log('\nShare of presses whose moves within 100 ms of the down reach at least L px from the press point:\n')
  log(markdownHeader(['L px', ...segmentLabels]))
  for (let level = 1; level <= 10; level++) log(markdownRow([level, ...histograms.map(histogram => percent(shareAtLeast(histogram, level), 1))]))
  log(`\nChosen level thresholds: ${levelThresholds.join(', ')} px.`)
}
results['stage2'] = {
  run: summarizeRun(stage2),
  bestInterval,
  bestPerSegment: stage2BestPerSegment.map(entry => ({setting: entry.setting, rates: entry.rates})),
  settings: stage2Settings.map((setting, group) => ({...setting, perSegment: Array.from({length: segmentCount}, (_, tremorSegment) => ratesOf(stage2.metrics, stage2Settings.length, (candidate, segment) => candidate === group && segment === tremorSegment))})),
  histograms: histograms.map(histogram => Array.from(histogram)),
  levelThresholds,
}

// ---------------------------------------------------------------------------
log('\n## Closed loop: the per-segment table hardened into the circuit\n')
const segmentSlop = stage2BestPerSegment.map(entry => entry.setting.slop)
const segmentDistance = stage2BestPerSegment.map(entry => entry.setting.doubleClickDistance)
const fixedBest = [...stage2Settings.map((setting, group) => ({setting, rates: ratesOf(stage2.metrics, stage2Settings.length, candidate => candidate === group)}))].sort((left, right) => left.rates.mistakeSum - right.rates.mistakeSum)[0]!.setting
let initialSegment = 0
for (let tremorSegment = 1; tremorSegment < segmentCount; tremorSegment++) {
  const distance = (segment: number) => Math.abs(segmentSlop[segment]! - fixedBest.slop) + Math.abs(segmentDistance[segment]! - fixedBest.doubleClickDistance)
  if (distance(tremorSegment) < distance(initialSegment)) initialSegment = tremorSegment
}
const adaptiveTable: AdaptiveTable = {holdWindow: 100, levelThresholds, segmentSlop, segmentDistance, doubleClickInterval: bestInterval, initialSegment}
log(`Table: slop ${segmentSlop.join(', ')} px, distance ${segmentDistance.join(', ')} px, interval ${bestInterval} ms, levels ${levelThresholds.join(', ')} px, hold window 100 ms, counters start in segment ${initialSegment}. Best single setting from stage 2: ${settingLabel(fixedBest)}.\n`)
const loopUsers = quick ? 1024 : 16384
const loopFrames = quick ? 400 : 900
const lateFrom = quick ? 150 : 300
const loopSeed = 9
const fixedRun = liftedRun([fixedBest], loopUsers, loopFrames, loopSeed, {userModel: {lateFromFrame: lateFrom}})
runLine('best single setting', fixedRun)
const knownBuild = buildWindowsCircuit(config, 16, folded)
const knownCircuit = liftedPopulationCircuit(knownBuild)
let knownSegments: Uint8Array = new Uint8Array(0)
const knownRun = runPopulation({
  circuit: knownCircuit,
  perUserCells: [knownBuild.constants.slop, knownBuild.constants.doubleClickInterval, knownBuild.constants.doubleClickDistance],
  groupCount: 1,
  usersPerGroup: loopUsers,
  writeGroup: () => {},
  frames: loopFrames,
  seed: loopSeed,
  checkedUsers: 32,
  jankProbability,
  userModel: {lateFromFrame: lateFrom},
  onStart: (population, model) => {
    knownSegments = model.segment
    for (let user = 0; user < population.userCount; user++) {
      const base = user * population.width
      population.table[base + population.columnOf(knownBuild.constants.slop)] = segmentSlop[model.segment[user]!]!
      population.table[base + population.columnOf(knownBuild.constants.doubleClickInterval)] = bestInterval
      population.table[base + population.columnOf(knownBuild.constants.doubleClickDistance)] = segmentDistance[model.segment[user]!]!
    }
  },
  createOracle: user => createLiftedOracle(knownCircuit, withBehavior(config, {slop: segmentSlop[knownSegments[user]!]!, doubleClickInterval: bestInterval, doubleClickDistance: segmentDistance[knownSegments[user]!]!})),
})
runLine('each user gets its true segment\'s setting', knownRun)
const adaptiveBuild = buildAdaptiveWindowsCircuit(config, 16, 2)
const adaptiveCircuit = adaptivePopulationCircuit(adaptiveBuild, adaptiveTable)
let tracker: ReturnType<typeof createAdaptiveTracker> | null = null
const adaptiveRun = runPopulation({
  circuit: adaptiveCircuit,
  perUserCells: [],
  groupCount: 1,
  usersPerGroup: loopUsers,
  writeGroup: () => {},
  frames: loopFrames,
  seed: loopSeed,
  checkedUsers: 32,
  jankProbability,
  userModel: {lateFromFrame: lateFrom},
  createOracle: () => createAdaptiveOracle(adaptiveBuild, adaptiveTable),
  onStart: (population, model) => {
    tracker = createAdaptiveTracker(population, adaptiveBuild, model.segment)
  },
  onFrame: frame => tracker!.track(frame >= lateFrom),
})
runLine('adaptive circuit, estimated segment', adaptiveRun)
{
  log(`\nMistake rates per true tremor segment, over tasks that end at frame ${lateFrom} or later (after about ${Math.round(lateFrom * populationFrameDelta / 1000)} s of use):\n`)
  log(markdownHeader(['tremor segment', 'run', ...rateHeader]))
  const loopRuns = [['best single setting', fixedRun], ['true segment\'s setting', knownRun], ['adaptive circuit', adaptiveRun]] as const
  for (let tremorSegment = 0; tremorSegment <= segmentCount; tremorSegment++) {
    for (const [label, run] of loopRuns) {
      const rates = ratesOf(run.lateMetrics, 1, (_, segment) => tremorSegment === segmentCount || segment === tremorSegment)
      log(markdownRow([tremorSegment === segmentCount ? 'all' : segmentLabels[tremorSegment]!, label, ...rateCells(rates)]))
    }
  }
  log('\nThe same over every task of the run, including the start where the counters begin in the initial segment:\n')
  log(markdownHeader(['tremor segment', 'run', ...rateHeader]))
  for (let tremorSegment = 0; tremorSegment <= segmentCount; tremorSegment++) {
    for (const [label, run] of loopRuns) {
      const rates = ratesOf(run.metrics, 1, (_, segment) => tremorSegment === segmentCount || segment === tremorSegment)
      log(markdownRow([tremorSegment === segmentCount ? 'all' : segmentLabels[tremorSegment]!, label, ...rateCells(rates)]))
    }
  }
  const finalTracker = tracker!
  log(`\nCounters over every user-frame: ${finalTracker.result.userFrames.toLocaleString('en-US')} user-frames, ${finalTracker.result.counterViolations} counters outside 0..8 or not whole, ${finalTracker.result.crossedCounters} crossed counters, ${finalTracker.result.holdLevelBitErrors} hold levels that are not exact bits.`)
  log(`\nWhere users spend their user-frames from frame ${lateFrom} on: rows are true tremor segments, columns the circuit's estimated segment, as shares of the row.\n`)
  log(markdownHeader(['true segment', ...segmentLabels.map(label => `estimated ${label}`)]))
  for (let row = 0; row < segmentCount; row++) {
    const total = Array.from({length: segmentCount}, (_, column) => finalTracker.confusion[row * segmentCount + column]!).reduce((sum, value) => sum + value, 0)
    log(markdownRow([segmentLabels[row]!, ...Array.from({length: segmentCount}, (_, column) => percent(finalTracker.confusion[row * segmentCount + column]! / total, 1))]))
  }
  results['closedLoop'] = {
    table: adaptiveTable,
    fixedBest,
    runs: Object.fromEntries(loopRuns.map(([label, run]) => [label, {
      ...summarizeRun(run),
      late: Array.from({length: segmentCount + 1}, (_, tremorSegment) => ratesOf(run.lateMetrics, 1, (_, segment) => tremorSegment === segmentCount || segment === tremorSegment)),
      all: Array.from({length: segmentCount + 1}, (_, tremorSegment) => ratesOf(run.metrics, 1, (_, segment) => tremorSegment === segmentCount || segment === tremorSegment)),
    }])),
    tracker: finalTracker.result,
    confusion: Array.from(finalTracker.confusion),
  }
}

// ---------------------------------------------------------------------------
log('\n## Planted corruptions: how long each check takes to notice\n')
{
  const targets = mutationTargets(10)
  const mutationSettings = stage1Settings
  const mutationUsersPerGroup = quick ? 4 : 16
  const mutationFrames = quick ? 300 : 600
  const trace = generateWindowsTrace(config, {seed: 1002, frames: quick ? 4000 : 20000, capacity: 16, maximumDowns: 2})
  log(`Populations: ${mutationSettings.length * mutationUsersPerGroup} users over the ${mutationSettings.length} stage 1 settings, up to ${mutationFrames} frames, compared with the unchanged circuit on the same events every frame. Random trace: input's trace with seed 1002, up to ${trace.length.toLocaleString('en-US')} frames.\n`)
  const cell = (detection: ReturnType<typeof detectWithPopulation>['detection']) => {
    const activated = detection.firstActivationFrame === -1 ? 'never activated' : `activated at frame ${detection.firstActivationFrame} for ${detection.activatedUsers} users`
    return detection.firstFrame === -1
      ? `none in ${detection.framesSimulated} frames (${activated})`
      : `frame ${detection.firstFrame} (${detection.userFramesToFirstDifference.toLocaleString('en-US')} user-frames), ${detection.detectingUsers} users, median frame ${detection.medianDetectionFrame} (${activated})`
  }
  log(markdownHeader(['wire', 'section', 'operation', 'change', 'population at a steady 60 fps', `population with ${percent(jankProbability, 0)}% janky frames`, 'random trace']))
  let steadyMaximum = {events: 0, downs: 0}
  let jankMaximum = {events: 0, downs: 0}
  const rows = targets.map(wire => {
    const steady = detectWithPopulation(wire, mutationSettings, mutationUsersPerGroup, mutationFrames, 3, 0)
    const janky = detectWithPopulation(wire, mutationSettings, mutationUsersPerGroup, mutationFrames, 3, jankProbability)
    const traced = detectWithTrace(wire, trace)
    steadyMaximum = {events: Math.max(steadyMaximum.events, steady.detection.maximumEvents), downs: Math.max(steadyMaximum.downs, steady.detection.maximumDowns)}
    jankMaximum = {events: Math.max(jankMaximum.events, janky.detection.maximumEvents), downs: Math.max(jankMaximum.downs, janky.detection.maximumDowns)}
    const {corruption} = steady
    log(markdownRow([
      wire, corruption.section, corruption.shape, corruption.change,
      cell(steady.detection), cell(janky.detection),
      traced.firstFrame === -1
        ? `none in ${traced.framesSimulated} frames (${traced.firstActivationFrame === -1 ? 'never activated' : `activated at frame ${traced.firstActivationFrame}`})`
        : `frame ${traced.firstFrame} (${traced.eventsToFirstDifference.toLocaleString('en-US')} events; activated at frame ${traced.firstActivationFrame})`,
    ]))
    return {corruption, steady: steady.detection, janky: janky.detection, trace: traced}
  })
  log(`\nMost events and downs any user put into one frame: ${steadyMaximum.events} and ${steadyMaximum.downs} at a steady 60 fps, ${jankMaximum.events} and ${jankMaximum.downs} with janky frames. input's random trace fills up to 16 slots with up to 2 downs.`)
  results['mutations'] = rows
}

await Bun.write(new URL('./results.json', import.meta.url), JSON.stringify(results, null, 2))
log('\nWrote results.json.')
