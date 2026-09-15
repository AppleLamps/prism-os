// Plants single-operation corruptions in the lifted window circuit, the way
// hn-thread/mutation.ts does (the first coefficient c becomes -c - 1, or the
// bias grows by 5 when there are no terms), and counts how long two checks take
// to notice each one:
// - a population of simulated users, each carrying its own state, compared
//   frame by frame with the unchanged circuit running the same events. The
//   unchanged circuit matches the one-event-at-a-time oracle on these users
//   (population.test.ts, report.ts), so a difference from it is a difference
//   from the oracle;
// - input's random window trace, compared the same way.
// The simulated users aim at what the unchanged circuit displays. Before a
// user's first difference both circuits display the same thing, so the events
// are the same ones a user of the corrupted circuit would have produced.
//
// Both circuits also output the corrupted wire itself, so each check reports
// when the corruption first changed that operation's value (activated) and when
// the change first reached a state or display output (noticed). A corruption
// that is never activated changes nothing for these inputs.

import {writeEventQueue} from './events.ts'
import {testWindowsConfig as config, type BehaviorSetting} from './fixtures.ts'
import type {Frame} from './input-traces.ts'
import {createPopulation, frameSchedule, liftedPopulationCircuit, populationFrameDelta} from './population.ts'
import {createUserModel} from './user-model.ts'
import {buildWindowsCircuit, createWindowsState, writeWindowsConstants, writeWindowsState, type WindowsBuild} from './windows.ts'

const folded = {kind: 'folded', maximumDowns: 2, pressPoint: 'session'} as const

type MutableOperation = {kind: string, leftTerms: (readonly [number, number])[], leftBias: number, gateTerms: (readonly [number, number])[]}

export function liveOperationWires(build: WindowsBuild) {
  const program = build.circuit.compileTensorProgram(build.roots)
  return Array.from(program.wireOrder).filter(wire => wire >= build.circuit.sourceSize).sort((left, right) => left - right)
}

// Live operations at evenly spaced positions of the live operation list.
export function mutationTargets(count: number) {
  const live = liveOperationWires(buildWindowsCircuit(config, 16, folded))
  return Array.from({length: count}, (_, index) => live[Math.floor((index + 0.5) / count * live.length)]!)
}

export type Corruption = {wire: number, section: string, shape: string, change: string}

export function corruptOperation(build: WindowsBuild, wire: number): Corruption {
  const operation = build.circuit.operations[wire - build.circuit.sourceSize] as unknown as MutableOperation
  const section = build.sections.find(entry => wire >= entry.firstWire && wire < entry.endWire)?.name ?? 'before the first section'
  const shape = `${operation.kind} with ${operation.leftTerms.length} left terms and ${operation.gateTerms.length} gate terms`
  let change: string
  if (operation.leftTerms.length > 0) {
    const [input, coefficient] = operation.leftTerms[0]!
    operation.leftTerms = [[input, -coefficient - 1], ...operation.leftTerms.slice(1)]
    change = `first coefficient ${coefficient} becomes ${-coefficient - 1}`
  } else {
    operation.leftBias += 5
    change = 'bias grows by 5'
  }
  build.circuit.tensorProgram = null
  return {wire, section, shape, change}
}

export type PopulationDetection = {
  userCount: number
  framesSimulated: number
  // The first frame at which any user's outputs differed, -1 when none did.
  firstFrame: number
  // User-frames simulated up to and including the first differing user-frame,
  // counting users in index order within a frame.
  userFramesToFirstDifference: number
  detectingUsers: number
  medianDetectionFrame: number
  // The most events and downs any user put into one frame.
  maximumEvents: number
  maximumDowns: number
  // The first frame at which the corrupted operation's own value differed.
  firstActivationFrame: number
  activatedUsers: number
}

