// Simulated users. Every number here is authored, not measured from people, so
// results describe what the compiled behavior does to these synthetic hands.
//
// Timing: frames are 16.6875 ms (on the 1/16 ms grid), except janky frames that
// last 3 to 7 normal frames (population.ts decides which). Each user's pointer
// is sampled every 8 ms at a per-user phase, and a sample becomes an event in
// the frame that contains it: a down, an up, or a move when the rounded
// position changed (browsers only send a move when the position changes). The
// circuit takes at most 2 downs per evaluation, so a third down in one frame
// waits for the next sample, as input's JS splitter would split the frame.
//
// Hands: position = intended position + tremor, rounded to whole pixels. Tremor
// is an AR(1) process per axis with a 40 ms correlation time, whose standard
// deviation is the user's tremor amplitude, drawn log-uniform in 0.5..4 px and
// stratified into 4 segments of equal log width. A user's tempo (log-normal,
// median 1) scales every duration.
//
// Tasks, each aimed at what the user's own instance currently displays (its
// state columns after the previous frame's writeback):
// - body click: focus a window by clicking its body;
// - title click: focus a window by clicking its title bar. When the slop latch
//   sets, the window moves a few pixels instead, which counts as a cancelled
//   click;
// - button click: toggle maximize with the button. A cancelled click toggles
//   nothing;
// - double click on a title: two title clicks with a log-normal gap, the second
//   one scattered around the first. Missed when maximize doesn't toggle;
// - two separate title clicks: the same two clicks with a long gap, meant as
//   two single clicks. Accidental when maximize toggles;
// - short nudge: press a title, wait, move 3 to 12 px along one of 8
//   directions, release. Lost when the window doesn't move;
// - long drag: press a title, wait, move 60 to 360 px along a random angle with
//   a minimum-jerk profile, release.
// For nudges and drags, frames to effect counts frames from the frame where the
// intended movement begins to the first frame the window follows the pointer.
// A window that already followed tremor before the movement began counts as 0
// frames and as an early drag.
// A new task's first press on the same window's title comes at least 1,000 ms
// after the previous task's last title press, so tasks can't form double
// clicks with each other.

import {invariant} from '../../../src/runtime/numeric-ui-core.ts'
import type {Population} from './population.ts'

export const frameDuration = 16.6875
export const samplePeriod = 8
export const segmentCount = 4
export const tremorMinimum = 0.5
export const tremorMaximum = 4

export const tremorSegmentBounds = Array.from({length: segmentCount + 1}, (_, index) => tremorMinimum * (tremorMaximum / tremorMinimum) ** (index / segmentCount))

export const taskNames = ['body click', 'title click', 'button click', 'double click', 'two separate title clicks', 'short nudge', 'long drag'] as const
export const task = {bodyClick: 0, titleClick: 1, buttonClick: 2, doubleClick: 3, separateClicks: 4, nudge: 5, longDrag: 6} as const

export type LogNormal = {median: number, logSigma: number}

export type UserModelOptions = {
  groupCount: number
  groupOfUser: Uint32Array
  seed: number
  taskWeights: readonly number[]
  tremorCorrelationMilliseconds: number
  tempoLogSigma: number
  hold: LogNormal
  doubleClickGap: LogNormal
  // Standard deviation per axis of the second press around the first, in px:
  // base + perTremor × tremor.
  secondPressScatter: {base: number, perTremor: number}
  separateClicksGap: LogNormal
  nudgeDistance: readonly [minimum: number, maximum: number]
  nudgeDwell: LogNormal
  nudgeMove: LogNormal
  nudgeSettle: LogNormal
  dragDistance: readonly [minimum: number, maximum: number]
  dragDwell: LogNormal
  dragMove: LogNormal
  dragSettle: LogNormal
  idleMinimumMilliseconds: number
  idle: LogNormal
  sameTitleGuardMilliseconds: number
  // Presses record the largest Chebyshev distance from the press point among
  // moves at most this long after the down, as a histogram per tremor segment.
  holdWindowMilliseconds: number
  // `lateMetrics` only counts tasks that end at or after this frame.
  lateFromFrame: number
}

