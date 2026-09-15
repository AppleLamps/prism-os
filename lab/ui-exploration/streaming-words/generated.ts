// Generated JavaScript for a stream circuit, through this folder's copy of codegen's generator
// (codegen.ts, copied from lab/ui-exploration/codegen with one change: gather computes are loops over
// position tables instead of one expression per bit). It returns the roots in the same order as the
// executor's evaluator, so both can feed the same decoding.
//
// The generator only knows the shared runtime's layers: affine, reglu, boolean and gather rows. The
// index-read runtime adds index-read rows and gathers resolved from an index wire, so circuits built
// with it aren't generated here.
import {compileScalarProgram, type ScalarProgram} from './codegen.ts'
import {type StreamBuild} from './stream-circuit.ts'

export type GeneratedEvaluator = {
  program: ScalarProgram
  evaluate: (table: Float32Array) => Float32Array
}

export function createGeneratedEvaluator(build: StreamBuild, rowsPerFunction = 128): GeneratedEvaluator {
  if ((build.options.runtime?.name ?? 'shared') !== 'shared') throw new Error('generated JS only covers circuits built with the shared runtime')
  const program = compileScalarProgram(build.compiled.program, {rowsPerFunction})
  const positions = build.compiled.roots.map(root => program.flat.positionOfWire[root]!)
  const outputs = new Float32Array(positions.length)
  return {
    program,
    evaluate: table => {
      program.run(table)
      for (let index = 0; index < positions.length; index++) outputs[index] = program.values[positions[index]!]!
      return outputs
    },
  }
}
