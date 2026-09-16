// The toggle switch of toggle.ts in plain JavaScript, in float64, with the timing that advanceFrame gives the program:
// the spring takes fixed 4 ms steps from the time the clock started, steps to each event's timestamp before the event
// applies, and settles only at a check every 64 ms of simulated time. Events that share a timestamp apply together, in
// the order that the program handles them within one evaluation: the last down, then the last up, then any cancel.
// Unlike advanceFrame, it never snaps the thumb onto its destination when a frame would need more than 300 steps, so a
// trace with a stall of more than about 1,140 ms while the thumb moves would differ from the program.
import {quantizeTimeMs} from '../host-timing.ts'
import {type ToggleEvent, layout, springConstants} from './toggle.ts'

export function createToggleReference() {
  const switchState = {on: 0, armed: 0, thumbOffset: 0, velocity: 0, animatedUntilMs: null as number | null, checkOriginMs: 0}
  const destination = () => switchState.on * layout.travel
  // emitAnimatedObject's default settle thresholds, 0.01 px and 0.01 px/s.
  const withinThresholds = () =>
    Math.abs(switchState.thumbOffset - destination()) <= Math.fround(0.01) && Math.abs(switchState.velocity) <= Math.fround(0.01)

  function stepTo(timeMs: number) {
    while (switchState.animatedUntilMs !== null && switchState.animatedUntilMs + 4 <= timeMs) {
      switchState.velocity += (-springConstants.stiffness * (switchState.thumbOffset - destination()) - springConstants.damping * switchState.velocity) * 0.004
      switchState.thumbOffset += switchState.velocity * 0.004
      switchState.animatedUntilMs += 4
      if ((switchState.animatedUntilMs - switchState.checkOriginMs) % 64 === 0 && withinThresholds()) {
        switchState.thumbOffset = destination()
        switchState.velocity = 0
        switchState.animatedUntilMs = null
      }
    }
  }

  function render(viewportWidth: number, viewportHeight: number, frameTime: number, events: readonly ToggleEvent[]) {
    const trackLeft = viewportWidth / 2 - layout.trackWidth / 2
    const trackTop = viewportHeight / 2 - layout.trackHeight / 2
    const insideTrack = ({x, y}: ToggleEvent) =>
      x >= trackLeft && x < trackLeft + layout.trackWidth && y >= trackTop && y < trackTop + layout.trackHeight
    for (let start = 0; start < events.length;) {
      const eventMs = quantizeTimeMs(events[start]!.timeStamp)
      let end = start + 1
      while (end < events.length && quantizeTimeMs(events[end]!.timeStamp) === eventMs) end++
      const sameTime = events.slice(start, end)
      start = end
      stepTo(eventMs)
      const down = sameTime.findLast(event => event.kind === 'down')
      const up = sameTime.findLast(event => event.kind === 'up')
      if (down !== undefined) switchState.armed = insideTrack(down) ? 1 : 0
      if (up !== undefined && switchState.armed === 1 && insideTrack(up)) switchState.on = 1 - switchState.on
      if (up !== undefined || sameTime.some(event => event.kind === 'cancel')) switchState.armed = 0
      // A stopped clock starts at an event that gives the thumb somewhere to go.
      if (switchState.animatedUntilMs === null && !withinThresholds()) {
        switchState.animatedUntilMs = eventMs
        switchState.checkOriginMs = eventMs
      }
    }
    stepTo(quantizeTimeMs(frameTime))
    return {trackLeft, trackTop, thumbOffset: switchState.thumbOffset, on: switchState.on, armed: switchState.armed, animating: switchState.animatedUntilMs !== null}
  }

  return {switchState, render}
}
