// Runs a batch program over many paragraphs at once through codegen's instance path
// (lab/ui-exploration/codegen/instance.ts): generated JavaScript that loops over a block of paragraphs inside each
// generated function, or the batched executor, which visits each row once per block and loops over the block's
// paragraphs inside. Every operation of these programs reads a paragraph's cells, so almost nothing is shared.
import {invariant} from '../../../../src/runtime/numeric-ui-core.ts'
import {type InstancePlan, type InstanceRunner, compileInstanceProgram, createBatchedExecutor, planInstances} from '../../codegen/instance.ts'
import type {BatchProgram} from './programs.ts'

export type InstanceBackend = 'generated' | 'batched'

// A block holds at most about 2^24 per-paragraph values, 64 MB, and at most 1,024 paragraphs.
export function blockSizeFor(instanceWidth: number) {
  return Math.max(16, Math.min(1024, 2 ** Math.floor(Math.log2(2 ** 24 / instanceWidth))))
}

export type BatchInstanceRunner = {
  backend: InstanceBackend
  plan: InstancePlan
  runner: InstanceRunner
  blockSize: number
  // Generating the JavaScript and compiling it with new Function, or encoding the rows for the batched executor.
  setupMilliseconds: number
  // instanceCells holds count × (2 × segments + 2) cells from writeInstanceCells; outputs receives count × outputNames.length values.
  run: (instanceCells: Float32Array, count: number, outputs: Float32Array) => void
}

export function createBatchInstanceRunner(program: BatchProgram, backend: InstanceBackend): BatchInstanceRunner {
  invariant(program.indexReads.reads === 0, "codegen's instance path doesn't take index reads: flattenProgram reads only a layer's affine, ReGLU, boolean and gather rows")
  const tensorProgram = program.compiled.circuit.tensorProgram
  invariant(tensorProgram !== undefined && tensorProgram !== null, 'the batch program must be compiled')
  const plan = planInstances(tensorProgram, program.instanceSourceWires, program.compiled.roots)
  const blockSize = blockSizeFor(plan.instanceWidth)
  const started = performance.now()
  const runner = backend === 'generated'
    ? compileInstanceProgram(plan, {rowsPerFunction: 64, blockSize})
    : createBatchedExecutor(plan, blockSize)
  const setupMilliseconds = performance.now() - started
  // The shared part reads only the unit cell. The instance cells in this table are replaced per paragraph.
  const sharedSource = new Float32Array(program.fc.circuit.sourceSize)
  sharedSource[0] = 1
  runner.runShared(sharedSource)
  return {
    backend,
    plan,
    runner,
    blockSize,
    setupMilliseconds,
    run: (instanceCells, count, outputs) => runner.runInstances(instanceCells, count, outputs),
  }
}
