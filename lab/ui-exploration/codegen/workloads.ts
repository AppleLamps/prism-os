// The instance-parallel workloads, built once for tests, report.ts,
// gpu-headless.ts and the demo page.
import type {Circuit} from '../../../src/runtime/numeric-ui-core.ts'
import {createCandidateGalleryMachine, sourceField as candidateSourceField} from './candidate-gallery-copy.ts'
import type {TensorProgram} from './codegen.ts'
import {instanceSourceTable, planInstances, type InstancePlan} from './instance.ts'
import {applyInteraction, createHandwiredOSMachine, interactionFrameTime} from './handwired-os-machine.ts'
import {createLifeCalendarCircuit, life, lifeCalendarSource, lifeCellIndices} from './life-calendar.ts'
import {buildRandomCircuit, createRandom, randomSource} from './random-circuit.ts'
import {createSdfShapesCircuit, pixelCenters, sdfShapesSource} from './sdf-shapes.ts'
import {createWindowOwnershipCircuit} from './window-ownership.ts'

export type Workload = {
  name: string
  circuit: Circuit
  program: TensorProgram
  plan: InstancePlan
  // Shared source tables to run, e.g. two pointer positions.
  sharedSources: Float32Array[]
  instanceSources: Float32Array
  count: number
  // Canvas size when the instances are pixels or grid cells.
  width: number
  height: number
  // Instances to leave out of GPU comparisons (non-finite reference values).
  skip?: (sharedIndex: number, instance: number) => boolean
}

// The HandwiredOS source table after the scripted session in
// handwired-os-machine.ts: window 0 moved and resized, window 1 minimized, and
// Photos restored after being maximized.
export function sessionHandwiredOSSource() {
  const machine = createHandwiredOSMachine({evaluator: 'generated', validate: false})
  for (let frame = 0; frame < 240; frame++) {
    applyInteraction(machine, frame)
    machine.step(1280, 800, interactionFrameTime(frame))
  }
  return new Float32Array(machine.source)
}

export function createOwnershipWorkload(handwiredOSSource: Float32Array, width = 1280, height = 800): Workload {
  const ownership = createWindowOwnershipCircuit()
  const program = ownership.circuit.compileTensorProgram(ownership.outputs)
  const pixels = new Float32Array(width * height * 2)
  const viewportWidth = handwiredOSSource[0]!
  const viewportHeight = handwiredOSSource[1]!
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels[(y * width + x) * 2] = (x + 0.5) * viewportWidth / width
      pixels[(y * width + x) * 2 + 1] = (y + 0.5) * viewportHeight / height
    }
  }
  return {
    name: `HandwiredOS ownership map, ${width}×${height} pixels`,
    circuit: ownership.circuit,
    program,
    plan: planInstances(program, ownership.instanceSources, ownership.outputs),
    sharedSources: [handwiredOSSource],
    instanceSources: pixels,
    count: width * height,
    width,
    height,
  }
}

export function createLifeCalendarWorkload(windowWidth = 1440, windowHeight = 900): Workload {
  const calendar = createLifeCalendarCircuit()
  const program = calendar.circuit.compileTensorProgram([...calendar.outputs, ...Object.values(calendar.shared)])
  return {
    name: 'life-calendar, 27,393 cells',
    circuit: calendar.circuit,
    program,
    plan: planInstances(program, calendar.instanceSources, calendar.outputs),
    sharedSources: [lifeCalendarSource(windowWidth, windowHeight, 700, 420, 11_503), lifeCalendarSource(windowWidth, windowHeight, 200, 600, 9000)],
    instanceSources: lifeCellIndices(),
    count: life,
    width: windowWidth,
    height: windowHeight,
  }
}

function candidateGallery() {
  const machine = createCandidateGalleryMachine()
  machine.step(1280, 800)
  const outputs = [...machine.output.selectedLayout, ...machine.output.scores, ...machine.output.thumbnails, ...machine.output.hero, machine.output.heroPresent]
  return {machine, outputs, program: machine.circuit.compileTensorProgram(outputs)}
}

