// bit-emit.ts on programs other than the two it was written for: which of its rules fire on how many operations, and
// that its shader gives loop-emit.ts's values and the CPU executor's, through the strict WGSL interpreter. The search
// step and the JSON highlighter's step are compared with their references in search.test.ts. Here are small loop
// programs written for the purpose: some have the structure that a rule needs without the helpers that regex search
// uses, and some miss one precondition of a rule, so that the rule must not fire and the values must still be right.
// Run from the repo root: bun test lab/json-search/bit-emit.test.ts
import {describe, expect, test} from 'bun:test'
import {type Wire, emitCompare} from '../../src/runtime/numeric-ui-core.ts'
import {constant, createSourceTable, input, inputBit, list} from '../../src/runtime/cells.ts'
import {and, andNot, not} from '../regex-search/bits.ts'
import {type RuleCounts, emitBitLoopWgsl, packWords} from './bit-emit.ts'
import {generateDocuments} from './documents.ts'
import {buildJsonLoop} from './json-step.ts'
import {emitLoopWgsl} from './loop-emit.ts'
import {type Binding, type LoopProgram, createLoopRunner, createStage} from './loop-program.ts'
import {buildCharacterSets, characterSets, countCharacters} from './million/character-sets.ts'
import {cellsPerDocument, writeDocumentCells} from './program.ts'
import {boundaryCapacity, buildSearchLoop, classCapacity} from './search-step.ts'
import {createWgslInterpreter} from './wgsl-interpreter.ts'

function lowbias32(n: number) {
  n = Math.imul((n >>> 16) ^ n, 0x21f0aaad)
  n = Math.imul((n >>> 15) ^ n, 0xd35a2d97)
  return (n >>> 15) ^ n
}
function createRandom(seed: number) {
  let counter = 0
  return () => (lowbias32(lowbias32(seed) ^ counter++) >>> 0) / 0x100000000
}
const pick = <Item>(random: () => number, items: readonly Item[]) => items[Math.floor(random() * items.length)]!

const positions = 12
const rowCount = 5

// "Does any wanted flag hold at this row?", for each of a document's 12 rows, with a count of the rows where one does
// and a bit that says whether none did so far. JS for the first variant:
//
//   for (const row of rows) {
//     const any = flags.some((flagsOfTable, table) => wanted[table] && flagsOfTable[row] === 1)   // row 5 has no flags
//     marks.push(any)
//     count += any
//     quiet = quiet && !any
//   }
//
// Each table's read is one index read, and one ReLU gate reads all of them, like regex search's step but written here
// without its helpers. The other variants change one thing each:
//   'ungated'           no `wanted`: every read is flags[table][row], and a row past the table reads the last row
//   'manyTables'        40 tables instead of 3, more than one word holds
//   'zeroBelow'         rows from -1 on, and a read below the table is +0
//   'shortGate'         rows from -1 on, and an unwanted table's index still moves by 5, so its row -1 reads row 4
//   'exclusiveBits'     table 0 is wanted when p && !q or when p && q, two bits that are never both 1
//   'fractionInGate'    the gate also subtracts a number within 0..1 that isn't a whole number
//   'differentIndexes'  table k is read at row + k
//   'fractionAsBit'     `wanted` is declared within 0..1 and not as a bit, and holds e.g. 0.5
//   'twoFreeBits'       table 0 is wanted through p and q as in 'exclusiveBits', but both can be 1
const flagVariants = ['gated', 'ungated', 'manyTables', 'zeroBelow', 'exclusiveBits', 'shortGate', 'fractionInGate', 'differentIndexes', 'fractionAsBit', 'twoFreeBits'] as const
type FlagVariant = typeof flagVariants[number]

