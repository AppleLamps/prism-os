// DOM and WebGPU wiring for demo.html: the HN thread drawn per pixel into a canvas.
// All per-frame logic is in demo-model.ts, which the tests exercise headlessly; this
// file only reads events, sizes canvases, and hands the shared buffer to the GPU.
// pretext measures with the browser's canvas here, and the glyph atlas is rendered
// by the browser, so glyphs sit where pretext put them with the browser's font.
// Nobody has looked at this page in a browser yet (no browser automation was allowed).
import atlasJson from './glyph-atlas.json'
import {thread} from '../hn-thread/hn-data.ts'
import {atlasFromCoverage, createDemoModel, demoVariants, type DemoModel, type DemoVariant} from './demo-model.ts'
import type {GlyphAtlasJson} from './text-table.ts'
import {cursorNames, type FrameInputs} from './thread-frame.ts'

// The spec's flag values; not every runtime defines the global namespaces.
const bufferUsage = {COPY_DST: 0x0008, STORAGE: 0x0080} as const

const gpuCanvas = document.querySelector<HTMLCanvasElement>('#gpu-canvas')!
const cpuCanvas = document.querySelector<HTMLCanvasElement>('#cpu-canvas')!
const statsNode = document.querySelector<HTMLPreElement>('#stats')!
const variantSelect = document.querySelector<HTMLSelectElement>('#variant')!
const backendSelect = document.querySelector<HTMLSelectElement>('#backend')!
for (const variant of demoVariants) variantSelect.append(new Option(variant.title, variant.name))

const measureContext = new OffscreenCanvas(1, 1).getContext('2d')!
const measure = (text: string, font: string) => {
  measureContext.font = font
  return measureContext.measureText(text).width
}

// The atlas's characters, rendered by this browser at 11px into the same 12×14 cells.
function browserAtlas(): GlyphAtlasJson {
  const json = atlasJson as GlyphAtlasJson
  const cell = new OffscreenCanvas(json.cellWidth, json.cellHeight)
  const context = cell.getContext('2d', {willReadFrequently: true})!
  context.font = '11px Verdana, Geneva, sans-serif'
  return atlasFromCoverage(Object.keys(json.glyphs), json.cellWidth, json.cellHeight, character => {
    context.clearRect(0, 0, json.cellWidth, json.cellHeight)
    context.fillStyle = 'black'
    context.fillText(character, 0, 11)
    const data = context.getImageData(0, 0, json.cellWidth, json.cellHeight).data
    return Uint8ClampedArray.from({length: json.cellWidth * json.cellHeight}, (_, index) => data[index * 4 + 3]!)
  })
}

const fullscreenTriangle = `
@vertex
fn main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  return vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}
`

type GpuDrawer = {draw: (shared: Float32Array) => void, compileMilliseconds: number}

let device: GPUDevice | null = null
async function createGpuDrawer(model: DemoModel): Promise<GpuDrawer | null> {
  if (device === null) return null
  const context = gpuCanvas.getContext('webgpu') as GPUCanvasContext | null
  if (context === null) return null
  const gpu = device
  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({device: gpu, format, alphaMode: 'opaque'})
  const start = performance.now()
  gpu.pushErrorScope('validation')
  const pipeline = await gpu.createRenderPipelineAsync({
    layout: 'auto',
    vertex: {module: gpu.createShaderModule({code: fullscreenTriangle}), entryPoint: 'main'},
    fragment: {module: gpu.createShaderModule({code: model.fragment.code}), entryPoint: 'main', targets: [{format}]},
    primitive: {topology: 'triangle-list'},
  })
  const error = await gpu.popErrorScope()
  if (error !== null) throw new Error(`WebGPU: ${error.message}`)
  const compileMilliseconds = performance.now() - start
  const sharedBuffer = gpu.createBuffer({size: model.fragment.sharedLength * 4, usage: bufferUsage.STORAGE | bufferUsage.COPY_DST})
  const bindGroup = gpu.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: sharedBuffer}}]})
  return {
    compileMilliseconds,
    draw(shared) {
      gpu.queue.writeBuffer(sharedBuffer, 0, shared)
      const encoder = gpu.createCommandEncoder()
      const pass = encoder.beginRenderPass({colorAttachments: [{view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: {r: 0, g: 0, b: 0, a: 1}}]})
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.draw(3)
      pass.end()
      gpu.queue.submit([encoder.finish()])
    },
  }
}

if ('gpu' in navigator) {
  const adapter = await navigator.gpu.requestAdapter()
  if (adapter !== null) device = await adapter.requestDevice()
}
if (device === null) backendSelect.value = 'cpu'

const atlas = browserAtlas()
let model: DemoModel | null = null
let drawer: GpuDrawer | null = null
const inputs: FrameInputs = {windowWidth: innerWidth, windowHeight: innerHeight, scrollTopReal: 0, pointerX: -1000, pointerY: -1000, pointerDown: 0, click: 0}
let scheduled = false
let busy = false
let frameMilliseconds = 0

