import {expect, test} from 'bun:test'
import {createExecutor} from './executor.ts'
import {createStagedEngine} from './gallery-engine.ts'
import {applySessionFrame, startSession} from './gallery-session.ts'
import {buildStagedGallery} from './gallery-staged.ts'
import {syntheticPhotos} from './synthetic-photos.ts'
import {emitInstanceWgsl, packSharedBuffer} from '../codegen/wgsl.ts'
import {createWgslInterpreter} from '../codegen/wgsl-interpreter.ts'

// Zeros of either sign count as equal.
const same = (left: number, right: number) => left === right || (Number.isNaN(left) && Number.isNaN(right))

test('every map stage of the staged gallery, emitted as WGSL with and without the max guard and interpreted with strict f32 rounding, reproduces the executor\'s columns', () => {
  const photos = syntheticPhotos(24)
  const staged = buildStagedGallery(photos)
  const interpreters = new Map<string, {none: ReturnType<typeof createWgslInterpreter>, max: ReturnType<typeof createWgslInterpreter>, modules: {none: ReturnType<typeof emitInstanceWgsl>, max: ReturnType<typeof emitInstanceWgsl>}}>()
  let compared = 0
  const stagesSeen = new Set<string>()
  const executor = createExecutor(staged.program, {
    mapStage: context => () => {
      context.runCpu()
      let entry = interpreters.get(context.stage.name)
      if (entry === undefined) {
        const modules = {none: emitInstanceWgsl(context.plan, {guard: 'none'}), max: emitInstanceWgsl(context.plan, {guard: 'max'})}
        entry = {modules, none: createWgslInterpreter(modules.none.code), max: createWgslInterpreter(modules.max.code)}
        interpreters.set(context.stage.name, entry)
      }
      const {count, inputColumns, outputColumns} = context
      const sources = new Float32Array(Math.max(1, count * inputColumns.length))
      inputColumns.forEach((column, position) => {
        for (let instance = 0; instance < count; instance++) sources[instance * inputColumns.length + position] = column[instance]!
      })
      for (const guard of ['none', 'max'] as const) {
        const module = entry.modules[guard]
        const outputs = new Float32Array(count * outputColumns.length)
        entry[guard](packSharedBuffer(module, context.cpu), sources, count, outputs)
        outputColumns.forEach((column, position) => {
          for (let instance = 0; instance < count; instance++) {
            const interpreted = outputs[instance * outputColumns.length + position]!
            if (!same(interpreted, column[instance]!)) throw new Error(`${context.stage.name}, guard ${guard}, instance ${instance}, output ${position}: interpreted ${interpreted}, executor ${column[instance]}`)
            compared++
          }
        })
      }
      stagesSeen.add(context.stage.name)
    },
  })
  const engine = createStagedEngine(staged, executor)
  startSession(engine, photos)
  for (const frame of [0, 1, 12, 20, 21, 40, 70, 80, 120, 140, 150]) {
    applySessionFrame(engine, frame)
    engine.step()
  }
  expect(stagesSeen.has('springs and occlusion')).toBe(true)
  expect(stagesSeen.has('grid targets and hover')).toBe(true)
  expect(stagesSeen.size).toBeGreaterThanOrEqual(20)
  expect(compared).toBeGreaterThan(20_000)
})