function buildFlags(variant: FlagVariant) {
  const tableCount = variant === 'manyTables' ? 40 : 3
  const lowestRow = variant === 'zeroBelow' || variant === 'shortGate' ? -1 : 0
  // How far an unwanted table's index moves: past the table from every row, except in 'shortGate'.
  const gateWeight = variant === 'zeroBelow' ? rowCount + 1 : rowCount
  const table = createSourceTable()
  const cells = table.declare({
    row: input([lowestRow, rowCount], {initial: rowCount, grid: 1}),
    flags: list(tableCount, () => list(rowCount, () => inputBit())),
    wanted: list(tableCount, () => variant === 'fractionAsBit' ? input([0, 1]) : inputBit()),
    p: inputBit(),
    q: inputBit(),
    fraction: input([0, 1]),
    count: input([0, positions], {grid: 1}),
    quiet: inputBit(1),
  })
  const circuit = table.createCircuit()
  const reads = cells.flags.map((flagsOfTable, index): Wire => {
    if (variant === 'ungated') return circuit.indexReadAffine([[cells.row, 1]], 0, flagsOfTable, 'clamp', 'clamp')
    const below = lowestRow < 0 ? 'zero' : 'clamp'
    if (index === 0 && (variant === 'exclusiveBits' || variant === 'twoFreeBits')) {
      const [first, second] = variant === 'exclusiveBits' ? [andNot(circuit, cells.p, cells.q) as Wire, and(circuit, cells.p, cells.q) as Wire] : [cells.p, cells.q]
      return circuit.indexReadAffine([[cells.row, 1], [first, -rowCount], [second, -rowCount]], rowCount, flagsOfTable, below, 'zero')
    }
    // JS: wanted && flags[row], as a read at row + 5 × (1 - wanted), which is +0 past the table.
    return circuit.indexReadAffine([[cells.row, 1], [cells.wanted[index]!, -gateWeight]], gateWeight + (variant === 'differentIndexes' ? index : 0), flagsOfTable, below, 'zero')
  })
  // JS: none = !reads.some(read => read === 1)
  const none = circuit.reglu([], 1, [...reads.map(read => [read, -1] as const), ...(variant === 'fractionInGate' ? [[cells.fraction, -1] as const] : [])], 1)
  const any = not(circuit, none) as Wire
  const nextCount = circuit.affine([[cells.count, 1], [any, 1]])
  const nextQuiet = and(circuit, cells.quiet, none) as Wire
  const {initialSource} = table.finish()
  const loop: LoopProgram = {
    positions,
    buffers: [{name: 'rows', cellsPerDocument: positions}],
    registers: [{name: 'count', initial: 0}, {name: 'quiet', initial: 1}],
    fields: [],
    outputGroups: [{name: 'summary', kind: 'document', valuesPerDocument: 2, fill: 0}, {name: 'any', kind: 'position', valuesPerDocument: positions, fill: 0}],
    stages: [createStage({
      name: 'rows', repeat: 'forward', circuit, sharedOffset: 0,
      bindings: new Map<Wire, Binding>([[cells.row, {kind: 'item', buffer: 0}], [cells.count, {kind: 'register', register: 0}], [cells.quiet, {kind: 'register', register: 1}]]),
      outputs: [{wire: any, write: {kind: 'position', group: 1}}, {wire: nextCount, write: {kind: 'register', register: 0}}, {wire: nextQuiet, write: {kind: 'register', register: 1}}],
    })],
    results: [{group: 0, column: 0, register: 0}, {group: 0, column: 1, register: 1}],
    sharedValues: new Float32Array(initialSource),
    lengthCell: undefined,
  }
  const bit = (random: () => number) => Number(random() < 0.5)
  return {
    loop,
    // Shared values and one document's rows within the declared ranges, with the values that a near miss turns on.
    writeShared(random: () => number, shared: Float32Array) {
      for (const flagsOfTable of cells.flags) for (const wire of flagsOfTable) shared[wire] = Number(random() < 0.3)
      for (const wire of cells.wanted) shared[wire] = variant === 'fractionAsBit' ? pick(random, [0, 0.5, 1]) : bit(random)
      shared[cells.p] = bit(random)
      shared[cells.q] = bit(random)
      shared[cells.fraction] = pick(random, [0, 0.25, 1])
    },
    writeDocument(random: () => number, document: Float32Array) {
      for (let position = 0; position < positions; position++) document[position] = lowestRow + Math.floor(random() * (rowCount + 1 - lowestRow))
    },
  }
}