export function createCandidateWidthWorkload(): Workload {
  const {machine, outputs, program} = candidateGallery()
  return {
    name: 'candidate-gallery, 256 viewport widths',
    circuit: machine.circuit,
    program,
    plan: planInstances(program, [candidateSourceField.viewportWidth], outputs),
    sharedSources: [new Float32Array(machine.source)],
    instanceSources: Float32Array.from({length: 256}, (_, index) => 320 + index * 5),
    count: 256,
    width: 256,
    height: 1,
  }
}

export const candidateGridSize = 256

// Width 320..2870 px across, height 240..1770 px down.
export function candidateGridViewport(column: number, row: number) {
  return {viewportWidth: 320 + column * 10, viewportHeight: 240 + row * 6}
}

export function createCandidateGridWorkload(): Workload {
  const {machine, outputs, program} = candidateGallery()
  const size = candidateGridSize
  const sources = new Float32Array(size * size * 2)
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const viewport = candidateGridViewport(column, row)
      sources[(row * size + column) * 2] = viewport.viewportWidth
      sources[(row * size + column) * 2 + 1] = viewport.viewportHeight
    }
  }
  return {
    name: 'candidate-gallery, 256×256 width × height grid',
    circuit: machine.circuit,
    program,
    plan: planInstances(program, [candidateSourceField.viewportWidth, candidateSourceField.viewportHeight], outputs),
    sharedSources: [new Float32Array(machine.source)],
    instanceSources: sources,
    count: size * size,
    width: size,
    height: size,
  }
}

export function createShapesWorkload(width = 560, height = 360, directions = 16): Workload {
  const scene = createSdfShapesCircuit(undefined, directions)
  const program = scene.circuit.compileTensorProgram([...scene.outputs, ...scene.hovers])
  return {
    name: `SDF shapes, ${width}×${height} pixels`,
    circuit: scene.circuit,
    program,
    plan: planInstances(program, scene.instanceSources, scene.outputs),
    sharedSources: [sdfShapesSource(338, 150), sdfShapesSource(262, 300)],
    instanceSources: pixelCenters(width, height),
    count: width * height,
    width,
    height,
  }
}

export function createRandomWorkloads(seeds = 12, count = 256): Workload[] {
  const cellSets = [[4, 5], [0, 1, 2, 3], [0, 1, 2, 3, 7, 9], [8, 11]]
  return Array.from({length: seeds}, (_, index) => {
    const seed = index + 1
    const {circuit, sources, all} = buildRandomCircuit(seed)
    const program = circuit.compileTensorProgram()
    const instanceCells = cellSets[seed % cellSets.length]!
    const plan = planInstances(program, instanceCells, all.filter(wire => wire >= circuit.sourceSize))
    const random = createRandom(seed * 31)
    const instanceSources = new Float32Array(count * instanceCells.length)
    for (let instance = 0; instance < count; instance++) {
      const other = randomSource(random, true)
      instanceCells.forEach((cell, column) => {
        instanceSources[instance * instanceCells.length + column] = other[cell]!
      })
    }
    const sharedSources = [sources[0]!]
    return {
      name: `random circuit ${seed}, ${count} instances`,
      circuit,
      program,
      plan,
      sharedSources,
      instanceSources,
      count,
      width: count,
      height: 1,
      skip: (sharedIndex, instance) => {
        const reference = circuit.evaluateReference(instanceSourceTable(plan, sharedSources[sharedIndex]!, instanceSources, instance))
        return Array.from(program.wireOrder, wire => reference[wire]!).some(value => !Number.isFinite(value))
      },
    }
  })
}

export function buildAllWorkloads(): Workload[] {
  return [
    createOwnershipWorkload(sessionHandwiredOSSource()),
    createLifeCalendarWorkload(),
    createCandidateWidthWorkload(),
    createCandidateGridWorkload(),
    createShapesWorkload(),
    ...createRandomWorkloads(),
  ]
}
