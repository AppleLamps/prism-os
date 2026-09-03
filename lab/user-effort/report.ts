import {observationInput, type EffortInput} from './domain.ts'
import {createPredictor, parameterNames, predictionErrors, trainPredictor} from './predictor.ts'
import {compareSelections} from './selection.ts'
import {createObservations, heldOutLevels, meanDurationMs, noiseHalfWidthMs, trainingLevels} from './simulator.ts'

export function runStudy() {
  const training = createObservations('train', 731)
  const heldOut = createObservations('held-out', 947)
  const trained = trainPredictor(training)
  const model = createPredictor(trained.parameters)
  const predict = (input: EffortInput) => model.predict(input)
  const meanTrainingDuration = training.reduce((total, observation) => total + observation.durationMs, 0) / training.length
  const selection = compareSelections(predict, meanDurationMs)
  return {
    assumptions: [
      'Synthetic durations only; the simulator formula and predictor features are deliberately matched.',
      'No human usability claim, causal identification, learned preference, error prediction, or candidate generation.',
      'Five shared parameters are fitted once from noisy observed durations; inference freezes them.',
      'Geometry and logarithm are fixed preprocessing; feature multiplication and prediction use the FP32 Circuit.',
      'Task probabilities and constraints are explicitly supplied, never inferred from click counts.',
    ],
    data: {training: training.length, heldOut: heldOut.length, trainingSeed: 731, heldOutSeed: 947, trainingLevels, heldOutLevels, noiseHalfWidthMs},
    training: {epochs: trained.epochs, learningRate: 0.04, adamEpsilon: 1e-8, initialMseSecondsSquared: trained.losses[0], finalPreUpdateMseSecondsSquared: trained.losses.at(-1)},
    circuit: {sources: model.circuit.sourceSize, operations: model.circuit.operations.length, layers: Math.max(...model.circuit.depths)},
    parametersSeconds: parameterNames.map((name, index) => ({name, value: trained.parameters[index]})),
    prediction: {
      trainingNoisy: predictionErrors(training, predict, observation => observation.durationMs),
      heldOutNoisy: predictionErrors(heldOut, predict, observation => observation.durationMs),
      heldOutSimulatorMean: predictionErrors(heldOut, predict, observation => meanDurationMs(observationInput(observation))),
      constantBaselineHeldOutMean: predictionErrors(heldOut, () => meanTrainingDuration, observation => meanDurationMs(observationInput(observation))),
    },
    selection: {allSituations: selection.summary, allCandidatesAllowed: selection.allCandidatesAllowed},
    freshTrainingSeeds: [1731, 2731, 3731].map(seed => {
      const fresh = createPredictor(trainPredictor(createObservations('train', seed)).parameters)
      const predictFresh = (input: EffortInput) => fresh.predict(input)
      return {
        trainingSeed: seed,
        heldOutSimulatorMean: predictionErrors(heldOut, predictFresh, observation => meanDurationMs(observationInput(observation))),
        selection: compareSelections(predictFresh, meanDurationMs).summary[0],
      }
    }),
    examples: selection.rows.filter(row => row.situation.motorContext === 0.375 && row.situation.constraints.minimumTargetWidth === 32 && row.situation.constraints.maximumClutter === 1),
    observationExamples: training.slice(0, 3),
  }
}

if (import.meta.main) console.log(JSON.stringify(runStudy(), null, 2))