// Bits next to ordinary numbers. JS:
//
//   for (const value of values) {             // e.g. 12.5, not a whole number
//     const over = value > limit
//     marks.push(over)
//     streak = over ? streak + 1 : 0          // a whole number
//     total += over ? weights[bucket] : 0     // an ordinary number
//     bucket = nextBucket[bucket + over]      // a whole number that picks the weight
//   }
function buildMixed() {
  const weights = [0.5, 1.25, 3, 7.75]
  const table = createSourceTable()
  const cells = table.declare({
    value: input([0, 100]),
    limit: input([0, 100], {initial: 50}),
    weights: weights.map(weight => constant(weight, [0, 8])),
    nextBucket: [0, 1, 2, 3, 3].map(bucket => constant(bucket, [0, 3], {grid: 1})),
    streak: input([0, positions], {grid: 1}),
    total: input([0, 8 * positions]),
    bucket: input([0, 3], {grid: 1}),
  })
  const circuit = table.createCircuit()
  // The operands have no grid, so this is a sign cascade, whose operations stay f32 statements. Its last operation is
  // declared a bit by emitCompare.
  const over = emitCompare(circuit, cells.value, '>', cells.limit)
  const nextStreak = circuit.reglu([[cells.streak, 1]], 1, [[over, 1]], 0)
  const weight = circuit.indexRead(cells.bucket, cells.weights)
  const nextTotal = circuit.roundAffine([[cells.total, 1], [circuit.reglu([[weight, 1]], 0, [[over, 1]], 0), 1]])
  const nextBucket = circuit.indexReadAffine([[cells.bucket, 1], [over, 1]], 0, cells.nextBucket, 'clamp', 'clamp')
  const {initialSource} = table.finish()
  const loop: LoopProgram = {
    positions,
    buffers: [{name: 'values', cellsPerDocument: positions}],
    registers: [{name: 'streak', initial: 0}, {name: 'total', initial: 0}, {name: 'bucket', initial: 0}],
    fields: [],
    outputGroups: [{name: 'summary', kind: 'document', valuesPerDocument: 2, fill: 0}, {name: 'over', kind: 'position', valuesPerDocument: positions, fill: 0}],
    stages: [createStage({
      name: 'values', repeat: 'forward', circuit, sharedOffset: 0,
      bindings: new Map<Wire, Binding>([[cells.value, {kind: 'item', buffer: 0}], [cells.streak, {kind: 'register', register: 0}], [cells.total, {kind: 'register', register: 1}], [cells.bucket, {kind: 'register', register: 2}]]),
      outputs: [
        {wire: over, write: {kind: 'position', group: 1}}, {wire: nextStreak, write: {kind: 'register', register: 0}},
        {wire: nextTotal, write: {kind: 'register', register: 1}}, {wire: nextBucket, write: {kind: 'register', register: 2}},
      ],
    })],
    results: [{group: 0, column: 0, register: 0}, {group: 0, column: 1, register: 1}],
    sharedValues: new Float32Array(initialSource),
    lengthCell: undefined,
  }
  return {
    loop,
    writeShared(random: () => number, shared: Float32Array) {
      shared[cells.limit] = pick(random, [0, 12.5, 50, 99.75])
    },
    writeDocument(random: () => number, document: Float32Array) {
      for (let position = 0; position < positions; position++) document[position] = pick(random, [0, 12.5, 12.25, 50, 50.5, 99.75, 100, Math.fround(random() * 100)])
    },
  }
}

