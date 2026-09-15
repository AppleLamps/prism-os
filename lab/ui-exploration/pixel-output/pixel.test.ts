import {describe, expect, test} from 'bun:test'
import {installFakeCanvas, fakeTextWidth} from '../hn-thread/fake-canvas.ts'
import {thread} from '../hn-thread/hn-data.ts'
import {initialThreadState, prepareThread, type PreparedThread} from './thread-prepare.ts'
import {buildThreadCircuit} from './thread-circuit.ts'
import {containerWidthF, referenceFrame, type ThreadFrame} from './thread-frame.ts'
import {randomInputs, randomState, scenarioInputs, seededRandom, targetedInputs} from './differential.ts'
import {buildPixelThread, createPixelMachine, pixelCenters, pixelCompileOptions, type GlyphTextOptions} from './pixel-machine.ts'
import {paintLayer, paintTables, pixelOutputField, type TextMode} from './pixel-model.ts'
import type {RowLookup} from './pixel-circuit.ts'
import {compareRaster, geometryFromCheckValues, geometryFromReference, rasterize, topsSorted} from './pixel-reference.ts'
import {atlasFromJson, layoutTextTables, textCapacity, type GlyphAtlasJson} from './text-table.ts'
import {emitInstanceWgsl, packSharedBuffer} from './wgsl.ts'
import {createWgslInterpreter} from './wgsl-interpreter.ts'
import {gpuGrid, gpuStates} from './gpu-cases.ts'
import {threadLayout} from '../hn-thread/thread-model.ts'
import atlasJson from './glyph-atlas.json'

installFakeCanvas()

const small = prepareThread(thread.comments.slice(0, 60))
const smallPaint = paintTables(thread, small.tables, fakeTextWidth)
const atlas = atlasFromJson(atlasJson as GlyphAtlasJson)
const smallGlyphText: GlyphTextOptions = {
  atlas,
  capacity: textCapacity(small, atlas, fakeTextWidth),
  layout: containerWidth => layoutTextTables(small, containerWidth, atlas, fakeTextWidth),
}
let fullThread: PreparedThread | undefined
const fullPrepared = () => fullThread ??= prepareThread(thread.comments)
const variants: {rowLookup: RowLookup, text: TextMode}[] = [
  {rowLookup: 'count', text: 'bars'},
  {rowLookup: 'binary-search', text: 'bars'},
  {rowLookup: 'binary-search', text: 'glyphs'},
]
const grid = {width: 160, height: 100, stride: 8, offset: 0.5}
const count = grid.width * grid.height
const centers = pixelCenters(grid.width, grid.height, grid.stride, grid.offset)

function machineFor(variant: {rowLookup: RowLookup, text: TextMode}) {
  return createPixelMachine(small, smallPaint, variant, initialThreadState(small, 1280), variant.text === 'glyphs' ? smallGlyphText : undefined)
}

describe('thread circuit without slots', () => {
  test("the runtime copy, compiled like the shared runtime, reproduces hn-thread's counts at 251 comments", () => {
    const full = fullPrepared()
    const model = {tables: full.tables, staircases: full.staircases}
    for (const [slotCount, liveOperations, storedWeights] of [[48, 53_703, 218_170], [0, 28_340, 84_308]] as const) {
      const built = buildThreadCircuit(model, {slotCount, slotMode: 'rank', naturalPrefix: 'brent-kung', visualPrefix: 'fold'})
      const program = built.circuit.compileTensorProgram(built.roots, true, pixelCompileOptions)
      expect(program.valueCount - program.sourceSize).toBe(liveOperations)
      expect(program.layers.reduce((total, layer) => total + layer.weights.length, 0)).toBe(storedWeights)
    }
  })

  test('the two pixel cells split each program into thread logic and a per-pixel part', () => {
    const plans = variants.map(variant => buildPixelThread(small, smallPaint, variant, variant.text === 'glyphs' ? smallGlyphText : undefined).plan.counts)
    // The thread logic is the same for every variant; only the per-pixel part differs.
    expect(Math.abs(plans[0]!.sharedRows - plans[1]!.sharedRows)).toBeLessThanOrEqual(1)
    expect(plans[2]!.sharedRows).toBe(plans[1]!.sharedRows)
    // Counting costs a comparison and a one-hot member per row per pixel; the binary search doesn't grow with rows.
    expect(plans[0]!.instanceRows).toBeGreaterThan(2 * plans[1]!.instanceRows)
    expect(plans[2]!.instanceRows).toBeGreaterThan(plans[1]!.instanceRows)
  })
})

