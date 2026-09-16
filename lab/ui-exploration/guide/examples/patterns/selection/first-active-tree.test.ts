import {describe, expect, test} from 'bun:test'
import {Circuit, emitCompare, emitFirstActive, validateOneHotGroups, asWire} from '../../../../../../numeric-ui-core.ts'
import {
  buildFirstActiveSelection,
  buildFirstTargetUnderPointer,
  firstTargetUnderPointerReference,
  type FirstActiveForm,
  type Rectangle,
} from './first-active-tree.ts'
import {createBothEvaluators, createRandom, measureProgram} from './kit.ts'

const forms: FirstActiveForm[] = ['tree', 'chain']
const quarterPixel = (value: number) => Math.round(value * 4) / 4
const sixtyFourthPixel = (value: number) => Math.round(value * 64) / 64

// The loop over candidates in priority order, as a list of selected bits.
function firstActiveReference(gate: number, hits: readonly number[]): number[] {
  const selected = hits.map(() => 0)
  if (gate === 0) return selected
  for (let candidate = 0; candidate < hits.length; candidate++) {
    if (hits[candidate] === 1) {
      selected[candidate] = 1
      break
    }
  }
  return selected
}

describe('the first active candidate, in a tree', () => {
  test('both forms pick the loop\'s target on random and adversarial presses, in both evaluators', () => {
    const random = createRandom(11)
    let checks = 0
    let mismatches = 0
    for (const targetCount of [1, 2, 5, 15]) {
      for (const form of forms) {
        const built = buildFirstTargetUnderPointer(targetCount, form)
        const evaluate = createBothEvaluators(built.circuit, [...built.selected, built.pressedTarget, built.pressedAny, built.pressedLeft])
        const source = new Float32Array(built.circuit.sourceSize)
        for (let layout = 0; layout < 8; layout++) {
          // The targets crowd one 320 px square, so most presses land on several of them. A few are empty.
          const targets: Rectangle[] = Array.from({length: targetCount}, () => ({
            left: quarterPixel(random() * 200),
            top: quarterPixel(random() * 200),
            width: random() < 0.1 ? 0 : quarterPixel(random() * 120),
            height: random() < 0.1 ? 0 : quarterPixel(random() * 120),
          }))
          targets.forEach((target, index) => {
            source[built.targets[index]!.left] = target.left
            source[built.targets[index]!.top] = target.top
            source[built.targets[index]!.width] = target.width
            source[built.targets[index]!.height] = target.height
          })
          const pointers: [number, number][] = []
          for (let sample = 0; sample < 40; sample++) {
            pointers.push([sixtyFourthPixel(random() * 360 - 20), sixtyFourthPixel(random() * 360 - 20)])
          }
          // Every corner of every target, and 1/64 px on either side of it along both axes.
          for (const {left, top, width, height} of targets) {
            for (const x of [left, left + width]) {
              for (const y of [top, top + height]) {
                for (const offsetX of [-1 / 64, 0, 1 / 64]) {
                  for (const offsetY of [-1 / 64, 0, 1 / 64]) pointers.push([x + offsetX, y + offsetY])
                }
              }
            }
          }
          for (const [pointerX, pointerY] of pointers) {
            for (const pressed of [0, 1]) {
              source[built.pressed] = pressed
              source[built.pointerX] = pointerX
              source[built.pointerY] = pointerY
              const {roots, everyWire} = evaluate(source)
              validateOneHotGroups(built.circuit, everyWire)
              const expected = firstTargetUnderPointerReference(targets, pressed, pointerX, pointerY)
              const expectedRoots = [
                ...targets.map((_, target) => target === expected ? 1 : 0),
                expected === -1 ? 0 : expected,
                expected === -1 ? 0 : 1,
                expected === -1 ? 0 : targets[expected]!.left,
              ]
              if (roots.some((value, index) => value !== expectedRoots[index])) mismatches++
              checks++
            }
          }
        }
      }
    }
    expect(checks).toBeGreaterThan(20_000)
    expect(mismatches).toBe(0)
  })

  test('both forms equal the loop on random hit bits, including no hits, every hit and a closed gate', () => {
    const random = createRandom(12)
    for (const candidateCount of [1, 4, 15, 16, 64]) {
      const patterns: number[][] = [Array(candidateCount).fill(0), Array(candidateCount).fill(1)]
      for (let pattern = 0; pattern < 150; pattern++) {
        const density = [0.02, 0.2, 0.6][pattern % 3]!
        patterns.push(Array.from({length: candidateCount}, () => random() < density ? 1 : 0))
      }
      for (const form of forms) {
        const built = buildFirstActiveSelection(candidateCount, form)
        const evaluate = createBothEvaluators(built.circuit, built.selected)
        const source = new Float32Array(built.circuit.sourceSize)
        for (const hits of patterns) {
          hits.forEach((hit, candidate) => {
            source[built.hits[candidate]!] = hit
          })
          for (const gate of [0, 1]) {
            source[built.gate] = gate
            expect(evaluate(source).roots).toEqual(firstActiveReference(gate, hits))
          }
        }
      }
    }
  })

  test('the worked example: [0 1 0 1 0 0 1 0] selects candidate 1', () => {
    const built = buildFirstActiveSelection(8, 'tree')
    const values = built.circuit.evaluateReference(Float32Array.from([1, 0, 1, 0, 1, 0, 0, 1, 0]))
    expect(built.selected.map(wire => values[wire])).toEqual([0, 1, 0, 0, 0, 0, 0, 0])
  })

  test('fractional candidates split the route, and emitFirstActive declares no one-hot group over them', () => {
    const built = buildFirstActiveSelection(2, 'tree')
    const values = built.circuit.evaluateReference(Float32Array.from([1, 0.5, 0]))
    expect(built.selected.map(wire => values[wire])).toEqual([0.25, 0.25])
    expect(built.circuit.oneHotGroups.length).toBe(0)
  })

  test('emitFirstActive declares a one-hot group over emitCompare bits, and not over an AND of them built with a ReLU', () => {
    const circuit = new Circuit(3)
    for (const wire of [0, 1, 2]) {
      circuit.assumeRange(asWire(wire), 0, 64)
      circuit.assumeGrid(asWire(wire), 1)
    }
    const gate = emitCompare(circuit, circuit.source(0), '>=', circuit.source(1))
    const firstBit = emitCompare(circuit, circuit.source(0), '<', circuit.source(2))
    const secondBit = emitCompare(circuit, circuit.source(1), '<', circuit.source(2))
    emitFirstActive(circuit, gate, [firstBit, secondBit])
    expect(circuit.oneHotGroups.length).toBe(1)
    const both = circuit.reglu([], 1, [[firstBit, 1], [secondBit, 1]], -1)
    circuit.assumeRange(both, 0, 1)
    emitFirstActive(circuit, gate, [firstBit, both])
    expect(circuit.oneHotGroups.length).toBe(1)
  })

  test('sizes quoted in the pattern', () => {
    const sizes = [4, 15, 16, 64, 1024].map(count => [count, ...forms.map(form => {
      const built = buildFirstActiveSelection(count, form)
      const {operations, layers, storedWeights} = measureProgram(built.circuit, built.selected)
      return `${form}: ${operations} operations, ${layers} layers, ${storedWeights} weights`
    })])
    expect(sizes).toEqual([
      [4, 'tree: 16 operations, 11 layers, 30 weights', 'chain: 7 operations, 7 layers, 17 weights'],
      [15, 'tree: 71 operations, 20 layers, 136 weights', 'chain: 29 operations, 29 layers, 71 weights'],
      [16, 'tree: 76 operations, 21 layers, 145 weights', 'chain: 31 operations, 31 layers, 77 weights'],
      [64, 'tree: 316 operations, 31 layers, 605 weights', 'chain: 127 operations, 127 layers, 317 weights'],
      [1024, 'tree: 5116 operations, 51 layers, 9793 weights', 'chain: 2047 operations, 2047 layers, 5117 weights'],
    ])
    // 15 overlapping rectangles, with the hit tests, the pressed index and the pressed left edge.
    const tree = buildFirstTargetUnderPointer(15, 'tree')
    const chain = buildFirstTargetUnderPointer(15, 'chain')
    expect(measureProgram(tree.circuit, tree.hits)).toEqual({operations: 165, layers: 4, storedWeights: 300, gatherReads: 0})
    expect(measureProgram(tree.circuit, [...tree.selected, tree.pressedTarget, tree.pressedLeft]))
      .toEqual({operations: 238, layers: 26, storedWeights: 451, gatherReads: 1})
    expect(measureProgram(chain.circuit, [...chain.selected, chain.pressedTarget, chain.pressedLeft]))
      .toEqual({operations: 196, layers: 35, storedWeights: 386, gatherReads: 1})
  })
})