// Six switches that stay on from one row to the next. JS for the first variant:
//
//   for (const row of rows) {
//     for (let k = 0; k < 6; k++) on[k] = on[k] && !blocked[k][row] && !stuck[k]   // row 5 blocks nothing
//     const any = on.some(isOn => isOn)
//     marks.push(any)
//     count += any
//   }
//
// The six gates have the same form, over the six `on` registers, six tables read at the same row, and six shared
// cells, so each of those is one word. In 'oneByOne', switch k instead reads two other switches, on[k + 1] && !on[k + 2],
// which are no neighboring lanes of a word.
function buildSwitches(variant: 'lanes' | 'oneByOne') {
  const switchCount = 6
  const table = createSourceTable()
  const cells = table.declare({
    row: input([0, rowCount], {initial: rowCount, grid: 1}),
    blocked: list(switchCount, () => list(rowCount, () => inputBit())),
    stuck: list(switchCount, () => inputBit()),
    on: list(switchCount, () => inputBit(1)),
    count: input([0, positions], {grid: 1}),
  })
  const circuit = table.createCircuit()
  const nextOn = cells.on.map((isOn, index): Wire => {
    if (variant === 'oneByOne') return andNot(circuit, cells.on[(index + 1) % switchCount]!, cells.on[(index + 2) % switchCount]!) as Wire
    const blocked = circuit.indexReadAffine([[cells.row, 1]], 0, cells.blocked[index]!, 'clamp', 'zero')
    // JS: on && !blocked && !stuck, as relu(on - blocked - stuck).
    return circuit.reglu([], 1, [[isOn, 1], [blocked, -1], [cells.stuck[index]!, -1]], 0)
  })
  const none = circuit.reglu([], 1, nextOn.map(isOn => [isOn, -1] as const), 1)
  const any = not(circuit, none) as Wire
  const nextCount = circuit.affine([[cells.count, 1], [any, 1]])
  const {initialSource} = table.finish()
  const loop: LoopProgram = {
    positions,
    buffers: [{name: 'rows', cellsPerDocument: positions}],
    registers: [...list(switchCount, index => ({name: `on[${index}]`, initial: 1})), {name: 'count', initial: 0}],
    fields: [],
    outputGroups: [{name: 'summary', kind: 'document', valuesPerDocument: 2, fill: 0}, {name: 'any', kind: 'position', valuesPerDocument: positions, fill: 0}],
    stages: [createStage({
      name: 'rows', repeat: 'forward', circuit, sharedOffset: 0,
      bindings: new Map<Wire, Binding>([[cells.row, {kind: 'item', buffer: 0}], ...cells.on.map((wire, index): [Wire, Binding] => [wire, {kind: 'register', register: index}]), [cells.count, {kind: 'register', register: switchCount}]]),
      outputs: [{wire: any, write: {kind: 'position', group: 1}}, ...nextOn.map((wire, index) => ({wire, write: {kind: 'register', register: index} as const})), {wire: nextCount, write: {kind: 'register', register: switchCount}}],
    })],
    // The count, and whether the last switch is still on.
    results: [{group: 0, column: 0, register: switchCount}, {group: 0, column: 1, register: switchCount - 1}],
    sharedValues: new Float32Array(initialSource),
    lengthCell: undefined,
  }
  return {
    loop,
    writeShared(random: () => number, shared: Float32Array) {
      for (const blockedOfSwitch of cells.blocked) for (const wire of blockedOfSwitch) shared[wire] = Number(random() < 0.1)
      for (const wire of cells.stuck) shared[wire] = Number(random() < 0.15)
    },
    writeDocument(random: () => number, document: Float32Array) {
      for (let position = 0; position < positions; position++) document[position] = Math.floor(random() * (rowCount + 1))
    },
  }
}

// Two loops over a document's 12 values, each 0 or 1: the first keeps, per position, the value and its opposite in a
// field that the loop program declares as bits, and the second counts the values. The values come from a cell that is
// declared within 0..1 and not as a bit, so nothing proves that the field holds bits.
function buildDeclaredField() {
  const table = createSourceTable()
  const cells = table.declare({value: input([0, 1]), kept: list(2, () => inputBit()), count: input([0, positions], {grid: 1})})
  const circuit = table.createCircuit()
  const keptValue = circuit.reglu([], 1, [[cells.value, 1]], 0)
  const opposite = circuit.roundAffine([[keptValue, -1]], 1)
  const nextCount = circuit.affine([[cells.count, 1], [cells.kept[0]!, 1]])
  const marked = circuit.roundAffine([[cells.kept[1]!, 1]])
  const {initialSource} = table.finish()
  const loop: LoopProgram = {
    positions,
    buffers: [{name: 'values', cellsPerDocument: positions}],
    registers: [{name: 'count', initial: 0}],
    fields: [{name: 'kept', width: 2, bits: true}],
    outputGroups: [{name: 'summary', kind: 'document', valuesPerDocument: 1, fill: 0}, {name: 'opposite', kind: 'position', valuesPerDocument: positions, fill: 0}],
    stages: [
      createStage({
        name: 'keep', repeat: 'forward', circuit, sharedOffset: 0, bindings: new Map<Wire, Binding>([[cells.value, {kind: 'item', buffer: 0}]]),
        outputs: [{wire: keptValue, write: {kind: 'field', field: 0, component: 0}}, {wire: opposite, write: {kind: 'field', field: 0, component: 1}}],
      }),
      createStage({
        name: 'count', repeat: 'backward', circuit, sharedOffset: 0,
        bindings: new Map<Wire, Binding>([[cells.kept[0]!, {kind: 'field', field: 0, component: 0}], [cells.kept[1]!, {kind: 'field', field: 0, component: 1}], [cells.count, {kind: 'register', register: 0}]]),
        outputs: [{wire: marked, write: {kind: 'position', group: 1}}, {wire: nextCount, write: {kind: 'register', register: 0}}],
      }),
    ],
    results: [{group: 0, column: 0, register: 0}],
    sharedValues: new Float32Array(initialSource),
    lengthCell: undefined,
  }
  return {
    loop,
    writeShared() {},
    writeDocument(random: () => number, document: Float32Array) {
      for (let position = 0; position < positions; position++) document[position] = Number(random() < 0.5)
    },
  }
}

