// DOM and WebGPU wiring for demo.html. All per-workload logic lives in
// demo-model.ts, gpu-runner.ts and wgsl.ts, which headless tests cover.
// The same shaders and runner were checked headlessly through Deno (wgpu) and
// Node (Dawn) in gpu-headless.ts, and this page was checked in Chrome later
// (README.md, "Browser check").
import {createDemoModel, demoTitles, type DemoKind, type DemoModel} from './demo-model.ts'
import {compareOutputs, createGpuInstanceRunner, runGpuProbes, type GpuInstanceRunner} from './gpu-runner.ts'
import {emitInstanceWgsl, packSharedBuffer, type Guard, type WgslModule} from './wgsl.ts'

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector)
  if (found === null) throw new Error(`missing element ${selector}`)
  return found
}

const canvas = element<HTMLCanvasElement>('#canvas')
const context = canvas.getContext('2d')
if (context === null) throw new Error('canvas 2D is unavailable')
const pointerOutput = element<HTMLOutputElement>('#pointer')
const counts = element<HTMLDListElement>('#counts')
const frame = element<HTMLDListElement>('#frame')
const probes = element<HTMLTableSectionElement>('#probes')
const status = element<HTMLParagraphElement>('#status')
const guardInput = element<HTMLInputElement>('#guard')

const models = new Map<DemoKind, DemoModel>()
let model: DemoModel = createDemoModel('shapes')
models.set('shapes', model)
let device: GPUDevice | null = null
let gpu: {runner: GpuInstanceRunner, module: WgslModule, kind: DemoKind, guard: Guard} | null = null
let gpuOutputs = new Float32Array(0)
let scheduled = false
let running = false
let pointer = {x: 0, y: 0}

function fill(list: HTMLDListElement, entries: [string, string][]) {
  list.replaceChildren(...entries.flatMap(([term, value]) => {
    const dt = document.createElement('dt')
    dt.textContent = term
    const dd = document.createElement('dd')
    dd.textContent = value
    return [dt, dd]
  }))
}

function selected(name: string) {
  return element<HTMLInputElement>(`input[name="${name}"]:checked`).value
}

function selectModel(kind: DemoKind) {
  let next = models.get(kind)
  if (next === undefined) {
    next = createDemoModel(kind)
    models.set(kind, next)
  }
  model = next
  canvas.width = model.width
  canvas.height = model.height
  const {plan, program} = model.workload
  fill(counts, [
    ['workload', `${demoTitles[kind]}, ${model.workload.count.toLocaleString('en-US')} instances`],
    ['live operations', (program.valueCount - program.sourceSize).toLocaleString('en-US')],
    ['shared rows (once per frame)', plan.counts.sharedRows.toLocaleString('en-US')],
    ['per-instance rows', plan.counts.instanceRows.toLocaleString('en-US')],
    ['per-instance depth', `${plan.counts.instanceLayers} layers`],
  ])
}

async function ensureGpuRunner(guard: Guard) {
  if (device === null) return null
  if (gpu !== null && gpu.kind === model.kind && gpu.guard === guard) return gpu
  gpu?.runner.destroy()
  const module = emitInstanceWgsl(model.workload.plan, {guard})
  const runner = await createGpuInstanceRunner(device, module, model.workload.count)
  await runner.setInstanceSources(model.workload.instanceSources, model.workload.count)
  gpu = {runner, module, kind: model.kind, guard}
  gpuOutputs = new Float32Array(model.outputs.length)
  return gpu
}

async function render() {
  scheduled = false
  if (running) {
    schedule()
    return
  }
  running = true
  try {
    const guard: Guard = guardInput.checked ? 'max' : 'none'
    model.setPointer(pointer.x, pointer.y)
    const cpuMilliseconds = model.runCpu()
    let shown = model.outputs
    const entries: [string, string][] = [['generated JS, shared part and every instance', `${cpuMilliseconds.toFixed(1)} ms`]]
    if (selected('backend') === 'gpu') {
      const active = await ensureGpuRunner(guard)
      if (active === null) {
        entries.push(['WebGPU', 'not available in this browser'])
      } else {
        const {milliseconds} = await active.runner.run(packSharedBuffer(active.module, model.runner), model.workload.count, gpuOutputs)
        const comparison = compareOutputs(gpuOutputs, model.outputs, gpuOutputs.length)
        shown = gpuOutputs
        entries.push(
          ['WebGPU dispatch and readback', `${milliseconds.toFixed(1)} ms`],
          ['shader compile', `${active.runner.compileMilliseconds.toFixed(0)} ms, ${active.module.statementCount} statements, ${active.module.exposure.guards} guards`],
          ['GPU outputs differing from CPU', `${comparison.mismatches.toLocaleString('en-US')} of ${gpuOutputs.length.toLocaleString('en-US')}${comparison.mismatches > 0 ? ` (largest difference ${comparison.maximumDifference.toExponential(2)})` : ''}`],
        )
      }
    }
    fill(frame, entries)
    const image = context!.createImageData(model.width, model.height)
    model.render(shown, image.data)
    context!.putImageData(image, 0, 0)
    pointerOutput.textContent = model.describePointer(pointer.x, pointer.y, shown)
  } catch (error) {
    status.textContent = String(error)
  } finally {
    running = false
  }
}

function schedule() {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(() => void render())
}

canvas.addEventListener('pointermove', event => {
  const bounds = canvas.getBoundingClientRect()
  pointer = {x: (event.clientX - bounds.left) * model.width / bounds.width, y: (event.clientY - bounds.top) * model.height / bounds.height}
  schedule()
})
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="workload"]')) {
  input.addEventListener('change', () => {
    selectModel(input.value as DemoKind)
    schedule()
  })
}
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="backend"], #guard')) input.addEventListener('change', schedule)

selectModel(selected('workload') as DemoKind)
pointer = {x: model.width / 2, y: model.height / 2}
if ('gpu' in navigator) {
  const adapter = await navigator.gpu.requestAdapter()
  if (adapter !== null) {
    device = await adapter.requestDevice()
    const results = await runGpuProbes(device)
    const summary = new Map<string, {strict: number, optimized: number}>()
    for (const probe of results) {
      const entry = summary.get(`${probe.kind}, ${probe.form}`) ?? {strict: 0, optimized: 0}
      if (probe.strict) entry.strict++
      if (probe.optimizedMatch) entry.optimized++
      summary.set(`${probe.kind}, ${probe.form}`, entry)
    }
    probes.replaceChildren(...[...summary].map(([name, entry]) => {
      const row = document.createElement('tr')
      for (const text of [name, String(entry.strict), String(entry.optimized)]) {
        const cell = document.createElement('td')
        cell.textContent = text
        row.append(cell)
      }
      return row
    }))
  }
} else {
  status.textContent = 'This browser has no WebGPU; only generated JS runs.'
}
schedule()
