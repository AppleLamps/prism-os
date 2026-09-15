import {expect, test} from 'bun:test'
import {sameFloat} from '../codegen/codegen.ts'
import {authoredBehavior, testWindowsConfig as config, withBehavior, type BehaviorSetting} from './fixtures.ts'
import {createLiftedOracle, createPopulation, liftedPopulationCircuit, populationFrameDelta, runPopulation} from './population.ts'
import {createUserModel, frameDuration, metric, ratesOf, segmentCount} from './user-model.ts'
import {buildWindowsCircuit} from './windows.ts'

const settings: BehaviorSetting[] = [
  authoredBehavior,
  {slop: 2, doubleClickInterval: 300, doubleClickDistance: 2},
  {slop: 10, doubleClickInterval: 700, doubleClickDistance: 12},
]

test('the generated instance loop matches the executor for every user and frame, with state carried across frames', () => {
  const build = buildWindowsCircuit(config, 16, {kind: 'folded', maximumDowns: 2, pressPoint: 'session'})
  const circuit = liftedPopulationCircuit(build)
  const behaviorCells = [build.constants.slop, build.constants.doubleClickInterval, build.constants.doubleClickDistance]
  const userCount = settings.length * 4
  const population = createPopulation(circuit, {userCount, perUserCells: behaviorCells, frameDelta: populationFrameDelta, blockSize: 5})
  const groupOfUser = Uint32Array.from({length: userCount}, (_, user) => user % settings.length)
  for (let user = 0; user < userCount; user++) {
    const setting = settings[groupOfUser[user]!]!
    const base = user * population.width
    population.table[base + population.columnOf(build.constants.slop)] = setting.slop
    population.table[base + population.columnOf(build.constants.doubleClickInterval)] = setting.doubleClickInterval
    population.table[base + population.columnOf(build.constants.doubleClickDistance)] = setting.doubleClickDistance
  }
  const model = createUserModel(population, {groupCount: settings.length, groupOfUser, seed: 5})
  const evaluate = build.circuit.createTensorEvaluator(build.roots)
  let compared = 0
  for (let frame = 0; frame < 240; frame++) {
    model.emitFrame(frame, (frame + 1) * frameDuration)
    const sources = Array.from({length: userCount}, (_, user) => population.sourceOf(user))
    population.step()
    for (let user = 0; user < userCount; user++) {
      // The evaluator validates every source cell against its declared range.
      const expected = evaluate(sources[user]!)
      for (let output = 0; output < population.outputCount; output++) {
        if (!sameFloat(population.outputs[user * population.outputCount + output]!, expected[output]!)) {
          throw new Error(`frame ${frame} user ${user} output ${output}: instance loop ${population.outputs[user * population.outputCount + output]}, executor ${expected[output]}`)
        }
        compared++
      }
    }
    model.observeFrame(frame)
  }
  expect(compared).toBe(240 * userCount * population.outputCount)
  expect(model.maximumEventsPerFrame.downs).toBeLessThanOrEqual(2)
})

test('every user of a small population matches the one-event-at-a-time oracle every frame', () => {
  const build = buildWindowsCircuit(config, 16, {kind: 'folded', maximumDowns: 2, pressPoint: 'session'})
  const circuit = liftedPopulationCircuit(build)
  const behaviorCells = [build.constants.slop, build.constants.doubleClickInterval, build.constants.doubleClickDistance]
  const usersPerGroup = 8
  const run = runPopulation({
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
    frames: 900,
    seed: 11,
    checkedUsers: settings.length * usersPerGroup,
    jankProbability: 0.05,
    createOracle: (_, group) => createLiftedOracle(circuit, withBehavior(config, settings[group]!)),
  })
  expect(run.jankFrames).toBeGreaterThan(20)
  expect(run.model.maximumEventsPerFrame.events).toBeGreaterThan(8)
  expect(run.model.maximumEventsPerFrame.downs).toBeLessThanOrEqual(2)
  expect(run.oracle.users.length).toBe(settings.length * usersPerGroup)
  expect(new Set(run.oracle.users).size).toBe(settings.length * usersPerGroup)
  expect(run.oracle.firstMismatch).toBeNull()
  expect(run.oracle.mismatches).toBe(0)
  expect(run.oracle.comparisons).toBe(900 * settings.length * usersPerGroup * run.population.outputCount)
  expect(run.checks.oneHotMassError).toBe(0)
  expect(run.checks.oneHotBitError).toBe(0)
  expect(run.checks.rankViolatingUserFrames).toBe(0)
  expect(run.checks.outsideWorkspaceUserFrames).toBe(0)
  // The users did every kind of task.
  const all = ratesOf(run.metrics, settings.length, () => true)
  expect(all.tasks).toBeGreaterThan(300)
  expect(all.counts.doubleClicks).toBeGreaterThan(20)
  expect(all.counts.nudges).toBeGreaterThan(20)
  expect(all.counts.longDrags).toBeGreaterThan(20)
  let presses = 0
  for (let group = 0; group < settings.length; group++) {
    for (let tremorSegment = 0; tremorSegment < segmentCount; tremorSegment++) presses += run.metrics[(group * segmentCount + tremorSegment) * run.metricCount + metric.presses]!
  }
  expect(presses).toBeGreaterThan(400)
})
