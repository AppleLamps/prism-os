// A toggle switch centered in the viewport, as one numeric program. Like a native switch, it acts on release: a press
// on the track arms it, a release on the track while armed flips it, and a release off the track or a pointercancel
// disarms it. The thumb springs to its new side. docs/tutorial.md walks through this file, toggle-reference.ts is the
// same app in plain JavaScript, and toggle.test.ts compares the two.
import {type Wire, emitAnimatedObject, emitCompare, emitSelect} from '../src/runtime/numeric-ui-core.ts'
import {type WriteBack, advanceFrame, defaultSpringClockConfig, springMatrixBound, springMatrixPower, springStepMatrix, stoppedSpringClock} from '../src/runtime/host-timing.ts'
import {type WireValues, createEvaluator, createSourceTable, event, input, inputBit, state, stateBit} from '../src/runtime/cells.ts'

export const layout = {trackWidth: 52, trackHeight: 32, thumbInset: 4, travel: 20} as const
export const springConstants = {stiffness: 650, damping: 45}
// The host writes the 2 × 2 matrix of an evaluation's spring steps into 4 input cells, each within ±matrixBound.
const matrixBound = springMatrixBound(springConstants)
const matrixEntry = input([-matrixBound, matrixBound])
// The host rounds pointer coordinates onto a 1/64 px grid.
const coordinate = () => input([-16_384, 16_384], {grid: 1 / 64})

// Every number the program reads, or keeps from one evaluation to the next.
export const toggleCells = {
  viewportWidth: input([0, 16_384], {initial: 1280, grid: 1}),
  viewportHeight: input([0, 16_384], {initial: 800, grid: 1}),
  down: {active: event(), x: coordinate(), y: coordinate()},
  up: {active: event(), x: coordinate(), y: coordinate()},
  cancel: event(),
  on: stateBit(),
  armed: stateBit(),
  // What advanceFrame plans for each evaluation: the spring matrix of its steps, whether the spring may come to rest
  // (a settle check), and whether the thumb snaps onto its destination because the frame would need too many steps.
  springMatrix: [matrixEntry, matrixEntry, matrixEntry, matrixEntry] as const,
  settleCheck: inputBit(),
  snap: inputBit(),
  // The thumb's spring in px from the off side: its displacement from the destination, its velocity, and the
  // destination. The bounds scale with the travel, and leave room for a click while the thumb still moves.
  thumb: {
    displacement: state([-2 * layout.travel, 2 * layout.travel]),
    velocity: state([-64 * layout.travel, 64 * layout.travel]),
    destination: state([0, layout.travel]),
  },
}

export function buildToggle() {
  const table = createSourceTable()
  const cells = table.declare(toggleCells)
  const circuit = table.createCircuit()

  // Layout. JS: trackLeft = viewportWidth / 2 - trackWidth / 2
  const trackLeft = circuit.affine([[cells.viewportWidth, 0.5]], -layout.trackWidth / 2)
  const trackTop = circuit.affine([[cells.viewportHeight, 0.5]], -layout.trackHeight / 2)
  // JS: bits.every(bit => bit === 1), as relu(sum of bits - (count - 1)).
  const all = (...bits: Wire[]) => circuit.reglu([], 1, bits.map(bit => [bit, 1] as const), 1 - bits.length)
  // JS: !bit
  const not = (bit: Wire) => circuit.affine([[bit, -1]], 1)
  // JS: x >= trackLeft && x < trackLeft + trackWidth && y >= trackTop && y < trackTop + trackHeight
  const insideTrack = (point: {x: Wire, y: Wire}) => all(
    emitCompare(circuit, point.x, '>=', trackLeft),
    emitCompare(circuit, point.x, '<', circuit.affine([[trackLeft, 1]], layout.trackWidth)),
    emitCompare(circuit, point.y, '>=', trackTop),
    emitCompare(circuit, point.y, '<', circuit.affine([[trackTop, 1]], layout.trackHeight)),
  )

  // Handle inputs in a fixed order: down, then up, then cancel. JS: if (down) armed = insideTrack(down)
  const armedAfterDown = emitSelect(circuit, cells.down.active, cells.armed, insideTrack(cells.down))
  // JS: if (up && armed && insideTrack(up)) on = !on
  const on = emitSelect(circuit, all(cells.up.active, armedAfterDown, insideTrack(cells.up)), cells.on, not(cells.on))
  // JS: if (up || cancel) armed = false
  const armed = all(armedAfterDown, not(cells.up.active), not(cells.cancel))

  // Animation. JS: thumb.destination = on ? travel : 0, then step the thumb's spring toward it.
  const destination = circuit.affine([[on, layout.travel]])
  const thumb = emitAnimatedObject(circuit, [{
    matrix: cells.springMatrix,
    displacement: cells.thumb.displacement,
    velocity: cells.thumb.velocity,
    destination,
    // The steps simulate time before this evaluation's events, so they pull toward the previous destination.
    destinationDuringSteps: cells.thumb.destination,
  }], {settleCheck: cells.settleCheck, snap: cells.snap})

  // Commit state: each state cell gets exactly one next value.
  table.next(cells.on, on)
  table.next(cells.armed, armed)
  table.next(cells.thumb, {displacement: thumb.displacements[0]!, velocity: thumb.velocities[0]!, destination})
  const output = {trackLeft, trackTop, thumbOffset: thumb.positions[0]!, on, armed, active: thumb.active}
  return {cells, output, ...table.finish()}
}