// Runs a loop program on the CPU executor and as both writers' shaders, for several shared tables and documents, and
// counts the values that differ from the executor's.
function compareWriters(program: {loop: LoopProgram, writeShared: (random: () => number, shared: Float32Array) => void, writeDocument: (random: () => number, document: Float32Array) => void}, seed: number) {
  const {loop} = program
  const random = createRandom(seed)
  const runner = createLoopRunner(loop, 'executor')
  const bitShader = emitBitLoopWgsl(loop)
  const interpreters = [createWgslInterpreter(emitLoopWgsl(loop).code), createWgslInterpreter(bitShader.code)]
  const documents = 6
  const cells = new Float32Array(documents * positions)
  const shared = new Float32Array(loop.sharedValues)
  const sizes = loop.outputGroups.map(group => documents * group.valuesPerDocument)
  const result = {values: 0, mismatches: [0, 0], nonZero: 0, rules: bitShader.rules, packedWords: bitShader.packedCells.length}
  for (let round = 0; round < 40; round++) {
    program.writeShared(random, shared)
    for (let row = 0; row < documents; row++) program.writeDocument(random, cells.subarray(row * positions, (row + 1) * positions))
    const expected = sizes.map(size => new Float32Array(size))
    runner.setShared(shared)
    for (let row = 0; row < documents; row++) runner.run([cells], row, expected, row, row)
    interpreters.forEach((interpret, writer) => {
      const actual = sizes.map(size => new Float32Array(size).fill(9))
      interpret(shared, cells, documents, actual, {window: {first: 0, count: documents}, packed: packWords(bitShader.packedCells, shared)})
      expected.forEach((values, group) => {
        for (let index = 0; index < values.length; index++) if (values[index] !== actual[group]![index]) result.mismatches[writer]!++
      })
    })
    for (const values of expected) {
      result.values += values.length
      for (const value of values) if (value !== 0) result.nonZero++
    }
  }
  return result
}

const fired = (rules: RuleCounts) => Object.fromEntries(Object.entries(rules).filter(([, count]) => count > 0))