export const defaultUserModel: Omit<UserModelOptions, 'groupCount' | 'groupOfUser' | 'seed'> = {
  taskWeights: [0.1, 0.15, 0.15, 0.15, 0.1, 0.2, 0.15],
  tremorCorrelationMilliseconds: 40,
  tempoLogSigma: 0.25,
  hold: {median: 95, logSigma: 0.35},
  doubleClickGap: {median: 170, logSigma: 0.35},
  secondPressScatter: {base: 0.5, perTremor: 0.5},
  separateClicksGap: {median: 800, logSigma: 0.4},
  nudgeDistance: [3, 12],
  nudgeDwell: {median: 150, logSigma: 0.4},
  nudgeMove: {median: 160, logSigma: 0.35},
  nudgeSettle: {median: 60, logSigma: 0.4},
  dragDistance: [60, 360],
  dragDwell: {median: 120, logSigma: 0.4},
  dragMove: {median: 450, logSigma: 0.35},
  dragSettle: {median: 50, logSigma: 0.4},
  idleMinimumMilliseconds: 150,
  idle: {median: 250, logSigma: 0.5},
  sameTitleGuardMilliseconds: 1000,
  holdWindowMilliseconds: 100,
  lateFromFrame: 0,
}

// Counters per (group, tremor segment).
export const metric = {
  tasks: 0,
  aimMisses: 1,
  bodyClicks: 2,
  titleClicks: 3,
  cancelledTitleClicks: 4,
  buttonClicks: 5,
  cancelledButtonClicks: 6,
  doubleClicks: 7,
  missedDoubleClicks: 8,
  separateClickPairs: 9,
  accidentalDoubleClicks: 10,
  nudges: 11,
  lostNudges: 12,
  longDrags: 13,
  lostLongDrags: 14,
  nudgeEffectFrames: 15,
  nudgeEffects: 16,
  dragEffectFrames: 17,
  dragEffects: 18,
  doubleClickEffectFrames: 19,
  doubleClickEffects: 20,
  strayToggles: 21,
  events: 22,
  downs: 23,
  presses: 24,
  // Nudges and drags whose window followed the pointer before the intended
  // movement began, because tremor alone crossed the slop.
  earlyNudgeEffects: 25,
  earlyDragEffects: 26,
} as const
export const metricCount = 27

export const histogramBins = 64

type PopulationView = Pick<Population, 'table' | 'outputs' | 'width' | 'outputCount' | 'userCount' | 'config' | 'windowColumns' | 'slotColumns' | 'dragOwnerOutputs'>

export type UserModel = ReturnType<typeof createUserModel>

const compass = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const

function minimumJerk(progress: number) {
  return progress * progress * progress * (10 - 15 * progress + 6 * progress * progress)
}

export function tremorSegmentOf(tremor: number) {
  const scaled = Math.floor(segmentCount * Math.log(tremor / tremorMinimum) / Math.log(tremorMaximum / tremorMinimum))
  return Math.min(segmentCount - 1, Math.max(0, scaled))
}

