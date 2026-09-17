// The GPU step's shaders and reference files. buildBatchShader emits codegen's WGSL (lab/ui-exploration/codegen/wgsl.ts)
// for the segment walker program of one paragraph size: one invocation runs every operation of one paragraph. The segment
// walker is the only formulation of programs.ts whose shader has no switch statements: codegen's instance path doesn't
// take the index-read program, and it writes the one-hot program's gathers as switch statements, e.g. 70,361 statements
// and 4.6 MB of WGSL for the short one-hot program. Two plans:
//   own-width     every source cell except the unit cell is a paragraph's cell, as in instances.ts: maxWidth, startCursor,
//                 the segment widths and the break-after bits, so each paragraph has its own width
//   shared-width  maxWidth is one shared value for every paragraph, and a paragraph's cells are the rest. A new width for
//                 every paragraph writes one float32 value into the shared buffer.
// Commands:
//   bun lab/ui-exploration/text-walker/batch/gpu/shaders.ts expected <folder> [--sizes short,long]
//     [--counts 1,100,1000,10000,100000] [--widths 320,400]
//     writes line-counts-<size>.i32, pretext's line count of each of the largest count's paragraphs at each width, and
//     expected.json, with a hash of the own-width cells at the first width after each count, which page.ts compares with
//     its own
//   bun lab/ui-exploration/text-walker/batch/gpu/shaders.ts sizes
//     the shaders' sizes, written to ../results/gpu-shader-sizes.json
import {mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {invariant} from '../../../../../src/runtime/numeric-ui-core.ts'
import {type InstancePlan, planInstances, runStepsOnce} from '../../../codegen/instance.ts'
import {type Guard, type WgslExposure, emitInstanceWgsl, packSharedBuffer} from '../../../codegen/wgsl.ts'
import {type ParagraphSize, assertFits, batchCapacities, expectedLineCount, timingParagraphs} from '../paragraphs.ts'
import {type BatchProgram, buildBatchProgram, instanceCellCount, writeInstanceCells} from '../programs.ts'
import {createCellsHasher} from './cells.ts'

export type ShaderPlan = 'own-width' | 'shared-width'
export const allShaderPlans: readonly ShaderPlan[] = ['own-width', 'shared-width']

export type BatchShader = {
  size: ParagraphSize
  plan: ShaderPlan
  guard: Guard
  workgroupSize: number
  code: string
  // The shared buffer the shader reads, see wgsl.ts's WgslModule: shared values, then the lowest float32 value. With the
  // shared-width plan it holds a width of 320 px at maxWidthOffset.
  sharedValues: number[]
  maxWidthOffset: number
  instanceSourceCount: number
  outputCount: number
  statementCount: number
  shaderBytes: number
  exposure: WgslExposure
  instancePlan: InstancePlan['counts']
  programSizes: BatchProgram['compiled']['size']
}

export function buildBatchShader(size: ParagraphSize, plan: ShaderPlan, guard: Guard, workgroupSize = 64): BatchShader {
  const program = buildBatchProgram('segment-walker', batchCapacities[size])
  const tensorProgram = program.compiled.circuit.tensorProgram
  invariant(tensorProgram !== undefined && tensorProgram !== null, 'the batch program must be compiled')
  const instanceWires = plan === 'own-width' ? program.instanceSourceWires : program.instanceSourceWires.slice(1)
  const instancePlan = planInstances(tensorProgram, instanceWires, program.compiled.roots)
  invariant(instancePlan.outputs.length === 1, 'the segment walker has one output, lineCount')
  const module = emitInstanceWgsl(instancePlan, {guard, workgroupSize})
  const unitPosition = instancePlan.flat.positionOfWire[0]!
  const maxWidthPosition = instancePlan.flat.positionOfWire[program.fc.maxWidth]!
  invariant(unitPosition === 0 && maxWidthPosition === program.fc.maxWidth, 'source cells keep their wire order in the packed values')
  // The shared part, e.g. the unit cell and, with the shared-width plan, maxWidth, computed once as codegen's runShared does.
  const sharedAt = (width: number) => {
    const values = new Float32Array(instancePlan.flat.valueCount)
    values[unitPosition] = 1
    if (plan === 'shared-width') values[maxWidthPosition] = width
    runStepsOnce(instancePlan.sharedSteps, values, new Int32Array(1), new Float32Array(1))
    return packSharedBuffer(module, {shared: values, sharedGatherIndices: new Int32Array(1), sharedGatherMasses: new Float32Array(1)})
  }
  const sharedValues = sharedAt(320)
  if (plan === 'shared-width') {
    // Only maxWidth changes between widths, so the host writes one value for a new width.
    const other = sharedAt(400)
    const differing = [...sharedValues.keys()].filter(index => !Object.is(sharedValues[index], other[index]))
    invariant(differing.length === 1 && differing[0] === maxWidthPosition, 'a shared value other than maxWidth depends on the width')
  }
  return {
    size, plan, guard, workgroupSize,
    code: module.code,
    sharedValues: Array.from(sharedValues),
    maxWidthOffset: plan === 'shared-width' ? maxWidthPosition : -1,
    instanceSourceCount: module.instanceSourceCount,
    outputCount: module.outputCount,
    statementCount: module.statementCount,
    shaderBytes: module.code.length,
    exposure: module.exposure,
    instancePlan: instancePlan.counts,
    programSizes: program.compiled.size,
  }
}

export type ExpectedMeta = {
  widths: number[]
  counts: number[]
  maxCount: number
  sizes: Record<string, {hashes: Record<string, number>, totalLines: number[], milliseconds: number}>
}

export function writeExpected(folder: string, sizes: readonly ParagraphSize[], counts: readonly number[], widths: readonly number[]) {
  mkdirSync(folder, {recursive: true})
  const maxCount = Math.max(...counts)
  const meta: ExpectedMeta = {widths: [...widths], counts: [...counts], maxCount, sizes: {}}
  for (const size of sizes) {
    const started = performance.now()
    const capacity = batchCapacities[size]
    const row = new Float32Array(instanceCellCount(capacity))
    const lineCounts = new Int32Array(maxCount * widths.length)
    const totalLines = widths.map(() => 0)
    const hasher = createCellsHasher()
    const hashes: Record<string, number> = {}
    const hashedCounts = new Set(counts)
    // 4,096 paragraphs at a time, so the prepared paragraphs of 100,000 long texts aren't all in memory at once.
    for (let first = 0; first < maxCount; first += 4096) {
      timingParagraphs(size, Math.min(4096, maxCount - first), first).forEach((paragraph, offset) => {
        const index = first + offset
        assertFits(capacity, paragraph)
        widths.forEach((width, widthIndex) => {
          const lines = expectedLineCount(paragraph, width)
          lineCounts[index * widths.length + widthIndex] = lines
          totalLines[widthIndex]! += lines
        })
        writeInstanceCells(row, 0, capacity, paragraph, widths[0]!)
        hasher.add(row)
        if (hashedCounts.has(index + 1)) hashes[String(index + 1)] = hasher.value()
      })
    }
    writeFileSync(join(folder, `line-counts-${size}.i32`), lineCounts)
    meta.sizes[size] = {hashes, totalLines, milliseconds: Math.round(performance.now() - started)}
    console.log(`${size}: ${maxCount} paragraphs in ${meta.sizes[size]!.milliseconds} ms`)
  }
  writeFileSync(join(folder, 'expected.json'), `${JSON.stringify(meta, null, 2)}\n`)
}

if (import.meta.main) {
  const [command, folder] = process.argv.slice(2)
  const argument = (name: string) => {
    const index = process.argv.indexOf(name)
    return index === -1 ? undefined : process.argv[index + 1]
  }
  if (command === 'expected' && folder !== undefined) {
    writeExpected(
      folder,
      (argument('--sizes') ?? 'short,long').split(',') as ParagraphSize[],
      (argument('--counts') ?? '1,100,1000,10000,100000').split(',').map(Number),
      (argument('--widths') ?? '320,400').split(',').map(Number),
    )
  } else if (command === 'sizes') {
    const rows: unknown[] = []
    for (const size of ['short', 'long'] as const) {
      for (const plan of allShaderPlans) {
        for (const guard of ['max', 'none'] as const) {
          const {code: _code, sharedValues, ...shader} = buildBatchShader(size, plan, guard)
          rows.push({...shader, sharedValueCount: sharedValues.length})
          console.log(JSON.stringify({size, plan, guard, statements: shader.statementCount, bytes: shader.shaderBytes, guards: shader.exposure.guards}))
        }
      }
    }
    writeFileSync(join(import.meta.dir, '../results/gpu-shader-sizes.json'), `${JSON.stringify(rows, null, 2)}\n`)
  } else {
    throw new Error('usage: shaders.ts expected <folder> [--sizes short,long] [--counts 1,100,1000,10000,100000] [--widths 320,400] | sizes')
  }
}
