// IndirectOS with a choice of springs and frame pacing, to watch frame-rate
// independence and stall catch-up by hand. Query parameters:
// ?springs=original|split-table|binary-powers|source-table|source-matrix
// &retarget=deferred|doctrine&fps=0|30|10 (0 renders at the display rate)
import type {SpringPowers} from './spring-bank.ts'
import {type WindowManagerOptions, bankOptions, mountWindowManager, originalOptions} from './window-manager.ts'

const parameters = new URLSearchParams(window.location.search)
const springs = (parameters.get('springs') ?? 'split-table') as 'original' | SpringPowers
const retarget = parameters.get('retarget') === 'doctrine' ? 'doctrine' : 'deferred'
const fps = Number(parameters.get('fps') ?? '0')
const options: WindowManagerOptions = springs === 'original' ? originalOptions : {...bankOptions, springs, retarget}

// A window facade whose requestAnimationFrame skips display frames until
// 1000 / fps milliseconds have passed since the last rendered frame.
function createPacedWindow(target: Window, framesPerSecond: number): Window {
  if (!(framesPerSecond > 0)) return target
  let lastRenderedTime = Number.NEGATIVE_INFINITY
  const facade = {
    performance: target.performance,
    addEventListener: target.addEventListener.bind(target),
    requestAnimationFrame(callback: FrameRequestCallback) {
      const tick = (now: number) => {
        if (now - lastRenderedTime >= 1000 / framesPerSecond - 1) {
          lastRenderedTime = now
          callback(now)
        } else {
          target.requestAnimationFrame(tick)
        }
      }
      return target.requestAnimationFrame(tick)
    },
  }
  return facade as unknown as Window
}

const controls = document.querySelector<HTMLElement>('#demo-controls')
if (controls !== null) {
  for (const link of controls.querySelectorAll<HTMLAnchorElement>('a[data-springs], a[data-fps], a[data-retarget]')) {
    const next = new URLSearchParams(parameters)
    if (link.dataset['springs'] !== undefined) next.set('springs', link.dataset['springs'])
    if (link.dataset['fps'] !== undefined) next.set('fps', link.dataset['fps'])
    if (link.dataset['retarget'] !== undefined) next.set('retarget', link.dataset['retarget'])
    link.href = `?${next.toString()}`
    const selected = link.dataset['springs'] === springs
      || link.dataset['fps'] === String(fps)
      || link.dataset['retarget'] === retarget
    link.classList.toggle('selected', selected)
  }
  controls.querySelector('#stall')?.addEventListener('pointerdown', event => {
    event.stopPropagation()
    // Block the main thread, the way a heavy task or a backgrounded tab would.
    const end = performance.now() + 500
    while (performance.now() < end) { /* stall */ }
  })
}

mountWindowManager(document, createPacedWindow(window, fps), options)
