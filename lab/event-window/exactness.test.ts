import {expect, test} from 'bun:test'
import {validateTensorEvaluation} from '../../numeric-ui-core.ts'
import {
  authoredParameterValues,
  createEventWindowMachine,
  writeFrameInputToSource,
  writeParameterValues,
} from './circuit.ts'
import {collectFrameMismatches, runClosedLoop} from './harness.ts'
import {type RelationTable, createOracleState, oracleTick, rectangleCount} from './oracle.ts'
import {createBehaviorConfig, generateTrace} from './trace.ts'

test('hand-authored circuit: zero divergence over 10,000-frame traces, 12 seeds', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const config = createBehaviorConfig(seed * 7919 + 13)
    const trace = generateTrace(config, seed, 10_000)
    const machine = createEventWindowMachine(config)
    const result = runClosedLoop(config, trace, machine, createOracleState(config))
    expect(
      result.divergences,
      `seed ${seed} first divergence at frame ${result.firstDivergenceFrame}: `
        + result.firstDivergenceDetail.join('; '),
    ).toBe(0)
  }
}, 60_000)

test('differential exactness: reference and tensor evaluators agree on every wire', () => {
  for (const seed of [21, 22]) {
    const config = createBehaviorConfig(seed * 104_729 + 1)
    const trace = generateTrace(config, seed, 10_000)
    const machine = createEventWindowMachine(config, {evaluator: 'tensor'})
    const state = createOracleState(config)
    let checkedFrames = 0
    for (const input of trace) {
      // Reproduce the exact source table the step evaluates (state plus this
      // frame's event cells), then check every live wire through both
      // evaluators while the closed loop runs against the oracle.
      const steppedSource = new Float32Array(machine.source)
      writeFrameInputToSource(input, steppedSource)
      const frame = machine.step(input)
      validateTensorEvaluation(steppedSource, machine.circuit, frame.values)
      const expected = oracleTick(config, state, input)
      expect(collectFrameMismatches(frame, expected)).toEqual([])
      checkedFrames++
    }
    expect(checkedFrames).toBe(10_000)
  }
}, 60_000)

test('the relation table is live data: all 16 combinations stay exact', () => {
  const combinations: RelationTable[] = []
  for (let mask = 0; mask < 16; mask++) {
    combinations.push({
      dragFromTitle: (mask & 1) !== 0,
      dragFromBody: (mask & 2) !== 0,
      clickTogglesFromTitle: (mask & 4) !== 0,
      clickTogglesFromBody: (mask & 8) !== 0,
    })
  }
  for (let combination = 0; combination < combinations.length; combination++) {
    const relations = combinations[combination]!
    const config = createBehaviorConfig(31 + combination, relations)
    const trace = generateTrace(config, 100 + combination, 2_000)
    const machine = createEventWindowMachine(config)
    writeParameterValues(machine.source, authoredParameterValues(config))
    const result = runClosedLoop(config, trace, machine, createOracleState(config))
    expect(
      result.divergences,
      `relation combination ${combination} diverged at frame ${result.firstDivergenceFrame}: `
        + result.firstDivergenceDetail.join('; '),
    ).toBe(0)
  }
}, 60_000)

test('the reference evaluator drives the same closed loop exactly', () => {
  const config = createBehaviorConfig(5)
  const trace = generateTrace(config, 55, 5_000)
  const machine = createEventWindowMachine(config, {evaluator: 'reference'})
  const result = runClosedLoop(config, trace, machine, createOracleState(config))
  expect(result.divergences).toBe(0)
})

test('circuit outputs stay well-formed: one-hot groups and exact bits every frame', () => {
  const config = createBehaviorConfig(77)
  const trace = generateTrace(config, 777, 5_000)
  const machine = createEventWindowMachine(config)
  let focusFrames = 0
  let dragFrames = 0
  const result = runClosedLoop(config, trace, machine, createOracleState(config), (_, frame) => {
    // readExactOneHot inside step already threw if any bit were fractional or
    // any group had two winners; count coverage here.
    if (frame.focused >= 0) focusFrames++
    if (frame.dragOwner >= 0) dragFrames++
  })
  expect(result.divergences).toBe(0)
  expect(focusFrames).toBeGreaterThan(1_000)
  expect(dragFrames).toBeGreaterThan(100)
  expect(rectangleCount).toBe(4)
})
