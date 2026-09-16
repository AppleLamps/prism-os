// spring-bank's source-matrix variant in miniature (createSourceMatrixGroup in
// lab/ui-exploration/event-time/spring-bank.ts): JS computes M^steps in float64
// and writes 4 cells, and the circuit only applies those cells to the spring.
// Stiffness and damping stay editable, but no wire in the circuit depends on them,
// so the backward pass stops at the 4 matrix cells. A training loop can finish the
// chain rule in JS.
import {Circuit, asWire} from '../../../../../numeric-ui-core.ts'
import {
  type SpringParameters,
  type WireMatrix,
  centralDifference,
  emitApplyFrameMatrix,
  referenceMatrixPower,
  referenceSpringPower,
  referenceStepMatrix,
  withParameter,
} from './spring-power.ts'

export const sourceMatrixCells = {
  stiffness: asWire(0),
  damping: asWire(1),
  stepSeconds: asWire(2),
  destination: asWire(3),
  position: asWire(4),
  velocity: asWire(5),
  frame: [asWire(6), asWire(7), asWire(8), asWire(9)] as WireMatrix,
}

export function buildSourceMatrixCircuit() {
  const cells = sourceMatrixCells
  const circuit = new Circuit(10)
  circuit.assumeRange(cells.stiffness, 0, 2000)
  circuit.assumeRange(cells.damping, 0, 200)
  circuit.assumeRange(cells.stepSeconds, 0, 0.016)
  circuit.assumeRange(cells.destination, -16384, 16384)
  circuit.assumeRange(cells.position, -16384, 16384)
  circuit.assumeRange(cells.velocity, -65536, 65536)
  // spring-bank declares its JS-written frame entries within ±256.
  for (const entry of cells.frame) circuit.assumeRange(entry, -256, 256)
  const stepped = emitApplyFrameMatrix(circuit, cells.frame, cells)
  return {circuit, cells, stepped}
}

function frameMatrix(parameters: SpringParameters, stepCount: number) {
  return referenceMatrixPower(referenceStepMatrix(parameters.stiffness, parameters.damping, parameters.stepSeconds), stepCount)
}

export function writeSourceMatrix(source: Float32Array, parameters: SpringParameters, stepCount: number) {
  const cells = sourceMatrixCells
  source[cells.stiffness] = parameters.stiffness
  source[cells.damping] = parameters.damping
  source[cells.stepSeconds] = parameters.stepSeconds
  source[cells.destination] = parameters.destination
  source[cells.position] = parameters.position
  source[cells.velocity] = parameters.velocity
  const frame = frameMatrix(parameters, stepCount)
  for (let entry = 0; entry < 4; entry++) source[cells.frame[entry]!] = frame[entry]!
}

export type SourceMatrixGradients = {
  // What the circuit's backward pass reports on the stiffness and damping cells.
  circuitStiffness: number
  circuitDamping: number
  // The chain rule finished in JS: sum over entries of (d position / d entry) × (d entry / d parameter).
  chainedStiffness: number
  chainedDamping: number
  finiteDifferenceStiffness: number
  finiteDifferenceDamping: number
}

export function sourceMatrixGradients(parameters: SpringParameters, stepCount: number): SourceMatrixGradients {
  const {circuit, cells, stepped} = buildSourceMatrixCircuit()
  const source = new Float32Array(circuit.sourceSize)
  writeSourceMatrix(source, parameters, stepCount)
  const values = circuit.evaluateReference(source)
  const seeds = new Float32Array(values.length)
  seeds[stepped.position] = 1
  const gradients = circuit.backpropagateReference(values, seeds)
  const chained = (name: 'stiffness' | 'damping') => {
    let total = 0
    for (let entry = 0; entry < 4; entry++) {
      const entrySlope = centralDifference(value => frameMatrix(withParameter(parameters, name, value), stepCount)[entry]!, parameters[name])
      total += gradients[cells.frame[entry]!]! * entrySlope
    }
    return total
  }
  const position = (name: 'stiffness' | 'damping') => (value: number) => referenceSpringPower(withParameter(parameters, name, value), stepCount).position
  return {
    circuitStiffness: gradients[cells.stiffness]!,
    circuitDamping: gradients[cells.damping]!,
    chainedStiffness: chained('stiffness'),
    chainedDamping: chained('damping'),
    finiteDifferenceStiffness: centralDifference(position('stiffness'), parameters.stiffness),
    finiteDifferenceDamping: centralDifference(position('damping'), parameters.damping),
  }
}
