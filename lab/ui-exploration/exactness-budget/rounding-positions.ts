// Rounding points as flags per packed position, for emitters that work on
// codegen's flattened program (planInstances and the WGSL emitter).
import type {Circuit} from '../../../numeric-ui-core.ts'
import type {TensorProgram} from './copies/codegen/codegen.ts'
import {prepareModeProgram} from './interpreter.ts'

export function roundingPositions(circuit: Circuit, program: TensorProgram): Uint8Array {
  const {packed, points} = prepareModeProgram(circuit, program)
  const flags = new Uint8Array(packed.valueCount)
  for (let row = 0; row < packed.rowCount; row++) if (points.isRoundingPoint[row] === 1) flags[packed.position[row]!] = 1
  return flags
}