export type ToggleEvent = {kind: 'down' | 'up' | 'cancel', x: number, y: number, timeStamp: number}
export type ToggleOutput = WireValues<ReturnType<typeof buildToggle>['output']>

// The host. Event handlers only queue events, and each step plans the frame's evaluations with advanceFrame, which
// steps the spring to each event's timestamp before applying the event. With 'events and settle checks', the frame's
// own evaluation runs on a copy of the table, so stored state depends only on the events, not on the frame rate.
export function createToggleMachine(writeBack: WriteBack = 'events and settle checks') {
  const built = buildToggle()
  const {cells} = built
  const evaluate = createEvaluator(built)
  // The spring matrix of every step count a frame can plan.
  const matrices = Array.from({length: defaultSpringClockConfig.maxStepsPerFrame + 1}, (_, steps) => springMatrixPower(springStepMatrix(springConstants), steps))
  const source = new Float32Array(built.initialSource)
  const copy = new Float32Array(source.length)
  let queued: ToggleEvent[] = []
  const machine = {
    built,
    source,
    // The host requests frames while clock.animatedUntilMs isn't null.
    clock: stoppedSpringClock,
    queue(event: ToggleEvent) {
      queued.push(event)
    },
    step(viewportWidth: number, viewportHeight: number, frameTime: number): ToggleOutput {
      let frameOutput: ToggleOutput | undefined
      machine.clock = advanceFrame(machine.clock, frameTime, queued, evaluation => {
        const values = evaluation.writesBack ? source : copy
        if (!evaluation.writesBack) copy.set(source)
        const matrix = matrices[evaluation.steps]!
        cells.springMatrix.forEach((wire, index) => { values[wire] = matrix[index]! })
        values[cells.settleCheck] = evaluation.settleCheck ? 1 : 0
        values[cells.snap] = evaluation.snap ? 1 : 0
        values[cells.viewportWidth] = viewportWidth
        values[cells.viewportHeight] = viewportHeight
        for (const {kind, x, y} of evaluation.events) {
          if (kind === 'cancel') {
            values[cells.cancel] = 1
          } else {
            values[cells[kind].active] = 1
            values[cells[kind].x] = x
            values[cells[kind].y] = y
          }
        }
        const result = evaluate(values)
        if (evaluation.writesBack) source.set(result.nextValues)
        frameOutput = result.output
        return result.output.active > 0
      }, writeBack)
      queued = []
      return frameOutput!
    },
  }
  return machine
}

// The page: one step per requestAnimationFrame, then DOM writes from output numbers only.
export function mountToggle() {
  const machine = createToggleMachine()
  const track = document.querySelector<HTMLElement>('.track')!
  const thumb = document.querySelector<HTMLElement>('.thumb')!
  let scheduledFrame: number | null = null
  const scheduleRender = () => {
    scheduledFrame ??= requestAnimationFrame(render)
  }
  function render(frameTime: number) {
    scheduledFrame = null
    const output = machine.step(document.documentElement.clientWidth, document.documentElement.clientHeight, frameTime)
    track.style.transform = `translate3d(${output.trackLeft}px,${output.trackTop}px,0)`
    track.style.setProperty('--fill', `${Math.min(1, Math.max(0, output.thumbOffset / layout.travel))}`)
    track.style.setProperty('--armed', `${output.armed}`)
    track.setAttribute('aria-checked', output.on === 1 ? 'true' : 'false')
    thumb.style.transform = `translate3d(${layout.thumbInset + output.thumbOffset}px,${layout.thumbInset}px,0)`
    if (machine.clock.animatedUntilMs !== null) scheduleRender()
  }
  // Event timestamps share requestAnimationFrame's time origin. Coordinates go onto the declared 1/64 px grid.
  const quantize = (coordinate: number) => Math.min(16_384, Math.max(-16_384, Math.round(coordinate * 64) / 64))
  for (const kind of ['down', 'up', 'cancel'] as const) {
    window.addEventListener(`pointer${kind}`, event => {
      machine.queue({kind, x: quantize(event.clientX), y: quantize(event.clientY), timeStamp: event.timeStamp})
      scheduleRender()
    })
  }
  window.addEventListener('resize', scheduleRender)
  scheduleRender()
}
