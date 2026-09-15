// Plain float64 JavaScript. How much does a spring's trajectory depend on the
// frame rate when a destination changes between two frames?
//
// Four timing rules over the same presses and the same spring:
// - 'index.ts': chenglou.github.io/index.ts's render(). A frame first applies
//   the presses that arrived since the previous frame, then runs the catch-up
//   steps from animatedUntilTime to now toward the new destination.
// - 'event time': before applying a press, step the spring to the press's own
//   timestamp toward the old destination. When the spring was at rest, its
//   clock starts at the press's timestamp instead of at the next frame.
// - 'event time, settle per step': the same, and the settle check runs after
//   every 4 ms step instead of once per frame, so the moment a spring settles
//   doesn't depend on which step counts the frames happen to land on.
// - 'IndirectOS substeps': window-manager.ts's timing, 4 substeps of
//   min(frame duration, 32 ms) / 4 per frame, with index.ts's settle rule.

export const msPerAnimationStep = 4

export type Spring = {
  readonly pos: number
  readonly dest: number
  readonly v: number
  readonly k: number
  readonly b: number
}

export function spring(pos: number, v = 0, k = 290, b = 30): Spring {
  return {pos, dest: pos, v, k, b}
}

export function springStillAnimating(s: Spring): boolean {
  return Math.abs(s.v) >= 0.01 || Math.abs(s.dest - s.pos) >= 0.01
}

// index.ts's stepSpringTo, without the positionDelta, velocityDelta and
// goToEnd parameters, which this check doesn't use.
export function stepSpringTo(previous: Spring, dest: number, steps: number, stepSeconds = msPerAnimationStep / 1000): Spring {
  const t = stepSeconds
  let pos = previous.pos
  let v = previous.v
  for (let i = 0; i < steps; i++) {
    const Fspring = -previous.k * (pos - dest)
    const Fdamper = -previous.b * v
    const a = Fspring + Fdamper
    v += a * t
    pos += v * t
    if (!Number.isFinite(pos) || !Number.isFinite(v)) {
      pos = dest
      v = 0
      break
    }
  }
  if (Math.abs(v) < 0.01 && Math.abs(dest - pos) < 0.01) {
    pos = dest
    v = 0
  }
  if (pos === previous.pos && dest === previous.dest && v === previous.v) return previous
  return {pos, dest, v, k: previous.k, b: previous.b}
}

// Runs the steps one at a time and stops at the first step after which
// springStillAnimating returns false. Returns how many steps it ran.
function stepSpringCheckingEachStep(previous: Spring, dest: number, steps: number): {spring: Spring, stepsRun: number} {
  let current = stepSpringTo(previous, dest, 0)
  if (!springStillAnimating(current)) return {spring: current, stepsRun: 0}
  for (let step = 1; step <= steps; step++) {
    current = stepSpringTo(current, dest, 1)
    if (!springStillAnimating(current)) return {spring: current, stepsRun: step}
  }
  return {spring: current, stepsRun: steps}
}

export type Press = {time: number, destination: number}

export type TimingRule = 'index.ts' | 'event time' | 'event time, settle per step' | 'IndirectOS substeps'

export const timingRules: readonly TimingRule[] = ['index.ts', 'event time', 'event time, settle per step', 'IndirectOS substeps']

// Positions at every frame time, keyed by the frame time.
export function runTimingRule(rule: TimingRule, presses: readonly Press[], frameTimes: readonly number[]): Map<number, number> {
  const positions = new Map<number, number>()
  let current = spring(0)
  let destination = 0
  let animatedUntilTime: number | null = null
  let previousFrameTime: number | null = null
  let nextPress = 0

  // Steps the spring from animatedUntilTime to `time` toward its current
  // destination, and stops the clock once springStillAnimating returns false.
  function advanceClockTo(time: number, settlePerStep: boolean) {
    if (animatedUntilTime === null) return
    const steps = Math.floor((time - animatedUntilTime) / msPerAnimationStep)
    if (settlePerStep) {
      const result = stepSpringCheckingEachStep(current, current.dest, steps)
      current = result.spring
      animatedUntilTime = springStillAnimating(current) ? animatedUntilTime + steps * msPerAnimationStep : null
    } else {
      current = stepSpringTo(current, current.dest, steps)
      animatedUntilTime = springStillAnimating(current) ? animatedUntilTime + steps * msPerAnimationStep : null
    }
  }

  for (const now of frameTimes) {
    if (rule === 'index.ts' || rule === 'IndirectOS substeps') {
      // Handle inputs: index.ts keeps the latest press of the frame.
      while (nextPress < presses.length && presses[nextPress]!.time <= now) {
        destination = presses[nextPress]!.destination
        nextPress++
      }
    } else {
      const settlePerStep = rule === 'event time, settle per step'
      while (nextPress < presses.length && presses[nextPress]!.time <= now) {
        const press = presses[nextPress]!
        advanceClockTo(press.time, settlePerStep)
        destination = press.destination
        current = {...current, dest: destination}
        animatedUntilTime ??= press.time
        nextPress++
      }
    }

    if (rule === 'index.ts') {
      // Run animation, as in index.ts: steps from animatedUntilTime to now,
      // all toward this frame's destination.
      let newAnimatedUntilTime: number = animatedUntilTime ?? now
      const steps = Math.floor((now - newAnimatedUntilTime) / msPerAnimationStep)
      newAnimatedUntilTime += steps * msPerAnimationStep
      current = stepSpringTo(current, destination, steps)
      animatedUntilTime = springStillAnimating(current) ? newAnimatedUntilTime : null
    } else if (rule === 'IndirectOS substeps') {
      const frameDuration = previousFrameTime === null ? 0 : Math.min(Math.max(0, now - previousFrameTime), 32)
      current = stepSpringTo(current, destination, 4, frameDuration / 4 / 1000)
    } else {
      advanceClockTo(now, rule === 'event time, settle per step')
    }
    previousFrameTime = now
    positions.set(now, current.pos)
  }
  return positions
}

