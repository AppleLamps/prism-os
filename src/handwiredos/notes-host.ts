// The DOM side of the Notes text. A textarea that is never shown holds what the
// visitor types: the characters, the caret, the selection, the undo history and an
// input method's composition are state the browser keeps. The host measures the
// textarea's value into segments and queues them for the program as an event, the
// program lays them out around the windows, and the host draws one span per word,
// the selection and a caret at the places the program outputs.
//
// A press places the caret. The program decides whether a press is on the note, the
// way it decides every press: against the window's destination rectangle and the
// stacking order, see notesContentPress in window-manager.ts. It stores a count of
// such presses and the last one's point in the content box. When a frame's count
// differs from the frame before, the host finds the character at that point, in the
// layout of that frame, i.e. after the press raised Notes and the text reflowed, and
// moves the textarea's caret there. So the caret lands on the character that ends up
// under the pointer, like a Photos click lands on the photo that ends up there.
//
// The textarea's own text is one long line, so the keys that move the caret by
// lines are the host's: ArrowUp, ArrowDown, Home, End, and Command with ArrowLeft or
// ArrowRight. The keydown handler prevents the browser's move and stores the key,
// and the frame moves the caret by the lines that the program laid out. Every
// other key is the browser's, e.g. ArrowLeft, Backspace and the keys that type.
//
// The flow's capacities are fixed, and the note says so when a text passes one: a
// line above the text tells the visitor that the text has more segments than the
// program has cells, that the last words have no free line, or that a line wrapped
// early, see notesNotice. A note is one paragraph: Enter inserts nothing, and a
// pasted line break is laid out as a space.
//
// mountWindowManager creates one host and calls it from its render function in the
// order of chenguini's ui.md: `read` at the top with the other DOM reads, `queueText`
// before the machine's step, `write` with the other DOM writes, and
// `applySideEffects` last.
import {type Wire, invariant} from '../runtime/numeric-ui-core.ts'
import {type NotesOutputs, bandOutputField, segmentOutputField} from './notes.ts'
import {type NotesOptions, notesFont} from './notes-paragraph.ts'
import {
  type LineMove,
  type MeasureText,
  type NotesLayout,
  type NotesText,
  type NotesTextLimits,
  caretPosition,
  notesNotice,
  offsetAfterLineMove,
  offsetAtPoint,
  prepareNotesText,
  selectionSpans,
} from './notes-text.ts'
import type {FastParagraph} from './notes-walker.ts'

// The wires that the host reads from a frame's values: Notes' own outputs, and three
// outputs of the Notes window.
export type NotesHostWires = {
  notes: NotesOutputs
  // 1 while Notes is the focused window, i.e. the frontmost visible one.
  focused: Wire
  // The content box's size at the window's destination.
  contentWidth: Wire
  contentHeight: Wire
}

// What a frame reads from the textarea, with the other DOM reads.
export type NotesRead = {
  value: string
  selectionStart: number
  selectionEnd: number
  // Whether the selection's moving end is its start, e.g. after Shift+ArrowLeft.
  selectionBackward: boolean
  // Whether the textarea has the keyboard focus.
  focused: boolean
}

// The line move that a key asks for, or null for a key that the textarea handles by itself. During an input
// method's composition the arrow keys belong to the input method.
function lineMoveOf(event: KeyboardEvent): LineMove | null {
  if (event.isComposing || event.altKey || event.ctrlKey) return null
  if (event.metaKey) return event.key === 'ArrowLeft' ? 'lineStart' : event.key === 'ArrowRight' ? 'lineEnd' : null
  switch (event.key) {
    case 'ArrowUp':
      return 'up'
    case 'ArrowDown':
      return 'down'
    case 'Home':
      return 'lineStart'
    case 'End':
      return 'lineEnd'
    default:
      return null
  }
}

// The most characters that the textarea holds, about 25 times what the program's 256 cells lay out. A frame measures
// the whole value when it changed, so the length is limited to keep that within the frame, e.g. after a paste of a
// whole book. The browser refuses typed and pasted characters past this length.
const longestValue = 20_000

// A function that measures a string in `font` with a canvas, for the caret's place inside a word.
export function createCanvasMeasure(document: Document, font: string): MeasureText {
  const context = document.createElement('canvas').getContext('2d')
  invariant(context !== null, 'the page has no 2d canvas to measure text with')
  context.font = font
  return text => context.measureText(text).width
}

