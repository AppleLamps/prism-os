// A scripted pointer trace for the toggle switch. Each entry is one frame: the DOM reads, the frame's duration in ms, and
// the pointer events that arrived before the frame, in the order they arrived. `checks` records what a frame must do,
// so the test can check that the trace exercises what it names.
// At 1280x800 the track spans x 614..666 and y 384..416; at 1000x700, x 474..526 and y 334..366; at 1x1, x -25.5..26.5
// and y -15.5..16.5.

export type ToggleEvent = {kind: 'move' | 'down' | 'up', x: number, y: number} | {kind: 'cancel'}
export type ToggleFrame = {viewportWidth: number, viewportHeight: number, frameDuration: number, events: readonly ToggleEvent[]}
export type ScriptedCheck = {
  frame: number
  expected: {on?: 0 | 1, armed?: 0 | 1, clicked?: 0 | 1, hovered?: 0 | 1}
  description: string
}

type PointerHandlers = {
  pointerMove(x: number, y: number): void
  pointerDown(x: number, y: number): void
  pointerUp(x: number, y: number): void
  pointerCancel(): void
}

// Call the event handlers the way the browser would, in arrival order, before the frame runs.
export function applyEvents(handlers: PointerHandlers, events: readonly ToggleEvent[]) {
  for (const event of events) {
    if (event.kind === 'cancel') handlers.pointerCancel()
    else if (event.kind === 'move') handlers.pointerMove(event.x, event.y)
    else if (event.kind === 'down') handlers.pointerDown(event.x, event.y)
    else handlers.pointerUp(event.x, event.y)
  }
}

export function scriptedToggleTrace() {
  const frames: ToggleFrame[] = []
  const checks: ScriptedCheck[] = []
  let viewportWidth = 1280
  let viewportHeight = 800
  const idle = (count: number, frameDuration = 16) => {
    for (let index = 0; index < count; index++) frames.push({viewportWidth, viewportHeight, frameDuration, events: []})
  }
  const at = (kind: 'move' | 'down' | 'up', x: number, y: number): ToggleEvent => ({kind, x, y})
  const eventFrame = (events: readonly ToggleEvent[], expected: ScriptedCheck['expected'], description: string) => {
    checks.push({frame: frames.length, expected, description})
    frames.push({viewportWidth, viewportHeight, frameDuration: 16, events})
  }

  frames.push({viewportWidth, viewportHeight, frameDuration: 0, events: []})
  idle(4)
  eventFrame([at('move', 700, 400)], {hovered: 0}, 'a pointer right of the track does not hover it')
  eventFrame([at('move', 640, 400)], {hovered: 1}, 'a pointer on the track hovers it')
  eventFrame([at('down', 640, 400)], {armed: 1, clicked: 0, on: 0}, 'a press on the track arms the switch without flipping it')
  idle(3)
  eventFrame([at('up', 640, 400)], {armed: 0, clicked: 1, on: 1}, 'a release on the track while armed flips the switch on')
  idle(60)
  eventFrame([at('down', 600, 400)], {armed: 0}, 'a press left of the track does not arm it')
  eventFrame([at('up', 640, 400)], {clicked: 0, on: 1}, 'a release on the track with no armed press does nothing')
  eventFrame([at('down', 614, 390)], {armed: 1}, 'a press exactly on the left edge counts, like x >= trackLeft')
  eventFrame([at('move', 700, 400), at('up', 700, 400)], {armed: 0, clicked: 0, hovered: 0, on: 1}, 'a release off the track disarms without flipping')
  eventFrame(
    [at('down', 665.984375, 415.984375), at('up', 665.984375, 415.984375)],
    {armed: 0, clicked: 1, on: 0},
    'a press and a release 1/64 px inside the bottom right corner, within one frame, flip it off',
  )
  idle(4)
  eventFrame([at('down', 666, 400)], {armed: 0}, 'a press exactly on the right edge does not count, like x < trackRight')
  eventFrame([at('down', 630.25, 399.5)], {armed: 1}, 'a press on a quarter pixel arms it while the thumb moves')
  eventFrame([at('up', 640, 416)], {armed: 0, clicked: 0, on: 0}, 'a release exactly on the bottom edge does not count')
  eventFrame(
    [at('down', 630.25, 399.5), at('up', 630.25, 399.5)],
    {clicked: 1, on: 1},
    'a click mid-animation turns it back on and changes the spring destination',
  )
  eventFrame([at('down', 640, 400)], {armed: 1, clicked: 0}, 'a press arms it again')
  eventFrame([{kind: 'cancel'}], {armed: 0, clicked: 0}, 'a pointercancel disarms it')
  eventFrame([at('up', 640, 400)], {clicked: 0, on: 1}, 'a release after a cancel does nothing')
  idle(2)
  // A resize while the thumb moves, with no events, then a stall that the circuit caps at 32 ms, then uneven durations.
  viewportWidth = 1000
  viewportHeight = 700
  idle(1)
  idle(1, 500)
  for (const frameDuration of [8.25, 33.5, 4, 16]) idle(1, frameDuration)
  idle(60)
  eventFrame([at('down', 500.5, 350.25)], {armed: 1}, 'a press inside the moved track arms it')
  viewportWidth = 1280
  viewportHeight = 800
  eventFrame(
    [at('up', 500.5, 350.25)],
    {armed: 0, clicked: 0, on: 1},
    'a release where the track used to be does not flip it, since each frame hit-tests its own layout',
  )
  eventFrame([at('down', 640, 400), at('up', 640, 400)], {clicked: 1, on: 0}, 'a click on the track at its new place flips it off')
  idle(60)
  viewportWidth = 1
  viewportHeight = 1
  eventFrame([at('down', -20, -10), at('up', -20, -10)], {clicked: 1, on: 1}, 'a click at negative coordinates hits the track of a 1x1 viewport')
  idle(60)
  return {frames, checks}
}
