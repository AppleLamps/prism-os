// Visual demo of the event-window experiment. The four windows are driven
// entirely by the compiled circuit stepping closed-loop through the tensor
// evaluator: this file only feeds pointer events into source cells and copies
// the sixteen displayed geometry numbers back onto DOM nodes. The plain
// TypeScript oracle runs in parallel on the same inputs as a judge, so the
// exactness claim is visible live. Run with: bun lab/event-window/demo.html
//
// Structure follows the repo's demo pattern and vibescript's ui.md: a DOM
// cache built once at mount, event handlers that only store raw input and
// schedule a render, one render function that reads the DOM, steps the state,
// then writes the DOM in a single batched phase.

import {
  type EventWindowMachine,
  type MachineFrame,
  createEventWindowMachine,
  sourceField,
  writeParameterValues,
} from './circuit.ts'
import {collectFrameMismatches, collectStateMismatches} from './harness.ts'
import {
  type BehaviorConfig,
  type FrameInput,
  type OracleState,
  createOracleState,
  oracleTick,
  rectangleCount,
} from './oracle.ts'
import {createRandom} from './trace.ts'
import {appendPointerMoves, type RawPointerInput} from './pointer-input.ts'

const worldWidth = 1280
const worldHeight = 800
const windowNames = ['Atlas', 'Briar', 'Cove', 'Delta'] as const
const windowHues = [28, 205, 152, 335] as const

function createDemoConfig(): BehaviorConfig {
  return {
    viewportWidth: worldWidth,
    viewportHeight: worldHeight,
    slop: 4,
    titleHeight: 30,
    rectangles: [
      {width: 380, height: 260, initialLeft: 90, initialTop: 90},
      {width: 320, height: 220, initialLeft: 710, initialTop: 130},
      {width: 300, height: 230, initialLeft: 170, initialTop: 440},
      {width: 360, height: 280, initialLeft: 770, initialTop: 450},
    ],
    relations: {
      dragFromTitle: true,
      dragFromBody: false,
      clickTogglesFromTitle: false,
      clickTogglesFromBody: true,
    },
  }
}

type WindowDom = {
  root: HTMLElement
  title: HTMLElement
}

