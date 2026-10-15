// What a layer costs on the CPU executor besides its operations: the same 16,384 sums of two terms, arranged as
// chains of 64, 1,024 and 16,384 sums, so that the compiled program has that many layers. docs/patterns.md's
// introduction quotes the result.
//
//   bun lab/runtime-cost/layers.ts          every layer count, each in a process of its own
//   bun lab/runtime-cost/layers.ts 1024     one layer count
//
// Each layer count runs in its own process, since timing programs of different sizes in one process can distort the
// later timings (README.md's update of September 16, 2026).
import {Circuit, type Wire} from '../../src/runtime/numeric-ui-core.ts'

const operationCount = 16_384
const layerCounts = [64, 1024, 16_384]

function measure(layerCount: number) {
  const chainCount = operationCount / layerCount
  const circuit = new Circuit(operationCount + chainCount)
  let nextCell = 0
  const cell = () => {
    const wire = circuit.source(nextCell++)
    circuit.assumeRange(wire, 0, 1)
    return wire
  }
  const roots: Wire[] = []
  for (let chain = 0; chain < chainCount; chain++) {
    let total = cell()
    for (let step = 0; step < layerCount; step++) total = circuit.roundAffine([[total, 1], [cell(), 1]])
    roots.push(total)
  }
  const program = circuit.compileTensorProgram(roots)
  const evaluate = circuit.createTensorProgramEvaluator(program)
  const source = new Float32Array(operationCount + chainCount).fill(1 / 1024)
  for (let warmup = 0; warmup < 2000; warmup++) evaluate(source)
  const samples: number[] = []
  for (let sample = 0; sample < 9; sample++) {
    const started = performance.now()
    let runs = 0
    while (performance.now() - started < 300) {
      evaluate(source)
      runs++
    }
    samples.push((performance.now() - started) / runs * 1000)
  }
  const expected = Math.fround((layerCount + 1) / 1024)
  if (evaluate(source)[0] !== expected) throw new Error(`a chain of ${layerCount} sums gave ${evaluate(source)[0]}, expected ${expected}`)
  samples.sort((left, right) => left - right)
  console.log(`${program.valueCount - program.sourceSize} operations in ${program.layers.length} layers: ${samples[4]!.toFixed(1)} µs per evaluation, median of 9 (${samples[0]!.toFixed(1)} to ${samples[8]!.toFixed(1)})`)
}

const requested = process.argv[2]
if (requested !== undefined) {
  measure(Number(requested))
} else {
  for (const layerCount of layerCounts) {
    const run = Bun.spawnSync([process.execPath, import.meta.path, String(layerCount)], {stdout: 'inherit', stderr: 'inherit'})
    if (run.exitCode !== 0) process.exit(run.exitCode)
  }
}