describe('bit-emit.ts on small loop programs', () => {
  // Per variant: the rules that fired on the step's operations, and how many words the runner packs.
  const expectedRules: Record<FlagVariant, [rules: Record<string, number>, packedWords: number]> = {
    // The three reads are one word and one AND. The table of 5 rows gets a sixth word of zeros for row 5.
    gated: [{sum: 2, gate: 2, packedRead: 3, packedWord: 1}, 6],
    // No word of zeros: a row past the table reads the last row.
    ungated: [{sum: 2, gate: 2, packedRead: 3, packedWord: 1}, 5],
    // 40 reads are two words, of 32 and of 8 bits.
    manyTables: [{sum: 2, gate: 2, packedRead: 40, packedWord: 2}, 12],
    // A word of zeros on each side of the table.
    zeroBelow: [{sum: 2, gate: 2, packedRead: 3, packedWord: 1}, 7],
    // The two gates over p and q are proven never both 1, so their sum in the index is an OR and table 0's read is packed too.
    exclusiveBits: [{sum: 2, gate: 4, packedRead: 3, packedWord: 1}, 6],
    // An unwanted table's row -1 reads row 4, so no read is "flags[row] && wanted", and each is read on its own.
    shortGate: [{sum: 2, gate: 2, read: 3}, 0],
    // The gate isn't a whole number, so it stays an f32 statement, and with it everything that reads it. The reads are
    // still bits, read one by one with an integer index.
    fractionInGate: [{read: 3, float: 4}, 0],
    // Three reads at three different indexes are three ordinary bits.
    differentIndexes: [{sum: 2, gate: 2, read: 3}, 0],
    // The index isn't a whole number, so every read keeps its floor, and its value is still a bit.
    fractionAsBit: [{sum: 2, gate: 2, float: 3}, 0],
    // p and q can both be 1, where the read is flags[0][0] through the clamp below the table, so table 0's read isn't
    // gated, and the other two reads are still one word.
    twoFreeBits: [{sum: 2, gate: 2, read: 1, packedRead: 2, packedWord: 1}, 6],
  }

  for (const variant of flagVariants) {
    test(`flags, '${variant}': the rules that fire, and the executor's values from both writers' shaders`, () => {
      const result = compareWriters(buildFlags(variant), 20261014)
      expect([fired(result.rules), result.packedWords]).toEqual(expectedRules[variant])
      expect([result.mismatches, result.values > 3000, result.nonZero > 500]).toEqual([[0, 0], true, true])
    })
  }

  test('the near misses hold values that the rule would get wrong', () => {
    // 'fractionAsBit' with wanted = 0.5 reads row + 2, and 'twoFreeBits' with p = q = 1 reads row 0 of table 0. A
    // writer that took either for a gated read would read row `row`.
    for (const [variant, cellsOf] of [['fractionAsBit', {wanted: 0.5, p: 0, q: 0}], ['twoFreeBits', {wanted: 0, p: 1, q: 1}]] as const) {
      const {loop} = buildFlags(variant)
      const shader = emitBitLoopWgsl(loop)
      const shared = new Float32Array(loop.sharedValues)
      // The cells in declaration order: row, 3 tables of 5 flags, 3 wanted cells, p and q.
      shared.set([0, 0, 1, 0, 0], 1)
      shared.fill(cellsOf.wanted, 16, 19)
      shared.set([cellsOf.p, cellsOf.q], 19)
      // Table 0 holds a flag only at row 2. Every position reads row 0, and the last one row 4.
      const document = new Float32Array(positions)
      document[positions - 1] = 4
      const outputs = [new Float32Array(2), new Float32Array(positions)]
      createWgslInterpreter(shader.code)(shared, document, 1, outputs, {window: {first: 0, count: 1}, packed: packWords(shader.packedCells, shared)})
      // 'fractionAsBit' reads row 2 at every position but the last. 'twoFreeBits' reads row 0, which holds no flag.
      expect([variant, [...outputs[1]!], [...outputs[0]!]]).toEqual(variant === 'fractionAsBit' ? [variant, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0], [11, 0]] : [variant, Array<number>(positions).fill(0), [0, 1]])
    }
  })

  test('switches: six gates of one form are one word operation, over a word of registers, a packed word and a word of shared cells', () => {
    const {loop} = buildSwitches('lanes')
    const result = compareWriters(buildSwitches('lanes'), 3)
    // The six gates are lanes, the six reads one packed word of six tables, and "no switch is on" one comparison of the word with 0.
    expect([fired(result.rules), result.packedWords]).toEqual([{sum: 2, gate: 1, packedRead: 6, packedWord: 1, lane: 6}, 6])
    expect([result.mismatches, result.values > 3000, result.nonZero > 500]).toEqual([[0, 0], true, true])
    const lines = emitBitLoopWgsl(loop).code.split('\n')
    expect(lines.filter(line => line.startsWith('var r'))).toEqual(['var r6: i32 = 0i;', 'var rw0: u32 = 63u;'])
    expect(lines.filter(line => line.includes('rw0')).slice(1)).toEqual([
      'let a_m1: u32 = rw0 & ((sw0 | a_m0) ^ 63u);',
      'rw0 = a_m1;',
      'instance_outputs_0[output_base_0 + 1u] = f32(((rw0 >> 5u) & 1u));',
    ])
    expect(lines.filter(line => line.includes('== 0u'))).toEqual(['let a_v56b: u32 = u32(a_m1 == 0u);'])
  })

  test('switches, \'oneByOne\': registers that are read one by one stay variables of their own', () => {
    const {loop} = buildSwitches('oneByOne')
    const result = compareWriters(buildSwitches('oneByOne'), 3)
    expect([fired(result.rules), result.packedWords]).toEqual([{sum: 2, gate: 7}, 0])
    expect(result.mismatches).toEqual([0, 0])
    const lines = emitBitLoopWgsl(loop).code.split('\n')
    expect(lines.filter(line => line.startsWith('var r'))).toEqual([...Array.from({length: 6}, (_, index) => `var r${index}: u32 = 1u;`), 'var r6: i32 = 0i;'])
  })

  test('a field that the loop program declares as bits without a proof is a word of f32 values\' bits, as loop-emit.ts writes it', () => {
    const {loop} = buildDeclaredField()
    const result = compareWriters(buildDeclaredField(), 11)
    expect(fired(result.rules)).toEqual({float: 4})
    expect(result.mismatches).toEqual([0, 0])
    const lines = emitBitLoopWgsl(loop).code.split('\n')
    // The count reads a value that nothing proves to be whole, so the count is an f32 register too.
    expect(lines.filter(line => line.startsWith('var '))).toEqual(['var r0: f32 = 0.0f;', 'var field0: array<u32, 12>;'])
    expect(lines.filter(line => line.includes('field0[j]'))).toEqual(['field0[j] = u32(a_v4) | (u32(a_v5) << 1u);', 'let b_w0: u32 = field0[j];'])
  })

  test('bits next to ordinary numbers: the sign cascade and the f32 total stay f32 statements, and the whole numbers around them are integers', () => {
    const result = compareWriters(buildMixed(), 7)
    expect(fired(result.rules)).toEqual({product: 1, read: 2, float: 18})
    expect([result.mismatches, result.values > 3000, result.nonZero > 500]).toEqual([[0, 0], true, true])
    // The streak and the bucket are i32 registers, the total an f32 one.
    const code = emitBitLoopWgsl(buildMixed().loop).code
    expect(['var r0: i32 = 0i;', 'var r1: f32 = 0.0f;', 'var r2: i32 = 0i;'].every(line => code.includes(line))).toBe(true)
  })
})