describe('pixels against the float64 rasterizer', () => {
  test('random states: no decision mismatch outside the tie band, for every variant, and count equals binary search bit for bit', () => {
    const barOutputs: (Float32Array | null)[][] = [[], []]
    variants.forEach((variant, variantIndex) => {
      const machine = machineFor(variant)
      const random = seededRandom(5)
      let checkedFrames = 0
      let inkSamples = 0
      for (let trial = 0; trial < 6; trial++) {
        const state = randomState(small, random, Math.round(320 + random() * 1100))
        const inputs = randomInputs(small, random, state)
        const {frame} = referenceFrame(small, state, inputs, 0, 'none')
        machine.setState(state)
        machine.setInputs(inputs)
        const outputs = new Float32Array(count * pixelOutputField.size)
        machine.draw(centers, count, outputs)
        const geometry = geometryFromReference(frame)
        // A row height below zero (hn.js' resize shift on a row at 0px) unsorts the row tops. Then the painter's order
        // and the row count disagree, and so do the two lookups, so those frames aren't compared.
        const sorted = topsSorted(geometry)
        if (variant.text === 'bars') barOutputs[variantIndex]!.push(sorted ? outputs : null)
        if (!sorted) continue
        checkedFrames++
        const textTables = machine.textTables()
        const glyphs = textTables === null ? undefined : {tables: textTables, atlas}
        const endToEnd = compareRaster(rasterize(geometry, small.tables, smallPaint, variant.text, grid, 0.05, glyphs), outputs, pixelOutputField.size)
        const perPixel = compareRaster(rasterize(geometryFromCheckValues(machine.checkValues(), machine.built.rowCount), small.tables, smallPaint, variant.text, grid, 1 / 32, glyphs), outputs, pixelOutputField.size)
        expect(endToEnd.firstMismatch).toBeNull()
        expect(perPixel.firstMismatch).toBeNull()
        expect(endToEnd.largestColorDifference).toBeLessThan(0.01)
        for (let sample = 0; sample < count; sample++) if (outputs[sample * pixelOutputField.size + pixelOutputField.layer] === 4) inkSamples++
      }
      expect(checkedFrames).toBeGreaterThanOrEqual(3)
      expect(inkSamples).toBeGreaterThan(500)
    })
    let compared = 0
    barOutputs[0]!.forEach((outputs, frame) => {
      const other = barOutputs[1]![frame]!
      if (outputs === null || other === null) return
      compared++
      for (let index = 0; index < outputs.length; index++) if (!Object.is(outputs[index], other[index])) throw new Error(`count and binary search differ at output ${index} of frame ${frame}`)
    })
    expect(compared).toBeGreaterThanOrEqual(3)
  })

  test('a scripted session (scroll, gutter press, collapse, resize), closed loop, glyph text', () => {
    const variant = {rowLookup: 'binary-search', text: 'glyphs'} as const
    let referenceState = initialThreadState(small, 1024)
    const machine = createPixelMachine(small, smallPaint, variant, referenceState, smallGlyphText)
    const frames = 120
    const inputsAt = scenarioInputs(small, frames)
    let previous: ThreadFrame | null = null
    let checked = 0
    let inkSamples = 0
    let inkComparedEndToEnd = 0
    let inkComparedPerPixel = 0
    for (let frame = 0; frame < frames; frame++) {
      const inputs = inputsAt(frame, previous)
      const {frame: expected} = referenceFrame(small, referenceState, inputs, 0, 'none')
      machine.setInputs(inputs)
      if (frame % 12 === 0 && topsSorted(geometryFromReference(expected))) {
        const outputs = new Float32Array(count * pixelOutputField.size)
        machine.draw(centers, count, outputs)
        const glyphs = {tables: machine.textTables()!, atlas}
        // End to end: the machine and the reference each run on their own state, so positions drift apart, and the band
        // is 0.5px. That band makes every sample of a glyph line whose top isn't on a whole pixel ambiguous.
        const endToEnd = compareRaster(rasterize(geometryFromReference(expected), small.tables, smallPaint, 'glyphs', grid, 0.5, glyphs), outputs, pixelOutputField.size)
        // Per-pixel part only: the circuit's own geometry, with a 1/32px band, so most glyph ink is compared.
        const perPixel = compareRaster(rasterize(geometryFromCheckValues(machine.checkValues(), machine.built.rowCount), small.tables, smallPaint, 'glyphs', grid, 1 / 32, glyphs), outputs, pixelOutputField.size)
        expect(endToEnd.firstMismatch).toBeNull()
        expect(perPixel.firstMismatch).toBeNull()
        inkSamples += perPixel.inkSamples
        inkComparedEndToEnd += endToEnd.inkSamplesCompared
        inkComparedPerPixel += perPixel.inkSamplesCompared
        checked++
      } else {
        machine.runShared()
      }
      machine.commit()
      referenceState = expected.next
      previous = expected
    }
    expect(checked).toBeGreaterThanOrEqual(8)
    expect(inkSamples).toBeGreaterThan(2000)
    expect(inkComparedEndToEnd).toBeLessThan(inkComparedPerPixel)
    expect(inkComparedPerPixel).toBeGreaterThan(0.8 * inkSamples)
  })

  test('both GPU states have emphasized samples at 1280×800, so the GPU comparison covers hover and press emphasis', () => {
    const full = fullPrepared()
    const fullPaint = paintTables(thread, full.tables, fakeTextWidth)
    const states = gpuStates(full)
    expect(states.map(state => state.name)).toEqual(['settled-hover-level-2', 'animated-peek-seed-6'])
    for (const {state, inputs} of states) {
      const {frame} = referenceFrame(full, state, inputs, 0, 'none')
      const raster = rasterize(geometryFromReference(frame), full.tables, fullPaint, 'bars', gpuGrid, 0.05)
      let banner = 0
      let gutter = 0
      for (let sample = 0; sample < raster.layer.length; sample++) {
        if (raster.emphasis[sample] !== 1 || raster.ambiguous[sample] === 1) continue
        if (raster.layer[sample] === paintLayer.gutter) gutter++
        else banner++
      }
      expect(gutter).toBeGreaterThan(100)
      // Hovering a gutter emphasizes only the gutter; pressing it (peeking) also emphasizes the pressed comment's banner.
      if (frame.global.peeking === 1) expect(banner).toBeGreaterThan(1000)
      else expect(banner).toBe(0)
    }
  })

  test('the generated instance loop matches the reference evaluator on samples of every paint layer, for every variant', () => {
    // A press on the gutter of a comment at indent 2 or deeper. With seed 4 the pressed comment's banner is in the window,
    // so emphasized banner, label and gutter samples are among the picks.
    const windowWidth = 900
    const state = initialThreadState(small, windowWidth)
    const deepRows = small.tables.indents.flatMap((indent, row) => indent >= 2 ? [row] : [])
    const random = seededRandom(4)
    const pressedRow = deepRows[Math.floor(random() * deepRows.length)]!
    const inputs = targetedInputs(small, random, state, pressedRow, 'gutter', windowWidth, 700)
    // Every 8th pixel, plus one column through every gutter line, which is 1px wide and falls between the 8px samples.
    const containerLeft = (windowWidth - containerWidthF(windowWidth)) / 2
    const pairs: number[] = []
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 120; x++) pairs.push(0.5 + 8 * x, 0.5 + 8 * y)
      for (let level = 0; level <= small.tables.maxIndent; level++) pairs.push(containerLeft + level * threadLayout.indentWidth + 0.5, 0.5 + 8 * y)
    }
    const sampleCenters = Float32Array.from(pairs)
    const sampleCount = sampleCenters.length / 2
    for (const variant of variants) {
      const machine = createPixelMachine(small, smallPaint, variant, state, variant.text === 'glyphs' ? smallGlyphText : undefined)
      machine.setInputs(inputs)
      const outputs = new Float32Array(sampleCount * pixelOutputField.size)
      machine.draw(sampleCenters, sampleCount, outputs)
      // The first 3 samples of each paint layer without emphasis, and the first 2 of each layer with emphasis.
      const perLayer = Array<number>(8).fill(0)
      const emphasizedPerLayer = Array<number>(8).fill(0)
      const picked: number[] = []
      for (let sample = 0; sample < sampleCount; sample++) {
        const layer = outputs[sample * pixelOutputField.size + pixelOutputField.layer]!
        const counts = outputs[sample * pixelOutputField.size + pixelOutputField.emphasis] === 1 ? emphasizedPerLayer : perLayer
        const limit = counts === emphasizedPerLayer ? 2 : 3
        if (counts[layer]! >= limit) continue
        counts[layer] = counts[layer]! + 1
        picked.push(sample)
      }
      expect(perLayer).toEqual([3, 3, 3, 3, 3, 3, 3, 3])
      expect(emphasizedPerLayer).toEqual([0, 0, 0, 0, 0, 2, 2, 2])
      for (const sample of picked) {
        const table = new Float32Array(machine.source)
        table[machine.pixel.pixelXCell] = sampleCenters[sample * 2]!
        table[machine.pixel.pixelYCell] = sampleCenters[sample * 2 + 1]!
        const values = machine.built.circuit.evaluateReference(table)
        machine.pixel.outputs.forEach((wire, field) => {
          if (!Object.is(values[wire], outputs[sample * pixelOutputField.size + field])) {
            throw new Error(`${variant.rowLookup} ${variant.text}: sample ${sample} output ${field}, reference evaluator ${values[wire]}, instance loop ${outputs[sample * pixelOutputField.size + field]}`)
          }
        })
      }
    }
  })
})

