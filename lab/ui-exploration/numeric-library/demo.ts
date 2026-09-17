// DOM projection of workload.ts. All layout, falloff, trigonometry, hashing, and
// decisions happen in the circuit; this file writes latches and styles.
import {measureProgram} from './measure.ts'
import {createWorkloadCircuit, iconCount, tickCount, workloadField, workloadRoots} from './workload.ts'

function mount(document: Document, window: Window) {
  const {circuit, output} = createWorkloadCircuit()
  const roots = workloadRoots(output)
  const size = measureProgram(circuit, roots)
  const run = circuit.createTensorEvaluator(roots)
  const source = new Float32Array(workloadField.size)
  const startTime = window.performance.now()

  const stats = document.querySelector<HTMLElement>('#stats')!
  const head = document.querySelector<HTMLElement>('#head')!
  const percent = document.querySelector<HTMLElement>('#percent')!
  const icons = Array.from({length: iconCount}, (_, icon) => {
    const element = document.createElement('div')
    element.className = 'icon'
    element.style.background = `hsl(${(icon * 40) % 360} 65% 58%)`
    document.body.appendChild(element)
    return element
  })
  const ticks = Array.from({length: tickCount}, () => {
    const element = document.createElement('div')
    element.className = 'tick'
    document.body.appendChild(element)
    return element
  })
  stats.innerHTML = `Dock magnification and a progress ring from one circuit: <strong>${size.liveOperations.toLocaleString('en-US')}</strong> live operations, <strong>${size.layers}</strong> layers, <strong>${size.storedWeights.toLocaleString('en-US')}</strong> stored weights. Move the pointer near the dock.`

  window.addEventListener('pointermove', event => {
    source[workloadField.pointerX] = event.clientX
    source[workloadField.pointerY] = event.clientY
    source[workloadField.pointerInside] = 1
  })
  document.documentElement.addEventListener('pointerleave', () => {
    source[workloadField.pointerInside] = 0
  })

  function render(now: number) {
    // Times are latched relative to page load, so FP32 keeps millisecond resolution.
    // The first frame's timestamp can be earlier than startTime, so a negative time counts as 0,
    // which keeps progress within its declared 0..1 and seconds within 0..16,384.
    const seconds = Math.max(0, now - startTime) / 1000
    source[workloadField.viewportWidth] = Math.max(320, document.documentElement.clientWidth)
    source[workloadField.viewportHeight] = Math.max(240, document.documentElement.clientHeight)
    source[workloadField.progress] = (seconds % 8) / 8
    source[workloadField.seconds] = seconds % 16_384
    const values = run(source)
    let offset = 0
    const take = () => values[offset++]!
    const iconLeft = Array.from({length: iconCount}, take)
    const iconTop = Array.from({length: iconCount}, take)
    const iconSize = Array.from({length: iconCount}, take)
    const nearest = Array.from({length: iconCount}, take)
    for (let icon = 0; icon < iconCount; icon++) {
      const element = icons[icon]!
      element.style.width = `${iconSize[icon]}px`
      element.style.height = `${iconSize[icon]}px`
      element.style.transform = `translate3d(${iconLeft[icon]}px,${iconTop[icon]}px,0)`
      element.dataset['nearest'] = `${nearest[icon]}`
    }
    const headX = take()
    const headY = take()
    head.style.transform = `translate3d(${headX}px,${headY}px,0)`
    const tickX = Array.from({length: tickCount}, take)
    const tickY = Array.from({length: tickCount}, take)
    const tickLit = Array.from({length: tickCount}, take)
    const tickOpacity = Array.from({length: tickCount}, take)
    for (let tick = 0; tick < tickCount; tick++) {
      const element = ticks[tick]!
      element.style.transform = `translate3d(${tickX[tick]}px,${tickY[tick]}px,0)`
      element.style.opacity = `${tickOpacity[tick]}`
      element.dataset['lit'] = `${tickLit[tick]}`
    }
    percent.textContent = `${take()}%`
    percent.style.left = `${source[workloadField.viewportWidth]! - 112}px`
    window.requestAnimationFrame(render)
  }
  window.requestAnimationFrame(render)
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  mount(document, window)
}
