// IndirectOS committed per event. With ?presenter=keyframes (the default), every
// commit predicts all 301 samples and hands them to Web Animations, and a timer
// runs the settle commit. With ?presenter=frames, requestAnimationFrame runs a
// display evaluation per frame while something animates. The logic lives in
// demo-model.ts, keyframes.ts and prediction.ts; this file wires the DOM.
import {invariant} from '../../../numeric-ui-core.ts'
import {type Presenter, createEventTimeScene, discreteStyles, displayRow, predictionRow} from './demo-model.ts'
import {type KeyframePlan, type Track, type TrackPart, animationTiming, keyframeStyle, trackKeyframes, trackValues} from './keyframes.ts'
import {itemCount as photoCount, photoNames} from './photo-gallery.ts'
import {sourceField, windowCount} from './window-manager.ts'

const parameters = new URLSearchParams(window.location.search)
const presenter: Presenter = parameters.get('presenter') === 'frames' ? 'frames' : 'keyframes'

const scene = createEventTimeScene()
const desktop = document.querySelector<HTMLElement>('#desktop')
const windows = [...document.querySelectorAll<HTMLElement>('.window')]
const dockItems = [...document.querySelectorAll<HTMLElement>('.dock-item')]
const photosViewport = document.querySelector<HTMLElement>('.photos-content')
const backdrop = document.querySelector<HTMLElement>('.photos-backdrop')
const previousControl = document.querySelector<HTMLElement>('.photos-previous')
const nextControl = document.querySelector<HTMLElement>('.photos-next')
const monitor = Object.fromEntries(
  ['commits', 'commit-time', 'prediction', 'rows', 'animated', 'settle', 'presenter'].map(name => [name, document.querySelector<HTMLElement>(`#monitor-${name}`)]),
)
invariant(desktop !== null && photosViewport !== null && backdrop !== null && previousControl !== null && nextControl !== null, 'page structure is missing')
invariant(windows.length === windowCount && dockItems.length === windowCount, 'window or dock node count mismatch')

for (const [variable, field] of [
  ['--title-height', sourceField.titleHeight],
  ['--button-size', sourceField.buttonSize],
  ['--button-gap', sourceField.buttonGap],
  ['--resize-grip', sourceField.resizeGrip],
  ['--dock-height', sourceField.dockHeight],
  ['--system-bar-height', sourceField.systemBarHeight],
] as const) {
  desktop.style.setProperty(variable, `${scene.machine.table[field]}px`)
}
for (const link of document.querySelectorAll<HTMLAnchorElement>('#demo-controls a[data-presenter]')) {
  link.href = `?presenter=${link.dataset['presenter']}`
  link.classList.toggle('selected', link.dataset['presenter'] === presenter)
}

const photoElements = Array<HTMLElement | null>(photoCount).fill(null)
const thumbnailElements = Array<HTMLElement | null>(photoCount).fill(null)
const animations = new Map<HTMLElement, Animation[]>()

function stopAnimations(element: HTMLElement) {
  for (const animation of animations.get(element) ?? []) animation.cancel()
  animations.delete(element)
}

function elementFor(track: Track): HTMLElement {
  switch (track.kind) {
    case 'window': return windows[track.index]!
    case 'previousControl': return previousControl!
    case 'nextControl': return nextControl!
    case 'backdrop': return backdrop!
    default: {
      const list = track.kind === 'photo' ? photoElements : thumbnailElements
      let element = list[track.index] ?? null
      if (element === null) {
        element = document.createElement('div')
        element.className = `${track.kind === 'photo' ? 'photos-photo' : 'photos-thumbnail'} image-${track.index}`
        if (track.kind === 'photo') {
          const title = document.createElement('span')
          title.textContent = photoNames[track.index]!
          element.appendChild(title)
        }
        photosViewport!.appendChild(element)
        list[track.index] = element
      }
      return element
    }
  }
}

function removePhotoElement(track: Track) {
  const list = track.kind === 'photo' ? photoElements : thumbnailElements
  const element = list[track.index] ?? null
  if (element === null) return
  stopAnimations(element)
  element.remove()
  list[track.index] = null
}

function applyStyle(element: HTMLElement, style: Keyframe) {
  for (const [property, value] of Object.entries(style)) {
    if (value === null || value === undefined) continue
    element.style.setProperty(property === 'zIndex' ? 'z-index' : property, String(value))
  }
}

function applyDiscrete(row: ArrayLike<number>) {
  const styles = discreteStyles(scene, row)
  windows.forEach((element, windowIndex) => {
    element.style.setProperty('--focused', styles.windows[windowIndex]!.focused)
    element.style.setProperty('--maximized', styles.windows[windowIndex]!.maximized)
  })
  dockItems.forEach((element, windowIndex) => {
    const dock = styles.dockItems[windowIndex]!
    element.style.left = dock.left
    element.style.top = dock.top
    element.style.width = dock.width
    element.style.height = dock.height
    element.style.setProperty('--inactive', dock.inactive)
    element.style.setProperty('--focused', dock.focused)
    element.style.setProperty('--open', dock.open)
  })
  photoElements.forEach((element, item) => element?.style.setProperty('--focused', styles.photoFocus[item]!))
  thumbnailElements.forEach((element, item) => element?.style.setProperty('--focused', styles.thumbnailFocus[item]!))
}

