// Tiered execution: start on the shared executor, and switch to generated
// JavaScript (codegen.ts) once its functions are compiled, warmed, and checked
// bit for bit on every live wire against the executor on the current table.
//
// Generated code starts slow: JavaScriptCore interprets big functions before it
// optimizes them, so codegen measured about 5 ms for the first frame and about
// 250 µs per frame for the first hundred frames, against the executor's 30 µs.
// The host decides when to promote, e.g. during idle time.
import {type Circuit, type Wire, invariant} from '../../../numeric-ui-core.ts'
import {type ScalarProgram, compileScalarProgram, sameFloat} from './codegen.ts'

export type TieredEvaluator = ReturnType<typeof createTieredEvaluator>

export function createTieredEvaluator(circuit: Circuit, roots: readonly Wire[], options: {rowsPerFunction?: number} = {}) {
  const program = circuit.tensorProgram ??= circuit.compileTensorProgram(roots)
  invariant(program.roots.length === roots.length && roots.every((root, index) => program.roots[index] === root), 'the circuit\'s tensor program must be compiled for these roots')
  const executor = circuit.createTensorEvaluator(roots)
  const rootValues = new Float32Array(roots.length)
  let generated: ScalarProgram | null = null
  let rootPositions: Int32Array | null = null
  let tier: 'executor' | 'generated' = 'executor'
  const stats = {generateMilliseconds: 0, compileMilliseconds: 0, warmupMilliseconds: 0, warmupRuns: 0, verifiedWires: 0, functionCount: 0, sourceBytes: 0}

  function runGenerated(source: Float32Array) {
    generated!.run(source)
    const values = generated!.values
    const positions = rootPositions!
    for (let index = 0; index < positions.length; index++) rootValues[index] = values[positions[index]!]!
    return rootValues
  }

  return {
    stats,
    get tier() {
      return tier
    },
    evaluate(source: Float32Array): Float32Array {
      if (tier === 'generated') {
        circuit.validateSourceRanges(source)
        return runGenerated(source)
      }
      return executor(source)
    },
    // The three steps of a promotion, so a host can spread them over idle time:
    // compile, warm for a few milliseconds at a time, then verify and switch.
    prepare,
    warm,
    switchIfIdentical,
    // All three at once. Returns false and stays on the executor when a wire differs.
    promote(source: Float32Array, warmupMilliseconds = 50) {
      prepare()
      warm(source, warmupMilliseconds)
      return switchIfIdentical(source)
    },
  }

  function prepare() {
    if (generated !== null) return
    generated = compileScalarProgram(program, {rowsPerFunction: options.rowsPerFunction ?? 128})
    stats.generateMilliseconds = generated.generateMilliseconds
    stats.compileMilliseconds = generated.compileMilliseconds
    stats.functionCount = generated.functions.length
    stats.sourceBytes = generated.sourceBytes
    rootPositions = Int32Array.from(roots, wire => generated!.flat.positionOfWire[wire]!)
  }

  // Runs the generated functions on a copy of the table, so the engine optimizes them before they're used.
  function warm(source: Float32Array, milliseconds: number) {
    prepare()
    const copy = Float32Array.from(source)
    const started = performance.now()
    while (performance.now() - started < milliseconds) {
      generated!.run(copy)
      stats.warmupRuns++
    }
    stats.warmupMilliseconds += performance.now() - started
  }

  // Compares every live wire with the executor on this table, and switches when all match.
  function switchIfIdentical(source: Float32Array) {
    if (tier === 'generated') return true
    prepare()
    const copy = Float32Array.from(source)
    const expected = circuit.evaluateTensor(copy)
    generated!.run(copy)
    for (let position = 0; position < program.valueCount; position++) {
      if (!sameFloat(generated!.values[position]!, expected[program.wireOrder[position]!]!)) return false
    }
    stats.verifiedWires = program.valueCount
    tier = 'generated'
    return true
  }
}
