// Switching from the executor to generated JavaScript in the middle of a session,
// with tiered.ts, while a window animates.
import {expect, test} from 'bun:test'
import {sameFloat} from './codegen.ts'
import {applyInteraction, createIndirectOSMachine, interactionFrameTime} from './indirect-os-machine.ts'

test('a machine that switches to generated JS in the middle of the scripted session writes back the same table and outputs as an executor-only machine', () => {
  const executor = createIndirectOSMachine({evaluator: 'executor', validate: false})
  const tiered = createIndirectOSMachine({evaluator: 'tiered', validate: true})
  const evaluator = tiered.tiered!
  // The root list repeats some wires, e.g. a window's next-source cell that is also a projected output.
  const roots = [...new Set(executor.program.roots)]
  for (let frame = 0; frame < 240; frame++) {
    // Photos is maximized at frame 130, so its window still animates at frame 140.
    if (frame === 140) {
      expect(executor.read(executor.output.animationActive)).toBeGreaterThan(0)
      expect(evaluator.tier).toBe('executor')
      expect(evaluator.promote(tiered.source, 5)).toBe(true)
    }
    for (const machine of [executor, tiered]) applyInteraction(machine, frame)
    const time = interactionFrameTime(frame)
    executor.step(1280, 800, time)
    tiered.step(1280, 800, time)
    for (let field = 0; field < executor.source.length; field++) {
      if (!sameFloat(executor.source[field]!, tiered.source[field]!)) {
        throw new Error(`frame ${frame} source cell ${field}: executor ${executor.source[field]}, tiered ${tiered.source[field]}`)
      }
    }
    for (const root of roots) {
      if (!sameFloat(executor.read(root), tiered.read(root))) {
        throw new Error(`frame ${frame} root ${root}: executor ${executor.read(root)}, tiered ${tiered.read(root)}`)
      }
    }
  }
  expect(evaluator.tier).toBe('generated')
  expect(evaluator.stats.verifiedWires).toBe(tiered.program.valueCount)
})
