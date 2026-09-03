import {describe, expect, test} from 'bun:test'
import {controlIDs, layoutViolations, observationInput, type EffortInput} from './domain.ts'
import {createPredictor, inputFeatures, parameterCount, predictionErrors, trainPredictor} from './predictor.ts'
import {candidates, compareSelections, expectedCost, selectLayout, selectionSituations} from './selection.ts'
import {createObservations, meanDurationMs, noiseHalfWidthMs} from './simulator.ts'

const training = createObservations('train', 731)
const heldOut = createObservations('held-out', 947)
const learned = trainPredictor(training)
const model = createPredictor(learned.parameters)
const predict = (input: EffortInput) => model.predict(input)

describe('simulated observations', () => {
  test('records the full shown layout, randomized selection probability, and noisy outcome', () => {
    expect(training).toEqual(createObservations('train', 731))
    expect(training).toHaveLength(720)
    expect(heldOut).toHaveLength(192)
    const rotations = [0, 0, 0]
    for (const observation of [...training, ...heldOut]) {
      expect(observation.layoutSelectionProbability).toBe(1 / 3)
      expect(observation.taskAssignmentProbability).toBe(1 / 3)
      expect(layoutViolations(observation.shownLayout, {minimumTargetWidth: 24, maximumClutter: 1})).toEqual([])
      expect(Math.abs(observation.durationMs - meanDurationMs(observationInput(observation)))).toBeLessThanOrEqual(noiseHalfWidthMs)
      const middle = observation.shownLayout.controls.find(control => control.y === 272)!
      rotations[controlIDs.indexOf(middle.id)]!++
    }
    expect(rotations.every(count => count > 0)).toBe(true)
  })

  test('holds out every numeric distance, width, clutter, and context value', () => {
    const trainingInputs = training.map(observationInput)
    for (const key of ['distance', 'targetWidth', 'clutter', 'motorContext'] as const) {
      const values = new Set(trainingInputs.map(input => input[key]))
      for (const observation of heldOut) expect(values.has(observationInput(observation)[key])).toBe(false)
    }
  })

  test('the authored simulator penalizes distance and clutter but rewards larger targets', () => {
    const input: EffortInput = {distance: 200, targetWidth: 40, clutter: 0.2, motorContext: 0.5}
    const base = meanDurationMs(input)
    expect(meanDurationMs({...input, distance: 300})).toBeGreaterThan(base)
    expect(meanDurationMs({...input, clutter: 0.6})).toBeGreaterThan(base)
    expect(meanDurationMs({...input, targetWidth: 80})).toBeLessThan(base)
  })
})

describe('shared numeric predictor', () => {
  test('matches reference evaluation and the stated formula with authored coefficients', () => {
    const known = createPredictor([0.2, 0.66, 0.18, 0.08, 0.39])
    for (const observation of heldOut) {
      const input = observationInput(observation)
      const prediction = known.predict(input)
      expect(prediction).toBeCloseTo(meanDurationMs(input), 3)
      expect(known.circuit.evaluateReference(known.source)[known.output]! * 1000).toBe(prediction)
    }
  })

  test('backpropagates through parameter products at zero and agrees with finite differences', () => {
    const zero = createPredictor()
    const input: EffortInput = {distance: 280, targetWidth: 64, clutter: 0.4, motorContext: 0.75}
    zero.predict(input)
    const values = zero.circuit.evaluateReference(zero.source)
    const seeds = new Float32Array(values.length)
    seeds[zero.output] = 1
    const gradient = zero.circuit.backpropagateReference(values, seeds)
    const features = inputFeatures(input)
    const expected = [1, features[0]!, features[1]!, features[2]!, Math.fround(features[0]! * features[2]!)]
    for (let parameter = 0; parameter < parameterCount; parameter++) {
      expect(gradient[parameter]).toBeCloseTo(expected[parameter]!, 6)
      zero.source[parameter] = 0.001
      const upper = zero.predict(input) / 1000
      zero.source[parameter] = -0.001
      const lower = zero.predict(input) / 1000
      zero.source[parameter] = 0
      expect((upper - lower) / 0.002).toBeCloseTo(gradient[parameter]!, 6)
    }
  })

  test('learns from noisy observations and generalizes within the simulator family', () => {
    const mean = (observation: typeof training[number]) => meanDurationMs(observationInput(observation))
    expect(predictionErrors(heldOut, predict, mean).rmseMs).toBeLessThan(5)
    expect(predictionErrors(heldOut, predict, observation => observation.durationMs).rmseMs).toBeLessThan(30)
    expect(learned.losses.at(-1)!).toBeLessThan(learned.losses[0]! / 100)
    expect(trainPredictor(training).parameters).toEqual(learned.parameters)
  })

  test('keeps parameters fixed while observations and tasks change', () => {
    const before = Array.from(model.source.slice(0, parameterCount))
    for (const observation of heldOut) predict(observationInput(observation))
    compareSelections(predict, meanDurationMs)
    expect(Array.from(model.source.slice(0, parameterCount))).toEqual(before)
  })
})

