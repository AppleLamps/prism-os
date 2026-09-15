// Browser demo: projects the thread circuit onto the DOM, in the shape of hn.js's render.
// JS reads the DOM (window size, scrollTop, pointer), writes the source table, runs
// the circuit, and formats outputs into styles. JS keeps what isn't numbers:
// comment innerHTML, links, native text selection, and drawing gutter lines.
// Breakpoints come from pretext with the browser's real canvas measurements, but
// the comment text itself is laid out natively by the browser from innerHTML, so a
// comment can occasionally be a line taller or shorter than pretext predicted.

import {thread} from './hn-data.ts'
import {prepareThread, initialThreadState} from './thread-prepare.ts'
import {buildThreadCircuit, createThreadMachine, demoOffsets, programStats} from './thread-circuit.ts'
import {cursorNames, type FrameInputs} from './thread-frame.ts'
import {commentWidthAt} from './text-heights.ts'
import {threadLayout} from './thread-model.ts'

const slotCount = 48
const textGray = '#5c5c5c'
const emphasisColor = 'hsl(37deg 25% 75%)'
const emphasisNoneColor = 'hsl(37deg 33% 87%)'

const statusNode = document.getElementById('status')!

await new Promise(resolve => setTimeout(resolve, 0))
const prepared = prepareThread(thread.comments)
const buildStart = performance.now()
const built = buildThreadCircuit({tables: prepared.tables, staircases: prepared.staircases}, {slotCount, slotMode: 'rank', naturalPrefix: 'brent-kung', visualPrefix: 'fold'})
const stats = programStats(built, built.demoRoots)
const machine = createThreadMachine(built, initialThreadState(prepared, window.innerWidth), built.demoRoots)
const setupMilliseconds = performance.now() - buildStart
const offsets = demoOffsets(built)
statusNode.remove()

// === static DOM
const container = document.createElement('div')
container.className = 'thread-container'
const submissionLines = document.createElement('div')
submissionLines.className = 'submission-lines'
const submissionLine1 = document.createElement('div')
submissionLine1.className = 'submission-line-1'
const submissionArrow = document.createElement('div')
submissionArrow.textContent = '▲'
submissionArrow.style.color = textGray
submissionArrow.style.fontSize = '9pt'
const submissionTitle = document.createElement('div')
submissionTitle.textContent = thread.title
const submissionLink = document.createElement('a')
submissionLink.textContent = `(${thread.link})`
submissionLink.style.color = textGray
submissionLine1.append(submissionArrow, submissionTitle, submissionLink)
const submissionLine2 = document.createElement('div')
submissionLine2.className = 'submission-line-2'
submissionLine2.textContent = `${thread.points} points by ${thread.submitter} on ${thread.submissionDate} | ${thread.comments.length} comments`
submissionLines.append(submissionLine1, submissionLine2)
const commentsScroller = document.createElement('div')
commentsScroller.className = 'comments-scroller'
const commentsDisplay = document.createElement('div')
commentsDisplay.className = 'comments-display'
const placeholder = document.createElement('div')
commentsScroller.append(commentsDisplay, placeholder)
container.append(submissionLines, commentsScroller)
const canvas = document.createElement('canvas')
canvas.className = 'gutters'
const canvasContext = canvas.getContext('2d')!
const statsNode = document.createElement('div')
statsNode.className = 'stats'
document.body.append(container, canvas, statsNode)

// === per-row DOM nodes, created the first time a row gets a slot (cache lifetime: the page)
type RowNodes = {user: HTMLDivElement, userText: HTMLDivElement, comment: HTMLDivElement, collapsedShown: number}
const rowNodes = new Map<number, RowNodes>()
const attachedRows = new Set<number>()

function bannerText(row: number, collapsed: number) {
  const comment = thread.comments[row]!
  const toggle = collapsed === 1 ? `[+${prepared.tables.descendantCounts[row]! + 1}]` : '[–]'
  return `▲ ${comment.user} ${comment.age} ${toggle}`
}

