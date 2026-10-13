// The DOM side of the Notes text. A textarea that is never shown holds what the
// visitor types: the characters, the caret, the selection, the undo history and an
// input method's composition are state the browser keeps. The host measures the
// textarea's value into segments and queues them for the program as an event, the
// program lays them out around the windows, and the host draws one span per word
// and a caret at the places the program outputs.
//
// mountWindowManager creates one host and calls it from its render function in the
// order of chenguini's ui.md: `read` at the top with the other DOM reads, `queueText`
// before the machine's step, `write` with the other DOM writes, and
// `applySideEffects` last.
import {type Wire, invariant} from '../runtime/numeric-ui-core.ts'
import {type NotesOutputs, bandOutputField, segmentOutputField} from './notes.ts'
import {type NotesOptions, notesFont} from './notes-paragraph.ts'
import {type MeasureText, type NotesLayout, type NotesText, caretPosition, prepareNotesText} from './notes-text.ts'
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
  initialValue: string,
  measure: MeasureText,
  scheduleRender: () => void,
) {
  // Static DOM, created once.
  const caret = document.createElement('div')
  caret.className = 'notes-caret'
  content.appendChild(caret)
  const input = document.createElement('textarea')
  input.className = 'notes-input'
  input.spellcheck = false
  input.autocapitalize = 'off'
  input.setAttribute('autocomplete', 'off')
  input.setAttribute('autocorrect', 'off')
  input.setAttribute('aria-label', 'Note')
  // The value is assigned once, here, which also leaves the caret at the end of the
  // text. Every later change is the browser's own, e.g. a typed character, a paste
  // or an undo. Assigning the value again would discard the browser's undo history.
  input.value = initialValue
  content.appendChild(input)

  const domCache = {
    input, // mount lifetime
    caret, // mount lifetime
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
  let text: NotesText = prepareNotesText(initialValue, notesFont, measure)
  let laidOutCells = machine.notesText(text.paragraph)
  // Transient input, reset at the end of every render: the time of the frame's last input event.
  const events = {inputTime: null as number | null}

  // The textarea's own events only store raw input and schedule a render, which reads the textarea.
  input.addEventListener('input', (event: Event) => {
    events.inputTime = event.timeStamp
    scheduleRender()
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
    // Whether a key event belongs to the note, i.e. the textarea has the focus. The browser then edits the text or
    // moves the caret by itself, so no other part of the page may take the key, e.g. Photos its arrow keys.
    takesKey(event: KeyboardEvent) {
      return event.target === domCache.input
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
      text = prepareNotesText(read.value, notesFont, measure)
      laidOutCells = machine.notesText(text.paragraph, events.inputTime ?? undefined)
    },

    // DOM writes, from the values of the frame's evaluation.
    write(read: NotesRead, values: Float32Array) {
      const layout = layoutOf(values)
      const notesFocused = values[wires.focused] === 1
      // The caret is drawn at the selection's moving end, like a textarea draws it.
      const caretPlace = caretPosition(text, laidOutCells, read.selectionBackward ? read.selectionStart : read.selectionEnd, layout, measure)

      // One node per word, i.e. per cell that doesn't break after itself. A space draws nothing.
      let node = 0
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
        node++
      }
      for (; node < domCache.wordNodes.length; node++) {
        const wordNode = domCache.wordNodes[node]!
        wordNode.style.display = 'none'
        wordNode.style.transform = 'translate3d(0px,0px,0)'
        wordNode.style.opacity = '0'
      }

      // The caret blinks from the start again whenever it moves: its two animations have the same keyframes, and
      // changing the animation's name restarts it, without a layout read.
      const place = caretPlace === null ? '' : `${caretPlace.x},${caretPlace.y}`
      if (place !== domCache.caretPlace) {
        domCache.caretPlace = place
        domCache.caretBlink = 1 - domCache.caretBlink
      }
      domCache.caret.style.display = notesFocused && caretPlace !== null ? 'block' : 'none'
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

    // Side effects: the keyboard focus follows the program. The textarea has the focus exactly while Notes is the
    // focused window, and the calls run only when they change what the browser holds. E.g. a press on the note
    // makes the browser blur the textarea, and this focuses it again in the frame of the press.
    applySideEffects(read: NotesRead, values: Float32Array) {
      const notesFocused = values[wires.focused] === 1
      if (notesFocused && !read.focused) domCache.input.focus({preventScroll: true})
      else if (!notesFocused && read.focused) domCache.input.blur()
      events.inputTime = null
    },
  }
}
