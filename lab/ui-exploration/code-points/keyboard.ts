// Turns browser input into editor events. Event handlers only append to a queue; the frame loop
// takes up to keysPerFrame events per evaluation. Key names follow KeyboardEvent.key with macOS
// modifiers: Option moves by word, Command by line or document. Text becomes code points, whether it
// comes from a typed key, a finished IME composition, or a paste.

import {codePointsOf} from './line-break-classes.ts'
import {type EditorEvent, type KeyKind, layoutKinds} from './reference.ts'

export type KeyInput = {
  key: string
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  // While an IME composes, e.g. pinyin before it commits 中文, its keys belong to the IME.
  isComposing?: boolean
}

export type PointerInput = {kind: 'pointerDown' | 'pointerDrag', shiftKey: boolean, x: number, y: number}

function movement(kind: KeyKind, shift: boolean): EditorEvent {
  return {kind, shift, codes: [], pointerX: 0, pointerY: 0}
}

// Returns null for keys the editor doesn't handle, so the browser keeps its default behavior.
export function eventsForKey(input: KeyInput, pasteLimit: number): EditorEvent[] | null {
  const {key, shiftKey: shift, altKey: option, metaKey: command, ctrlKey: control} = input
  if (input.isComposing === true) return null
  switch (key) {
    case 'ArrowLeft':
      return [movement(command ? 'lineStart' : option ? 'wordLeft' : 'left', shift)]
    case 'ArrowRight':
      return [movement(command ? 'lineEnd' : option ? 'wordRight' : 'right', shift)]
    case 'ArrowUp':
      return [movement(command ? 'documentStart' : 'up', shift)]
    case 'ArrowDown':
      return [movement(command ? 'documentEnd' : 'down', shift)]
    case 'Home':
      return [movement('lineStart', shift)]
    case 'End':
      return [movement('lineEnd', shift)]
    case 'Backspace':
      return [movement(option ? 'wordBackspace' : 'backspace', false)]
    case 'Delete':
      return [movement('delete', false)]
    case 'Enter':
      return eventsForText('\n', pasteLimit)
  }
  if ((command || control) && key.toLowerCase() === 'a') return [movement('selectAll', false)]
  if (command || control) return null
  if ([...key].length !== 1 && key !== ' ') return null
  return eventsForText(key, pasteLimit)
}

// Typing, composition and paste all insert code points; a text longer than pasteLimit becomes
// several events.
export function eventsForText(text: string, pasteLimit: number): EditorEvent[] {
  const codes = codePointsOf(text)
  const events: EditorEvent[] = []
  for (let start = 0; start < codes.length; start += pasteLimit) {
    events.push({kind: 'insert', shift: false, codes: codes.slice(start, start + pasteLimit), pointerX: 0, pointerY: 0})
  }
  return events
}

// Pointer coordinates are relative to the text box, in pixels.
export function eventForPointer(input: PointerInput, unitsPerPixel: number, maxWidthLimit: number): EditorEvent {
  return {
    kind: input.kind,
    shift: input.kind === 'pointerDown' && input.shiftKey,
    codes: [],
    pointerX: Math.min(maxWidthLimit, Math.max(0, Math.floor(input.x * unitsPerPixel))),
    pointerY: Math.min(2 ** 16, Math.max(0, Math.floor(input.y * unitsPerPixel))),
  }
}

// Takes events for one evaluation. Slots past layoutSlots have no layout before them, so a key that
// reads line geometry there ends the batch and waits for the next evaluation.
export function takeFrameEvents(queue: EditorEvent[], keysPerFrame: number, layoutSlots = keysPerFrame): EditorEvent[] {
  let count = 0
  while (count < keysPerFrame && count < queue.length && (count < layoutSlots || !layoutKinds.includes(queue[count]!.kind))) count++
  return queue.splice(0, count)
}