// comment-doc.ts counts an 8 px gap between consecutive blocks and none before the first block. HN comments usually
// start with plain text and put later paragraphs in <p>, e.g. `First paragraph<p>Second paragraph`, and there the
// first <p> is the second block, so it keeps its 8 px top margin. Only a <p> or <pre> with no visible text before it
// is the first block and loses the margin (the `.leading-block` rule in demo.css). A CSS `:first-child` rule can't
// tell these apart, because it ignores text nodes.
function markLeadingBlock(comment: HTMLElement) {
  for (const node of comment.childNodes) {
    if (node instanceof HTMLElement && (node.tagName === 'P' || node.tagName === 'PRE')) {
      node.classList.add('leading-block')
      return
    }
    if ((node.textContent ?? '').trim() !== '') return
  }
}

function nodesFor(row: number): RowNodes {
  let nodes = rowNodes.get(row)
  if (nodes !== undefined) return nodes
  const indentsWidth = prepared.tables.indents[row]! * threadLayout.indentWidth
  const user = document.createElement('div')
  user.className = 'user'
  user.style.left = `${indentsWidth}px`
  const userText = document.createElement('div')
  userText.className = 'user-text'
  userText.textContent = bannerText(row, 0)
  user.append(userText)
  const comment = document.createElement('div')
  comment.className = 'comment'
  comment.style.left = `${indentsWidth + threadLayout.commentLeftGap}px`
  comment.innerHTML = thread.comments[row]!.comment
  markLeadingBlock(comment)
  nodes = {user, userText, comment, collapsedShown: 0}
  rowNodes.set(row, nodes)
  return nodes
}

// === inputs: event callbacks only record raw input and schedule a render
const inputs: FrameInputs = {windowWidth: window.innerWidth, windowHeight: window.innerHeight, scrollTopReal: 0, pointerX: 0, pointerY: 0, pointerDown: 0, click: 0}
let scheduled = false
function scheduleRender() {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(render)
}
const pointerUp = () => {
  inputs.pointerDown = 0
  scheduleRender()
}
window.addEventListener('resize', scheduleRender)
window.addEventListener('scroll', scheduleRender, true)
window.addEventListener('mouseup', pointerUp)
window.addEventListener('touchend', pointerUp)
window.addEventListener('contextmenu', pointerUp)
window.addEventListener('pointermove', event => {
  inputs.pointerX = event.pageX
  inputs.pointerY = event.pageY
  scheduleRender()
})
window.addEventListener('mousedown', event => {
  inputs.pointerDown = 1
  inputs.pointerX = event.pageX
  inputs.pointerY = event.pageY
  scheduleRender()
})
window.addEventListener('click', event => {
  inputs.click = 1
  inputs.pointerX = event.pageX
  inputs.pointerY = event.pageY
  scheduleRender()
})

let stepMicroseconds = 0
const visibleRows = new Set<number>()

