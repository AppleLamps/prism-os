// The reviewer's programs of writer-probes.ts and writer-fuzz.ts on the GPU: each loop program as loop-emit.ts's shader
// and as bit-emit.ts's, through gpu/host.ts's runner, which fills bit-emit.ts's packed words from the shader's plan,
// with every output compared with the CPU executor's. A shader that the GPU's compiler refuses is reported with the
// compiler's message. writer-probes-run.ts opens this page.
import {emitBitLoopWgsl} from '../bit-emit.ts'
import {createDocumentStore, createProgramRunner, requestBatchDevice} from '../gpu/host.ts'
import {emitLoopWgsl} from '../loop-emit.ts'
import {createLoopRunner} from '../loop-program.ts'
import {buildLanes, buildScalar} from './writer-fuzz.ts'
import {type Probe, createRandom, fillRound, positions, probes} from './writer-probes.ts'

export type ProbesConfig = {fuzzPrograms: number, rounds: number, fuzzRounds: number, salt: number}
type Entry = {
  name: string
  // bit-emit.ts stopped, or the GPU's compiler refused its shader.
  writerThrew?: string
  compileErrors?: string
  values: number
  nonZero: number
  // Values that differ from the CPU executor's, in loop-emit.ts's shader and in bit-emit.ts's.
  mismatches: [today: number, bits: number]
  firstMismatch?: string
  packedWords: number
}

const config = await (await fetch('/config')).json() as ProbesConfig
const entries: Entry[] = []
const report: Record<string, unknown> = {startedAt: new Date().toISOString(), config, entries}
const post = async (done: boolean) => {
  await fetch('/result', {method: 'POST', body: JSON.stringify({...report, done})})
}

try {
  const documents = 64
  const granted = await requestBatchDevice(documents * positions * 4)
  const {device} = granted
  report['adapter'] = granted.adapterInfo
  device.addEventListener('uncapturederror', event => {
    report['uncapturedError'] = event.error.message
  })
  // One store for the programs with a cell per position, and one for those with the text's length after them.
  const stores = [await createDocumentStore(device, positions, documents), await createDocumentStore(device, positions + 1, documents)]

  const compileErrorsOf = async (code: string) => {
    device.pushErrorScope('validation')
    const module = device.createShaderModule({code})
    const messages = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error')
    await device.popErrorScope()
    return messages.map(message => `line ${message.lineNum}: ${message.message}`).join('; ')
  }

  const run = async (name: string, probe: Probe, seed: number, rounds: number): Promise<Entry> => {
    const {loop} = probe
    const store = stores.find(each => each.cellsPerDocument === loop.buffers[0]!.cellsPerDocument)!
    const cells = new Float32Array(documents * store.cellsPerDocument)
    const entry: Entry = {name, values: 0, nonZero: 0, mismatches: [0, 0], packedWords: 0}
    let bitShader: ReturnType<typeof emitBitLoopWgsl>
    try {
      bitShader = emitBitLoopWgsl(loop)
    } catch (error) {
      entry.writerThrew = (error as Error).message
      return entry
    }
    entry.packedWords = bitShader.packedCells.length
    const errors = await compileErrorsOf(bitShader.code)
    if (errors !== '') {
      entry.compileErrors = errors.slice(0, 400)
      return entry
    }
    const runners = [
      await createProgramRunner(device, emitLoopWgsl(loop), loop.sharedValues, store, config.salt, {windowCapacity: documents}),
      await createProgramRunner(device, bitShader, loop.sharedValues, store, config.salt, {windowCapacity: documents}),
    ]
    const executor = createLoopRunner(loop, 'executor')
    const random = createRandom(seed)
    const shared = new Float32Array(loop.sharedValues)
    const sizes = loop.outputGroups.map(group => documents * group.valuesPerDocument)
    const readbacks = loop.outputGroups.map((_, group) => ({group, firstDocument: 0, documentCount: documents}))
    for (let round = 0; round < rounds; round++) {
      fillRound(probe, random, round, shared, cells)
      store.write(cells, documents)
      const expected = sizes.map(size => new Float32Array(size))
      executor.setShared(shared)
      for (let row = 0; row < documents; row++) executor.run([cells], row, expected, row, row)
      const outputs: Float32Array[][] = []
      for (const runner of runners) outputs.push((await runner.evaluate({count: documents, shared, window: {firstDocument: 0, documentCount: documents}, readbacks})).outputs)
      expected.forEach((values, group) => {
        entry.values += values.length
        for (let index = 0; index < values.length; index++) {
          if (values[index] !== 0) entry.nonZero++
          for (const writer of [0, 1] as const) {
            if (values[index] === outputs[writer]![group]![index]) continue
            entry.mismatches[writer]++
            if (writer === 1) entry.firstMismatch ??= `round ${round}, output group ${group}, value ${index}: the executor gives ${values[index]}, loop-emit.ts's shader ${outputs[0]![group]![index]}, bit-emit.ts's shader ${outputs[1]![group]![index]}`
          }
        }
      })
    }
    for (const runner of runners) runner.destroy()
    return entry
  }

  for (const [name, build] of Object.entries(probes)) {
    entries.push(await run(name, build(), 20261014, config.rounds))
    console.log(JSON.stringify(entries.at(-1)))
    await post(false)
  }
  await post(false)

  // The random programs, summed per kind, with the entries that didn't agree.
  // In a 'broken' program, two registers' own stage writes numbers that their cells' declarations rule out.
  for (const [kind, build] of [['scalar', buildScalar], ['lanes', buildLanes], ['broken', (seed: number) => buildScalar(seed, true)]] as const) {
    const total = {name: `${kind}: ${config.fuzzPrograms} random programs`, programs: 0, refused: 0, values: 0, nonZero: 0, mismatches: [0, 0], withPackedWords: 0, failed: [] as Entry[]}
    for (let seed = 1; seed <= config.fuzzPrograms; seed++) {
      let entry: Entry
      try {
        entry = await run(`${kind} ${seed}`, build(seed), seed, config.fuzzRounds)
      } catch {
        // The builder or the executor refused the random program.
        total.refused++
        continue
      }
      total.programs++
      total.values += entry.values
      total.nonZero += entry.nonZero
      total.mismatches[0]! += entry.mismatches[0]
      total.mismatches[1]! += entry.mismatches[1]
      if (entry.packedWords > 0) total.withPackedWords++
      if (entry.writerThrew !== undefined || entry.compileErrors !== undefined || entry.mismatches[1] > 0) total.failed.push(entry)
      if (seed % 50 === 0) console.log(`${kind}: ${seed} programs`)
    }
    report[kind] = total
    console.log(JSON.stringify({...total, failed: total.failed.length}))
    await post(false)
  }
  for (const store of stores) store.destroy()
  report['finishedAt'] = new Date().toISOString()
} catch (error) {
  report['error'] = String(error instanceof Error ? error.stack ?? error.message : error)
  console.error(error)
}
await post(true)
