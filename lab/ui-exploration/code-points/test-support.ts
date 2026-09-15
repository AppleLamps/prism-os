// Shared random inputs for the differential tests and the report.

import {classOfCodePoint, LB} from './line-break-classes.ts'
import type {EditorConfig, EditorEvent, FieldGeometry, KeyKind} from './reference.ts'

export function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

const codePoints = (text: string) => Array.from(text, character => character.codePointAt(0)!)

// Code points that reach every class the layout treats differently, grouped by how often random
// text uses them. Several sit in supplementary planes, e.g. U+20B9F and U+1F600.
export const testCodePoints = {
  letters: codePoints('abcxyzéΩא_#'),
  digits: codePoints('07'),
  spaces: codePoints(' \t'),
  newline: codePoints('\n'),
  cjk: codePoints('中文字日本語の한국\u{20B9F}'),
  japaneseStarters: codePoints('ーッぁ々・'),
  cjkPunctuation: codePoints('、。」「，（）！'),
  punctuation: codePoints('.,:;!?()[]{}-/"\'%$…—“”’'),
  other: codePoints("\u00A0\u200B\u00AD\u0301\u{1F600}\u{1F44D}\u{1F3FD}\u202F"),
}

const wideClasses = new Set([LB.ID_CJK, LB.CJ, LB.NS_CJK, LB.CL_CJK, LB.OP_CJK])

// Advances in layout units: spaces 10 and 15, ideographs and CJK punctuation 64, zero width
// characters 0, and 18..40 otherwise, varying by code point so words have varied widths.
export function testAdvance(codePoint: number): number {
  const lineBreakClass = classOfCodePoint(codePoint)
  if (codePoint === 0x09) return 15
  if (lineBreakClass === LB.SP) return 10
  if (lineBreakClass === LB.LF || lineBreakClass === LB.ZW || lineBreakClass === LB.SHY) return 0
  if (wideClasses.has(lineBreakClass)) return 64
  return 18 + (Math.imul(codePoint, 7) >>> 0) % 23
}

export function randomCodePoint(random: () => number): number {
  const roll = random()
  const pool = roll < 0.4 ? testCodePoints.letters
    : roll < 0.45 ? testCodePoints.digits
    : roll < 0.6 ? testCodePoints.spaces
    : roll < 0.64 ? testCodePoints.newline
    : roll < 0.76 ? testCodePoints.cjk
    : roll < 0.8 ? testCodePoints.japaneseStarters
    : roll < 0.86 ? testCodePoints.cjkPunctuation
    : roll < 0.96 ? testCodePoints.punctuation
    : testCodePoints.other
  return pool[Math.floor(random() * pool.length)]!
}

const weightedKinds: [KeyKind, number][] = [
  ['none', 2],
  ['insert', 34],
  ['backspace', 9],
  ['delete', 5],
  ['wordBackspace', 3],
  ['left', 6],
  ['right', 6],
  ['wordLeft', 3],
  ['wordRight', 3],
  ['lineStart', 2],
  ['lineEnd', 3],
  ['up', 5],
  ['down', 5],
  ['documentStart', 1],
  ['documentEnd', 1],
  ['selectAll', 1],
  ['pointerDown', 6],
  ['pointerDrag', 5],
]
const totalWeight = weightedKinds.reduce((sum, [, weight]) => sum + weight, 0)

export function randomEvent(random: () => number, config: EditorConfig, geometry: FieldGeometry): EditorEvent {
  let roll = random() * totalWeight
  let kind: KeyKind = 'none'
  for (const [candidate, weight] of weightedKinds) {
    roll -= weight
    if (roll < 0) {
      kind = candidate
      break
    }
  }
  const count = kind !== 'insert' ? 0 : random() < 0.85 ? 1 : 1 + Math.floor(random() * config.pasteLimit)
  return {
    kind,
    shift: random() < 0.3,
    codes: Array.from({length: count}, () => randomCodePoint(random)),
    pointerX: Math.min(config.maxWidthLimit, Math.floor(random() * (geometry.maxWidth + 60))),
    pointerY: Math.floor(random() * geometry.lineHeight * (config.lineSlots + 1)),
  }
}