function render() {
  scheduled = false
  // === DOM reads
  inputs.windowWidth = window.innerWidth
  inputs.windowHeight = window.innerHeight
  inputs.scrollTopReal = commentsScroller.scrollTop
  const devicePixelRatio = window.devicePixelRatio

  // === the circuit
  const stepStart = performance.now()
  const out = machine.step(inputs)
  stepMicroseconds = stepMicroseconds * 0.9 + (performance.now() - stepStart) * 1000 * 0.1
  inputs.click = 0
  const global = (field: keyof typeof offsets.global) => out[offsets.global[field]]!

  // === DOM writes
  const containerWidth = global('containerWidth')
  const containerLeft = global('containerLeft')
  const containerHeight = global('containerHeight')
  const scrollerTop = global('scrollerTop')
  const scrollerHeight = global('scrollerHeight')
  container.style.left = `${containerLeft}px`
  container.style.top = `${threadLayout.currentContainerTop}px`
  container.style.width = `${containerWidth}px`
  container.style.height = `${containerHeight}px`
  submissionLines.style.width = `${containerWidth}px`
  submissionLines.style.height = `${scrollerTop}px`
  const submissionFadeOpacity = 1 - global('submissionHeight') / global('scrollerPeekUp')
  submissionLines.style.maskImage = `linear-gradient(0deg, rgba(0, 0, 0, ${Number.isFinite(submissionFadeOpacity) ? submissionFadeOpacity : 0}) 0%, rgba(0, 0, 0, 1) 20px)`
  submissionLine1.style.top = `${global('submissionLine1Top')}px`
  submissionLine2.style.top = `${global('submissionLine2Top')}px`
  commentsScroller.style.top = `${scrollerTop}px`
  commentsScroller.style.width = `${containerWidth}px`
  commentsScroller.style.height = `${scrollerHeight}px`
  commentsDisplay.style.height = `${scrollerHeight}px`
  placeholder.style.height = `${Math.max(0, global('placeholderHeight') - scrollerHeight)}px`

  visibleRows.clear()
  let slotsUsed = 0
  for (let slot = 0; slot < slotCount; slot++) {
    if (out[offsets.slot.present + slot] !== 1) continue
    slotsUsed++
    const row = out[offsets.slot.row + slot]!
    visibleRows.add(row)
    const nodes = nodesFor(row)
    if (!attachedRows.has(row)) {
      commentsDisplay.append(nodes.user, nodes.comment)
      attachedRows.add(row)
    }
    const collapsed = out[offsets.slot.collapsed + slot]!
    if (collapsed !== nodes.collapsedShown) {
      nodes.userText.textContent = bannerText(row, collapsed)
      nodes.collapsedShown = collapsed
    }
    nodes.user.style.top = `${out[offsets.slot.userTop + slot]}px`
    nodes.user.style.height = `${out[offsets.slot.userHeight + slot]}px`
    nodes.user.style.opacity = String(out[offsets.slot.userOpacity + slot])
    nodes.user.style.backgroundColor = out[offsets.slot.emphasis + slot] === 1 ? emphasisColor : emphasisNoneColor
    nodes.userText.style.opacity = String(out[offsets.slot.userTextOpacity + slot])
    nodes.comment.style.top = `${out[offsets.slot.commentTop + slot]}px`
    nodes.comment.style.height = `${out[offsets.slot.commentHeight + slot]}px`
    nodes.comment.style.width = `${commentWidthAt(containerWidth, prepared.tables.indents[row]!)}px`
    nodes.comment.style.maskImage = `linear-gradient(0deg, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 1) ${out[offsets.slot.commentFadeSize + slot]}px)`
  }
  for (const row of attachedRows) {
    if (visibleRows.has(row)) continue
    const nodes = rowNodes.get(row)!
    nodes.user.remove()
    nodes.comment.remove()
    attachedRows.delete(row)
  }

  // gutters: canvas lines from the per-row gutter outputs
  canvas.width = window.innerWidth * devicePixelRatio
  canvas.height = window.innerHeight * devicePixelRatio
  canvasContext.scale(devicePixelRatio, devicePixelRatio)
  const rowCount = built.rowCount
  const containerBottom = threadLayout.currentContainerTop + containerHeight
  for (let row = 0; row < rowCount; row++) {
    if (out[offsets.gutter.gutterVisible + row] !== 1) continue
    const indent = prepared.tables.indents[row]!
    const left = indent * threadLayout.indentWidth + 0.5 + containerLeft
    const top = out[offsets.gutter.gutterTop + row]! + scrollerTop + threadLayout.currentContainerTop
    const bottom = Math.min(out[offsets.gutter.gutterBottom + row]! + scrollerTop + threadLayout.currentContainerTop, containerBottom - (indent === 0 ? threadLayout.containerBorderRadius : 0))
    canvasContext.strokeStyle = out[offsets.gutter.gutterEmphasis + row] === 1 ? emphasisColor : emphasisNoneColor
    canvasContext.beginPath()
    canvasContext.moveTo(left, Math.max(top, threadLayout.currentContainerTop + scrollerTop))
    canvasContext.lineTo(left, bottom)
    canvasContext.stroke()
  }

  const cursorCode = global('cursorCode')
  document.body.style.cursor = cursorCode === 1 ? '' : cursorNames[cursorCode] ?? ''

  statsNode.textContent = [
    `${rowCount} comments, ${stats.liveOperations.toLocaleString()} live operations, ${stats.layers} layers`,
    `${stats.storedWeights.toLocaleString()} stored weights, ${built.comparisonCount.toLocaleString()} comparisons`,
    `slots ${slotsUsed}/${slotCount}${global('slotOverflow') === 1 ? ' (overflow)' : ''}, step ${stepMicroseconds.toFixed(0)}µs`,
    `setup ${setupMilliseconds.toFixed(0)}ms, breakpoints ${prepared.tabulateMilliseconds.toFixed(0)}ms`,
  ].join('\n')

  if (global('scheduleNextRender') === 1) scheduleRender()
}

render()
