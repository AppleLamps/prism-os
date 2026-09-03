import {describe as suite, expect, test} from 'bun:test'
import {boundaryScenes, buildAdapter, CAPACITY, encode, enumeratePrograms, heldOutScenes, makeScene, oracle, repeatedLookup, synthesize, TASKS, trainingScenes, verify} from './experiment.ts'

const search = synthesize(trainingScenes())
const programs = search.fits.map(fit => {
  if (fit.programs.length !== 1) throw new Error(`expected one solution for ${fit.task}, got ${fit.programs.length}`)
  return fit.programs[0]!
})
const reusable = repeatedLookup(programs)
if (reusable === null) throw new Error('no repeated lookup')

suite('bounded data adapters', () => {
  test('exhaustive search recovers all eight tasks without held-out examples', () => {
    expect(search.candidateCount).toBe(7 * 4 * (1 + 5 + 25))
    expect(trainingScenes()).toHaveLength(12)
    expect(search.fits.map(fit => fit.task)).toEqual([...TASKS])
    for (const program of programs) {
      expect(program.predicates).toEqual(['active', 'same-id'])
    }
    expect(programs.map(program => [program.field, program.steps])).toEqual([
      ['left', []], ['top', []], ['left', ['add-width']], ['top', ['add-height']],
      ['left', ['subtract-origin-x', 'multiply-scale']],
      ['top', ['subtract-origin-y', 'multiply-scale']],
      ['left', ['add-width', 'multiply-scale']],
      ['top', ['add-height', 'multiply-scale']],
    ])
    expect(enumeratePrograms().every(program => program.steps.length <= 2)).toBe(true)
  })

  test('larger counts, new IDs, fractions and storage permutations match native lookup', () => {
    const scenes = heldOutScenes()
    expect(scenes).toHaveLength(432)
    expect([...new Set(scenes.map(scene => scene.slots.filter(slot => slot.active).length))]).toEqual([0, 4, 6, 9, 12])
    for (let index = 0; index < scenes.length; index += 2) {
      for (const task of TASKS) expect(oracle(scenes[index]!, task)).toEqual(oracle(scenes[index + 1]!, task))
    }
    expect(verify(programs, TASKS, scenes).comparisons).toBe(432 * 8 * 2 * 2)
  })

  test('repeated lookup can be factored and reused without changing results', () => {
    expect(reusable).toEqual({predicates: ['active', 'same-id'], uses: 8})
    const scenes = [...heldOutScenes(), ...boundaryScenes()]
    const expanded = verify(programs, TASKS, scenes)
    const factored = verify(programs, TASKS, scenes, reusable)
    // The core already deduplicates the repeated prefix in a jointly built
    // graph. Do not claim a second graph-size saving from our library name.
    expect(factored.operations).toBe(expanded.operations)
    expect(factored.comparisons).toBe(expanded.comparisons)
    expect(repeatedLookup([programs[0]!])).toBeNull()
    expect(() => buildAdapter(programs, {predicates: ['same-id'], uses: 8})).toThrow('does not match')
  })

  test('empty and missing selections return found=0, value=0 before any coordinate transform', () => {
    for (const count of [0, 3, CAPACITY]) {
      const scene = makeScene(1007, count, true, true)
      expect(scene.originX).not.toBe(0)
      for (const task of TASKS) expect(oracle(scene, task)).toEqual({found: 0, value: 0})
      verify(programs, TASKS, [scene], reusable)
    }
    const scene = makeScene(1011, 4, false, true)
    const inactive = scene.slots.filter(slot => !slot.active)
    expect(inactive.length).toBeGreaterThan(0)
    expect(inactive.every(slot => slot.id === scene.selectedID)).toBe(true)
    expect(oracle(scene, 'left').found).toBe(1)
    verify(programs, TASKS, [scene], reusable)
  })

  test('input rounding and intermediate FP32 rounding are part of the target', () => {
    const cases = boundaryScenes()
    expect(oracle(cases[0]!, 'local-left').value).toBe(0)
    const rectangle = cases[0]!.slots.find(slot => slot.active && slot.id === cases[0]!.selectedID)!
    expect(Math.fround((rectangle.left - cases[0]!.originX) * cases[0]!.scale)).not.toBe(0)
    expect(oracle(cases[1]!, 'scaled-right').value).toBe(3)
    expect(Math.fround((1 + 2 ** -24) * 3)).not.toBe(3)
    verify(programs, TASKS, cases, reusable)
  })

  test('the fixed graph handles every selected storage position', () => {
    const scene = makeScene(1003, 1, false, true)
    const selectedSlot = scene.slots.findIndex(slot => slot.active)
    const {circuit, roots} = buildAdapter(programs, reusable)
    const evaluate = circuit.createTensorEvaluator(roots)
    const operations = circuit.operations.length
    const expected = [...evaluate(encode(scene))]
    for (let slot = 0; slot < CAPACITY; slot++) {
      const slots = [...scene.slots]
      ;[slots[slot], slots[selectedSlot]] = [slots[selectedSlot]!, slots[slot]!]
      expect([...evaluate(encode({...scene, slots}))]).toEqual(expected)
    }
    expect(circuit.operations.length).toBe(operations)
  })

  test('gather lowering is exercised and agrees with the unlowered graph', () => {
    const {circuit, roots} = buildAdapter(programs, reusable)
    const lowered = circuit.compileTensorProgram(roots, true)
    const unlowered = circuit.compileTensorProgram(roots, false)
    expect(lowered.layers.reduce((count, layer) => count + layer.gatherReads.length, 0)).toBe(4)
    expect(unlowered.layers.every(layer => layer.gatherReads.length === 0)).toBe(true)
    for (const scene of [...boundaryScenes(), makeScene(1008, 0, true, true), makeScene(1009, 12, false, true)]) {
      const source = encode(scene)
      circuit.tensorProgram = lowered
      const loweredValues = circuit.evaluateTensor(source)
      circuit.tensorProgram = unlowered
      const unloweredValues = circuit.evaluateTensor(source)
      for (const root of roots) expect(loweredValues[root] === unloweredValues[root]).toBe(true)
    }
  })

  test('invalid IDs, duplicate active IDs and invalid numeric inputs are rejected', () => {
    const scene = makeScene(1001, 4, false, true)
    const active = scene.slots.filter(slot => slot.active)
    const duplicate = {...scene, slots: scene.slots.map(slot => slot === active[1] ? {...slot, id: active[0]!.id} : slot)}
    expect(() => encode(duplicate)).toThrow('active IDs must be unique')
    expect(() => encode({...scene, selectedID: 2.5})).toThrow('numeric contract')
    expect(() => encode({...scene, selectedID: 65536})).toThrow('numeric contract')
    expect(() => encode({...scene, scale: Infinity})).toThrow('numeric contract')
    expect(() => encode({...scene, originX: NaN})).toThrow('numeric contract')
    expect(() => encode({...scene, slots: scene.slots.slice(1)})).toThrow('storage slots')
    expect(() => makeScene(1, CAPACITY + 1, false, false)).toThrow('active count')
  })
})