describe('selection under explicit goals', () => {
  test('retains all controls and rejects missing, duplicated, overlapping, or out-of-bounds candidates', () => {
    const situation = selectionSituations()[0]!
    for (const candidate of candidates) expect(layoutViolations(candidate, situation.constraints)).toEqual([])
    const valid = candidates[0]!
    const invalid = [
      {...valid, controls: valid.controls.slice(1)},
      {...valid, controls: [...valid.controls, valid.controls[0]!]},
      {...valid, controls: valid.controls.map(control => ({...control, x: 0}))},
      {...valid, controls: valid.controls.map(control => ({...control, x: 100, y: 100}))},
    ]
    for (const candidate of invalid) {
      expect(layoutViolations(candidate, situation.constraints).length).toBeGreaterThan(0)
      expect(selectLayout([candidate], situation, predict)).toBeNull()
    }
    expect(selectLayout(candidates, {...situation, constraints: {minimumTargetWidth: 200, maximumClutter: 1}}, predict)).toBeNull()
  })

  test('changes the choice when task probabilities change, without learning new weights', () => {
    const confirm = selectionSituations().find(situation => situation.name === 'confirm-heavy')!
    const details = {...confirm, taskProbabilities: {confirm: 0.1, details: 0.8, cancel: 0.1}}
    expect(selectLayout(candidates, confirm, predict)?.id).toBe('wide-confirm')
    expect(selectLayout(candidates, details, predict)?.id).toBe('wide-details')
    expect(selectLayout(candidates, {...confirm, constraints: {minimumTargetWidth: 72, maximumClutter: 1}}, predict)?.id).toBe('balanced')
    expect(() => selectLayout(candidates, {...confirm, taskProbabilities: {confirm: 1, details: 1, cancel: 1}}, predict)).toThrow('sum to one')
  })

  test('uses identity rather than control storage order', () => {
    const situation = selectionSituations()[0]!
    for (const layout of candidates) {
      expect(expectedCost({...layout, controls: [...layout.controls].reverse()}, situation, predict)).toBe(expectedCost(layout, situation, predict))
    }
  })

  test('compares the same valid candidates with distance and simulator-optimal selection', () => {
    const comparison = compareSelections(predict, meanDurationMs)
    const predicted = comparison.summary[0]!
    const distance = comparison.summary[1]!
    const optimal = comparison.summary[2]!
    expect(predicted.situations).toBe(120)
    expect(predicted.meanRegretMs).toBeLessThan(5)
    expect(predicted.meanDurationMs).toBeLessThan(distance.meanDurationMs)
    expect(optimal.meanRegretMs).toBe(0)
    expect(comparison.allCandidatesAllowed[0]!.situations).toBe(20)
    for (const row of comparison.rows) {
      for (const selection of row.selections) {
        const layout = candidates.find(candidate => candidate.id === selection.layout)!
        expect(layoutViolations(layout, row.situation.constraints)).toEqual([])
        expect(selection.regretMs).toBeGreaterThanOrEqual(0)
      }
    }
  })
})
