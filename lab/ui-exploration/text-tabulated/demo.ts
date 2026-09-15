// Browser demo: the Notes window. Prepare and tabulate with the browser's real canvas, compile the
// circuit, then every frame: decode the clock into step bits, run the circuit, and write its numbers
// onto DOM nodes. JS slices line text only when a line's cursors change.
// Run with: bun lab/ui-exploration/text-tabulated/demo.html
//
// Structure follows vibescript's ui.md: a DOM cache built once, event handlers that only store raw
// input and schedule a render, and one render function that reads, steps, then writes.

import {createNotesMachine, createStepClock, materializeSlot, notesLayout, prepareNotesBlocks, type NotesBlock} from './notes-machine.ts'
import {compareBlock} from './reference.ts'
import {createResizeTrace, type TraceFrame} from './resize-trace.ts'

type SlotDom = {element: HTMLDivElement, start: number, end: number}
type BlockDom = {bubble: HTMLDivElement | null, slots: SlotDom[]}

function requireElement<T extends HTMLElement>(document: Document, selector: string): T {
  const element = document.querySelector<T>(selector)
  if (element === null) throw new Error(`missing ${selector}`)
  return element
}

async function mountNotesDemo(document: Document, window: Window) {
  await document.fonts.ready
  const tabulateStarted = window.performance.now()
  const blocks = prepareNotesBlocks()
  const tabulateMilliseconds = window.performance.now() - tabulateStarted
  const machine = createNotesMachine(blocks)
  const stats = machine.stats()
  const thresholdCount = blocks.reduce((total, block) => total + block.table.thresholds.length, 0)

  const domCache = {
    window: requireElement<HTMLElement>(document, '#notes-window'),
    content: requireElement<HTMLElement>(document, '#notes-content'),
    ruler: requireElement<HTMLElement>(document, '#ruler'),
    rulerMarker: requireElement<HTMLElement>(document, '#ruler-marker'),
    stats: requireElement<HTMLElement>(document, '#panel-stats'),
    agreement: requireElement<HTMLElement>(document, '#panel-agreement'),
    autopilot: requireElement<HTMLButtonElement>(document, '#autopilot'),
    blocks: [] as BlockDom[],
  }
  const createSlots = (block: NotesBlock): SlotDom[] => Array.from({length: block.table.slotCount}, () => {
    const element = document.createElement('div')
    element.className = `notes-line notes-${block.kind === 'bubble' ? 'paragraph' : block.kind}${block.mine ? ' mine' : ''}`
    element.style.font = block.font
    element.style.lineHeight = `${block.lineHeight}px`
    domCache.content.appendChild(element)
    return {element, start: -1, end: -1}
  })
  for (const block of blocks) {
    let bubble: HTMLDivElement | null = null
    if (block.kind === 'bubble') {
      bubble = document.createElement('div')
      bubble.className = `notes-bubble${block.mine ? ' mine' : ''}`
      domCache.content.appendChild(bubble)
    }
    domCache.blocks.push({bubble, slots: createSlots(block)})
  }
  // Ruler ticks at window-edge positions where any block's line count changes.
  const tickXs = new Set<number>()
  for (const block of blocks) {
    block.table.thresholds.forEach((threshold, index) => {
      if (block.table.lineCount[index + 1] !== block.table.lineCount[index]) tickXs.add(Math.round(notesLayout.windowLeft + notesLayout.padding + threshold))
    })
  }
  for (const x of tickXs) {
    const tick = document.createElement('div')
    tick.className = 'ruler-tick'
    tick.style.transform = `translateX(${x}px)`
    domCache.ruler.appendChild(tick)
  }

  const clock = createStepClock(window.performance.now())
  let autopilot: {frames: TraceFrame[], index: number, seed: number} | null = null
  // Decisions (line counts, tight widths, cursors, line text) are counted apart from width drift: with real
  // fonts, delta rows add up width deltas that aren't exact in FP32, so widths drift by a few ulps.
  let checkedFrames = 0
  let decisionMismatchFrames = 0
  let lastDecisionProblem = ''
  let widestMaxLineWidthDrift = 0
  let widestLineXDrift = 0
  let evaluateMicroseconds = 0

  let scheduledRaf: number | null = null
  function scheduleRender() {
    if (scheduledRaf !== null) return
    scheduledRaf = window.requestAnimationFrame(render)
  }

  function render(now: number) {
    scheduledRaf = null
    // DOM reads
    machine.setViewportWidth(document.documentElement.clientWidth)
    // Autopilot feeds recorded pointer events, one trace frame per rendered frame.
    if (autopilot !== null) {
      const frame = autopilot.frames[autopilot.index++]
      if (frame === undefined) autopilot = {frames: createResizeTrace(autopilot.seed + 1, machine.readWindow().width), index: 0, seed: autopilot.seed + 1}
      else for (const event of frame.events) {
        if (event.kind === 'down') machine.pointerDown(event.x, event.y)
        else if (event.kind === 'move') machine.pointerMove(event.x)
        else machine.pointerUp(event.x)
      }
    }
    const evaluateStarted = window.performance.now()
    machine.step(clock(now))
    evaluateMicroseconds = evaluateMicroseconds * 0.9 + (window.performance.now() - evaluateStarted) * 1000 * 0.1
    const view = machine.readWindow()

    // DOM writes
    domCache.window.style.width = `${view.width}px`
    domCache.window.style.height = `${view.height}px`
    domCache.rulerMarker.style.transform = `translateX(${notesLayout.windowLeft + notesLayout.padding + view.contentWidth}px)`
    let problems: string[] = []
    blocks.forEach((block, index) => {
      const blockView = machine.readBlock(index)
      const dom = domCache.blocks[index]!
      if (dom.bubble !== null) {
        dom.bubble.style.width = `${blockView.bubbleWidth}px`
        dom.bubble.style.height = `${blockView.height}px`
        dom.bubble.style.transform = `translate(${blockView.bubbleX}px,${blockView.top}px)`
      }
      blockView.slots.forEach((slot, slotIndex) => {
        const slotDom = dom.slots[slotIndex]!
        if (slotDom.start !== slot.start || slotDom.end !== slot.end) {
          slotDom.start = slot.start
          slotDom.end = slot.end
          slotDom.element.textContent = materializeSlot(block, slot.start, slot.end)
        }
        slotDom.element.style.transform = `translate(${slot.x ?? 0}px,${slot.y}px)`
        slotDom.element.style.opacity = `${slot.opacity}`
      })
      const comparison = compareBlock(block, blockView, view.contentWidth)
      problems = problems.concat(comparison.decisionProblems)
      widestMaxLineWidthDrift = Math.max(widestMaxLineWidthDrift, comparison.maxLineWidthDrift)
      widestLineXDrift = Math.max(widestLineXDrift, comparison.lineXDrift)
    })
    checkedFrames++
    if (problems.length > 0) {
      decisionMismatchFrames++
      lastDecisionProblem = problems[0]!
    }
    domCache.stats.textContent =
      `${blocks.length} blocks, ${thresholdCount} thresholds, tabulated in ${tabulateMilliseconds.toFixed(0)} ms\n` +
      `${stats.liveOperations} live ops · ${stats.layers} layers · ${stats.storedWeights} weights\n` +
      `circuit ${evaluateMicroseconds.toFixed(0)} µs · content width ${view.contentWidth.toFixed(2)}px`
    domCache.agreement.textContent =
      `circuit vs pretext: ${checkedFrames} frames\n` +
      `${decisionMismatchFrames} with a wrong line count, tight width, cursor, or line text${lastDecisionProblem === '' ? '' : `\nlast: ${lastDecisionProblem}`}\n` +
      `widest maxLineWidth drift ${widestMaxLineWidthDrift.toExponential(1)}px\n` +
      `widest heading line x drift ${widestLineXDrift.toExponential(1)}px`
    domCache.autopilot.textContent = autopilot === null ? 'autopilot off' : 'autopilot on'
    if (view.animationActive > 0 || autopilot !== null) scheduleRender()
  }

  window.addEventListener('pointerdown', event => {
    machine.pointerDown(event.clientX, event.clientY)
    scheduleRender()
  })
  window.addEventListener('pointermove', event => {
    machine.pointerMove(event.clientX)
    scheduleRender()
  })
  window.addEventListener('pointerup', event => {
    machine.pointerUp(event.clientX)
    scheduleRender()
  })
  window.addEventListener('pointercancel', event => {
    machine.pointerUp(event.clientX)
    scheduleRender()
  })
  domCache.autopilot.addEventListener('pointerdown', event => event.stopPropagation())
  domCache.autopilot.addEventListener('click', () => {
    autopilot = autopilot === null ? {frames: createResizeTrace(1, machine.readWindow().width), index: 0, seed: 1} : null
    scheduleRender()
  })
  window.addEventListener('resize', scheduleRender)
  render(window.performance.now())
}

void mountNotesDemo(document, window)
