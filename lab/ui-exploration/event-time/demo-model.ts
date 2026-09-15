// The demo page's logic without the DOM: IndirectOS committed per event, one
// prediction of all 301 samples per commit, and a keyframe plan per prediction.
// demo.ts only reads plans and writes styles.
import {type Committer, createCommitter} from './commits.ts'
import {type Evaluation, createEventTimeMachine, displayLayout} from './event-machine.ts'
import {type KeyframePlan, createTracks, planKeyframes} from './keyframes.ts'
import {controlField, itemCount as photoCount, photoField} from './photo-gallery.ts'
import {type Prediction, createPredictor} from './prediction.ts'
import {dockOutputField, windowCount, windowOutputField} from './window-manager.ts'

export type Presenter = 'keyframes' | 'frames'

export function createEventTimeScene(options: {evaluator?: 'generated' | 'executor'} = {}) {
  const buildStart = performance.now()
  const machine = createEventTimeMachine({springs: 'source-matrix', evaluator: options.evaluator ?? 'generated'})
  const predictor = createPredictor(machine)
  const buildMilliseconds = performance.now() - buildStart
  const tracks = createTracks(machine)
  const layout = displayLayout(machine)
  let prediction: Prediction | null = null
  let plan: KeyframePlan | null = null
  // Increments on every commit, so the page knows when to replace its animations.
  let version = 0
  const timings = {buildMilliseconds, lastCommitMicroseconds: 0, lastPredictionMilliseconds: 0}

  const commit = machine.commit
  machine.commit = (time: number) => {
    const started = performance.now()
    const evaluation = commit(time)
    timings.lastCommitMicroseconds = (performance.now() - started) * 1000
    return evaluation
  }

  const committer: Committer = createCommitter(machine, {
    settle: 'predicted',
    probe: () => prediction!.settleStep,
    afterCommit() {
      const started = performance.now()
      prediction = predictor.predict()
      plan = planKeyframes(prediction, tracks)
      timings.lastPredictionMilliseconds = performance.now() - started
      version++
    },
  })

  const commitEvents = (time: number, apply: () => void) => committer.commitEvents(time, apply)

  return {
    machine,
    predictor,
    tracks,
    layout,
    committer,
    timings,
    get prediction() {
      return prediction!
    },
    get plan() {
      return plan!
    },
    get version() {
      return version
    },
    mount(time: number, width: number, height: number) {
      machine.setViewport(width, height)
      committer.mount(time)
    },
    resize(time: number, width: number, height: number) {
      commitEvents(time, () => machine.setViewport(width, height))
    },
    pointerDown(time: number, x: number, y: number) {
      commitEvents(time, () => machine.base.pointerDown(x, y))
    },
    pointerMove(time: number, x: number, y: number) {
      commitEvents(time, () => machine.base.pointerMove(x, y))
    },
    pointerUp(time: number, x: number, y: number) {
      commitEvents(time, () => machine.base.pointerUp(x, y))
    },
    photoClick(time: number, x: number, y: number) {
      commitEvents(time, () => machine.base.photoClick(x, y))
    },
    photoNext(time: number) {
      commitEvents(time, () => machine.base.photoNext())
    },
    photoPrevious(time: number) {
      commitEvents(time, () => machine.base.photoPrevious())
    },
    photoClose(time: number) {
      commitEvents(time, () => machine.base.photoClose())
    },
    // Runs settle commits due by `time`. Returns true when the plan changed.
    settleUntil(time: number) {
      const before = version
      committer.settleUntil(time)
      return version !== before
    },
    // A display evaluation for the frame presenter, after due settle commits.
    display(time: number): Evaluation {
      committer.settleUntil(time)
      return machine.display(time)
    },
  }
}

export type EventTimeScene = ReturnType<typeof createEventTimeScene>

// The display roots of one evaluation, in displayRoots order.
export function displayRow(scene: EventTimeScene, evaluation: Evaluation, target = new Float32Array(scene.machine.displayRoots.length)) {
  const positions = scene.machine.displayPositions
  for (let index = 0; index < positions.length; index++) target[index] = evaluation.values[positions[index]!]!
  return target
}

// One sample of a prediction, in displayRoots order.
export function predictionRow(prediction: Prediction, sample: number) {
  return prediction.samples.subarray(sample * prediction.rootCount, (sample + 1) * prediction.rootCount)
}

// Properties that change only at commits: focus and maximized flags, dock item
// geometry and flags, photo focus, and control geometry is keyframed elsewhere.
export function discreteStyles(scene: Pick<EventTimeScene, 'layout'>, row: ArrayLike<number>) {
  const {layout} = scene
  const windows = Array.from({length: windowCount}, (_, windowIndex) => {
    const start = layout.windows + windowIndex * windowOutputField.size
    return {focused: `${row[start + windowOutputField.focused]}`, maximized: `${row[start + windowOutputField.maximized]}`}
  })
  const dockItems = Array.from({length: windowCount}, (_, windowIndex) => {
    const start = layout.dockItems + windowIndex * dockOutputField.size
    return {
      left: `${row[start + dockOutputField.left]}px`,
      top: `${row[start + dockOutputField.top]}px`,
      width: `${row[start + dockOutputField.width]}px`,
      height: `${row[start + dockOutputField.height]}px`,
      inactive: `${row[start + dockOutputField.inactive]}`,
      focused: `${row[start + dockOutputField.focused]}`,
      open: `${row[start + dockOutputField.open]}`,
    }
  })
  const photoFocus = Array.from({length: photoCount}, (_, item) => `${row[layout.photos + item * photoField.size + photoField.focused]}`)
  const thumbnailFocus = Array.from({length: photoCount}, (_, item) => `${row[layout.thumbnails + item * photoField.size + photoField.focused]}`)
  return {windows, dockItems, photoFocus, thumbnailFocus, controlOpacityOffset: controlField.opacity}
}
