// What the backward pass costs for n spring steps with stiffness and damping in
// cells, in three forms:
// - unrolled: n copies of the step, n chosen while building;
// - masked unrolled: a copy per possible step up to a maximum, all computed on every
//   evaluation, with a bit per copy that selects whether the copy's result is kept, so the
//   count can come from this frame's timestamp;
// - matrix power: spring-power.ts, 8 squarings, 9 selects of 4 entries and 8 products in a
//   tree, for any count up to 511.
// backpropagateReference walks every operation once, from last to first, and needs
// the forward value of every wire, so the operations walked and the values stored
// measure its work and memory. It skips an operation whose gradient is 0 with one
// comparison, so the operations that receive a gradient measure the work that remains.
import {Circuit, type Wire, emitSelect} from '../../../../../src/runtime/numeric-ui-core.ts'
import {type SpringCells, type SpringParameters, declareSpringRanges, springCells} from './spring-power.ts'

const unrolledCells: SpringCells = {...springCells, stepBits: []}
const unrolledSourceSize = 6

function emitEulerStep(circuit: Circuit, cells: SpringCells, displacement: Wire, velocity: Wire) {
  const springForce = circuit.multiply(cells.stiffness, displacement)
  const dampingForce = circuit.multiply(cells.damping, velocity)
  const acceleration = circuit.roundAffine([[springForce, -1], [dampingForce, -1]])
  const nextVelocity = circuit.roundAffine([[velocity, 1], [circuit.multiply(acceleration, cells.stepSeconds), 1]])
  const nextDisplacement = circuit.roundAffine([[displacement, 1], [circuit.multiply(nextVelocity, cells.stepSeconds), 1]])
  return {displacement: nextDisplacement, velocity: nextVelocity}
}

export function buildUnrolledSpring(stepCount: number) {
  const cells = unrolledCells
  const circuit = new Circuit(unrolledSourceSize)
  declareSpringRanges(circuit, cells)
  let displacement = circuit.roundAffine([[cells.position, 1], [cells.destination, -1]])
  let velocity: Wire = cells.velocity
  for (let step = 0; step < stepCount; step++) ({displacement, velocity} = emitEulerStep(circuit, cells, displacement, velocity))
  const position = circuit.roundAffine([[cells.destination, 1], [displacement, 1]])
  return {circuit, cells, position}
}

// runsStep[i] = [stepCount >= i + 1], a thermometer JS writes after the first 6 cells.
export function buildMaskedUnrolledSpring(maximumSteps: number) {
  const cells = unrolledCells
  const circuit = new Circuit(unrolledSourceSize + maximumSteps)
  declareSpringRanges(circuit, cells)
  const runsStep = Array.from({length: maximumSteps}, (_, index) => circuit.source(unrolledSourceSize + index))
  for (const bit of runsStep) circuit.assumeRange(bit, 0, 1)
  let displacement = circuit.roundAffine([[cells.position, 1], [cells.destination, -1]])
  let velocity: Wire = cells.velocity
  for (const bit of runsStep) {
    const advanced = emitEulerStep(circuit, cells, displacement, velocity)
    displacement = emitSelect(circuit, bit, displacement, advanced.displacement)
    velocity = emitSelect(circuit, bit, velocity, advanced.velocity)
  }
  const position = circuit.roundAffine([[cells.destination, 1], [displacement, 1]])
  return {circuit, cells, position, runsStep}
}

export function writeUnrolledSource(source: Float32Array, parameters: SpringParameters, runsStep: readonly Wire[] = [], stepCount = 0) {
  source[unrolledCells.stiffness] = parameters.stiffness
  source[unrolledCells.damping] = parameters.damping
  source[unrolledCells.stepSeconds] = parameters.stepSeconds
  source[unrolledCells.destination] = parameters.destination
  source[unrolledCells.position] = parameters.position
  source[unrolledCells.velocity] = parameters.velocity
  runsStep.forEach((bit, index) => {
    source[bit] = index < stepCount ? 1 : 0
  })
}

// Plain float64 Euler loop, the twin of both unrolled forms.
export function referenceUnrolledSpring(parameters: SpringParameters, stepCount: number) {
  let displacement = parameters.position - parameters.destination
  let velocity = parameters.velocity
  for (let step = 0; step < stepCount; step++) {
    const acceleration = -parameters.stiffness * displacement - parameters.damping * velocity
    velocity += acceleration * parameters.stepSeconds
    displacement += velocity * parameters.stepSeconds
  }
  return {displacement, velocity, position: parameters.destination + displacement}
}

export type BackwardCost = {
  operationsWalked: number
  operationsReceivingGradient: number
  liveOperations: number
  layers: number
  storedValues: number
  backwardMicroseconds: number
}

export function measureBackwardCost(circuit: Circuit, source: Float32Array, output: Wire, repeats = 200): BackwardCost {
  const program = circuit.compileTensorProgram([output])
  const values = circuit.evaluateReference(source)
  const seeds = new Float32Array(values.length)
  seeds[output] = 1
  const gradients = circuit.backpropagateReference(values, seeds)
  let operationsReceivingGradient = 0
  for (let wire = circuit.sourceSize; wire < gradients.length; wire++) {
    if (gradients[wire] !== 0) operationsReceivingGradient++
  }
  const samples: number[] = []
  for (let repeat = 0; repeat < repeats; repeat++) {
    const start = performance.now()
    circuit.backpropagateReference(values, seeds)
    samples.push(performance.now() - start)
  }
  samples.sort((left, right) => left - right)
  return {
    operationsWalked: circuit.operations.length,
    operationsReceivingGradient,
    liveOperations: program.layers.reduce((sum, layer) => sum + layer.outputSize, 0),
    layers: program.layers.length,
    storedValues: values.length,
    backwardMicroseconds: samples[Math.floor(samples.length / 2)]! * 1000,
  }
}