describe('WGSL', () => {
  test('emitted shaders, with and without the max guard, interpreted with strict f32 rounding, reproduce the CPU outputs', () => {
    const shaderGrid = {width: 24, height: 15, stride: 40, offset: 7.25}
    const shaderCount = shaderGrid.width * shaderGrid.height
    const shaderCenters = pixelCenters(shaderGrid.width, shaderGrid.height, shaderGrid.stride, shaderGrid.offset)
    for (const variant of variants) {
      const machine = machineFor(variant)
      machine.setInputs({windowWidth: 1000, windowHeight: 760, scrollTopReal: 1500.5, pointerX: 140.5, pointerY: 420.25, pointerDown: 1, click: 0})
      const cpu = new Float32Array(shaderCount * pixelOutputField.size)
      machine.draw(shaderCenters, shaderCount, cpu)
      for (const guard of ['none', 'max'] as const) {
        const module = emitInstanceWgsl(machine.plan, {guard})
        if (variant.rowLookup === 'binary-search') expect(module.exposure.indexReads).toBeGreaterThan(10)
        const interpreted = new Float32Array(cpu.length)
        createWgslInterpreter(module.code)(packSharedBuffer(module, machine.runner), shaderCenters, shaderCount, interpreted)
        for (let index = 0; index < cpu.length; index++) if (!(interpreted[index] === cpu[index])) throw new Error(`${variant.rowLookup} ${variant.text}, guard ${guard}: output ${index} interpreted ${interpreted[index]}, CPU ${cpu[index]}`)
      }
    }
  })

  test('the fragment stage has the compute body, with the pixel cells from @builtin(position) and a color return', () => {
    const machine = machineFor({rowLookup: 'binary-search', text: 'glyphs'})
    const compute = emitInstanceWgsl(machine.plan, {guard: 'max'})
    const fragment = emitInstanceWgsl(machine.plan, {guard: 'max', stage: 'fragment'})
    // Value lines only: `let v12`, `let p12`, `var v12`, and gather switches. The pixel cells' lines differ on purpose.
    const body = (code: string) => code.split('\n').filter(line => /^(let [vp]\d|var v\d|switch |case \d|default:)/.test(line) && !line.includes('instance_sources') && !line.includes('position.'))
    expect(body(fragment.code)).toEqual(body(compute.code))
    expect(fragment.code).toContain('@fragment')
    expect(fragment.code).toContain('position.x * pixel_scale')
    expect(fragment.code).not.toContain('instance_outputs')
    expect(fragment.sharedLength).toBe(compute.sharedLength)
  })
})