async function selectVariant(variant: DemoVariant) {
  busy = true
  statsNode.textContent = `Building ${variant}…`
  await new Promise(resolve => setTimeout(resolve, 0))
  const next = createDemoModel(thread, variant, measure, atlas, innerWidth)
  model = next
  drawer = null
  if (backendSelect.value === 'webgpu') {
    statsNode.textContent = `Compiling the ${next.fragment.statementCount}-statement fragment shader…`
    try {
      drawer = await createGpuDrawer(next)
    } catch (error) {
      statsNode.textContent = String(error)
      backendSelect.value = 'cpu'
    }
  }
  busy = false
  schedule()
}

function schedule() {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(render)
}

function render() {
  scheduled = false
  if (busy || model === null) return
  const useGpu = backendSelect.value === 'webgpu' && drawer !== null
  gpuCanvas.hidden = !useGpu
  cpuCanvas.hidden = useGpu
  inputs.windowWidth = innerWidth
  inputs.windowHeight = innerHeight
  const start = performance.now()
  const shared = model.frame(inputs, devicePixelRatio)
  const sharedMilliseconds = performance.now() - start
  if (useGpu) {
    const width = Math.round(innerWidth * devicePixelRatio)
    const height = Math.round(innerHeight * devicePixelRatio)
    if (gpuCanvas.width !== width || gpuCanvas.height !== height) {
      gpuCanvas.width = width
      gpuCanvas.height = height
    }
    drawer!.draw(shared)
  } else {
    const stride = 2
    const width = Math.floor(innerWidth / stride)
    const height = Math.floor(innerHeight / stride)
    if (cpuCanvas.width !== width || cpuCanvas.height !== height) {
      cpuCanvas.width = width
      cpuCanvas.height = height
    }
    const context = cpuCanvas.getContext('2d')!
    const image = context.createImageData(width, height)
    model.drawCpu(innerWidth, innerHeight, stride, image.data)
    context.putImageData(image, 0, 0)
  }
  model.commit()
  inputs.click = 0
  frameMilliseconds = frameMilliseconds * 0.8 + (performance.now() - start) * 0.2
  const {machine} = model
  document.body.style.cursor = cursorNames[machine.global('cursorCode')] ?? ''
  statsNode.textContent = [
    `${demoVariants.find(entry => entry.name === model!.variant)!.title}`,
    `${(machine.program.valueCount - machine.program.sourceSize).toLocaleString()} live operations, ${machine.program.layers.length} layers, ${machine.program.sourceSize.toLocaleString()} source cells`,
    `thread logic ${machine.plan.counts.sharedRows.toLocaleString()} rows once per frame; per pixel ${machine.plan.counts.instanceRows} rows, ${machine.plan.counts.instanceLayers} layers`,
    `fragment shader ${model.fragment.statementCount.toLocaleString()} statements, ${model.fragment.exposure.guards.toLocaleString()} guards${drawer !== null ? `, compiled in ${drawer.compileMilliseconds.toFixed(0)}ms` : ''}`,
    `setup ${model.setupMilliseconds.toFixed(0)}ms; frame ${frameMilliseconds.toFixed(1)}ms (thread logic ${sharedMilliseconds.toFixed(1)}ms), ${useGpu ? 'GPU' : 'CPU'}`,
    machine.textTables() !== null ? `text layout on width change ${machine.textLayoutMilliseconds().toFixed(1)}ms` : '',
  ].filter(line => line !== '').join('\n')
  if (machine.global('scheduleNextRender') === 1) schedule()
}

const onPanel = (event: Event) => event.target instanceof Element && event.target.closest('.panel') !== null
window.addEventListener('resize', schedule)
window.addEventListener('wheel', (event: WheelEvent) => {
  if (model === null) return
  inputs.scrollTopReal = Math.min(Math.max(0, inputs.scrollTopReal + event.deltaY), model.maximumScrollTop())
  schedule()
}, {passive: true})
window.addEventListener('pointermove', (event: PointerEvent) => {
  inputs.pointerX = event.clientX
  inputs.pointerY = event.clientY
  schedule()
})
window.addEventListener('pointerdown', (event: PointerEvent) => {
  if (onPanel(event)) return
  inputs.pointerDown = 1
  schedule()
})
window.addEventListener('pointerup', () => {
  inputs.pointerDown = 0
  schedule()
})
window.addEventListener('click', (event: MouseEvent) => {
  if (onPanel(event)) return
  inputs.click = 1
  inputs.pointerX = event.clientX
  inputs.pointerY = event.clientY
  schedule()
})
variantSelect.addEventListener('change', () => void selectVariant(variantSelect.value as DemoVariant))
backendSelect.addEventListener('change', () => {
  if (model !== null) void selectVariant(model.variant)
})

await selectVariant('binary-search-glyphs')