describe('bit-emit.ts on a third program over the documents', () => {
  test('the characters of the wanted sets: four tables of 128 bits are one word read, and both shaders give plain JavaScript\'s counts', () => {
    const textPositions = 512
    const {loop, writeWanted} = buildCharacterSets(textPositions, cellsPerDocument)
    const shader = emitBitLoopWgsl(loop)
    // 128 words of 4 bits, and a word of zeros on each side for a code point of -1 and for one from 128 on.
    expect([fired(shader.rules), shader.packedCells.length, shader.packedCells[0], shader.packedCells[129]]).toEqual([{sum: 2, gate: 1, packedRead: 4, packedWord: 1}, 130, [], []])
    const texts = [...generateDocuments(24).map(document => document.text), '', 'Ünïcödé 42 "x": [1, 2]']
    const cells = new Float32Array(texts.length * cellsPerDocument)
    texts.forEach((text, row) => writeDocumentCells(cells, row * cellsPerDocument, text))
    const interpreters = [createWgslInterpreter(emitLoopWgsl(loop).code), createWgslInterpreter(shader.code)]
    const shared = new Float32Array(loop.sharedValues)
    let counted = 0
    for (const wanted of [[true, false, false, false], [false, true, true, false], [true, true, true, true], [false, false, false, false]]) {
      writeWanted(shared, wanted)
      const expected = texts.map(text => countCharacters(text, wanted, textPositions))
      counted += expected.reduce((total, count) => total + count, 0)
      const outputs = interpreters.map(interpret => {
        const groups = [new Float32Array(texts.length), new Float32Array(texts.length * textPositions).fill(9)]
        interpret(shared, cells, texts.length, groups, {window: {first: 0, count: texts.length}, packed: packWords(shader.packedCells, shared)})
        return groups
      })
      expect([[...outputs[0]![0]!], [...outputs[1]![0]!]]).toEqual([expected, expected])
      expect(outputs[1]![1]).toEqual(outputs[0]![1]!)
    }
    expect([characterSets.length, counted > 5000]).toEqual([4, true])
  })
})

