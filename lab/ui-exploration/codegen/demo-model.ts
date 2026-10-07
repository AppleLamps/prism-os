// Everything the demo page does per workload, without the DOM: canvas size,
// how the pointer enters the shared source table, the CPU run, the projection
// to pixels, and a description of what's under the pointer.
import {sourceField as candidateSourceField} from './candidate-gallery-copy.ts'
import {compileInstanceProgram, type InstanceRunner} from './instance.ts'
import {lifeOutputField, lifeSourceField} from './life-calendar.ts'
import {renderCandidateGrid, renderLifeCalendar, renderOwnership, renderShapes} from './render.ts'
import {defaultShapes, sdfOutputField, sdfSourceField} from './sdf-shapes.ts'
import {ownerCode, regionCode} from './window-ownership.ts'
import {
  candidateGridViewport,
  createCandidateGridWorkload,
  createLifeCalendarWorkload,
  createOwnershipWorkload,
  createShapesWorkload,
  sessionHandwiredOSSource,
  type Workload,
} from './workloads.ts'

export type DemoKind = 'shapes' | 'ownership' | 'life' | 'grid'

export const demoTitles: Record<DemoKind, string> = {
  shapes: 'SDF shapes',
  ownership: 'HandwiredOS press map',
  life: 'life-calendar cells',
  grid: 'candidate-gallery layout map',
}

export type DemoModel = {
  kind: DemoKind
  workload: Workload
  sharedSource: Float32Array
  runner: InstanceRunner
  outputs: Float32Array
  width: number
  height: number
  setPointer: (x: number, y: number) => void
  runCpu: () => number
  render: (outputs: Float32Array, pixels: Uint8ClampedArray) => void
  describePointer: (x: number, y: number, outputs: Float32Array) => string
}

const regionNames = Object.fromEntries(Object.entries(regionCode).map(([name, code]) => [code, name])) as Record<number, string>
const layoutNames = ['Cinema', 'Contact', 'Story']

export function createDemoModel(kind: DemoKind): DemoModel {
  const workload = kind === 'shapes'
    ? createShapesWorkload(560, 360)
    : kind === 'ownership'
      ? createOwnershipWorkload(sessionHandwiredOSSource(), 640, 400)
      : kind === 'life' ? createLifeCalendarWorkload(720, 450) : createCandidateGridWorkload()
  const sharedSource = new Float32Array(workload.sharedSources[0]!)
  const runner = compileInstanceProgram(workload.plan, {rowsPerFunction: 128, blockSize: 1024})
  const outputCount = workload.plan.outputs.length
  const outputs = new Float32Array(workload.count * outputCount)
  const sharedValue = (rootIndex: number) => runner.shared[workload.plan.flat.positionOfWire[workload.program.roots[rootIndex]!]!]!
  const outputAt = (x: number, y: number, field: number) => {
    const column = Math.max(0, Math.min(workload.width - 1, Math.floor(x)))
    const row = Math.max(0, Math.min(workload.height - 1, Math.floor(y)))
    return outputs[(row * workload.width + column) * outputCount + field]!
  }
  return {
    kind,
    workload,
    sharedSource,
    runner,
    outputs,
    width: workload.width,
    height: workload.height,
    setPointer(x, y) {
      if (kind === 'shapes') {
        sharedSource[sdfSourceField.pointerX] = x
        sharedSource[sdfSourceField.pointerY] = y
      } else if (kind === 'life') {
        sharedSource[lifeSourceField.pointerX] = x
        sharedSource[lifeSourceField.pointerY] = y
      }
    },
    runCpu() {
      const start = performance.now()
      runner.runShared(sharedSource)
      runner.runInstances(workload.instanceSources, workload.count, outputs)
      return performance.now() - start
    },
    render(result, pixels) {
      if (kind === 'shapes') renderShapes(result, workload.count, pixels)
      else if (kind === 'ownership') renderOwnership(result, workload.count, pixels)
      else if (kind === 'grid') renderCandidateGrid(result, workload.width, outputCount, pixels)
      else {
        // Shared roots follow the per-cell outputs: countX, countY, blockSize,
        // gridFinalSizeX, gridFinalSizeY, gridLeft, gridTop.
        renderLifeCalendar(result, workload.count, sharedValue(lifeOutputField.size + 2), workload.width, workload.height, pixels, sharedValue(lifeOutputField.size + 5), sharedValue(lifeOutputField.size + 6))
      }
    },
    describePointer(x, y, result) {
      if (kind === 'shapes') {
        const owner = result.length === 0 ? 0 : outputAt(x, y, sdfOutputField.owner)
        return owner === 0 ? 'background' : `shape ${owner} of ${defaultShapes.length}`
      }
      if (kind === 'ownership') {
        const owner = outputAt(x, y, 0)
        const region = outputAt(x, y, 1)
        if (owner === ownerCode.desktop) return 'desktop: a press here changes nothing'
        if (owner >= ownerCode.firstDockItem) return `dock item ${owner - ownerCode.firstDockItem + 1}`
        return `window ${owner}, ${regionNames[region] ?? `regions ${region}`}`
      }
      if (kind === 'grid') {
        const column = Math.floor(x)
        const row = workload.height - 1 - Math.floor(y)
        const viewport = candidateGridViewport(column, row)
        const base = (row * workload.width + column) * outputCount
        const winner = [0, 1, 2].find(layout => result[base + layout] === 1) ?? 0
        return `${viewport.viewportWidth}×${viewport.viewportHeight}: ${layoutNames[winner]} (score ${result[base + 3 + winner]?.toFixed(3)})`
      }
      let hovered = -1
      for (let cell = 0; cell < workload.count; cell++) {
        if (result[cell * outputCount + lifeOutputField.hovered] === 1) hovered = cell
      }
      return hovered < 0 ? 'no cell under the pointer' : `day ${hovered}, row ${result[hovered * outputCount + lifeOutputField.row]}, column ${result[hovered * outputCount + lifeOutputField.column]}`
    },
  }
}

export {candidateSourceField}
