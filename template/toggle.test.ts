// Runs the toggle switch program and its plain JavaScript version over a scripted trace, and compares them every frame.
import {expect, test} from 'bun:test'
import {createToggleReference} from './toggle-reference.ts'
import {type ToggleEvent, createToggleMachine} from './toggle.ts'

// `moving` says whether the thumb still moves before the frame, so a step that should land mid-animation does.
type Frame = {timeMs: number, events: ToggleEvent[], expected?: {on: number, armed: number}, moving?: boolean | undefined}

// Frames 16 ms apart at 1280 × 800, where the track spans x 614..666 and y 384..416. Each event arrives 3 ms before
// its frame.
function scriptedTrace() {
  const frames: Frame[] = []
  let timeMs = 1000
  const idle = (count: number, gapMs = 16, moving?: boolean) => {
    for (let index = 0; index < count; index++) frames.push({timeMs: timeMs += gapMs, events: [], moving})
  }
  const pointer = (kind: ToggleEvent['kind'], x: number, y: number, on: number, armed: number, moving?: boolean) => {
    timeMs += 16
    frames.push({timeMs, events: [{kind, x, y, timeStamp: timeMs - 3}], expected: {on, armed}, moving})
  }
  idle(2)
  pointer('down', 640, 400, 0, 1, false) // a press on the track arms the switch
  pointer('up', 640, 400, 1, 0) // a release on the track while armed flips it on
  idle(3)
  pointer('down', 630.25, 399.5, 1, 1, true)
  pointer('up', 630.25, 399.5, 0, 0, true) // a click while the thumb moves flips it back
  idle(60)
  pointer('down', 613.984375, 400, 0, 0, false) // 1/64 px left of the track
  pointer('down', 614, 384, 0, 1) // exactly on the left and top edges
  pointer('up', 666, 400, 0, 0) // exactly on the right edge, which is outside, so it only disarms
  pointer('down', 640, 400, 0, 1)
  pointer('cancel', 0, 0, 0, 0) // a pointercancel disarms
  pointer('up', 640, 400, 0, 0) // so this release doesn't flip
  pointer('down', 665.984375, 415.984375, 0, 1)
  pointer('up', 665.984375, 415.984375, 1, 0) // 1/64 px inside the bottom right corner
  idle(1, 500, true) // a 500 ms stall while the thumb moves
  idle(60)
  return frames
}

test('the program and plain JavaScript agree on every frame, and every scripted step takes effect', () => {
  const machine = createToggleMachine()
  const reference = createToggleReference()
  let largestThumbError = 0
  let animatingFrames = 0
  for (const frame of scriptedTrace()) {
    if (frame.moving !== undefined) expect(machine.clock.animatedUntilMs !== null).toBe(frame.moving)
    for (const event of frame.events) machine.queue(event)
    const output = machine.step(1280, 800, frame.timeMs)
    const expected = reference.render(1280, 800, frame.timeMs, frame.events)
    expect([output.on, output.armed, output.trackLeft, output.trackTop]).toEqual([expected.on, expected.armed, expected.trackLeft, expected.trackTop])
    if (frame.expected !== undefined) expect([output.on, output.armed]).toEqual([frame.expected.on, frame.expected.armed])
    expect(machine.clock.animatedUntilMs !== null).toBe(expected.animating)
    largestThumbError = Math.max(largestThumbError, Math.abs(output.thumbOffset - expected.thumbOffset))
    if (expected.animating) animatingFrames++
  }
  expect(animatingFrames).toBe(38)
  expect(largestThumbError).toBeLessThan(1e-5)
  // At rest the thumb sits exactly on its side, and the host stops requesting frames.
  expect(machine.step(1280, 800, 5000).thumbOffset).toBe(20)
  expect(machine.clock.animatedUntilMs).toBeNull()
})

test('the table check rejects a pointer coordinate off the 1/64 px grid', () => {
  const machine = createToggleMachine()
  machine.queue({kind: 'down', x: 640.001, y: 400, timeStamp: 1000})
  expect(() => machine.step(1280, 800, 1016)).toThrow('down.x must be a multiple of 0.015625')
})

test('events that share a timestamp apply together, the last down, then the last up, then any cancel, in both versions', () => {
  const at = (kind: ToggleEvent['kind'], timeStamp: number): ToggleEvent => ({kind, x: 640, y: 400, timeStamp})
  const cases: {frames: {timeMs: number, events: ToggleEvent[]}[], expected: {on: number, armed: number}}[] = [
    // A press, then a release and a press at one timestamp: the press applies first, and the release flips the switch
    // and disarms it.
    {frames: [{timeMs: 1016, events: [at('down', 1013)]}, {timeMs: 1032, events: [at('up', 1029), at('down', 1029)]}], expected: {on: 1, armed: 0}},
    // A cancel and a press at one timestamp: the cancel applies after the press, so the switch stays disarmed.
    {frames: [{timeMs: 1016, events: [at('cancel', 1013), at('down', 1013)]}], expected: {on: 0, armed: 0}},
    // The same release and press 1/64 ms apart apply one after the other, so the press arms the switch again.
    {frames: [{timeMs: 1016, events: [at('down', 1013)]}, {timeMs: 1032, events: [at('up', 1029), at('down', 1029.015625)]}], expected: {on: 1, armed: 1}},
  ]
  for (const {frames, expected} of cases) {
    const machine = createToggleMachine()
    const reference = createToggleReference()
    let decisions: number[] = []
    for (const frame of frames) {
      for (const event of frame.events) machine.queue(event)
      const output = machine.step(1280, 800, frame.timeMs)
      const referenceOutput = reference.render(1280, 800, frame.timeMs, frame.events)
      decisions = [output.on, output.armed]
      expect(decisions).toEqual([referenceOutput.on, referenceOutput.armed])
    }
    expect(decisions).toEqual([expected.on, expected.armed])
  }
})