export function createNotesHost(
  document: Document,
  // The Notes window's content box, the positioned parent of every node below.
  content: HTMLElement,
  machine: {notesText(paragraph: FastParagraph, timeStamp?: number): number},
  wires: NotesHostWires,
  options: NotesOptions,
  limits: NotesTextLimits,
  initialValue: string,
  measure: MeasureText,
  scheduleRender: () => void,
) {
  // Static DOM, created once. The selection's rectangles come first, so the words are drawn over them.
  const selections = Array.from({length: options.bands}, () => {
    const selection = document.createElement('div')
    selection.className = 'notes-selection'
    content.appendChild(selection)
    return selection
  })
  const caret = document.createElement('div')
  caret.className = 'notes-caret'
  content.appendChild(caret)
  const notice = document.createElement('div')
  notice.className = 'notes-notice'
  content.appendChild(notice)
  const input = document.createElement('textarea')
  input.className = 'notes-input'
  input.spellcheck = false
  input.autocapitalize = 'off'
  input.setAttribute('autocomplete', 'off')
  input.setAttribute('autocorrect', 'off')
  input.setAttribute('aria-label', 'Note')
  input.maxLength = longestValue
  // The value is assigned once, here, which also leaves the caret at the end of the
  // text. Every later change is the browser's own, e.g. a typed character, a paste
  // or an undo. Assigning the value again would discard the browser's undo history.
  input.value = initialValue
  content.appendChild(input)

  const domCache = {
    input, // mount lifetime
    caret, // mount lifetime
    selections, // mount lifetime: one rectangle per band, shown while the band's line holds selected text
    notice, // mount lifetime
    noticeText: '', // the text last written into the notice, so that textContent is written only when it changes
    // One node per word, in the text's order. Created when a text first needs them, then kept for the mount's
    // lifetime: a node past the text's last word is hidden, and shown again when a longer text needs it.
    wordNodes: [] as HTMLElement[],
    // The text last written into each word node, so that textContent is written only when it changes.
    wordTexts: [] as string[],
    // The caret's last place, and which of the two blink animations it runs, see write.
    caretPlace: '',
    caretBlink: 0,
  }

  // The text that the program's cells hold, or will hold after the queued event, and how many of its cells the
  // program has room for. The first text is queued before the machine's first step, so it commits with the mount.
  let text: NotesText = prepareNotesText(initialValue, notesFont, limits, measure)
  let laidOutCells = machine.notesText(text.paragraph)
  // Transient input, reset at the end of every render: the time of the frame's last input event, and the frame's
  // line move keys in order, each with whether Shift was held, which extends the selection.
  const events = {inputTime: null as number | null, lineMoves: [] as {move: LineMove, extend: boolean}[]}
  // The program's count of presses on the note as of the last frame, or null before the first frame.
  let seenPressCount: number | null = null
  // The selection that this frame's press or line moves ask for, which applySideEffects writes into the textarea.
  let placedSelection: {start: number, end: number, backward: boolean} | null = null
  // Where the last up or down move left the caret, and the x that the move aimed for. The next up or down move
  // from that offset aims for the same x.
  let verticalRun: {offset: number, x: number} | null = null

  // The textarea's own events only store raw input and schedule a render, which reads the textarea.
  input.addEventListener('input', (event: Event) => {
    events.inputTime = event.timeStamp
    scheduleRender()
  })
  // A note is one paragraph, so Enter inserts nothing. The browser asks before it inserts a line break, and the
  // answer has to come from the handler. A pasted line break still arrives, and is laid out as a space.
  input.addEventListener('beforeinput', (event: Event) => {
    const {inputType} = event as InputEvent
    if (inputType === 'insertLineBreak' || inputType === 'insertParagraph') event.preventDefault()
  })
  // A caret that moves without a change of the text, e.g. after Select All from the browser's menu. Chrome and Safari
  // dispatch selectionchange at the document, and Firefox at the textarea.
  input.addEventListener('selectionchange', scheduleRender)
  document.addEventListener('selectionchange', scheduleRender)

  const layoutOf = (values: Float32Array): NotesLayout => ({
    lineHeight: options.lineHeight,
    padding: options.padding,
    bands: options.bands,
    cell(cell) {
      const start = cell * segmentOutputField.size
      const read = (field: number) => values[wires.notes.segments[start + field]!]!
      return {x: read(segmentOutputField.x), y: read(segmentOutputField.y), visible: read(segmentOutputField.visible) === 1}
    },
    band(band) {
      const start = band * bandOutputField.size
      const read = (field: number) => values[wires.notes.bands[start + field]!]!
      return {usable: read(bandOutputField.usable) === 1, left: read(bandOutputField.left), width: read(bandOutputField.width)}
    },
  })

  return {
    // Whether a key event belongs to the note, i.e. the textarea has the focus. No other part of the page may then
    // take the key, e.g. Photos its arrow keys. The browser edits the text or moves the caret by itself, except for
    // a line move, which is stored for the frame. preventDefault has to run here, in the handler.
    takesKey(event: KeyboardEvent) {
      if (event.target !== domCache.input) return false
      const move = lineMoveOf(event)
      if (move !== null) {
        event.preventDefault()
        events.lineMoves.push({move, extend: event.shiftKey})
      }
      return true
    },

    // DOM reads: the state that the browser keeps for the textarea.
    read(): NotesRead {
      return {
        value: domCache.input.value,
        selectionStart: domCache.input.selectionStart,
        selectionEnd: domCache.input.selectionEnd,
        selectionBackward: domCache.input.selectionDirection === 'backward',
        focused: document.activeElement === domCache.input,
      }
    },

    // Handle inputs: a changed value reaches the program as one event, at the time of the frame's last input event.
    // Without an input event, e.g. after the browser restored a form, the event applies at the frame's time.
    queueText(read: NotesRead) {
      if (read.value === text.value) return
      text = prepareNotesText(read.value, notesFont, limits, measure)
      laidOutCells = machine.notesText(text.paragraph, events.inputTime ?? undefined)
    },

    // DOM writes, from the values of the frame's evaluation.
    write(read: NotesRead, values: Float32Array) {
      const layout = layoutOf(values)
      const notesFocused = values[wires.focused] === 1
      // The selection as this frame draws it: what the frame read from the textarea, then moved by the frame's
      // inputs. The textarea gets the moved selection in applySideEffects.
      let selection = {start: read.selectionStart, end: read.selectionEnd, backward: read.selectionBackward}
      // A press on the note since the last frame places the caret at the character under the press's point.
      const pressCount = values[wires.notes.press.count]!
      const pressed = seenPressCount !== null && pressCount !== seenPressCount
      seenPressCount = pressCount
      if (pressed) {
        const offset = offsetAtPoint(text, laidOutCells, layout, measure, values[wires.notes.press.x]!, values[wires.notes.press.y]!)
        selection = {start: offset, end: offset, backward: false}
      }
      // Each line move key moves the selection's moving end by the laid-out lines, and the other end with it
      // unless Shift was held.
      for (const {move, extend} of events.lineMoves) {
        const moving = selection.backward ? selection.start : selection.end
        const fixed = selection.backward ? selection.end : selection.start
        const vertical = move === 'up' || move === 'down'
        const preferredX = vertical && verticalRun !== null && verticalRun.offset === moving ? verticalRun.x : null
        const moved = offsetAfterLineMove(text, laidOutCells, moving, move, preferredX, layout, measure)
        verticalRun = vertical ? moved : null
        const anchor = extend ? fixed : moved.offset
        selection = {start: Math.min(anchor, moved.offset), end: Math.max(anchor, moved.offset), backward: moved.offset < anchor}
      }
      placedSelection = pressed || events.lineMoves.length > 0 ? selection : null
      const selected = notesFocused && selection.end > selection.start
      const spans = selectionSpans(text, laidOutCells, selection.start, selection.end, layout, measure)
      // The caret is the selection's moving end, like a textarea's, and isn't drawn while text is selected.
      const caretPlace = caretPosition(text, laidOutCells, selection.backward ? selection.start : selection.end, layout, measure)

      // One node per word, i.e. per cell that doesn't break after itself. A space draws nothing.
      let node = 0
      let hiddenWords = 0
      for (let cell = 0; cell < Math.min(laidOutCells, text.cellTexts.length); cell++) {
        if (text.paragraph.breakAfter[cell] === 1) continue
        let wordNode = domCache.wordNodes[node]
        if (wordNode === undefined) {
          wordNode = document.createElement('span')
          wordNode.className = 'notes-word'
          content.appendChild(wordNode)
          domCache.wordNodes.push(wordNode)
          domCache.wordTexts.push('')
        }
        const cellText = text.cellTexts[cell]!
        if (domCache.wordTexts[node] !== cellText) {
          wordNode.textContent = cellText
          domCache.wordTexts[node] = cellText
        }
        const place = layout.cell(cell)
        wordNode.style.display = 'block'
        wordNode.style.transform = `translate3d(${place.x}px,${place.y}px,0)`
        wordNode.style.opacity = place.visible ? '1' : '0'
        if (!place.visible) hiddenWords++
        node++
      }
      for (; node < domCache.wordNodes.length; node++) {
        const wordNode = domCache.wordNodes[node]!
        wordNode.style.display = 'none'
        wordNode.style.transform = 'translate3d(0px,0px,0)'
        wordNode.style.opacity = '0'
      }

      // The notice names each capacity that the text passes, see notesNotice.
      const noticeText = notesNotice({
        segments: text.cellTexts.length,
        capacity: options.capacity,
        hiddenWords,
        wrappedLines: values[wires.notes.windowOverflow]!,
        window: options.window,
      })
      if (noticeText !== domCache.noticeText) {
        domCache.notice.textContent = noticeText
        domCache.noticeText = noticeText
      }
      domCache.notice.style.display = noticeText === '' ? 'none' : 'block'

      domCache.selections.forEach((selection, band) => {
        const span = selected ? spans[band] ?? null : null
        selection.style.display = span === null ? 'none' : 'block'
        selection.style.transform = `translate3d(${span?.left ?? 0}px,${options.padding + band * options.lineHeight}px,0)`
        selection.style.width = `${span === null ? 0 : span.right - span.left}px`
      })

      // The caret blinks from the start again whenever it moves: its two animations have the same keyframes, and
      // changing the animation's name restarts it, without a layout read.
      const place = caretPlace === null ? '' : `${caretPlace.x},${caretPlace.y}`
      if (place !== domCache.caretPlace) {
        domCache.caretPlace = place
        domCache.caretBlink = 1 - domCache.caretBlink
      }
      domCache.caret.style.display = notesFocused && !selected && caretPlace !== null ? 'block' : 'none'
      domCache.caret.style.transform = `translate3d(${caretPlace?.x ?? 0}px,${caretPlace?.y ?? 0}px,0)`
      domCache.caret.style.animationName = domCache.caretBlink === 1 ? 'notes-caret-blink-a' : 'notes-caret-blink-b'

      // The textarea follows the caret, so that an input method opens its candidate window there, and stays inside
      // the content box, since the browser scrolls a box to show the focused textarea when the box cuts it off.
      const contentWidth = values[wires.contentWidth]!
      const contentHeight = values[wires.contentHeight]!
      const inputX = Math.max(0, Math.min(caretPlace?.x ?? 0, contentWidth - 1))
      const inputY = Math.max(0, Math.min(caretPlace?.y ?? 0, contentHeight - options.lineHeight))
      domCache.input.style.transform = `translate3d(${inputX}px,${inputY}px,0)`
    },

    // Side effects: the textarea's selection goes where a press or a line move placed it, and the keyboard focus
    // follows the program. The textarea has the focus exactly while Notes is the focused window, and the calls run
    // only when they change what the browser holds. E.g. a press on the note makes the browser blur the textarea,
    // and this focuses it again in the frame of the press.
    applySideEffects(read: NotesRead, values: Float32Array) {
      if (placedSelection !== null) {
        const {start, end, backward} = placedSelection
        if (start !== read.selectionStart || end !== read.selectionEnd || (end > start && backward !== read.selectionBackward)) {
          domCache.input.setSelectionRange(start, end, end === start ? 'none' : backward ? 'backward' : 'forward')
        }
      }
      placedSelection = null
      events.lineMoves = []
      const notesFocused = values[wires.focused] === 1
      if (notesFocused && !read.focused) domCache.input.focus({preventScroll: true})
      else if (!notesFocused && read.focused) domCache.input.blur()
      events.inputTime = null
    },
  }
}