export function createUserModel(population: PopulationView, partial: Partial<UserModelOptions> & Pick<UserModelOptions, 'groupCount' | 'groupOfUser' | 'seed'>) {
  const options: UserModelOptions = {...defaultUserModel, ...partial}
  const {table, outputs, width, outputCount, userCount, config, windowColumns, slotColumns, dragOwnerOutputs} = population
  const windowCount = config.windows.length
  const capacity = slotColumns.length
  const workspace = config.workspace
  invariant(options.taskWeights.length === taskNames.length, 'one weight per task kind')
  const weightTotal = options.taskWeights.reduce((total, weight) => total + weight, 0)
  const cumulativeWeights = options.taskWeights.map((_, index) => options.taskWeights.slice(0, index + 1).reduce((total, weight) => total + weight, 0) / weightTotal)

  const rng = new Uint32Array(userCount)
  const tremor = new Float64Array(userCount)
  const segment = new Uint8Array(userCount)
  const tempo = new Float64Array(userCount)
  const sampleOffset = new Float64Array(userCount)
  const noiseX = new Float64Array(userCount)
  const noiseY = new Float64Array(userCount)
  const nextSample = new Int32Array(userCount)
  const taskActive = new Uint8Array(userCount)
  const taskKind = new Uint8Array(userCount)
  const taskWindow = new Int8Array(userCount)
  const pressIndex = new Uint8Array(userCount)
  const pressCount = new Uint8Array(userCount)
  const downSample = new Int32Array(userCount * 2)
  const upSample = new Int32Array(userCount * 2)
  const moveStart = new Int32Array(userCount * 2)
  const moveEnd = new Int32Array(userCount * 2)
  const aimX = new Float64Array(userCount * 2)
  const aimY = new Float64Array(userCount * 2)
  const moveX = new Float64Array(userCount * 2)
  const moveY = new Float64Array(userCount * 2)
  const pressed = new Uint8Array(userCount)
  const lastX = new Int32Array(userCount)
  const lastY = new Int32Array(userCount)
  const pressX = new Int32Array(userCount)
  const pressY = new Int32Array(userCount)
  const pressTime = new Float64Array(userCount)
  const holdExcursion = new Int32Array(userCount)
  const startLeft = new Float32Array(userCount)
  const startTop = new Float32Array(userCount)
  const startMaximized = new Float32Array(userCount)
  const downFrame = new Int32Array(userCount).fill(-1)
  const effectFrame = new Int32Array(userCount).fill(-1)
  const moveFrame = new Int32Array(userCount).fill(-1)
  const aimMissed = new Uint8Array(userCount)
  const idleUntil = new Int32Array(userCount)
  const lastTitleWindow = new Int8Array(userCount).fill(-1)
  const lastTitleUpSample = new Int32Array(userCount)
  const endedThisFrame = new Uint8Array(userCount)
  const eventsLastFrame = new Uint8Array(userCount)
  const metrics = new Float64Array(options.groupCount * segmentCount * metricCount)
  const lateMetrics = new Float64Array(options.groupCount * segmentCount * metricCount)
  function add(base: number, index: number, value: number, late: boolean) {
    metrics[base + index]! += value
    if (late) lateMetrics[base + index]! += value
  }
  const excursionHistogram = new Float64Array(segmentCount * histogramBins)
  const maximumEventsPerFrame = {events: 0, downs: 0}
  // User-frames by how many events and how many downs they carried.
  const eventHistogram = new Float64Array(capacity + 1)
  const downHistogram = new Float64Array(3)
  const rho = Math.exp(-samplePeriod / options.tremorCorrelationMilliseconds)
  const innovation = Math.sqrt(1 - rho * rho)

  function random(user: number) {
    let value = rng[user]!
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    rng[user] = value
    return (value >>> 0) / 4294967296
  }
  function gaussian(user: number) {
    const a = Math.max(1e-12, random(user))
    return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * random(user))
  }
  function logNormal(user: number, distribution: LogNormal) {
    return distribution.median * tempo[user]! * Math.exp(distribution.logSigma * gaussian(user))
  }
  const toSamples = (milliseconds: number) => Math.max(1, Math.round(milliseconds / samplePeriod))

  for (let user = 0; user < userCount; user++) {
    rng[user] = (Math.imul(user + 1, 0x9e3779b1) ^ Math.imul(options.seed + 0x632be5ab, 0x85ebca6b)) >>> 0 || 1
    for (let warmup = 0; warmup < 8; warmup++) random(user)
    // Stratified over tremor segments: within any group, users take segments in turn.
    const stratum = Math.floor(user / options.groupCount) % segmentCount
    tremor[user] = tremorMinimum * (tremorMaximum / tremorMinimum) ** ((stratum + random(user)) / segmentCount)
    segment[user] = tremorSegmentOf(tremor[user]!)
    tempo[user] = Math.min(2, Math.max(0.5, Math.exp(options.tempoLogSigma * gaussian(user))))
    sampleOffset[user] = Math.floor(random(user) * samplePeriod * 16) / 16
    noiseX[user] = tremor[user]! * gaussian(user)
    noiseY[user] = tremor[user]! * gaussian(user)
    idleUntil[user] = toSamples(random(user) * 400)
  }

  function displayedLeft(base: number, index: number) {
    return table[base + windowColumns.maximized[index]!] === 1 ? workspace.left : table[base + windowColumns.left[index]!]!
  }
  function displayedTop(base: number, index: number) {
    return table[base + windowColumns.maximized[index]!] === 1 ? workspace.top : table[base + windowColumns.top[index]!]!
  }
  function displayedWidth(base: number, index: number) {
    return table[base + windowColumns.maximized[index]!] === 1 ? workspace.width : config.windows[index]!.width
  }
  function displayedHeight(base: number, index: number) {
    return table[base + windowColumns.maximized[index]!] === 1 ? workspace.height : config.windows[index]!.height
  }
  function frontmost(base: number, x: number, y: number) {
    let hit = -1
    for (let index = 0; index < windowCount; index++) {
      const left = displayedLeft(base, index)
      const top = displayedTop(base, index)
      if (!(x > left && x < left + displayedWidth(base, index) && y > top && y < top + displayedHeight(base, index))) continue
      if (hit === -1 || table[base + windowColumns.rank[index]!]! > table[base + windowColumns.rank[hit]!]!) hit = index
    }
    return hit
  }
  // 0 body, 1 title, 2 button, -1 nothing of window `index`.
  function partAt(base: number, index: number, x: number, y: number) {
    if (frontmost(base, x, y) !== index) return -1
    const left = displayedLeft(base, index)
    const top = displayedTop(base, index)
    if (y - top >= config.titleHeight) return 0
    return x >= left + displayedWidth(base, index) - config.buttonWidth ? 2 : 1
  }
  const partOfTask = (kind: number) => (kind === task.bodyClick ? 0 : kind === task.buttonClick ? 2 : 1)
  const isTitleTask = (kind: number) => partOfTask(kind) === 1

  function aimInPart(user: number, base: number, index: number, part: number) {
    const left = displayedLeft(base, index)
    const top = displayedTop(base, index)
    const right = left + displayedWidth(base, index)
    const bottom = top + displayedHeight(base, index)
    const uniform = (low: number, high: number) => low + random(user) * Math.max(0, high - low)
    if (part === 0) return {x: uniform(left + 16, right - 16), y: uniform(top + config.titleHeight + 12, bottom - 16)}
    if (part === 1) return {x: uniform(left + 12, right - config.buttonWidth - 12), y: uniform(top + 9, top + config.titleHeight - 9)}
    return {x: uniform(right - config.buttonWidth + 9, right - 9), y: uniform(top + 9, top + config.titleHeight - 9)}
  }

  function schedulePress(user: number, press: number, down: number, holdSamples: number, x: number, y: number, dx: number, dy: number, dwellSamples: number, moveSamples: number) {
    const index = user * 2 + press
    downSample[index] = down
    aimX[index] = x
    aimY[index] = y
    moveX[index] = dx
    moveY[index] = dy
    moveStart[index] = down + dwellSamples
    moveEnd[index] = down + dwellSamples + moveSamples
    upSample[index] = down + holdSamples
  }

  // Chooses a task at sample n from what the user's instance displays. Returns
  // false when no window offers a usable target, and the user tries again at
  // the next sample.
  function startTask(user: number, n: number, frame: number) {
    const base = user * width
    const roll = random(user)
    let kind = 0
    while (kind < cumulativeWeights.length - 1 && roll >= cumulativeWeights[kind]!) kind++
    const firstWindow = Math.floor(random(user) * windowCount)
    for (let offset = 0; offset < windowCount; offset++) {
      const index = (firstWindow + offset) % windowCount
      const maximized = table[base + windowColumns.maximized[index]!] === 1
      // Title clicks, nudges and drags need a window that can move, so a
      // cancelled click and a lost drag are both visible as positions.
      if (maximized && (kind === task.titleClick || kind === task.nudge || kind === task.longDrag)) continue
      for (let attempt = 0; attempt < 6; attempt++) {
        const aim = aimInPart(user, base, index, partOfTask(kind))
        if (partAt(base, index, aim.x, aim.y) !== partOfTask(kind)) continue
        let dx = 0
        let dy = 0
        if (kind === task.nudge || kind === task.longDrag) {
          const left = table[base + windowColumns.left[index]!]!
          const top = table[base + windowColumns.top[index]!]!
          if (kind === task.nudge) {
            const distance = options.nudgeDistance[0] + Math.floor(random(user) * (options.nudgeDistance[1] - options.nudgeDistance[0] + 1))
            const direction = compass[Math.floor(random(user) * compass.length)]!
            dx = direction[0] * distance
            dy = direction[1] * distance
          } else {
            const distance = options.dragDistance[0] + random(user) * (options.dragDistance[1] - options.dragDistance[0])
            const angle = random(user) * 2 * Math.PI
            dx = Math.round(distance * Math.cos(angle))
            dy = Math.round(distance * Math.sin(angle))
          }
          // Keep 16 px from the workspace edges so tremor never clamps the result.
          const window = config.windows[index]!
          const newLeft = left + dx
          const newTop = top + dy
          if (newLeft < workspace.left + 16 || newLeft + window.width > workspace.left + workspace.width - 16) continue
          if (newTop < workspace.top + 16 || newTop + window.height > workspace.top + workspace.height - 16) continue
        }
        let down = n
        if (isTitleTask(kind) && lastTitleWindow[user] === index) {
          down = Math.max(n, lastTitleUpSample[user]! + toSamples(options.sameTitleGuardMilliseconds))
        }
        taskActive[user] = 1
        taskKind[user] = kind
        taskWindow[user] = index
        pressIndex[user] = 0
        aimMissed[user] = 0
        downFrame[user] = -1
        effectFrame[user] = -1
        moveFrame[user] = -1
        startLeft[user] = table[base + windowColumns.left[index]!]!
        startTop[user] = table[base + windowColumns.top[index]!]!
        startMaximized[user] = table[base + windowColumns.maximized[index]!]!
        switch (kind) {
          case task.bodyClick:
          case task.titleClick:
          case task.buttonClick: {
            pressCount[user] = 1
            const hold = toSamples(logNormal(user, options.hold))
            schedulePress(user, 0, down, hold, aim.x, aim.y, 0, 0, hold, 0)
            break
          }
          case task.doubleClick:
          case task.separateClicks: {
            pressCount[user] = 2
            const firstHold = toSamples(logNormal(user, options.hold))
            schedulePress(user, 0, down, firstHold, aim.x, aim.y, 0, 0, firstHold, 0)
            const gap = toSamples(logNormal(user, kind === task.doubleClick ? options.doubleClickGap : options.separateClicksGap))
            const scatter = options.secondPressScatter.base + options.secondPressScatter.perTremor * tremor[user]!
            const secondDown = down + firstHold + gap
            const secondHold = toSamples(logNormal(user, options.hold))
            schedulePress(user, 1, secondDown, secondHold, aim.x + scatter * gaussian(user), aim.y + scatter * gaussian(user), 0, 0, secondHold, 0)
            break
          }
          default: {
            pressCount[user] = 1
            const nudge = kind === task.nudge
            const dwell = toSamples(logNormal(user, nudge ? options.nudgeDwell : options.dragDwell))
            const move = toSamples(logNormal(user, nudge ? options.nudgeMove : options.dragMove))
            const settle = toSamples(logNormal(user, nudge ? options.nudgeSettle : options.dragSettle))
            schedulePress(user, 0, down, dwell + move + settle, aim.x, aim.y, dx, dy, dwell, move)
          }
        }
        return true
      }
    }
    void frame
    return false
  }

  const metricBase = (user: number) => (options.groupOfUser[user]! * segmentCount + segment[user]!) * metricCount

  function writeEvent(base: number, slot: number, kind: 0 | 1 | 2, x: number, y: number, time: number) {
    const columns = slotColumns[slot]!
    table[base + columns.down] = kind === 0 ? 1 : 0
    table[base + columns.move] = kind === 1 ? 1 : 0
    table[base + columns.up] = kind === 2 ? 1 : 0
    table[base + columns.x] = x
    table[base + columns.y] = y
    table[base + columns.time] = time
  }

  // Writes every user's events for the frame that ends at world time frameEnd (ms).
  function emitFrame(frame: number, frameEnd: number) {
    for (let user = 0; user < userCount; user++) {
      const base = user * width
      endedThisFrame[user] = 0
      let events = 0
      let downs = 0
      for (;;) {
        const n = nextSample[user]!
        const t = sampleOffset[user]! + samplePeriod * n
        if (t > frameEnd) break
        nextSample[user] = n + 1
        noiseX[user] = rho * noiseX[user]! + innovation * tremor[user]! * gaussian(user)
        noiseY[user] = rho * noiseY[user]! + innovation * tremor[user]! * gaussian(user)
        if (taskActive[user] === 0) {
          if (n < idleUntil[user]! || !startTask(user, n, frame)) continue
        }
        const press = user * 2 + pressIndex[user]!
        const time = t - frameEnd
        if (pressed[user] === 0) {
          if (n !== downSample[press]) continue
          if (downs === 2) {
            // A third down in this evaluation waits one sample, with the rest of the task.
            for (let later = pressIndex[user]!; later < pressCount[user]!; later++) {
              const index = user * 2 + later
              downSample[index]!++
              upSample[index]!++
              moveStart[index]!++
              moveEnd[index]!++
            }
            continue
          }
          const x = Math.round(aimX[press]! + noiseX[user]!)
          const y = Math.round(aimY[press]! + noiseY[user]!)
          writeEvent(base, events++, 0, x, y, time)
          downs++
          pressed[user] = 1
          lastX[user] = x
          lastY[user] = y
          pressX[user] = x
          pressY[user] = y
          pressTime[user] = t
          holdExcursion[user] = 0
          if (pressIndex[user] === 0) downFrame[user] = frame
          if (partAt(base, taskWindow[user]!, x, y) !== partOfTask(taskKind[user]!)) aimMissed[user] = 1
          continue
        }
        const start = moveStart[press]!
        const end = moveEnd[press]!
        if (n === start && end > start && moveFrame[user]! < 0) moveFrame[user] = frame
        const progress = n <= start ? 0 : n >= end ? 1 : minimumJerk((n - start) / (end - start))
        const x = Math.round(aimX[press]! + moveX[press]! * progress + noiseX[user]!)
        const y = Math.round(aimY[press]! + moveY[press]! * progress + noiseY[user]!)
        if (n === upSample[press]) {
          writeEvent(base, events++, 2, x, y, time)
          pressed[user] = 0
          lastX[user] = x
          lastY[user] = y
          excursionHistogram[segment[user]! * histogramBins + Math.min(histogramBins - 1, holdExcursion[user]!)]!++
          add(metricBase(user), metric.presses, 1, frame >= options.lateFromFrame)
          if (isTitleTask(taskKind[user]!)) {
            lastTitleWindow[user] = taskWindow[user]!
            lastTitleUpSample[user] = n
          }
          pressIndex[user]!++
          if (pressIndex[user] === pressCount[user]) {
            taskActive[user] = 0
            endedThisFrame[user] = 1
            idleUntil[user] = n + toSamples(options.idleMinimumMilliseconds + logNormal(user, options.idle))
          }
        } else if ((x !== lastX[user] || y !== lastY[user]) && events < capacity - 1) {
          writeEvent(base, events++, 1, x, y, time)
          lastX[user] = x
          lastY[user] = y
          if (t - pressTime[user]! <= options.holdWindowMilliseconds) {
            holdExcursion[user] = Math.max(holdExcursion[user]!, Math.abs(x - pressX[user]!), Math.abs(y - pressY[user]!))
          }
        }
      }
      invariant(events <= capacity && downs <= 2, 'a frame overflowed the queue or the down limit')
      for (let slot = events; slot < eventsLastFrame[user]!; slot++) writeEvent(base, slot, 0, 0, 0, 0)
      for (let slot = events; slot < eventsLastFrame[user]!; slot++) table[base + slotColumns[slot]!.down] = 0
      eventsLastFrame[user] = events
      eventHistogram[events]!++
      downHistogram[downs]!++
      if (events > maximumEventsPerFrame.events) maximumEventsPerFrame.events = events
      if (downs > maximumEventsPerFrame.downs) maximumEventsPerFrame.downs = downs
      const metricsBase = metricBase(user)
      add(metricsBase, metric.events, events, frame >= options.lateFromFrame)
      add(metricsBase, metric.downs, downs, frame >= options.lateFromFrame)
    }
  }

  // Reads each user's outputs after the circuit ran and the state was written back.
  function observeFrame(frame: number) {
    for (let user = 0; user < userCount; user++) {
      if (taskActive[user] === 0 && endedThisFrame[user] === 0) continue
      if (downFrame[user]! < 0) continue
      const base = user * width
      const index = taskWindow[user]!
      const kind = taskKind[user]!
      const moved = table[base + windowColumns.left[index]!] !== startLeft[user] || table[base + windowColumns.top[index]!] !== startTop[user]
      const toggled = table[base + windowColumns.maximized[index]!] !== startMaximized[user]
      if (effectFrame[user]! < 0) {
        if (kind === task.nudge || kind === task.longDrag) {
          if (outputs[user * outputCount + dragOwnerOutputs[index]!] === 1 || moved) effectFrame[user] = frame
        } else if ((kind === task.doubleClick || kind === task.buttonClick) && toggled) {
          effectFrame[user] = frame
        }
      }
      if (endedThisFrame[user] === 0) continue
      const metricsBase = metricBase(user)
      const late = frame >= options.lateFromFrame
      add(metricsBase, metric.tasks, 1, late)
      if (aimMissed[user] === 1) {
        add(metricsBase, metric.aimMisses, 1, late)
        continue
      }
      const effectDelay = effectFrame[user]! - downFrame[user]!
      // For nudges and drags: frames from the frame where the intended movement
      // began to the first frame the window follows, 0 when it followed earlier.
      const early = moveFrame[user]! < 0 || effectFrame[user]! < moveFrame[user]!
      const movementDelay = early ? 0 : effectFrame[user]! - moveFrame[user]!
      switch (kind) {
        case task.bodyClick:
          add(metricsBase, metric.bodyClicks, 1, late)
          if (toggled) add(metricsBase, metric.strayToggles, 1, late)
          break
        case task.titleClick:
          add(metricsBase, metric.titleClicks, 1, late)
          if (moved) add(metricsBase, metric.cancelledTitleClicks, 1, late)
          if (toggled) add(metricsBase, metric.strayToggles, 1, late)
          break
        case task.buttonClick:
          add(metricsBase, metric.buttonClicks, 1, late)
          if (!toggled) add(metricsBase, metric.cancelledButtonClicks, 1, late)
          break
        case task.doubleClick:
          add(metricsBase, metric.doubleClicks, 1, late)
          if (!toggled) add(metricsBase, metric.missedDoubleClicks, 1, late)
          else {
            add(metricsBase, metric.doubleClickEffectFrames, effectDelay, late)
            add(metricsBase, metric.doubleClickEffects, 1, late)
          }
          break
        case task.separateClicks:
          add(metricsBase, metric.separateClickPairs, 1, late)
          if (toggled) add(metricsBase, metric.accidentalDoubleClicks, 1, late)
          break
        case task.nudge:
          add(metricsBase, metric.nudges, 1, late)
          if (!moved) add(metricsBase, metric.lostNudges, 1, late)
          else {
            add(metricsBase, metric.nudgeEffectFrames, movementDelay, late)
            add(metricsBase, metric.nudgeEffects, 1, late)
            if (early) add(metricsBase, metric.earlyNudgeEffects, 1, late)
          }
          if (toggled) add(metricsBase, metric.strayToggles, 1, late)
          break
        default:
          add(metricsBase, metric.longDrags, 1, late)
          if (!moved) add(metricsBase, metric.lostLongDrags, 1, late)
          else {
            add(metricsBase, metric.dragEffectFrames, movementDelay, late)
            add(metricsBase, metric.dragEffects, 1, late)
            if (early) add(metricsBase, metric.earlyDragEffects, 1, late)
          }
          if (toggled) add(metricsBase, metric.strayToggles, 1, late)
      }
    }
  }

  return {options, tremor, segment, tempo, metrics, lateMetrics, excursionHistogram, maximumEventsPerFrame, eventHistogram, downHistogram, emitFrame, observeFrame}
}