export function detectWithPopulation(wire: number, settings: readonly BehaviorSetting[], usersPerGroup: number, frames: number, seed: number, jankProbability: number): {corruption: Corruption, detection: PopulationDetection} {
  const referenceBuild = buildWindowsCircuit(config, 16, folded)
  const mutatedBuild = buildWindowsCircuit(config, 16, folded)
  const corruption = corruptOperation(mutatedBuild, wire)
  const perUserCells = (build: WindowsBuild) => [build.constants.slop, build.constants.doubleClickInterval, build.constants.doubleClickDistance]
  const userCount = settings.length * usersPerGroup
  const withWire = (build: WindowsBuild) => ({...liftedPopulationCircuit(build), roots: [...build.roots, wire]})
  const reference = createPopulation(withWire(referenceBuild), {userCount, perUserCells: perUserCells(referenceBuild), frameDelta: populationFrameDelta})
  const mutated = createPopulation(withWire(mutatedBuild), {userCount, perUserCells: perUserCells(mutatedBuild), frameDelta: populationFrameDelta})
  const groupOfUser = Uint32Array.from({length: userCount}, (_, user) => user % settings.length)
  for (const [population, build] of [[reference, referenceBuild], [mutated, mutatedBuild]] as const) {
    for (let user = 0; user < userCount; user++) {
      const setting = settings[groupOfUser[user]!]!
      const base = user * population.width
      population.table[base + population.columnOf(build.constants.slop)] = setting.slop
      population.table[base + population.columnOf(build.constants.doubleClickInterval)] = setting.doubleClickInterval
      population.table[base + population.columnOf(build.constants.doubleClickDistance)] = setting.doubleClickDistance
    }
  }
  const model = createUserModel(reference, {groupCount: settings.length, groupOfUser, seed})
  const detectionFrame = new Int32Array(userCount).fill(-1)
  const activationFrame = new Int32Array(userCount).fill(-1)
  const {width, stateCount, outputCount} = reference
  // The last output is the corrupted wire; the others are state and display.
  const visibleOutputs = outputCount - 1
  const detection: PopulationDetection = {userCount, framesSimulated: 0, firstFrame: -1, userFramesToFirstDifference: -1, detectingUsers: 0, medianDetectionFrame: -1, maximumEvents: 0, maximumDowns: 0, firstActivationFrame: -1, activatedUsers: 0}
  const schedule = frameSchedule(frames, jankProbability, seed)
  let frameEnd = 0
  let currentFrameDelta = populationFrameDelta
  for (let frame = 0; frame < frames && detection.detectingUsers < userCount; frame++) {
    const frameDelta = schedule[frame]!
    frameEnd += frameDelta
    if (frameDelta !== currentFrameDelta) {
      reference.setFrameDelta(frameDelta)
      mutated.setFrameDelta(frameDelta)
      currentFrameDelta = frameDelta
    }
    model.emitFrame(frame, frameEnd)
    for (let user = 0; user < userCount; user++) {
      const base = user * width
      for (let index = stateCount; index < width; index++) mutated.table[base + index] = reference.table[base + index]!
    }
    reference.step()
    mutated.step()
    for (let user = 0; user < userCount; user++) {
      const base = user * outputCount
      if (activationFrame[user] === -1 && !Object.is(reference.outputs[base + visibleOutputs], mutated.outputs[base + visibleOutputs])) {
        activationFrame[user] = frame
        detection.activatedUsers++
        if (detection.firstActivationFrame === -1) detection.firstActivationFrame = frame
      }
      if (detectionFrame[user] !== -1) continue
      for (let output = 0; output < visibleOutputs; output++) {
        if (!Object.is(reference.outputs[base + output], mutated.outputs[base + output])) {
          detectionFrame[user] = frame
          detection.detectingUsers++
          if (detection.firstFrame === -1) {
            detection.firstFrame = frame
            detection.userFramesToFirstDifference = frame * userCount + user + 1
          }
          break
        }
      }
    }
    model.observeFrame(frame)
    detection.framesSimulated = frame + 1
  }
  const detected = Array.from(detectionFrame).filter(frame => frame >= 0).sort((left, right) => left - right)
  detection.medianDetectionFrame = detected.length === 0 ? -1 : detected[detected.length >> 1]!
  detection.maximumEvents = model.maximumEventsPerFrame.events
  detection.maximumDowns = model.maximumEventsPerFrame.downs
  return {corruption, detection}
}

export type TraceDetection = {framesSimulated: number, firstFrame: number, eventsToFirstDifference: number, firstActivationFrame: number, reason: string | null}

export function detectWithTrace(wire: number, frames: readonly Frame[]): TraceDetection {
  const referenceBuild = buildWindowsCircuit(config, 16, folded)
  const mutatedBuild = buildWindowsCircuit(config, 16, folded)
  corruptOperation(mutatedBuild, wire)
  const builds = [referenceBuild, mutatedBuild] as const
  const evaluators = builds.map(build => build.circuit.createTensorEvaluator([...build.roots, wire]))
  const visibleOutputs = referenceBuild.roots.length
  let firstActivationFrame = -1
  const sources = builds.map(build => {
    const source = new Float32Array(build.layout.size)
    writeWindowsConstants(source, build.constants, config)
    writeWindowsState(source, build.cells, createWindowsState(config))
    return source
  })
  let events = 0
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index]!
    events += frame.events.length
    builds.forEach((build, which) => {
      sources[which]![build.frameDelta] = frame.frameDelta
      writeEventQueue(sources[which]!, build.slots, frame.events)
    })
    const referenceOutputs = new Float32Array(evaluators[0]!(sources[0]!))
    let mutatedOutputs: Float32Array
    try {
      mutatedOutputs = evaluators[1]!(sources[1]!)
    } catch (error) {
      return {framesSimulated: index + 1, firstFrame: index, eventsToFirstDifference: events, firstActivationFrame, reason: `the executor refused a source cell: ${(error as Error).message}`}
    }
    if (firstActivationFrame === -1 && !Object.is(referenceOutputs[visibleOutputs], mutatedOutputs[visibleOutputs])) firstActivationFrame = index
    for (let output = 0; output < visibleOutputs; output++) {
      if (!Object.is(referenceOutputs[output], mutatedOutputs[output])) return {framesSimulated: index + 1, firstFrame: index, eventsToFirstDifference: events, firstActivationFrame, reason: `output ${output} differs`}
    }
    builds.forEach((build, which) => {
      const outputs = which === 0 ? referenceOutputs : mutatedOutputs
      build.stateCells.forEach((cell, position) => {
        sources[which]![cell] = outputs[position]!
      })
    })
  }
  return {framesSimulated: frames.length, firstFrame: -1, eventsToFirstDifference: -1, firstActivationFrame, reason: null}
}