describe('bit-emit.ts on the search step and the highlighter\'s step', () => {
  test('the rules that fire at 8, 16 and 32 states, with a scope, and on the highlighter', () => {
    const shaderOf = (states: number, masked: boolean) => emitBitLoopWgsl(buildSearchLoop({states, classes: classCapacity, boundaries: boundaryCapacity}, {positions: 512, cellsPerDocument, masked, stopAtLength: false}).loop)
    const describeShader = (shader: ReturnType<typeof emitBitLoopWgsl>) => [fired(shader.rules), shader.packedCells.length, shader.statementCount]
    // Every table read of a transition is one bit of a packed word: 16 gates of 8 reads, 32 of 16 and 64 of 32, each
    // one read of a word. A table of 16 classes is 17 words, with one of zeros for the class that no step reads. Four
    // operations per state are lanes of a word operation: the first notFinish, the next notFinish, continuing, and
    // the next reached.
    expect([8, 16, 32].map(states => describeShader(shaderOf(states, false)))).toEqual([
      [{sum: 3, gate: 51, comparison: 33, read: 1, packedRead: 128, packedWord: 16, lane: 32}, 272, 141],
      [{sum: 3, gate: 67, comparison: 33, read: 1, packedRead: 512, packedWord: 32, lane: 64}, 544, 165],
      [{sum: 3, gate: 99, comparison: 33, read: 1, packedRead: 2048, packedWord: 64, lane: 128}, 1088, 213],
    ])
    // With a scope: one more read, of whether the search reads the code point's kind, and the product that replaces
    // the code point with -1.
    expect(describeShader(shaderOf(8, true))).toEqual([{sum: 4, gate: 51, comparison: 33, product: 1, read: 2, packedRead: 128, packedWord: 16, lane: 32}, 272, 147])
    // The highlighter has no gated reads. Its comparison of the container code is a sign cascade, 15 f32 statements
    // between integer ones.
    expect(describeShader(emitBitLoopWgsl(buildJsonLoop().loop))).toEqual([{sum: 12, gate: 1, comparison: 1, product: 7, read: 18, float: 15}, 0, 103])
  })

  test('the search step\'s registers and fields are words and whole numbers, and the forward step is a few word operations', () => {
    const {loop} = buildSearchLoop({states: 8, classes: classCapacity, boundaries: boundaryCapacity}, {positions: 512, cellsPerDocument, masked: false, stopAtLength: false})
    const lines = emitBitLoopWgsl(loop).code.split('\n')
    // The match count, the 8 notFinish bits, the 8 reached bits, the class of every position, and the notReach bits of
    // every position.
    expect(lines.filter(line => line.startsWith('var '))).toEqual(['var r16: i32 = 0i;', 'var rw0: u32 = 255u;', 'var rw1: u32 = 0u;', 'var field0: array<i32, 512>;', 'var field1: array<u32, 512>;'])
    const forward = lines.slice(lines.indexOf('for (var j: u32 = 0u; j < positions; j++) {'))
    // JS: continuing = reached & ~notReach, and notContinuing = continuing === 0.
    expect(forward.slice(1, 4)).toEqual(['let c_w1: u32 = field1[j];', 'let c_m0: u32 = rw1 & (c_w1 ^ 255u);', 'let c_v1133b: u32 = u32(c_m0 == 0u);'])
    // continuing[0] and start are never both 1, which the writer proves from the two gates, so live[0] is their OR:
    // the word of the 8 open bits is the continuing word with start in lane 0.
    expect(forward).toContain('let c_m1: u32 = c_m0 | c_v1190b;')
    // JS: reached = ~(the word of the 8 gates).
    expect(forward.filter(line => line.includes('rw1 = ') || line.includes('c_m3'))).toEqual(['let c_m3: u32 = c_m2 ^ 255u;', 'rw1 = c_m3;'])
    expect(lines.some(line => line.includes(': f32 = max('))).toBe(false)
  })
})
