// Shared random inputs for the differential tests and the report.

import {classCodes, type EditorConfig, type EditorEvent, type FieldGeometry, type KeyKind, packCell} from './reference.ts'

export function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

// Code 0 is the empty cell. Codes 1..7 are word characters 20..50 wide, 8 and 9 are spaces 10 and
// 15 wide, 10 is a newline, 11 is punctuation. Larger tables repeat the pattern with other widths.
export function testTable(codeLimit: number) {
  const table = [0]
  const codes = {word: [] as number[], space: [] as number[], newline: [] as number[], other: [] as number[]}
  for (let code = 1; code < codeLimit; code++) {
    const slot = (code - 1) % 11
    const round = Math.floor((code - 1) / 11)
    if (slot < 7) {
      table.push(packCell(code, classCodes.word, 20 + 5 * slot + round))
      codes.word.push(code)
    } else if (slot < 9) {
      table.push(packCell(code, classCodes.space, slot === 7 ? 10 : 15))
      codes.space.push(code)
    } else if (slot === 9) {
      table.push(packCell(code, classCodes.newline, 0))
      codes.newline.push(code)
    } else {
      table.push(packCell(code, classCodes.other, 22 + round))
      codes.other.push(code)
    }
  }
  return {table, codes}
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

export function randomEvent(random: () => number, config: EditorConfig, codes: ReturnType<typeof testTable>['codes'], geometry: FieldGeometry): EditorEvent {
  let roll = random() * totalWeight
  let kind: KeyKind = 'none'
  for (const [candidate, weight] of weightedKinds) {
    roll -= weight
    if (roll < 0) {
      kind = candidate
      break
    }
  }
  const pickCode = () => {
    const classRoll = random()
    const pool = classRoll < 0.6 ? codes.word : classRoll < 0.85 ? codes.space : classRoll < 0.9 ? codes.newline : codes.other
    return pool[Math.floor(random() * pool.length)]!
  }
  const count = kind !== 'insert' ? 0 : random() < 0.85 ? 1 : 1 + Math.floor(random() * config.pasteLimit)
  return {
    kind,
    shift: random() < 0.3,
    codes: Array.from({length: count}, pickCode),
    pointerX: Math.min(config.maxWidthLimit, Math.floor(random() * (geometry.maxWidth + 60))),
    pointerY: Math.floor(random() * geometry.lineHeight * (config.lineSlots + 1)),
  }
}