// Frame i at `hz` is (i * 1000) / hz. Division of two exact integers rounds
// correctly, so frame 4j at 120 fps and frame j at 30 fps are the same float64.
export function frameTimesAt(hz: number, durationMs: number, stall?: {startMs: number, lengthMs: number}): number[] {
  const times: number[] = []
  for (let frame = 0; ; frame++) {
    const time = (frame * 1000) / hz
    if (time > durationMs) break
    if (stall !== undefined && time > stall.startMs && time < stall.startMs + stall.lengthMs) continue
    times.push(time)
  }
  return times
}

export function seededRandom(seed: number) {
  let state = seed >>> 0
  return function random() {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

// 'during animations': presses 90 to 700 ms apart, so most presses change the
// destination of a moving spring. 'only at rest': presses 2,500 to 3,500 ms
// apart, and the spring (stiffness 290, damping 30) settles from any of these
// destinations in well under a second, so every press starts from rest.
export type PressSpacing = 'during animations' | 'only at rest'

// Presses at random times between frames, each moving the destination to a
// random whole pixel in 0..800. Times sit on a 1/64 ms grid.
export function randomPresses(seed: number, count: number, spacing: PressSpacing = 'during animations'): Press[] {
  const random = seededRandom(seed)
  const presses: Press[] = []
  let time = 100
  for (let index = 0; index < count; index++) {
    time += spacing === 'during animations' ? 90 + random() * 610 : 2500 + random() * 1000
    presses.push({time: Math.round(time * 64) / 64, destination: Math.round(random() * 800)})
  }
  return presses
}

export type Comparison = {rule: TimingRule, hz: number, stall: boolean, maxDifferencePx: number, sharedFrames: number}

// Max position difference from 120 fps at the timestamps both runs rendered.
export function compareWithHighRate(rule: TimingRule, presses: readonly Press[], hz: number, stall: boolean): Comparison {
  const lastPress = presses.at(-1)!.time
  const durationMs = lastPress + 2000
  const stallSpec = stall ? {startMs: presses[2]!.time - 100, lengthMs: 500} : undefined
  const reference = runTimingRule(rule, presses, frameTimesAt(120, durationMs))
  const other = runTimingRule(rule, presses, frameTimesAt(hz, durationMs, stallSpec))
  let maxDifferencePx = 0
  let sharedFrames = 0
  for (const [time, position] of other) {
    const referencePosition = reference.get(time)
    if (referencePosition === undefined) continue
    sharedFrames++
    maxDifferencePx = Math.max(maxDifferencePx, Math.abs(position - referencePosition))
  }
  return {rule, hz, stall, maxDifferencePx, sharedFrames}
}

export type TraceOptions = {
  // A 500 ms stall that starts 100 ms before the third press.
  stall: boolean
  // With a rate, every press moves to the next frame time of that rate. For
  // example, with 30, every press sits on a frame time that 30, 60 and 120 fps
  // runs all render.
  pressesOnFramesOfHz?: number | undefined
  spacing?: PressSpacing | undefined
}

export const reportSeeds = [1, 2, 3, 4, 5, 6, 7, 8]

// Worst over several random press traces of 12 presses.
export function worstOverSeeds(
  rule: TimingRule,
  hz: number,
  {stall, pressesOnFramesOfHz, spacing = 'during animations'}: TraceOptions,
  seeds: readonly number[] = reportSeeds,
): Comparison {
  let worst: Comparison | null = null
  for (const seed of seeds) {
    let presses = randomPresses(seed, 12, spacing)
    if (pressesOnFramesOfHz !== undefined) {
      presses = presses.map(press => ({
        ...press,
        time: (Math.ceil((press.time * pressesOnFramesOfHz) / 1000) * 1000) / pressesOnFramesOfHz,
      }))
    }
    const comparison = compareWithHighRate(rule, presses, hz, stall)
    if (worst === null || comparison.maxDifferencePx > worst.maxDifferencePx) worst = comparison
  }
  return worst!
}

if (import.meta.main) {
  console.log('| Timing rule | 10 fps | 30 fps | 60 fps | 60 fps, 500 ms stall |')
  console.log('| --- | ---: | ---: | ---: | ---: |')
  for (const rule of timingRules) {
    const cells = [
      worstOverSeeds(rule, 10, {stall: false}),
      worstOverSeeds(rule, 30, {stall: false}),
      worstOverSeeds(rule, 60, {stall: false}),
      worstOverSeeds(rule, 60, {stall: true}),
    ].map(comparison => comparison.maxDifferencePx === 0 ? '0' : comparison.maxDifferencePx.toPrecision(3))
    console.log(`| ${rule} | ${cells.join(' | ')} |`)
  }
}
