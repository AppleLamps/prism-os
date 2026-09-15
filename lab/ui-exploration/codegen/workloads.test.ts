import {expect, test} from 'bun:test'
import {compileInstanceProgram, createBatchedExecutor, planInstances} from './instance.ts'
import {applyInteraction, createIndirectOSMachine, interactionFrameTime} from './indirect-os-machine.ts'
import {createLifeCalendarCircuit, life, lifeCalendarSource, lifeCellIndices, lifeOutputField, referenceLifeCalendar} from './life-calendar.ts'
import {createSdfShapesCircuit, defaultShapes, referenceShapeDistance, referenceShapesPixel, sdfOutputField, sdfShapesSource} from './sdf-shapes.ts'
import {createWindowOwnershipCircuit, referenceOwnership} from './window-ownership.ts'

test('the per-pixel ownership map matches an independent stack walk on a live IndirectOS source table', () => {
  const machine = createIndirectOSMachine({evaluator: 'generated', validate: false})
  for (let frame = 0; frame < 240; frame++) {
    applyInteraction(machine, frame)
    machine.step(1280, 800, interactionFrameTime(frame))
  }
  const ownership = createWindowOwnershipCircuit()
  const program = ownership.circuit.compileTensorProgram(ownership.outputs)
  const plan = planInstances(program, ownership.instanceSources, ownership.outputs)
  expect(plan.counts.sharedRows).toBeGreaterThan(50)
  const width = 320
  const height = 200
  const count = width * height
  const pixels = new Float32Array(count * 2)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels[(y * width + x) * 2] = x * 4 + 0.5
      pixels[(y * width + x) * 2 + 1] = y * 4 + 0.5
    }
  }
  const owners = new Set<number>()
  for (const runner of [compileInstanceProgram(plan, {rowsPerFunction: 128, blockSize: 512}), createBatchedExecutor(plan, 512)]) {
    const outputs = new Float32Array(count * 2)
    runner.runShared(machine.source)
    runner.runInstances(pixels, count, outputs)
    let mismatches = 0
    for (let pixel = 0; pixel < count; pixel++) {
      const expected = referenceOwnership(machine.source, pixels[pixel * 2]!, pixels[pixel * 2 + 1]!)
      owners.add(expected.owner)
      if (outputs[pixel * 2] !== expected.owner || outputs[pixel * 2 + 1] !== expected.region) mismatches++
    }
    expect(mismatches).toBe(0)
  }
  // The map covers desktop, windows and dock items.
  expect(owners.size).toBeGreaterThan(4)
})

