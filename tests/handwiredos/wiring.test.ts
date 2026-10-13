import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {Circuit} from '../../src/runtime/numeric-ui-core.ts'
import {createWindowManagerMachine} from '../../src/handwiredos/window-manager.ts'
import {drawWiring} from '../../src/handwiredos/wiring.ts'

type Arc = {color: string, left: number, right: number, height: number, baseline: number}

// A canvas that records each stroked arc: its color, the x of its two feet, its
// height and the y it stands on.
function recordingCanvas() {
  const arcs: Arc[] = []
  let pending: Omit<Arc, 'color'> | null = null
  const context = {
    lineWidth: 0,
    globalAlpha: 0,
    strokeStyle: '',
    setTransform() {},
    beginPath() {
      pending = null
    },
    ellipse(centerX: number, centerY: number, radiusX: number, radiusY: number, rotation: number, startAngle: number, endAngle: number) {
      assert.deepEqual([rotation, startAngle, endAngle], [0, Math.PI, 2 * Math.PI], 'an arc is the upper half of an ellipse')
      pending = {left: centerX - radiusX, right: centerX + radiusX, height: radiusY, baseline: centerY}
    },
    stroke() {
      assert.ok(pending !== null, 'every stroke draws one arc')
      arcs.push({...pending, color: context.strokeStyle})
    },
  }
  const canvas = {width: 0, height: 0, getContext: () => context}
  return {canvas: canvas as unknown as HTMLCanvasElement, size: canvas, context, arcs}
}

const options = {width: 300, height: 100, pixelRatio: 2, adds: 'copper', subtracts: 'indigo', alpha: 0.5, lineWidth: 0.5}

test('the wallpaper draws one arc per stored weight, from the value it reads to the operation that reads it', () => {
  // 2 cells, then a = 2 × cell 0 - cell 1 in layer 1, then b = a × max(0, cell 0) in layer 2.
  const circuit = new Circuit(2)
  const first = circuit.source(0)
  const second = circuit.source(1)
  const difference = circuit.roundAffine([[first, 2], [second, -1]])
  const product = circuit.reglu([[difference, 1]], 0, [[first, 1]], 0)
  const program = circuit.compileTensorProgram([product])
  assert.equal(program.layers.length, 2)

  const {canvas, size, context, arcs} = recordingCanvas()
  drawWiring(canvas, program, options)
  assert.deepEqual([size.width, size.height], [600, 200])
  assert.equal(context.globalAlpha, 0.5)
  assert.equal(context.lineWidth, 0.5)
  // 3 columns of 100 px: the cells at x 0 and 50, a at x 100, b at x 200. Every arc
  // stands on the middle of the canvas's last row of pixels, 99.75 px down, and one
  // as wide as the canvas would be that tall.
  const heightOf = (width: number) => width / 2 * (99.75 / 150)
  assert.deepEqual(arcs, [
    // The weights that add, layer by layer: 2 × cell 0 into a, then a and the gate's cell 0 into b.
    {color: 'copper', left: 0, right: 100, height: heightOf(100), baseline: 99.75},
    {color: 'copper', left: 100, right: 200, height: heightOf(100), baseline: 99.75},
    {color: 'copper', left: 0, right: 200, height: heightOf(200), baseline: 99.75},
    // Then the weight that subtracts: -1 × cell 1 into a.
    {color: 'indigo', left: 50, right: 100, height: heightOf(50), baseline: 99.75},
  ])
})

test('HandwiredOS\'s wallpaper has one arc for each of the program\'s stored weights', () => {
  const program = createWindowManagerMachine().tensorProgram
  let weights = 0
  let negative = 0
  for (const layer of program.layers) {
    weights += layer.weights.length
    for (const weight of layer.weights) negative += weight < 0 ? 1 : 0
  }
  const {canvas, arcs} = recordingCanvas()
  drawWiring(canvas, program, {...options, width: 1392, height: 846, pixelRatio: 1})
  assert.equal(arcs.length, weights)
  assert.equal(arcs.filter(arc => arc.color === 'indigo').length, negative)
  for (const arc of arcs) {
    assert.ok(arc.left >= 0 && arc.right <= 1392 && arc.left < arc.right, 'an arc reads an earlier value, inside the canvas')
    assert.ok(arc.height <= 845.5 + 1e-9, 'no arc is taller than the canvas')
  }
})

test('on a tall canvas an arc is at most 1.25 times as tall as half its width', () => {
  const circuit = new Circuit(1)
  const doubled = circuit.roundAffine([[circuit.source(0), 2]])
  const program = circuit.compileTensorProgram([doubled])
  const {canvas, arcs} = recordingCanvas()
  drawWiring(canvas, program, {...options, width: 200, height: 800, pixelRatio: 1})
  // Cell 0 at x 0, the operation at x 100.
  assert.deepEqual(arcs, [{color: 'copper', left: 0, right: 100, height: 62.5, baseline: 799.5}])
})
