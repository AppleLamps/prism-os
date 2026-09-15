// One experiment: build a task, train a network on a seeded split, harden it,
// count exact cases on the training cases, the held-out cases, and every case,
// compile it into a circuit, check every case with the tensor evaluator, and
// read what the live units are.

import {certifyCircuit, compileHardNetwork, measureProgram} from './compile.ts'
import {describeLeaders, describeUnits, matchPredicates, neededInputs, wiringCoverage} from './inspect.ts'
import {
  countExactCases,
  createNetwork,
  defaultNetworkOptions,
  defaultTrainOptions,
  harden,
  logitCount,
  splitCases,
  trainNetwork,
  type NetworkOptions,
  type TrainOptions,
} from './network.ts'
import {createTask} from './tasks.ts'

export type ExperimentConfig = {
  label: string
  task: string
  seed: number
  trainFraction: number
  network: Partial<NetworkOptions>
  train: Partial<TrainOptions>
  inspect: boolean
  // When above 0, redraws the wiring (network seed seed * 1000 + 1, + 2, ...)
  // up to this many times until every output bit can read every input it needs
  // (inspect.ts's wiringCoverage). The training seed stays `seed`.
  redrawUntilCovered?: number
}

export function runExperiment(config: ExperimentConfig) {
  const task = createTask(config.task)
  const needed = neededInputs(task)
  let networkOptions: NetworkOptions = {...defaultNetworkOptions, ...config.network, seed: config.seed}
  let network = createNetwork(task, networkOptions)
  let coverage = wiringCoverage(network, task, needed)
  let redraws = 0
  while (coverage.coveredOutputs < coverage.outputCount && redraws < (config.redrawUntilCovered ?? 0)) {
    redraws++
    networkOptions = {...networkOptions, seed: config.seed * 1000 + redraws}
    network = createNetwork(task, networkOptions)
    coverage = wiringCoverage(network, task, needed)
  }
  const trainOptions: TrainOptions = {...defaultTrainOptions, ...config.train, seed: config.seed}
  const split = splitCases(task, config.trainFraction, config.seed)
  const trainCases = config.trainFraction >= 1 ? Int32Array.from({length: task.caseCount}, (_, index) => index) : split.train
  const trained = trainNetwork(network, task, trainCases, trainOptions)
  const hard = harden(network)
  const allExact = countExactCases(hard, task, null)
  const {circuit, roots} = compileHardNetwork(hard, task)
  const certified = certifyCircuit(circuit, roots, task, hard)
  const inspection = config.inspect ? {units: describeUnits(hard), predicates: matchPredicates(hard, task)} : null
  return {
    label: config.label,
    task: task.name,
    kind: networkOptions.kind,
    seed: config.seed,
    networkSeed: networkOptions.seed,
    wiringRedraws: redraws,
    // How many output bits the wiring lets read every input they need.
    coveredOutputs: coverage.coveredOutputs,
    caseCount: task.caseCount,
    logits: logitCount(network),
    units: network.layers.reduce((total, layer) => total + layer.width, 0),
    layers: network.layers.length,
    seconds: Number(trained.seconds.toFixed(1)),
    softLoss: Number(trained.loss.toPrecision(4)),
    trainExact: countExactCases(hard, task, trainCases),
    trainCount: trainCases.length,
    heldOutExact: config.trainFraction >= 1 ? null : countExactCases(hard, task, split.heldOut),
    heldOutCount: config.trainFraction >= 1 ? null : split.heldOut.length,
    allExact,
    learnedExactly: allExact === task.caseCount,
    circuit: measureProgram(circuit, roots),
    circuitExact: certified.exact,
    circuitAgreesWithNetlist: certified.agreesWithNetlist,
    inspection: inspection === null ? null : {
      liveUnits: inspection.units.liveUnits,
      widestRead: inspection.units.widestRead,
      kinds: inspection.units.kinds,
      matchedUnits: inspection.predicates.matchedUnits,
      rediscovered: inspection.predicates.rediscovered,
      sharedRules: networkOptions.sharing ? describeLeaders(hard, task) : [],
    },
  }
}

export type ExperimentResult = ReturnType<typeof runExperiment>