// ---------------------------------------------------------------------------
// Rates from counters

export type Rates = {
  tasks: number
  aimMissRate: number
  cancelledClickRate: number
  lostNudgeRate: number
  lostLongDragRate: number
  missedDoubleClickRate: number
  accidentalDoubleClickRate: number
  strayToggleRate: number
  // Frames from the start of intended movement to the window following it.
  nudgeEffectFrames: number
  dragEffectFrames: number
  // Share of moved nudges and drags that followed tremor before the movement began.
  earlyNudgeRate: number
  earlyDragRate: number
  // Frames from the first down to the maximize toggle.
  doubleClickEffectFrames: number
  // Sum of the four mistake rates the settings trade against each other.
  mistakeSum: number
  counts: {clicks: number, nudges: number, doubleClicks: number, separatePairs: number, longDrags: number}
}

// Sums counters over the (group, segment) cells named by `select`.
export function ratesOf(metrics: Float64Array, groupCount: number, select: (group: number, segment: number) => boolean): Rates {
  const total = new Float64Array(metricCount)
  for (let group = 0; group < groupCount; group++) {
    for (let tremorSegment = 0; tremorSegment < segmentCount; tremorSegment++) {
      if (!select(group, tremorSegment)) continue
      const base = (group * segmentCount + tremorSegment) * metricCount
      for (let index = 0; index < metricCount; index++) total[index]! += metrics[base + index]!
    }
  }
  const ratio = (numerator: number, denominator: number) => (denominator === 0 ? 0 : numerator / denominator)
  const clicks = total[metric.titleClicks]! + total[metric.buttonClicks]!
  const cancelledClickRate = ratio(total[metric.cancelledTitleClicks]! + total[metric.cancelledButtonClicks]!, clicks)
  const lostNudgeRate = ratio(total[metric.lostNudges]!, total[metric.nudges]!)
  const missedDoubleClickRate = ratio(total[metric.missedDoubleClicks]!, total[metric.doubleClicks]!)
  const accidentalDoubleClickRate = ratio(total[metric.accidentalDoubleClicks]!, total[metric.separateClickPairs]!)
  return {
    tasks: total[metric.tasks]!,
    aimMissRate: ratio(total[metric.aimMisses]!, total[metric.tasks]!),
    cancelledClickRate,
    lostNudgeRate,
    lostLongDragRate: ratio(total[metric.lostLongDrags]!, total[metric.longDrags]!),
    missedDoubleClickRate,
    accidentalDoubleClickRate,
    strayToggleRate: ratio(total[metric.strayToggles]!, total[metric.tasks]!),
    nudgeEffectFrames: ratio(total[metric.nudgeEffectFrames]!, total[metric.nudgeEffects]!),
    dragEffectFrames: ratio(total[metric.dragEffectFrames]!, total[metric.dragEffects]!),
    earlyNudgeRate: ratio(total[metric.earlyNudgeEffects]!, total[metric.nudgeEffects]!),
    earlyDragRate: ratio(total[metric.earlyDragEffects]!, total[metric.dragEffects]!),
    doubleClickEffectFrames: ratio(total[metric.doubleClickEffectFrames]!, total[metric.doubleClickEffects]!),
    mistakeSum: cancelledClickRate + lostNudgeRate + missedDoubleClickRate + accidentalDoubleClickRate,
    counts: {clicks, nudges: total[metric.nudges]!, doubleClicks: total[metric.doubleClicks]!, separatePairs: total[metric.separateClickPairs]!, longDrags: total[metric.longDrags]!},
  }
}