function mountEventWindowDemo(document: Document, window: Window) {
  const demoConfig = createDemoConfig()
  const machine: EventWindowMachine = createEventWindowMachine(demoConfig)
  // The judge: the plain TypeScript reference ticks on the same inputs every
  // frame. The autopilot also reads it to aim at what is currently displayed.
  const oracle: OracleState = createOracleState(demoConfig)
  const operationCount = machine.circuit.operations.length

  function requireElement(selector: string, message: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(selector)
    if (element === null) throw new Error(message)
    return element
  }

  function requireInput(selector: string, message: string): HTMLInputElement {
    const element = document.querySelector<HTMLInputElement>(selector)
    if (element === null) throw new Error(message)
    return element
  }

  const stage = requireElement('#demo-stage', 'demo stage is missing')
  const world = requireElement('#demo-world', 'demo world is missing')
  const hitCellContainer = requireElement('#latch-hit-cells', 'hit cell container is missing')

  function createWindowElements(): WindowDom[] {
    return windowNames.map((name, index) => {
      const root = document.createElement('div')
      root.className = 'demo-window'
      root.style.setProperty('--hue', `${windowHues[index]}`)
      const title = document.createElement('div')
      title.className = 'window-title'
      const dot = document.createElement('i')
      const label = document.createElement('span')
      label.textContent = name
      title.append(dot, label)
      const body = document.createElement('div')
      body.className = 'window-body'
      const glyph = document.createElement('b')
      glyph.textContent = name[0]!
      const maximizedHint = document.createElement('small')
      maximizedHint.textContent = 'maximized — click to restore'
      body.append(glyph, maximizedHint)
      root.append(body, title)
      world.appendChild(root)
      return {root, title}
    })
  }

  function createHitCellElements(): HTMLElement[] {
    return windowNames.map((name, index) => {
      const cell = document.createElement('div')
      cell.className = 'latch-hit-cell'
      cell.style.setProperty('--hue', `${windowHues[index]}`)
      cell.textContent = name[0]!
      hitCellContainer.appendChild(cell)
      return cell
    })
  }

  const domCache = {
    stage, // cache lifetime: mount
    world, // cache lifetime: mount
    windows: createWindowElements(), // cache lifetime: mount
    hitCells: createHitCellElements(), // cache lifetime: mount
    pointerX: requireElement('#latch-pointer-x', 'pointer x readout is missing'), // cache lifetime: mount
    pointerY: requireElement('#latch-pointer-y', 'pointer y readout is missing'), // cache lifetime: mount
    pressLamp: requireElement('#latch-press', 'press lamp is missing'), // cache lifetime: mount
    pressX: requireElement('#latch-press-x', 'press x readout is missing'), // cache lifetime: mount
    pressY: requireElement('#latch-press-y', 'press y readout is missing'), // cache lifetime: mount
    onTitleLamp: requireElement('#latch-on-title', 'on-title lamp is missing'), // cache lifetime: mount
    wasFocusedLamp: requireElement('#latch-was-focused', 'was-focused lamp is missing'), // cache lifetime: mount
    onMaximizedLamp: requireElement('#latch-on-maximized', 'was-maximized lamp is missing'), // cache lifetime: mount
    slopLamp: requireElement('#latch-slop', 'slop lamp is missing'), // cache lifetime: mount
    statLine: requireElement('#stat-line', 'stat line is missing'), // cache lifetime: mount
    agreement: requireElement('#agreement', 'agreement readout is missing'), // cache lifetime: mount
    autopilotToggle: requireElement('#autopilot-toggle', 'autopilot toggle is missing'), // cache lifetime: mount
    slopValue: requireElement('#cell-slop-value', 'slop value label is missing'), // cache lifetime: mount
    titleValue: requireElement('#cell-title-value', 'title value label is missing'), // cache lifetime: mount
    dragTitleInput: requireInput('#cell-drag-title', 'drag-title toggle is missing'), // cache lifetime: mount
    toggleTitleInput: requireInput('#cell-toggle-title', 'toggle-title toggle is missing'), // cache lifetime: mount
    dragBodyInput: requireInput('#cell-drag-body', 'drag-body toggle is missing'), // cache lifetime: mount
    toggleBodyInput: requireInput('#cell-toggle-body', 'toggle-body toggle is missing'), // cache lifetime: mount
    slopInput: requireInput('#cell-slop', 'slop slider is missing'), // cache lifetime: mount
    titleInput: requireInput('#cell-title', 'title slider is missing'), // cache lifetime: mount
  }

  const st = {
    pendingPointer: [] as RawPointerInput[],
    activePointerId: null as number | null,
    autopilotOn: true,
    autopilotQueue: [] as FrameInput[],
    controls: {
      slop: 4,
      titleHeight: 30,
      dragFromTitle: true,
      dragFromBody: false,
      clickTogglesFromTitle: false,
      clickTogglesFromBody: true,
    },
    framesStepped: 0,
    divergences: 0,
    evalMicroseconds: 0,
    lastFrame: null as MachineFrame | null,
  }
  const autopilotRandom = createRandom(20_260_708)

  function stepCircuitAndJudge(input: FrameInput) {
    const startTime = performance.now()
    const frame = machine.step(input)
    const elapsedMicroseconds = (performance.now() - startTime) * 1000
    st.evalMicroseconds = st.evalMicroseconds === 0
      ? elapsedMicroseconds
      : st.evalMicroseconds * 0.95 + elapsedMicroseconds * 0.05
    const expected = oracleTick(demoConfig, oracle, input)
    const mismatchCount = collectFrameMismatches(frame, expected).length
      + collectStateMismatches(machine.source, oracle).length
    if (mismatchCount > 0) st.divergences++
    st.framesStepped++
    st.lastFrame = frame
  }

  // The autopilot scripts whole press sessions (down, eased moves, up) aimed at
  // what the oracle says is currently on screen, one event per frame, so the
  // demo drives itself at a watchable pace. Deterministic seed.
  function planAutopilotSession(): FrameInput[] {
    const frames: FrameInput[] = []
    const idleFrames = 12 + Math.floor(autopilotRandom() * 36)
    for (let frame = 0; frame < idleFrames; frame++) frames.push(null)

    const clampX = (x: number) => Math.max(1, Math.min(worldWidth - 1, Math.round(x)))
    const clampY = (y: number) => Math.max(1, Math.min(worldHeight - 1, Math.round(y)))
    const bodyPoint = (index: number) => {
      const seen = oracle.seenGeometry[index]!
      return {
        x: clampX(seen.left + 8 + autopilotRandom() * (seen.width - 16)),
        y: clampY(seen.top + demoConfig.titleHeight + 6
          + autopilotRandom() * (seen.height - demoConfig.titleHeight - 12)),
      }
    }
    const titlePoint = (index: number) => {
      const seen = oracle.seenGeometry[index]!
      return {
        x: clampX(seen.left + 10 + autopilotRandom() * (seen.width - 20)),
        y: clampY(seen.top + 2 + autopilotRandom() * (demoConfig.titleHeight - 4)),
      }
    }
    const pushClick = (point: {x: number, y: number}, clickCount: number) => {
      for (let click = 0; click < clickCount; click++) {
        frames.push({kind: 'down', ...point})
        for (let pause = 0; pause < 4; pause++) frames.push(null)
        frames.push({kind: 'up', ...point})
        for (let pause = 0; pause < 10; pause++) frames.push(null)
      }
    }

    const maximizedIndex = oracle.maximized.findIndex(maximized => maximized)
    if (maximizedIndex >= 0) {
      // The maximized window covers everything; click its body to restore it.
      pushClick(bodyPoint(maximizedIndex), 1)
      return frames
    }
    const roll = autopilotRandom()
    const index = Math.floor(autopilotRandom() * rectangleCount)
    if (roll < 0.55) {
      // A drag session: press the title bar, ease toward a destination that
      // keeps the window inside the viewport, release.
      const seen = oracle.seenGeometry[index]!
      const grab = titlePoint(index)
      const destinationLeft = Math.round(autopilotRandom() * (worldWidth - seen.width))
      const destinationTop = Math.round(autopilotRandom() * (worldHeight - seen.height))
      const deltaX = destinationLeft - seen.left
      const deltaY = destinationTop - seen.top
      const moveFrames = 28 + Math.floor(autopilotRandom() * 40)
      frames.push({kind: 'down', x: grab.x, y: grab.y})
      for (let move = 1; move <= moveFrames; move++) {
        const linear = move / moveFrames
        const eased = linear < 0.5
          ? 4 * linear ** 3
          : 1 - (-2 * linear + 2) ** 3 / 2
        frames.push({
          kind: 'move',
          x: clampX(grab.x + deltaX * eased),
          y: clampY(grab.y + deltaY * eased),
        })
      }
      for (let pause = 0; pause < 4; pause++) frames.push(null)
      frames.push({kind: 'up', x: clampX(grab.x + deltaX), y: clampY(grab.y + deltaY)})
    } else if (roll < 0.85) {
      // A body click: on an unfocused window the first click only focuses, so
      // half the time click twice to show the second click toggling maximize.
      const clickCount = oracle.focused === index || autopilotRandom() < 0.5 ? 1 : 2
      pushClick(bodyPoint(index), clickCount)
    } else {
      // A click on empty space clears focus (or hits whatever sits there).
      pushClick({
        x: clampX(autopilotRandom() * worldWidth),
        y: clampY(autopilotRandom() * worldHeight),
      }, 1)
    }
    return frames
  }

  let scheduledFrame: number | null = null
  function scheduleRender() {
    if (scheduledFrame !== null) return
    scheduledFrame = window.requestAnimationFrame(renderEventWindowDemo)
  }

  function renderEventWindowDemo() {
    scheduledFrame = null

    // DOM reads, batched.
    const stageWidth = domCache.stage.clientWidth
    const stageHeight = domCache.stage.clientHeight
    const stageBounds = domCache.stage.getBoundingClientRect()
    const scale = Math.max(0.05, Math.min(stageWidth / worldWidth, stageHeight / worldHeight))
    const offsetX = (stageWidth - worldWidth * scale) / 2
    const offsetY = (stageHeight - worldHeight * scale) / 2

    // Apply the behavior cell controls to the running circuit AND to the
    // oracle config, so the judge follows the same rules. The circuit cells
    // sit at the center of the integer band each rule quantizes to (see the
    // README's half-pixel convention).
    demoConfig.slop = st.controls.slop
    demoConfig.titleHeight = st.controls.titleHeight
    demoConfig.relations.dragFromTitle = st.controls.dragFromTitle
    demoConfig.relations.dragFromBody = st.controls.dragFromBody
    demoConfig.relations.clickTogglesFromTitle = st.controls.clickTogglesFromTitle
    demoConfig.relations.clickTogglesFromBody = st.controls.clickTogglesFromBody
    writeParameterValues(machine.source, {
      slopBoundary: st.controls.slop + 0.5,
      titleBoundary: st.controls.titleHeight - 0.5,
      dragFromTitle: st.controls.dragFromTitle ? 1 : 0,
      dragFromBody: st.controls.dragFromBody ? 1 : 0,
      clickTogglesFromTitle: st.controls.clickTogglesFromTitle ? 1 : 0,
      clickTogglesFromBody: st.controls.clickTogglesFromBody ? 1 : 0,
    })

    // Handle inputs: manual pointer events first, one circuit step per event.
    // The circuit's exactness story relies on integer pixel coordinates, so
    // client coordinates round to whole world pixels here, once, at the
    // boundary — nowhere else.
    const toWorldInput = (raw: RawPointerInput) => ({
      kind: raw.kind,
      x: Math.max(-512, Math.min(1792, Math.round((raw.clientX - stageBounds.left - offsetX) / scale))),
      y: Math.max(-512, Math.min(1312, Math.round((raw.clientY - stageBounds.top - offsetY) / scale))),
    })
    let manualSteps = 0
    for (const raw of st.pendingPointer) {
      const input = toWorldInput(raw)
      if (input.kind === 'down' && oracle.pressed) {
        // The autopilot may have left a press open; release it before the
        // manual press so the event stream stays legal.
        stepCircuitAndJudge({kind: 'up', x: oracle.pointerX, y: oracle.pointerY})
        manualSteps++
      }
      if (input.kind === 'up' && !oracle.pressed) continue
      stepCircuitAndJudge(input)
      manualSteps++
    }
    if (manualSteps === 0) {
      if (st.autopilotOn) {
        if (st.autopilotQueue.length === 0) st.autopilotQueue = planAutopilotSession()
        const nextInput = st.autopilotQueue.shift()
        stepCircuitAndJudge(nextInput ?? null)
      } else if (st.lastFrame === null) {
        // First paint runs the same dataflow as every later frame.
        stepCircuitAndJudge(null)
      }
    }

    // Commit transient state.
    st.pendingPointer.length = 0
    const frame = st.lastFrame!
    const source = machine.source
    // The title-bar strip is drawn from the same cell the circuit's region
    // test reads, so the picture and the behavior cannot disagree.
    const titleStripHeight = source[sourceField.titleBoundary]! + 0.5

    // DOM writes, batched.
    domCache.world.style.transform =
      `translate3d(${offsetX}px,${offsetY}px,0) scale(${scale})`
    domCache.stage.dataset['dragging'] = frame.dragOwner >= 0 ? '1' : '0'
    for (let index = 0; index < rectangleCount; index++) {
      const geometry = frame.displayed[index]!
      const {root, title} = domCache.windows[index]!
      root.style.width = `${geometry.width}px`
      root.style.height = `${geometry.height}px`
      root.style.transform = `translate3d(${geometry.left}px,${geometry.top}px,0)`
      // Visual stacking mirrors the circuit's fixed hit priority (maximized
      // first, then lowest index), so what looks frontmost is what a press hits.
      root.style.zIndex = `${(frame.maximized[index]! ? 10 : 0) + rectangleCount - index}`
      root.style.setProperty('--focused', frame.focused === index ? '1' : '0')
      root.style.setProperty('--maximized', frame.maximized[index]! ? '1' : '0')
      title.style.height = `${titleStripHeight}px`
      domCache.hitCells[index]!.style.setProperty(
        '--on',
        `${source[sourceField.pressRectangleStart + index]}`,
      )
    }
    domCache.pointerX.textContent = `${source[sourceField.pointerX]}`
    domCache.pointerY.textContent = `${source[sourceField.pointerY]}`
    const pressActive = source[sourceField.pressActive]!
    domCache.pressLamp.style.setProperty('--on', `${pressActive}`)
    domCache.pressX.textContent = `${source[sourceField.pressX]}`
    domCache.pressY.textContent = `${source[sourceField.pressY]}`
    domCache.pressX.style.setProperty('--lit', pressActive === 1 ? '1' : '0.35')
    domCache.pressY.style.setProperty('--lit', pressActive === 1 ? '1' : '0.35')
    domCache.onTitleLamp.style.setProperty('--on', `${source[sourceField.pressOnTitle]}`)
    domCache.wasFocusedLamp.style.setProperty('--on', `${source[sourceField.pressWasFocused]}`)
    domCache.onMaximizedLamp.style.setProperty('--on', `${source[sourceField.pressOnMaximized]}`)
    domCache.slopLamp.style.setProperty('--on', `${source[sourceField.slopLatch]}`)
    domCache.statLine.textContent =
      `${operationCount} ops · ${st.evalMicroseconds.toFixed(1)} µs/step`
      + ` · ${st.framesStepped.toLocaleString('en-US')} frames stepped`
    domCache.agreement.textContent =
      `circuit ≡ reference · ${st.framesStepped.toLocaleString('en-US')} frames`
      + ` · ${st.divergences} divergences`
    domCache.agreement.className = st.divergences > 0 ? 'agreement diverged' : 'agreement'
    domCache.autopilotToggle.textContent = st.autopilotOn ? 'autopilot on' : 'autopilot off'
    domCache.autopilotToggle.dataset['on'] = st.autopilotOn ? '1' : '0'
    domCache.slopValue.textContent = `${st.controls.slop}`
    domCache.titleValue.textContent = `${st.controls.titleHeight}`

    if (st.autopilotOn) scheduleRender()
  }

  // Event handlers only store raw input and schedule a render.
  domCache.stage.addEventListener('pointerdown', event => {
    if (st.activePointerId !== null) return
    st.activePointerId = event.pointerId
    domCache.stage.setPointerCapture(event.pointerId)
    // Manual input pauses the autopilot; the button turns it back on.
    st.autopilotOn = false
    st.autopilotQueue.length = 0
    st.pendingPointer.push({kind: 'down', clientX: event.clientX, clientY: event.clientY})
    scheduleRender()
  })
  domCache.stage.addEventListener('pointermove', event => {
    if (st.activePointerId !== null && event.pointerId !== st.activePointerId) return
    // Hover moves are legal input for the circuit, but while the autopilot is
    // driving they would yank its pointer around, so they only count when the
    // autopilot is off.
    if (st.autopilotOn) return
    const samples = event.getCoalescedEvents()
    appendPointerMoves(st.pendingPointer, samples.length > 0 ? samples : [event])
    scheduleRender()
  })
  const releasePointer = (event: PointerEvent) => {
    if (event.pointerId !== st.activePointerId) return
    st.activePointerId = null
    st.pendingPointer.push({kind: 'up', clientX: event.clientX, clientY: event.clientY})
    scheduleRender()
  }
  domCache.stage.addEventListener('pointerup', releasePointer)
  domCache.stage.addEventListener('pointercancel', releasePointer)

  domCache.autopilotToggle.addEventListener('click', () => {
    st.autopilotOn = !st.autopilotOn
    st.autopilotQueue.length = 0
    scheduleRender()
  })
  const readControls = () => {
    st.controls.slop = Number(domCache.slopInput.value)
    st.controls.titleHeight = Number(domCache.titleInput.value)
    st.controls.dragFromTitle = domCache.dragTitleInput.checked
    st.controls.dragFromBody = domCache.dragBodyInput.checked
    st.controls.clickTogglesFromTitle = domCache.toggleTitleInput.checked
    st.controls.clickTogglesFromBody = domCache.toggleBodyInput.checked
    scheduleRender()
  }
  for (const input of [domCache.dragTitleInput, domCache.dragBodyInput, domCache.toggleTitleInput, domCache.toggleBodyInput]) {
    input.addEventListener('change', readControls)
  }
  domCache.slopInput.addEventListener('input', readControls)
  domCache.titleInput.addEventListener('input', readControls)
  new ResizeObserver(scheduleRender).observe(domCache.stage)

  renderEventWindowDemo()
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  mountEventWindowDemo(document, window)
}
