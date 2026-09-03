import {Circuit} from '../../numeric-ui-core.ts'
import {createCandidateGalleryMachine} from '../../candidate-gallery.ts'
import {createWindowManagerMachine} from '../../window-manager.ts'

type Runner = (source: Float32Array) => Float32Array

function median(values: number[]) {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!
}

function measure(name: string, circuit: Circuit, source: Float32Array, roots: readonly number[], iterations: number, direct?: Runner) {
  const select = (evaluate: Runner): Runner => {
    const output = new Float32Array(roots.length)
    return input => {
      const values = evaluate(input)
      for (let index = 0; index < roots.length; index++) output[index] = values[roots[index]!]!
      return output
    }
  }
  circuit.tensorProgram = circuit.compileTensorProgram(roots)
  const runners: [string, Runner][] = [
    ['reference', select(input => circuit.evaluateReference(input))],
    ['tensor full array', select(input => circuit.evaluateTensor(input))],
    ['tensor reusable roots', circuit.createTensorEvaluator(roots)],
  ]
  if (direct !== undefined) runners.unshift(['direct scalar JS', direct])
  const samples = runners.map(() => [] as number[])
  let expectedChecksum: number | undefined
  for (let sample = 0; sample < 7; sample++) {
    for (let offset = 0; offset < runners.length; offset++) {
      const index = (sample + offset) % runners.length
      const [, run] = runners[index]!
      for (let warm = 0; warm < 200; warm++) run(source)
      let checksum = 0
      const started = performance.now()
      for (let iteration = 0; iteration < iterations; iteration++) {
        const result = run(source)
        for (const value of result) checksum += value
      }
      samples[index]!.push((performance.now() - started) * 1000 / iterations)
      expectedChecksum ??= checksum
      if (checksum !== expectedChecksum) throw new Error(`${name}: runtime result disagreement`)
    }
  }
  return {
    name,
    sources: circuit.sourceSize,
    operations: circuit.operations.length,
    liveOperations: circuit.tensorProgram.wireOrder.length - circuit.sourceSize,
    layers: circuit.tensorProgram.layers.length,
    storedWeights: circuit.tensorProgram.layers.reduce((total, layer) => total + layer.weights.length, 0),
    roots: roots.length,
    iterations,
    checksum: expectedChecksum,
    medianMicroseconds: Object.fromEntries(runners.map(([label], index) => [label, median(samples[index]!)])),
  }
}

export function runRuntimeStudy() {
  const coordinate = new Circuit(3)
  for (let wire = 0; wire < 3; wire++) coordinate.assumeRange(wire, -128, 128)
  const translated = coordinate.roundAffine([[0, 1], [1, -1]])
  const result = coordinate.multiply(translated, 2)
  const directOutput = new Float32Array(1)
  const candidate = createCandidateGalleryMachine()
  const windows = createWindowManagerMachine()
  return [
    measure('coordinate transform', coordinate, new Float32Array([13.25, -7.5, 3]), [result], 100_000, source => {
      directOutput[0] = Math.fround(Math.fround(source[0]! - source[1]!) * source[2]!)
      return directOutput
    }),
    measure('candidate gallery', candidate.circuit, candidate.source, [...candidate.tensorProgram.roots], 2_000),
    measure('window manager', windows.circuit, windows.source, [...windows.tensorProgram.roots], 500),
  ]
}

if (import.meta.main) console.log(JSON.stringify(runRuntimeStudy(), null, 2))
