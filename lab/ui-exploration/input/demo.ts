// Visual demo of the combined app: a menu bar, three windows, and a keypad,
// driven by one compiled circuit. Run with: bun lab/ui-exploration/input/demo.html
//
// Event handlers only store raw input and schedule a render. The render
// function reads the stage size, turns the frame's input into queued events,
// splits them into evaluations of at most 8 events, steps the circuit once per
// evaluation, judges every evaluation against the oracle, then writes the DOM.
// The circuit decides which element should have keyboard focus; this file only
// calls element.focus() when that output changes.

import {invariant} from '../../../numeric-ui-core.ts'
import {appItemSlots, appKeyCount, appKeyLabels, appMenuAnchors, appMenus, appOracleFrame, appWindows, createAppMachine, createAppState, type AppViewport} from './app.ts'
import {keyNameOf, legalizePointerStream, quantizeFrameDelta, splitIntoEvaluations, toQueuedEvents, type RawInput} from './input.ts'
import {measureProgram} from './kit.ts'

const capacity = 8

function mountInputQueueDemo(document: Document, window: Window) {
  const stageElement = document.querySelector<HTMLElement>('#stage')
  invariant(stageElement !== null, 'the demo stage is missing')
  const stage = stageElement

  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: HTMLElement) => {
    const node = document.createElement(tag)
    node.className = className
    parent.appendChild(node)
    return node
  }

  const initialViewport = readViewport()
  const machine = createAppMachine(capacity, initialViewport)
  const oracle = createAppState(initialViewport)
  const programSize = measureProgram(machine.circuit, machine.roots)

  // DOM cache, built once at mount.
  const menubar = element('div', 'bar menubar', stage)
  const statusbar = element('div', 'bar statusbar', stage)
  const statusText = element('span', 'status-text', statusbar)
  const titleButtons = appMenus.map((menu, index) => {
    const button = element('button', 'menu-title', index === appMenus.length - 1 ? statusbar : menubar)
    button.type = 'button'
    button.tabIndex = -1
    button.textContent = menu.title
    return button
  })
  const panel = element('div', 'menu-panel', stage)
  panel.hidden = true
  const itemButtons = Array.from({length: appItemSlots}, () => {
    const button = element('button', 'menu-item', panel)
    button.type = 'button'
    button.tabIndex = -1
    return button
  })
  const windows = appWindows.map(definition => {
    const root = element('section', 'window', stage)
    const title = element('div', 'window-title', root)
    title.textContent = definition.title
    const maximize = element('span', 'maximize-button', title)
    maximize.textContent = '□'
    const body = element('div', 'window-body', root)
    return {root, body}
  })
  const keys = Array.from({length: appKeyCount}, (_, index) => {
    const button = element('button', 'key', windows[0]!.body)
    button.type = 'button'
    button.tabIndex = -1
    const label = element('b', '', button)
    label.textContent = appKeyLabels[index]!
    const count = element('small', '', button)
    return {button, count}
  })
  windows[0]!.body.style.padding = '0'
  windows[1]!.body.innerHTML = '<p>Every pointer event and key press of a frame goes into a queue of 8 slots in the source table, and one circuit evaluation handles the whole queue in order.</p><p>Try: drag a title bar, move out past the slop distance and back before releasing a maximize button (no toggle), double-click a title, Tab into the menu bar and use the arrows, click a key and navigate the keypad with arrows, or open Layout at the bottom right (it opens upward).</p>'
  const inspector = element('pre', '', windows[2]!.body)
  const toast = element('div', 'toast', stage)
  toast.hidden = true
  toast.textContent = 'About: this page is one compiled numeric circuit (affine, ReGLU, and boolean atoms) evaluated once per queue of input events. JavaScript stores input, splits the queue, and writes the DOM.'

  const st = {
    pending: [] as RawInput[],
    activePointerId: null as number | null,
    pointerPressed: false,
    previousFrameTime: null as number | null,
    appliedFocusTarget: -1,
    evaluations: 0,
    frames: 0,
    divergences: 0,
    lastEvents: 0,
    lastEvaluations: 0,
    stepMicroseconds: 0,
    toastUntil: 0,
  }

  function readViewport(): AppViewport {
    return {
      width: Math.max(480, Math.min(4096, Math.round(stage.clientWidth))),
      height: Math.max(360, Math.min(4096, Math.round(stage.clientHeight))),
    }
  }

  let scheduledFrame: number | null = null
  function scheduleRender() {
    if (scheduledFrame !== null) return
    scheduledFrame = window.requestAnimationFrame(render)
  }

  function focusElementFor(target: number): HTMLElement | null {
    const menuCount = appMenus.length
    if (target < 0) return null
    if (target < menuCount) return titleButtons[target]!
    if (target < menuCount + menuCount * appItemSlots) return itemButtons[(target - menuCount) % appItemSlots]!
    return keys[target - menuCount - menuCount * appItemSlots]!.button
  }

  function render(now: number) {
    scheduledFrame = null

    // DOM reads.
    const bounds = stage.getBoundingClientRect()
    const viewport = readViewport()

    // Handle inputs: quantize at the boundary, keep the pointer stream legal,
    // and split into evaluations.
    const frameDelta = quantizeFrameDelta(now, st.previousFrameTime)
    st.previousFrameTime = now
    const queued = toQueuedEvents(st.pending, now, (clientX, clientY) => ({x: clientX - bounds.left, y: clientY - bounds.top}))
    st.pending.length = 0
    const legal = legalizePointerStream(queued, st.pointerPressed)
    st.pointerPressed = legal.pressed
    const evaluations = splitIntoEvaluations(legal.events, capacity)
    machine.writeViewport(viewport)
    let result = null as ReturnType<typeof machine.step> | null
    let aboutActivations = 0
    const startTime = performance.now()
    let judgeTime = 0
    evaluations.forEach((events, index) => {
      const delta = index === 0 ? frameDelta : 0
      result = machine.step(delta, events)
      const judgeStart = performance.now()
      const expected = appOracleFrame(viewport, oracle, delta, events)
      if (JSON.stringify(result.state) !== JSON.stringify(oracle) || JSON.stringify(result.outputs) !== JSON.stringify(expected)) st.divergences++
      judgeTime += performance.now() - judgeStart
      aboutActivations += result.outputs.aboutActivations
    })
    const stepMicroseconds = ((performance.now() - startTime - judgeTime) * 1000) / evaluations.length
    st.stepMicroseconds = st.frames === 0 ? stepMicroseconds : st.stepMicroseconds * 0.9 + stepMicroseconds * 0.1
    st.frames++
    st.evaluations += evaluations.length
    st.lastEvents = legal.events.length
    st.lastEvaluations = evaluations.length
    if (aboutActivations > 0) st.toastUntil = now + 4000
    const {state, outputs} = result!

    // DOM writes.
    const anchors = appMenuAnchors(viewport)
    titleButtons.forEach((button, index) => {
      const anchor = anchors[index]!
      button.style.left = `${anchor.left}px`
      button.style.width = `${anchor.width}px`
      button.dataset['open'] = state.menu.open === index ? '1' : '0'
      button.dataset['focused'] = state.menu.titleFocus === index && state.menu.open === -1 ? '1' : '0'
    })
    if (state.menu.open >= 0) {
      const placement = outputs.placements[state.menu.open]!
      const menu = appMenus[state.menu.open]!
      panel.hidden = false
      panel.style.left = `${placement.left}px`
      panel.style.top = `${placement.top}px`
      panel.style.width = `${placement.width}px`
      panel.style.height = `${placement.height}px`
      itemButtons.forEach((button, item) => {
        button.hidden = item >= menu.items.length
        button.textContent = menu.items[item] ?? ''
        button.dataset['enabled'] = menu.enabled[item] ? '1' : '0'
        button.dataset['highlighted'] = state.menu.highlight === item ? '1' : '0'
      })
    } else {
      panel.hidden = true
    }
    windows.forEach((view, index) => {
      const rectangle = outputs.windows.rectangles[index]!
      view.root.style.transform = `translate3d(${rectangle.left}px, ${rectangle.top}px, 0)`
      view.root.style.width = `${rectangle.width}px`
      view.root.style.height = `${rectangle.height}px`
      view.root.style.zIndex = `${10 + state.windows.rank[index]!}`
      view.root.dataset['focused'] = state.windows.focus === index ? '1' : '0'
      view.root.dataset['maximized'] = state.windows.maximized[index] ? '1' : '0'
      view.root.dataset['dragging'] = outputs.windows.dragOwner === index ? '1' : '0'
    })
    const keypadWindow = outputs.windows.rectangles[0]!
    keys.forEach((view, index) => {
      const rectangle = outputs.keyRectangles[index]!
      // Key rectangles are in stage coordinates; the keypad body starts 28px
      // below the window's top edge and 1px inside its border.
      view.button.style.left = `${rectangle.left - keypadWindow.left - 1}px`
      view.button.style.top = `${rectangle.top - keypadWindow.top - 29}px`
      view.button.style.width = `${rectangle.width}px`
      view.button.style.height = `${rectangle.height}px`
      view.button.dataset['focused'] = state.keypad.focus === index ? '1' : '0'
      view.button.dataset['pressed'] = state.keypad.pressedControl === index ? '1' : '0'
      view.button.dataset['enabled'] = state.keyEnabled[index] ? '1' : '0'
      view.count.textContent = `${state.keyCounts[index]}`
    })
    inspector.textContent = [
      `circuit: ${programSize.liveOperations.toLocaleString('en-US')} live operations`,
      `         ${programSize.layers} layers, ${programSize.weights.toLocaleString('en-US')} stored weights`,
      `queue capacity: ${capacity} events per evaluation`,
      `this frame: ${st.lastEvents} events, ${st.lastEvaluations} evaluation${st.lastEvaluations === 1 ? '' : 's'}`,
      `step: ${st.stepMicroseconds.toFixed(0)} µs per evaluation (with JS reads)`,
      `frames ${st.frames}, evaluations ${st.evaluations}`,
      `circuit ≡ oracle, divergences: ${st.divergences}`,
      `focus target: ${outputs.focusTarget}`,
      `window focus ${state.windows.focus}, ranks ${state.windows.rank.join(' ')}`,
      `menu open ${state.menu.open}, highlight ${state.menu.highlight}, title focus ${state.menu.titleFocus}`,
    ].join('\n')
    statusText.textContent = `${st.lastEvents} events · ${st.lastEvaluations} evaluation · ${st.divergences} divergences`
    toast.hidden = now > st.toastUntil

    // Side effects: move DOM focus only when the circuit's output changes.
    if (outputs.focusTarget !== st.appliedFocusTarget) {
      st.appliedFocusTarget = outputs.focusTarget
      const target = focusElementFor(outputs.focusTarget)
      if (target === null) (document.activeElement as HTMLElement | null)?.blur()
      else target.focus({preventScroll: true})
    }
    if (!toast.hidden) scheduleRender()
  }

  // Event handlers only store raw input and schedule a render.
  stage.addEventListener('pointerdown', event => {
    if (st.activePointerId !== null) return
    st.activePointerId = event.pointerId
    stage.setPointerCapture(event.pointerId)
    // Keeps the browser from moving focus on press; the circuit decides focus.
    event.preventDefault()
    st.pending.push({kind: 'down', clientX: event.clientX, clientY: event.clientY, timeStamp: event.timeStamp})
    scheduleRender()
  })
  stage.addEventListener('pointermove', event => {
    if (st.activePointerId !== null && event.pointerId !== st.activePointerId) return
    const samples = event.getCoalescedEvents()
    for (const sample of samples.length > 0 ? samples : [event]) {
      st.pending.push({kind: 'move', clientX: sample.clientX, clientY: sample.clientY, timeStamp: sample.timeStamp})
    }
    scheduleRender()
  })
  const release = (event: PointerEvent) => {
    if (event.pointerId !== st.activePointerId) return
    st.activePointerId = null
    st.pending.push({kind: 'up', clientX: event.clientX, clientY: event.clientY, timeStamp: event.timeStamp})
    scheduleRender()
  }
  stage.addEventListener('pointerup', release)
  stage.addEventListener('pointercancel', release)
  window.addEventListener('keydown', event => {
    const key = keyNameOf(event.key)
    if (key === null) return
    // Must be decided inside the handler, before the circuit runs.
    event.preventDefault()
    st.pending.push({kind: 'key', key, shift: event.shiftKey, timeStamp: event.timeStamp})
    scheduleRender()
  })
  window.addEventListener('resize', scheduleRender)

  render(performance.now())
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  mountInputQueueDemo(document, window)
}
