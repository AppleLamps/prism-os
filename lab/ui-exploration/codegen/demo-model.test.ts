import {expect, test} from 'bun:test'
import {createDemoModel, type DemoKind} from './demo-model.ts'
import {emitInstanceWgsl, packSharedBuffer} from './wgsl.ts'

test('every demo model runs, paints, describes the pointer, and emits a guarded shader', () => {
  for (const kind of ['shapes', 'ownership', 'life', 'grid'] as DemoKind[]) {
    const model = createDemoModel(kind)
    model.setPointer(model.width / 2, model.height / 2)
    const milliseconds = model.runCpu()
    expect(milliseconds).toBeGreaterThan(0)
    const pixels = new Uint8ClampedArray(model.width * model.height * 4)
    model.render(model.outputs, pixels)
    expect(pixels.some(value => value > 0)).toBe(true)
    expect(model.describePointer(model.width / 2, model.height / 2, model.outputs).length).toBeGreaterThan(5)
    const module = emitInstanceWgsl(model.workload.plan, {guard: 'max'})
    expect(packSharedBuffer(module, model.runner).length).toBe(module.sharedLength)
  }
})
