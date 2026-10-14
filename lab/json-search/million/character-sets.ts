// A third loop program for the code writer's check, over the same documents as the search and the highlighter, written
// without regex search's helpers: which characters of a document are in one of the wanted sets, and how many. JS:
//
//   for (const codePoint of codePoints) {
//     const any = sets.some((set, index) => wanted[index] && codePoint >= 0 && codePoint < 128 && set[codePoint] === 1)
//     marks.push(any)
//     count += any
//   }
//
// Each set is a table of 128 bits, read at the code point, and one ReLU gate reads the four reads. bit-emit.ts packs
// the four tables into words of 4 bits, 130 words with a word of zeros on each side of the table, and the page runs the
// shader with gpu/host.ts's runner, which fills those words from the shared cells, as for the search step.
import type {Wire} from '../../../src/runtime/numeric-ui-core.ts'
import {createSourceTable, input, inputBit, list} from '../../../src/runtime/cells.ts'
import {type Binding, type LoopProgram, createStage} from '../loop-program.ts'

const tableLength = 128
export const characterSets = [
  {name: 'digits', has: (codePoint: number) => codePoint >= 48 && codePoint <= 57},
  {name: 'lowercase letters', has: (codePoint: number) => codePoint >= 97 && codePoint <= 122},
  {name: 'uppercase letters', has: (codePoint: number) => codePoint >= 65 && codePoint <= 90},
  {name: 'quotes, colons, commas, brackets and braces', has: (codePoint: number) => '":,[]{}'.includes(String.fromCodePoint(codePoint))},
] as const

// `cellsPerDocument` is the layout of buffer 0: `positions` code points, -1 past the text's end, then the text's length.
export function buildCharacterSets(positions: number, cellsPerDocument: number) {
  const table = createSourceTable()
  const cells = table.declare({
    codePoint: input([-1, 0x10ffff], {initial: -1, grid: 1}),
    sets: characterSets.map(set => list(tableLength, codePoint => inputBit(Number(set.has(codePoint))))),
    wanted: characterSets.map(() => inputBit()),
    count: input([0, positions], {grid: 1}),
  })
  const circuit = table.createCircuit()
  // JS: wanted && set[codePoint], as a read at codePoint + 129 × (1 - wanted). An unwanted set's index is 128 or more,
  // past the table, and a code point of -1 or of 128 or more reads +0 too.
  const reads = cells.sets.map((set, index) => circuit.indexReadAffine([[cells.codePoint, 1], [cells.wanted[index]!, -(tableLength + 1)]], tableLength + 1, set, 'zero', 'zero'))
  // JS: none = !reads.some(read => read === 1), as relu(1 - sum of the reads).
  const none = circuit.reglu([], 1, reads.map(read => [read, -1] as const), 1)
  const any = circuit.affine([[none, -1]], 1)
  const nextCount = circuit.affine([[cells.count, 1], [none, -1]], 1)
  const {initialSource} = table.finish()
  const loop: LoopProgram = {
    positions,
    buffers: [{name: 'documents', cellsPerDocument}],
    registers: [{name: 'count', initial: 0}],
    fields: [],
    outputGroups: [{name: 'count', kind: 'document', valuesPerDocument: 1, fill: 0}, {name: 'marks', kind: 'position', valuesPerDocument: positions, fill: 0}],
    stages: [createStage({
      name: 'characters', repeat: 'forward', circuit, sharedOffset: 0,
      bindings: new Map<Wire, Binding>([[cells.codePoint, {kind: 'item', buffer: 0}], [cells.count, {kind: 'register', register: 0}]]),
      outputs: [{wire: any, write: {kind: 'position', group: 1}}, {wire: nextCount, write: {kind: 'register', register: 0}}],
    })],
    results: [{group: 0, column: 0, register: 0}],
    sharedValues: new Float32Array(initialSource),
    lengthCell: undefined,
  }
  return {
    loop,
    // Writes which sets are wanted, e.g. [true, false, false, false] for the digits.
    writeWanted(shared: Float32Array, wanted: readonly boolean[]) {
      cells.wanted.forEach((wire, index) => {
        shared[wire] = wanted[index] === true ? 1 : 0
      })
    },
  }
}

// The same count in plain JavaScript, for a comparison.
export function countCharacters(text: string, wanted: readonly boolean[], positions: number) {
  let count = 0
  let position = 0
  for (const character of text) {
    if (position++ === positions) break
    const codePoint = character.codePointAt(0)!
    if (characterSets.some((set, index) => wanted[index] === true && set.has(codePoint))) count++
  }
  return count
}
