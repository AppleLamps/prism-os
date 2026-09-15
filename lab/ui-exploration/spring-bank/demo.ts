// Predictive keyframes demo. All logic lives in predictive.ts; this file only
// reads the viewport and events, and writes Web Animations.
import {
  type PredictionMode,
  animationTiming,
  createPredictiveScene,
  keyframesForBox,
  predictiveBoxSize,
  predictiveLanesPerBox,
  predictiveSampleCount,
} from './predictive.ts'

const stage = document.querySelector<HTMLElement>('#stage')
const status = document.querySelector<HTMLElement>('#status')
const modeSelect = document.querySelector<HTMLSelectElement>('#mode')
if (stage === null || status === null || modeSelect === null) throw new Error('demo markup is missing')

const scene = createPredictiveScene('split-table')
const colors = ['#ff6b6b', '#4ecdc4', '#ffe66d', '#a78bfa', '#60a5fa']
const nodes = Array.from({length: scene.boxCount}, (_, box) => {
  const node = document.createElement('div')
  node.className = 'box'
  node.style.width = `${predictiveBoxSize.width}px`
  node.style.height = `${predictiveBoxSize.height}px`
  node.style.background = colors[box % colors.length]!
  stage.appendChild(node)
  return node
})
let animations: Animation[] = []
let scheduledTimeout: ReturnType<typeof setTimeout> | null = null
let pendingFling = false
const sizeText = (program: {valueCount: number, sourceSize: number, layers: {weights: Float32Array}[]}) =>
  `${program.valueCount - program.sourceSize} live ops, ${program.layers.length} layers, ${program.layers.reduce((total, layer) => total + layer.weights.length, 0)} weights`

function render(now: number) {
  scheduledTimeout = null
  const viewportWidth = document.documentElement.clientWidth
  const viewportHeight = document.documentElement.clientHeight
  if (pendingFling) {
    scene.fling(viewportWidth, viewportHeight)
    pendingFling = false
  }
  for (const animation of animations) animation.cancel()
  const mode = modeSelect!.value as PredictionMode
  const {samples, animationActive, microsecondsPerSample} = scene.render(now, mode)
  const timing = animationTiming(predictiveSampleCount)
  animations = nodes.map((node, box) =>
    node.animate(keyframesForBox(samples, scene.machine.laneCount, box * predictiveLanesPerBox, predictiveBoxSize), timing))
  status!.textContent = `${predictiveSampleCount} samples, ${mode}: ${microsecondsPerSample.toFixed(1)} µs per sample`
    + ` · bank: ${sizeText(scene.machine.program)} · batch: ${sizeText(scene.batch.program)}`
  // Deliberately slow render loop, as in vibescript's predictive-keyframes demo:
  // motion stays smooth because the compositor plays the predicted frames.
  if (animationActive) scheduleRender(300)
}

function scheduleRender(delay: number) {
  if (scheduledTimeout !== null) return
  scheduledTimeout = setTimeout(() => requestAnimationFrame(render), delay)
}

scene.arrange(document.documentElement.clientWidth, document.documentElement.clientHeight)
window.addEventListener('pointerdown', event => {
  if (event.target === modeSelect) return
  pendingFling = true
  if (scheduledTimeout !== null) clearTimeout(scheduledTimeout)
  scheduledTimeout = null
  requestAnimationFrame(render)
})
requestAnimationFrame(render)