function startAnimation(element: HTMLElement, track: Track, plan: KeyframePlan, part: TrackPart) {
  const animation = element.animate(trackKeyframes(scene.prediction, plan, track, part), animationTiming(plan))
  // The prediction's sample 0 is on screen from the commit's simulated time,
  // less half a clock grid step (keyframes.ts's planKeyframes), which is on the
  // same clock as event timestamps and document.timeline.
  animation.startTime = plan.startTime
  animations.set(element, [...(animations.get(element) ?? []), animation])
}

let stallArmed = false
function stall(milliseconds: number) {
  const end = performance.now() + milliseconds
  while (performance.now() < end) { /* block the main thread */ }
}

let settleTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSettle() {
  if (settleTimer !== null) clearTimeout(settleTimer)
  settleTimer = null
  const settleTime = scene.committer.nextSettleTime
  if (settleTime === null) return
  settleTimer = setTimeout(() => {
    settleTimer = null
    if (scene.settleUntil(performance.now())) afterCommit()
    else scheduleSettle()
  }, Math.max(0, settleTime - performance.now()))
}

function applyPlan() {
  const {prediction, plan} = scene
  for (const planned of plan.tracks) {
    const {track} = planned
    if (!planned.visible) {
      removePhotoElement(track)
      continue
    }
    const element = elementFor(track)
    stopAnimations(element)
    // The final sample underneath, so a finished or cancelled animation shows it.
    applyStyle(element, keyframeStyle(track.kind, trackValues(prediction, track, plan.lastSample)))
    if (planned.animated.composited) startAnimation(element, track, plan, 'composited')
    if (planned.animated.layout) startAnimation(element, track, plan, 'layout')
  }
  applyDiscrete(predictionRow(prediction, 0))
  scheduleSettle()
  if (stallArmed && plan.animatedTrackCount > 0) {
    stallArmed = false
    document.querySelector('#stall-next')?.classList.remove('armed')
    // A later task, so the compositor has received the animations first.
    setTimeout(() => stall(500), 60)
  }
}

const row = new Float32Array(scene.machine.displayRoots.length)
let frameRequest: number | null = null
function requestFrame() {
  frameRequest ??= window.requestAnimationFrame(renderFrame)
}
function renderFrame(now: number) {
  frameRequest = null
  displayRow(scene, scene.display(now), row)
  for (const track of scene.tracks) {
    const values = track.columns.map(column => row[column]!)
    const photoLike = track.kind === 'photo' || track.kind === 'thumbnail'
    if (photoLike && !(values[2]! > 0 && values[3]! > 0 && values[4]! > 0)) {
      removePhotoElement(track)
      continue
    }
    applyStyle(elementFor(track), keyframeStyle(track.kind, values))
  }
  applyDiscrete(row)
  if (row[scene.layout.animationActive]! > 0) requestFrame()
  updateMonitor()
}

function updateMonitor() {
  const {counts} = scene.committer
  const {plan, predictor, timings} = scene
  const set = (name: string, text: string) => {
    const element = monitor[name]
    if (element !== null && element !== undefined) element.textContent = text
  }
  set('commits', `${counts.event} event · ${counts.settle} settle · ${counts.undoneSettles} undone`)
  set('commit-time', `${timings.lastCommitMicroseconds.toFixed(0)} µs`)
  set('prediction', `${timings.lastPredictionMilliseconds.toFixed(2)} ms · 301 samples`)
  set('rows', `${predictor.plan.counts.sharedRows} shared · ${predictor.plan.counts.instanceRows} per sample`)
  set('animated', `${plan.compositedAnimationCount} composited · ${plan.layoutAnimationCount} layout · ${plan.lastSample + 1} keyframes`)
  const settleTime = scene.committer.nextSettleTime
  set('settle', settleTime === null ? 'idle' : `in ${Math.max(0, settleTime - performance.now()).toFixed(0)} ms`)
  set('presenter', presenter === 'keyframes' ? 'predicted keyframes' : 'display frames')
}

function afterCommit() {
  if (presenter === 'keyframes') applyPlan()
  else requestFrame()
  updateMonitor()
}

window.addEventListener('pointerdown', event => {
  scene.pointerDown(event.timeStamp, event.clientX, event.clientY)
  afterCommit()
})
window.addEventListener('pointermove', event => {
  const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : []
  for (const move of coalesced.length > 0 ? coalesced : [event]) scene.pointerMove(move.timeStamp, move.clientX, move.clientY)
  afterCommit()
})
for (const type of ['pointerup', 'pointercancel'] as const) {
  window.addEventListener(type, event => {
    scene.pointerUp(event.timeStamp, event.clientX, event.clientY)
    afterCommit()
  })
}
photosViewport.addEventListener('click', event => {
  scene.photoClick(event.timeStamp, event.offsetX, event.offsetY)
  afterCommit()
})
window.addEventListener('keydown', event => {
  switch (event.key) {
    case 'ArrowLeft': scene.photoPrevious(event.timeStamp); break
    case 'ArrowRight': scene.photoNext(event.timeStamp); break
    case 'Escape': scene.photoClose(event.timeStamp); break
    default: return
  }
  event.preventDefault()
  afterCommit()
})
window.addEventListener('resize', event => {
  scene.resize(event.timeStamp, document.documentElement.clientWidth, document.documentElement.clientHeight)
  afterCommit()
})
document.querySelector('#stall')?.addEventListener('pointerdown', event => {
  event.stopPropagation()
  stall(500)
})
document.querySelector('#stall-next')?.addEventListener('pointerdown', event => {
  event.stopPropagation()
  stallArmed = true
  document.querySelector('#stall-next')?.classList.add('armed')
})

scene.mount(performance.now(), document.documentElement.clientWidth, document.documentElement.clientHeight)
afterCommit()