test('life-calendar cells match the demo formulas for every cell, and the row formula is exact for every cell and column count', () => {
  // The per-cell row: round(week · fround(1/m) - fround((m - 1) / (2m))) with
  // ties to even, replayed in plain FP32 arithmetic for all 27,393 cells and
  // all 140 column counts.
  const round = (value: number) => Math.fround(Math.fround(value + 12_582_912) - 12_582_912)
  let rowMismatches = 0
  for (let m = 1; m <= 140; m++) {
    const reciprocal = Math.fround(1 / m)
    const offset = Math.fround((m - 1) / (2 * m))
    for (let cell = 0; cell < life; cell++) {
      const week = Math.floor(cell / 7)
      const row = round(Math.fround(Math.fround(week * reciprocal) - offset))
      if (row !== Math.floor(cell / (7 * m))) rowMismatches++
    }
  }
  expect(rowMismatches).toBe(0)

  const calendar = createLifeCalendarCircuit()
  const program = calendar.circuit.compileTensorProgram([...calendar.outputs, ...Object.values(calendar.shared)])
  const plan = planInstances(program, calendar.instanceSources, calendar.outputs)
  expect(plan.counts.instanceRows).toBeLessThan(80)
  const runner = compileInstanceProgram(plan, {rowsPerFunction: 128, blockSize: 2048})
  const outputs = new Float32Array(life * lifeOutputField.size)
  const cells = lifeCellIndices()
  for (const [windowWidth, windowHeight, pointerX, pointerY] of [[1440, 900, 700, 420], [390, 844, 200, 600]] as const) {
    const age = 11_503
    const reference = referenceLifeCalendar(windowWidth, windowHeight, pointerX, pointerY, age)
    runner.runShared(lifeCalendarSource(windowWidth, windowHeight, pointerX, pointerY, age))
    runner.runInstances(cells, life, outputs)
    let integerMismatches = 0
    let hovered = 0
    let maximumPositionError = 0
    for (let cell = 0; cell < life; cell++) {
      const expected = reference.cell(cell)
      for (let field = 0; field < lifeOutputField.size; field++) {
        const actual = outputs[cell * lifeOutputField.size + field]!
        if (field === lifeOutputField.x || field === lifeOutputField.y) {
          maximumPositionError = Math.max(maximumPositionError, Math.abs(actual - expected[field]!))
        } else if (actual !== expected[field]) {
          integerMismatches++
        }
      }
      hovered += outputs[cell * lifeOutputField.size + lifeOutputField.hovered]!
    }
    expect(integerMismatches).toBe(0)
    expect(hovered).toBe(1)
    expect(maximumPositionError).toBeLessThan(5e-4)
  }

  // Grid sizing through the shared part alone, over a sweep of viewports.
  let sizingMismatches = 0
  let viewports = 0
  for (let windowWidth = 328; windowWidth <= 3848; windowWidth += 37) {
    for (let windowHeight = 328; windowHeight <= 2168; windowHeight += 41) {
      const reference = referenceLifeCalendar(windowWidth, windowHeight, 0, 0, 0)
      if (reference.countX / 7 > 140) continue
      runner.runShared(lifeCalendarSource(windowWidth, windowHeight, 0, 0, 0))
      viewports++
      if (runner.shared[plan.flat.positionOfWire[calendar.shared.countX]!] !== reference.countX
        || runner.shared[plan.flat.positionOfWire[calendar.shared.countY]!] !== reference.countY) sizingMismatches++
    }
  }
  expect(viewports).toBeGreaterThan(3000)
  expect(sizingMismatches).toBe(0)
})

test('SDF shapes: exact frontmost bits away from edges, colors within 3/255 of float64 shading', () => {
  const scene = createSdfShapesCircuit()
  const program = scene.circuit.compileTensorProgram([...scene.outputs, ...scene.hovers])
  const plan = planInstances(program, scene.instanceSources, scene.outputs)
  const width = 140
  const height = 90
  const count = width * height
  const pixels = new Float32Array(count * 2)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels[(y * width + x) * 2] = x * 4 + 0.5
      pixels[(y * width + x) * 2 + 1] = y * 4 + 0.5
    }
  }
  const runner = compileInstanceProgram(plan, {rowsPerFunction: 128, blockSize: 1024})
  for (const [pointerX, pointerY] of [[338, 150], [262, 300]] as const) {
    runner.runShared(sdfShapesSource(pointerX, pointerY))
    const outputs = new Float32Array(count * sdfOutputField.size)
    runner.runInstances(pixels, count, outputs)
    let ownerMismatches = 0
    let maximumColorError = 0
    for (let pixel = 0; pixel < count; pixel++) {
      const x = pixels[pixel * 2]!
      const y = pixels[pixel * 2 + 1]!
      const expected = referenceShapesPixel(defaultShapes, pointerX, pointerY, x, y)
      const base = pixel * sdfOutputField.size
      maximumColorError = Math.max(
        maximumColorError,
        Math.abs(outputs[base + sdfOutputField.red]! - expected.red),
        Math.abs(outputs[base + sdfOutputField.green]! - expected.green),
        Math.abs(outputs[base + sdfOutputField.blue]! - expected.blue),
      )
      const nearEdge = defaultShapes.some(shape => Math.abs(referenceShapeDistance(shape, x, y)) < 0.02)
      if (!nearEdge && outputs[base + sdfOutputField.owner] !== expected.owner) ownerMismatches++
    }
    expect(ownerMismatches).toBe(0)
    expect(maximumColorError).toBeLessThan(3)
  }
})
