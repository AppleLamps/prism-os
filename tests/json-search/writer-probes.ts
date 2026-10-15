// A reviewer's check of bit-emit.ts, by someone other than the writer's author. Each probe is a small loop program
// that changes one thing that a rule of bit-emit.ts depends on, e.g. the order of a gate's reads, a table of whole
// numbers instead of bits, or 33 bits where a word holds 32. A probe runs as both writers' shaders through the strict
// WGSL interpreter and on the CPU executor, for many shared tables and documents, with the lowest and the highest
// value of every declared range.
//
//   bun tests/json-search/writer-probes.ts            every probe, one line each
//   bun tests/json-search/writer-probes.ts <name>     one probe, with bit-emit.ts's shader printed first
//   bun test tests/json-search/writer-probes.test.ts  the same as tests, with the probes that fail today marked
//   bun lab/json-search/million/writer-probes-run.ts --profile <new folder> --out <file.json>   the same on the GPU
//
// A line says which rules fired, how many values were compared, and how many of them differ from the executor's in
// loop-emit.ts's shader and in bit-emit.ts's. "THREW" marks a probe where bit-emit.ts stopped, or where its shader
// holds something that a GPU's shader compiler refuses, e.g. a shift by 32 bits.
import {type Circuit, type Wire, emitCompare} from '../../src/runtime/numeric-ui-core.ts'
import {constant, createSourceTable, input, inputBit, list} from '../../src/runtime/cells.ts'
import {type Bit, andNot, not} from '../../src/json-search/regex/bits.ts'
import {emitBitLoopWgsl, packWords} from '../../src/json-search/bit-emit.ts'
import {emitLoopWgsl} from '../../src/json-search/loop-emit.ts'
import {type Binding, type LoopProgram, createLoopRunner, createStage} from '../../src/json-search/loop-program.ts'
import {createWgslInterpreter} from './wgsl-interpreter.ts'

// JS: a && b, as relu(a + b - 1), with bits that builder code already knows folded, like the helpers of
// src/json-search/regex/bits.ts. It is here because only the probes and bit-emit.test.ts build an AND this way.
export function and(circuit: Circuit, a: Bit, b: Bit): Bit {
  if (a === false || b === false) return false
  if (a === true) return b
  if (b === true) return a
  return circuit.reglu([], 1, [[a, 1], [b, 1]], -1)
}

function lowbias32(n: number) {
  n = Math.imul((n >>> 16) ^ n, 0x21f0aaad)
  n = Math.imul((n >>> 15) ^ n, 0xd35a2d97)
  return (n >>> 15) ^ n
}
export function createRandom(seed: number) {
  let counter = 0
  return () => (lowbias32(lowbias32(seed) ^ counter++) >>> 0) / 0x100000000
}
export const pick = <Item>(random: () => number, items: readonly Item[]) => items[Math.floor(random() * items.length)]!

export const positions = 12

// A loop program with the values that its cells may hold, so that the comparison can fill them without knowing the
// program. Positions are positions in loop.sharedValues.
export type Probe = {
  loop: LoopProgram
  // Shared cells declared as exact bits, e.g. a table's cells.
  sharedBits: readonly number[]
  // Other shared cells, each with the values that its declaration allows, corners first and last.
  sharedNumbers: readonly {position: number, values: readonly number[]}[]
  // The values that a cell of buffer 0 may hold, lowest first and highest last, e.g. rows -1 to 5. A document's cell
  // after its positions, e.g. the text's length, holds one of them too.
  itemValues: readonly number[]
}

export type Comparison = {
  // Why bit-emit.ts's shader couldn't be written, parsed or run, if it couldn't.
  threw: string | undefined
  values: number
  nonZero: number
  // Values that differ from the CPU executor's, in loop-emit.ts's shader and in bit-emit.ts's.
  mismatches: [today: number, bits: number]
  firstMismatch: string | undefined
  rules: Record<string, number>
  packedWords: number
  statements: [today: number, bits: number]
}

// One round's shared values and documents, within the declarations. Round 0 holds every lowest value and round 1
// every highest one, and every round's first document starts with the lowest and the highest item.
export function fillRound(probe: Probe, random: () => number, round: number, shared: Float32Array, cells: Float32Array) {
  const density = round === 0 ? 0 : round === 1 ? 1 : pick(random, [0.1, 0.3, 0.5, 0.9])
  for (const position of probe.sharedBits) shared[position] = Number(random() < density)
  for (const {position, values} of probe.sharedNumbers) shared[position] = round === 0 ? values[0]! : round === 1 ? values.at(-1)! : pick(random, values)
  for (let index = 0; index < cells.length; index++) cells[index] = pick(random, probe.itemValues)
  cells[0] = probe.itemValues[0]!
  cells[1] = probe.itemValues.at(-1)!
}

export function compareProbe(probe: Probe, seed: number, rounds = 120): Comparison {
  const {loop} = probe
  const random = createRandom(seed)
  const today = emitLoopWgsl(loop)
  const result: Comparison = {threw: undefined, values: 0, nonZero: 0, mismatches: [0, 0], firstMismatch: undefined, rules: {}, packedWords: 0, statements: [today.statementCount, 0]}
  const runner = createLoopRunner(loop, 'executor')
  const interpretToday = createWgslInterpreter(today.code)
  let bitShader: ReturnType<typeof emitBitLoopWgsl>
  let interpretBits: ReturnType<typeof createWgslInterpreter>
  try {
    bitShader = emitBitLoopWgsl(loop)
    interpretBits = createWgslInterpreter(bitShader.code)
  } catch (error) {
    result.threw = `while writing or parsing: ${(error as Error).message}`
    return result
  }
  result.rules = Object.fromEntries(Object.entries(bitShader.rules).filter(([, count]) => count > 0))
  result.packedWords = bitShader.packedCells.length
  result.statements[1] = bitShader.statementCount
  const documents = 4
  const cells = new Float32Array(documents * loop.buffers[0]!.cellsPerDocument)
  const shared = new Float32Array(loop.sharedValues)
  const sizes = loop.outputGroups.map(group => documents * group.valuesPerDocument)
  for (let round = 0; round < rounds; round++) {
    fillRound(probe, random, round, shared, cells)
    const expected = sizes.map(size => new Float32Array(size).fill(9))
    runner.setShared(shared)
    for (let row = 0; row < documents; row++) runner.run([cells], row, expected, row, row)
    const outputs = [interpretToday, interpretBits].map((interpret, writer) => {
      const actual = sizes.map(size => new Float32Array(size).fill(9))
      try {
        interpret(shared, cells, documents, actual, {window: {first: 0, count: documents}, packed: packWords(bitShader.packedCells, shared)})
      } catch (error) {
        if (writer === 0) throw error
        result.threw ??= `while running round ${round}: ${(error as Error).message}`
      }
      return actual
    })
    if (result.threw !== undefined) return result
    expected.forEach((values, group) => {
      result.values += values.length
      for (let index = 0; index < values.length; index++) {
        if (values[index] !== 0) result.nonZero++
        for (const writer of [0, 1] as const) {
          if (values[index] === outputs[writer]![group]![index]) continue
          result.mismatches[writer]++
          if (writer === 1) result.firstMismatch ??= `round ${round}, output group ${group} (${loop.outputGroups[group]!.name}), value ${index}: the executor gives ${values[index]}, bit-emit.ts's shader ${outputs[1]![group]![index]}`
        }
      }
    })
  }
  return result
}

// One forward stage over a document's 12 rows: the row of the position is the item, each register is carried, and
// each mark is written per position. Output group 0 holds the registers after the last row.
function rowsLoop(description: {
  circuit: Circuit
  initialSource: Float32Array
  row: Wire
  registers: readonly {cell: Wire, initial: number, next: Wire}[]
  marks: readonly Wire[]
}): LoopProgram {
  const {circuit, registers, marks} = description
  return {
    positions,
    buffers: [{name: 'rows', cellsPerDocument: positions}],
    registers: registers.map((register, index) => ({name: `register ${index}`, initial: register.initial})),
    fields: [],
    outputGroups: [
      {name: 'registers', kind: 'document', valuesPerDocument: Math.max(1, registers.length), fill: 0},
      ...marks.map((_, index) => ({name: `mark ${index}`, kind: 'position' as const, valuesPerDocument: positions, fill: 0})),
    ],
    stages: [createStage({
      name: 'rows', repeat: 'forward', circuit, sharedOffset: 0,
      bindings: new Map<Wire, Binding>([[description.row, {kind: 'item', buffer: 0}], ...registers.map(({cell}, index): [Wire, Binding] => [cell, {kind: 'register', register: index}])]),
      outputs: [
        ...marks.map((wire, index) => ({wire, write: {kind: 'position', group: 1 + index} as const})),
        ...registers.map(({next}, index) => ({wire: next, write: {kind: 'register', register: index} as const})),
      ],
    })],
    results: registers.map((_, index) => ({group: 0, column: index, register: index})),
    sharedValues: new Float32Array(description.initialSource),
    lengthCell: undefined,
  }
}

const range = (from: number, to: number) => Array.from({length: to - from + 1}, (_, index) => from + index)
// JS: !bits.some(bit => bit === 1), as relu(1 - sum of the bits), written out so that a list of one bit is a gate too.
const none = (circuit: Circuit, bits: readonly Wire[]) => circuit.reglu([], 1, bits.map(bit => [bit, -1] as const), 1)
// JS: wanted && table[row], as a read at row + weight × (1 - wanted). `weight` is how far an unwanted read moves.
const gatedRead = (circuit: Circuit, row: Wire, wanted: Wire, table: readonly Wire[], below: 'clamp' | 'zero', above: 'clamp' | 'zero', weight = table.length) =>
  circuit.indexReadAffine([[row, 1], [wanted, -weight]], weight, table, below, above)

// "Does any wanted flag hold at this row?", as in bit-emit.test.ts's flags, with what each probe changes. The reads
// feed gates, a count of the rows where the first gate found a flag, and a bit that says whether the last gate never did.
type FlagsOptions = {
  tables: number
  rows: number
  lowestRow: number
  highestRow: number
  // The gates, each a list of table numbers in the order in which the gate's reads are built.
  gates: readonly (readonly number[])[]
  read: (context: {circuit: Circuit, row: Wire, table: number, flags: readonly Wire[], wanted: Wire, extra: readonly Wire[]}) => Wire
  // More shared cells declared as exact bits, for a probe's own gating.
  extraBits?: number
  // What a table's cell is declared as, exact bits unless given.
  cell?: 'bit' | 'gridBit' | 'whole' | 'float' | 'constant'
  // The tables' cells row by row, table 0's row 0, table 1's row 0, and so on, instead of table by table.
  byRow?: boolean
  // The wanted cells before the tables instead of after them.
  wantedFirst?: boolean
}
function buildFlags(options: FlagsOptions): Probe {
  const {tables, rows} = options
  const kind = options.cell ?? 'bit'
  const flagCell = () => kind === 'bit' ? inputBit() : kind === 'gridBit' ? input([0, 1], {grid: 1}) : kind === 'whole' ? input([0, 3], {grid: 1}) : kind === 'float' ? input([0, 1]) : constant(1, [0, 1], {grid: 1})
  const table = createSourceTable()
  const wantedCells = () => list(tables, () => inputBit())
  const first = table.declare({wanted: options.wantedFirst === true ? wantedCells() : []})
  const cells = table.declare({
    row: input([options.lowestRow, options.highestRow], {initial: options.highestRow, grid: 1}),
    flags: options.byRow === true ? list(rows, () => list(tables, flagCell)) : list(tables, () => list(rows, flagCell)),
    wanted: options.wantedFirst === true ? [] : wantedCells(),
    extra: list(options.extraBits ?? 0, () => inputBit()),
    count: input([0, positions], {grid: 1}),
    quiet: inputBit(1),
  })
  const wanted = options.wantedFirst === true ? first.wanted : cells.wanted
  const flagsOf = (index: number) => options.byRow === true ? cells.flags.map(row => row[index]!) : cells.flags[index]!
  const circuit = table.createCircuit()
  const readOf = new Map<number, Wire>()
  const gates = options.gates.map(tablesOfGate => none(circuit, tablesOfGate.map(index => {
    let read = readOf.get(index)
    if (read === undefined) {
      read = options.read({circuit, row: cells.row, table: index, flags: flagsOf(index), wanted: wanted[index]!, extra: cells.extra})
      readOf.set(index, read)
    }
    return read
  })))
  const any = gates.map(gate => not(circuit, gate) as Wire)
  const nextCount = circuit.affine([[cells.count, 1], [any[0]!, 1]])
  const nextQuiet = and(circuit, cells.quiet, gates.at(-1)!) as Wire
  const {initialSource} = table.finish()
  const flagCells = cells.flags.flat()
  const flagValues = kind === 'whole' ? [0, 1, 2, 3] : kind === 'float' ? [0, 0.5, 1] : kind === 'constant' ? [1] : [0, 1]
  return {
    loop: rowsLoop({circuit, initialSource, row: cells.row, registers: [{cell: cells.count, initial: 0, next: nextCount}, {cell: cells.quiet, initial: 1, next: nextQuiet}], marks: any}),
    sharedBits: [...(kind === 'bit' ? flagCells : []), ...wanted, ...cells.extra],
    sharedNumbers: kind === 'bit' ? [] : flagCells.map(position => ({position, values: flagValues})),
    itemValues: range(options.lowestRow, options.highestRow),
  }
}

const flagsDefaults = {tables: 3, rows: 5, lowestRow: 0, highestRow: 5, gates: [[0, 1, 2]]} as const
const sides = ['clamp', 'zero'] as const

// Switches that stay on from one row to the next, as in bit-emit.test.ts's switches, with what each probe changes.
// JS for the plain form: on[k] = on[k] && !blocked[k][row] && !stuck[k], then any = on.some(isOn => isOn).
type SwitchesOptions = {
  switches: number
  // Which switch's register, table and shared cell the gate of switch k reads.
  operandOf?: (index: number) => number
  // Which switches the "no switch is on" gate reads, every one unless given.
  noneOver?: readonly number[]
  // Reads gated by the switch itself, blocked[k][row] && on[k], instead of plain reads.
  gatedBySwitch?: boolean
  // A second list of carried bits that the same loop writes: seen[k] = seen[k] || on[k].
  seen?: boolean
}
function buildSwitches(options: SwitchesOptions): Probe {
  const {switches} = options
  const rows = 5
  const table = createSourceTable()
  const cells = table.declare({
    row: input([0, rows], {initial: rows, grid: 1}),
    blocked: list(switches, () => list(rows, () => inputBit())),
    stuck: list(switches, () => inputBit()),
    on: list(switches, () => inputBit(1)),
    seen: list(options.seen === true ? switches : 0, () => inputBit()),
    count: input([0, positions], {grid: 1}),
  })
  const circuit = table.createCircuit()
  const nextSeen = cells.seen.map((seen, index) => circuit.roundAffine([[none(circuit, [seen, cells.on[index]!]), -1]], 1))
  const nextOn = cells.on.map((_, index): Wire => {
    const from = options.operandOf?.(index) ?? index
    const blocked = options.gatedBySwitch === true
      ? gatedRead(circuit, cells.row, cells.on[from]!, cells.blocked[from]!, 'clamp', 'zero', rows + 1)
      : circuit.indexReadAffine([[cells.row, 1]], 0, cells.blocked[from]!, 'clamp', 'zero')
    return circuit.reglu([], 1, [[cells.on[from]!, 1], [blocked, -1], [cells.stuck[from]!, -1]], 0)
  })
  const noneOn = none(circuit, (options.noneOver ?? range(0, switches - 1)).map(index => nextOn[index]!))
  const any = not(circuit, noneOn) as Wire
  const nextCount = circuit.affine([[cells.count, 1], [any, 1]])
  const {initialSource} = table.finish()
  return {
    loop: rowsLoop({
      circuit, initialSource, row: cells.row, marks: [any],
      registers: [
        ...cells.on.map((cell, index) => ({cell, initial: 1, next: nextOn[index]!})), ...cells.seen.map((cell, index) => ({cell, initial: 0, next: nextSeen[index]!})),
        {cell: cells.count, initial: 0, next: nextCount},
      ],
    }),
    sharedBits: [...cells.blocked.flat(), ...cells.stuck],
    sharedNumbers: [],
    itemValues: range(0, rows),
  }
}

// One gate over shared cells and whole numbers, for the Gate rule: `build` returns the wires to mark.
function buildGates(build: (context: {circuit: Circuit, bits: readonly Wire[], row: Wire, level: Wire}) => Wire[], bitCount = 6): Probe {
  const table = createSourceTable()
  const cells = table.declare({
    row: input([-2, 5], {initial: 0, grid: 1}),
    level: input([0, 3], {grid: 1}),
    bits: list(bitCount, () => inputBit()),
    count: input([0, positions], {grid: 1}),
  })
  const circuit = table.createCircuit()
  const marks = build({circuit, bits: cells.bits, row: cells.row, level: cells.level})
  const nextCount = circuit.affine([[cells.count, 1], [cells.bits[0]!, 1]])
  const {initialSource} = table.finish()
  return {
    loop: rowsLoop({circuit, initialSource, row: cells.row, registers: [{cell: cells.count, initial: 0, next: nextCount}], marks}),
    sharedBits: cells.bits,
    sharedNumbers: [{position: cells.level, values: [0, 1, 2, 3]}],
    itemValues: range(-2, 5),
  }
}

// Two stages with a circuit each, so that the second stage's shared cells start after the first's: a backward stage
// that keeps "a wanted flag holds at this row" per position in a field, and a forward stage that reads the field next
// to its own tables, which have another length.
function buildTwoCircuits(): Probe {
  const firstRows = 4
  const secondRows = 7
  const firstTable = createSourceTable()
  const first = firstTable.declare({
    row: input([0, 7], {grid: 1}),
    flags: list(3, () => list(firstRows, () => inputBit())),
    wanted: list(3, () => inputBit()),
  })
  const firstCircuit = firstTable.createCircuit()
  const firstNone = none(firstCircuit, first.flags.map((flags, index) => gatedRead(firstCircuit, first.row, first.wanted[index]!, flags, 'clamp', 'zero', firstRows + 4)))
  const firstAny = not(firstCircuit, firstNone) as Wire
  const firstSource = firstTable.finish().initialSource

  const secondTable = createSourceTable()
  const second = secondTable.declare({
    wanted: list(5, () => inputBit()),
    row: input([0, 7], {grid: 1}),
    kept: list(2, () => inputBit()),
    flags: list(5, () => list(secondRows, () => inputBit())),
    count: input([0, positions], {grid: 1}),
  })
  const secondCircuit = secondTable.createCircuit()
  const secondNone = none(secondCircuit, second.flags.map((flags, index) => gatedRead(secondCircuit, second.row, second.wanted[index]!, flags, 'clamp', 'zero', secondRows + 1)))
  // JS: both = keptAny && !secondNone
  const both = andNot(secondCircuit, second.kept[1]!, secondNone) as Wire
  const nextCount = secondCircuit.affine([[second.count, 1], [both, 1], [second.kept[0]!, 1]])
  const mark = secondCircuit.affine([[both, 1], [second.kept[0]!, 2]])
  const secondSource = secondTable.finish().initialSource
  const offset = firstSource.length
  return {
    loop: {
      positions,
      buffers: [{name: 'rows', cellsPerDocument: positions}],
      registers: [{name: 'count', initial: 0}],
      fields: [{name: 'kept', width: 2, bits: true}],
      outputGroups: [{name: 'count', kind: 'document', valuesPerDocument: 1, fill: 0}, {name: 'marks', kind: 'position', valuesPerDocument: positions, fill: 0}],
      stages: [
        createStage({
          name: 'keep', repeat: 'backward', circuit: firstCircuit, sharedOffset: 0, bindings: new Map<Wire, Binding>([[first.row, {kind: 'item', buffer: 0}]]),
          outputs: [{wire: firstNone, write: {kind: 'field', field: 0, component: 0}}, {wire: firstAny, write: {kind: 'field', field: 0, component: 1}}],
        }),
        createStage({
          name: 'count', repeat: 'forward', circuit: secondCircuit, sharedOffset: offset,
          bindings: new Map<Wire, Binding>([
            [second.row, {kind: 'item', buffer: 0}], [second.kept[0]!, {kind: 'field', field: 0, component: 0}], [second.kept[1]!, {kind: 'field', field: 0, component: 1}],
            [second.count, {kind: 'register', register: 0}],
          ]),
          outputs: [{wire: mark, write: {kind: 'position', group: 1}}, {wire: nextCount, write: {kind: 'register', register: 0}}],
        }),
      ],
      results: [{group: 0, column: 0, register: 0}],
      sharedValues: Float32Array.of(...firstSource, ...secondSource),
      lengthCell: undefined,
    },
    sharedBits: [...first.flags.flat(), ...first.wanted, ...second.wanted.map(wire => offset + wire), ...second.flags.flat().map(wire => offset + wire)],
    sharedNumbers: [],
    itemValues: range(0, 7),
  }
}

// A field of four bits per position that two loops fill, two bits each, and a third loop reads. The loop program
// declares the field as plain numbers (`bits: false`), where loop-emit.ts writes each number on its own.
function buildSplitField(): Probe {
  const table = createSourceTable()
  const cells = table.declare({
    row: input([0, 5], {grid: 1}),
    flags: list(4, () => list(5, () => inputBit())),
    kept: list(4, () => inputBit()),
    count: input([0, positions], {grid: 1}),
  })
  const circuit = table.createCircuit()
  const reads = cells.flags.map(flags => circuit.indexReadAffine([[cells.row, 1]], 0, flags, 'clamp', 'zero'))
  const copies = reads.map(read => circuit.roundAffine([[read, 1]]))
  // JS: count += kept[0] && !kept[1], and the mark is !kept.some(bit => bit).
  const nextCount = circuit.affine([[cells.count, 1], [andNot(circuit, cells.kept[0]!, cells.kept[1]!) as Wire, 1]])
  const mark = none(circuit, cells.kept)
  const {initialSource} = table.finish()
  const fill = (name: string, components: readonly number[]) => createStage({
    name, repeat: 'forward', circuit, sharedOffset: 0, bindings: new Map<Wire, Binding>([[cells.row, {kind: 'item', buffer: 0}]]),
    outputs: components.map(component => ({wire: copies[component]!, write: {kind: 'field', field: 0, component} as const})),
  })
  return {
    loop: {
      positions,
      buffers: [{name: 'rows', cellsPerDocument: positions}],
      registers: [{name: 'count', initial: 0}],
      fields: [{name: 'kept', width: 4, bits: false}],
      outputGroups: [{name: 'count', kind: 'document', valuesPerDocument: 1, fill: 0}, {name: 'marks', kind: 'position', valuesPerDocument: positions, fill: 0}],
      stages: [
        fill('first half', [0, 1]),
        fill('second half', [2, 3]),
        createStage({
          name: 'count', repeat: 'backward', circuit, sharedOffset: 0,
          bindings: new Map<Wire, Binding>([...cells.kept.map((wire, component): [Wire, Binding] => [wire, {kind: 'field', field: 0, component}]), [cells.count, {kind: 'register', register: 0}]]),
          outputs: [{wire: mark, write: {kind: 'position', group: 1}}, {wire: nextCount, write: {kind: 'register', register: 0}}],
        }),
      ],
      results: [{group: 0, column: 0, register: 0}],
      sharedValues: new Float32Array(initialSource),
      lengthCell: undefined,
    },
    sharedBits: cells.flags.flat(),
    sharedNumbers: [],
    itemValues: range(0, 5),
  }
}

// The search step's two passes (search-step.ts) written again without createStepAnd, noneOf and dataSearchCells, over a
// class per position instead of a code point, so that the reads' order, the tables' layout and length and the lists'
// order can each change. JS, with reach and finish as in search-step.ts:
//
//   notFinish = accepting.map(isAccepting => !isAccepting)
//   for (const position of positions.toReversed()) {
//     notReach[position] = states.map(from => !states.some(to => transitions[from][to][class] && !notFinish[to]))
//     notFinish = states.map(state => notReach[position][state] && !accepting[state])
//   }
//   for (const position of positions) {
//     continuing = states.map(state => reached[state] && !notReach[position][state])
//     start = !continuing.some(bit => bit) && !notReach[position][0]
//     live = continuing.map((bit, state) => state === 0 ? bit || start : bit)
//     reached = states.map(to => states.some(from => live[from] && transitions[from][to][class]))
//     matchCount += start
//   }
type MiniSearchOptions = {
  states: number
  classes: number
  // The order in which the reads of one gate are built: by state, backwards, or state 0 last.
  readOrder: 'ascending' | 'descending' | 'rotated'
  // How the transition cells are declared: one table after the other, class by class as in dataSearchCells, or the
  // tables of a class in reverse order of the states.
  layout: 'byTable' | 'byClass' | 'byClassReversed'
  // The reads as createStepAnd writes them, one index read that moves past the table, or as a plain read and an AND gate.
  form: 'movedIndex' | 'andGate'
  // The notReach bits of a position in the field in reverse order of the states.
  fieldReversed?: boolean
}
function buildMiniSearch(options: MiniSearchOptions): Probe {
  const {states, classes} = options
  const stateList = range(0, states - 1)
  const table = createSourceTable()
  const transitionCell = () => inputBit()
  const cells = table.declare({
    // The class of the position, with `classes` for a position that no step reads.
    class: input([0, classes], {initial: classes, grid: 1}),
    accepting: list(states, () => inputBit()),
    transitions: options.layout === 'byTable'
      ? list(states, () => list(states, () => list(classes, transitionCell)))
      : list(classes, () => list(states, () => list(states, transitionCell))),
    notFinish: list(states, () => inputBit(1)),
    codePointClass: input([0, classes], {initial: classes, grid: 1}),
    notReach: list(states, () => inputBit(1)),
    reached: list(states, () => inputBit()),
    matchCount: input([0, positions], {grid: 1}),
  })
  // The cells transitions[from][to][0], [1], and so on.
  const tableOf = (from: number, to: number) => options.layout === 'byTable'
    ? cells.transitions[from]![to]!
    : cells.transitions.map(byClass => options.layout === 'byClass' ? byClass[from]![to]! : byClass[states - 1 - from]![states - 1 - to]!)
  const circuit = table.createCircuit()
  const order = options.readOrder === 'ascending' ? stateList : options.readOrder === 'descending' ? stateList.toReversed() : [...stateList.slice(1), 0]
  // JS: transitions[from][to][class] && bit
  const step = (classOf: Wire, from: number, to: number, bit: Wire) => options.form === 'movedIndex'
    ? circuit.indexReadAffine([[classOf, 1], [bit, -classes]], classes, tableOf(from, to), 'clamp', 'zero')
    : circuit.reglu([], 1, [[circuit.indexReadAffine([[classOf, 1]], 0, tableOf(from, to), 'clamp', 'zero'), 1], [bit, 1]], -1)
  const startNotFinish = cells.accepting.map(accepting => circuit.roundAffine([[accepting, -1]], 1))
  const classCopy = circuit.roundAffine([[cells.class, 1]])
  const notReach = stateList.map(from => none(circuit, order.map(to => step(cells.class, from, to, circuit.affine([[cells.notFinish[to]!, -1]], 1)))))
  const nextNotFinish = stateList.map(state => circuit.reglu([], 1, [[notReach[state]!, 1], [cells.accepting[state]!, -1]], 0))
  const continuing = stateList.map(state => circuit.reglu([], 1, [[cells.reached[state]!, 1], [cells.notReach[state]!, -1]], 0))
  const notContinuing = none(circuit, continuing)
  const start = circuit.reglu([], 1, [[notContinuing, 1], [cells.notReach[0]!, -1]], 0)
  const live = continuing.map((bit, state) => state === 0 ? circuit.affine([[bit, 1], [start, 1]]) : bit)
  const mark = circuit.affine([[notContinuing, -1], [start, 2]], 1)
  const nextReached = stateList.map(to => circuit.roundAffine([[none(circuit, order.map(from => step(cells.codePointClass, from, to, live[from]!))), -1]], 1))
  const nextMatchCount = circuit.affine([[cells.matchCount, 1], [start, 1]])
  const {initialSource} = table.finish()
  const component = (state: number) => options.fieldReversed === true ? states - 1 - state : state
  return {
    loop: {
      positions,
      buffers: [{name: 'classes', cellsPerDocument: positions}],
      registers: [...stateList.map(state => ({name: `notFinish[${state}]`, initial: 1})), ...stateList.map(state => ({name: `reached[${state}]`, initial: 0})), {name: 'matchCount', initial: 0}],
      fields: [{name: 'class', width: 1, bits: false}, {name: 'notReach', width: states, bits: true}],
      outputGroups: [{name: 'matchCount', kind: 'document', valuesPerDocument: 1, fill: 0}, {name: 'marks', kind: 'position', valuesPerDocument: positions, fill: 0}],
      stages: [
        createStage({
          name: 'start', repeat: 'once', circuit, sharedOffset: 0, bindings: new Map(),
          outputs: startNotFinish.map((wire, state) => ({wire, write: {kind: 'register', register: state}})),
        }),
        createStage({
          name: 'reverse', repeat: 'backward', circuit, sharedOffset: 0,
          bindings: new Map<Wire, Binding>([[cells.class, {kind: 'item', buffer: 0}], ...cells.notFinish.map((wire, state): [Wire, Binding] => [wire, {kind: 'register', register: state}])]),
          outputs: [
            {wire: classCopy, write: {kind: 'field', field: 0, component: 0}},
            ...notReach.map((wire, state) => ({wire, write: {kind: 'field', field: 1, component: component(state)} as const})),
            ...nextNotFinish.map((wire, state) => ({wire, write: {kind: 'register', register: state} as const})),
          ],
        }),
        createStage({
          name: 'forward', repeat: 'forward', circuit, sharedOffset: 0,
          bindings: new Map<Wire, Binding>([
            [cells.codePointClass, {kind: 'field', field: 0, component: 0}],
            ...cells.notReach.map((wire, state): [Wire, Binding] => [wire, {kind: 'field', field: 1, component: component(state)}]),
            ...cells.reached.map((wire, state): [Wire, Binding] => [wire, {kind: 'register', register: states + state}]),
            [cells.matchCount, {kind: 'register', register: 2 * states}],
          ]),
          outputs: [
            {wire: mark, write: {kind: 'position', group: 1}},
            ...nextReached.map((wire, state) => ({wire, write: {kind: 'register', register: states + state} as const})),
            {wire: nextMatchCount, write: {kind: 'register', register: 2 * states}},
          ],
        }),
      ],
      results: [{group: 0, column: 0, register: 2 * states}],
      sharedValues: new Float32Array(initialSource),
      lengthCell: undefined,
    },
    sharedBits: [...cells.accepting, ...cells.transitions.flat(2)],
    sharedNumbers: [],
    itemValues: range(0, classes),
  }
}
const miniDefaults = {states: 8, classes: 16, readOrder: 'ascending', layout: 'byClass', form: 'movedIndex'} as const

// A register whose cell is declared on a grid, into which the stage writes a number that isn't on that grid. JS:
// level += step, with a step of e.g. 0.25 for a level that is declared a whole number. The cell's declaration is false
// for what the stage itself writes, which the executor doesn't check (it checks ranges, not grids), so loop-emit.ts's
// shader and the executor agree on e.g. 0.5. With a grid of 0.25 and a step of 0.125, the register is never a whole
// number by its declaration, and 4 × level is one by the circuit's grid.
function buildFractionRegister(grid: 1 | 0.25): Probe {
  const table = createSourceTable()
  const cells = table.declare({row: input([0, 4], {grid: 1}), step: input([0, 1]), level: input([0, 40], {grid})})
  const circuit = table.createCircuit()
  const next = circuit.roundAffine([[cells.level, 1], [cells.step, 1]])
  // What reads the register: a multiple of its value as an operation of its own, which the circuit puts on a grid of
  // 2, and a gate over that, relu(7 - 2 × level).
  const multiple = circuit.roundAffine([[cells.level, 2 / grid]])
  const left = circuit.reglu([], 1, [[multiple, -1]], 7)
  const {initialSource} = table.finish()
  return {
    loop: rowsLoop({circuit, initialSource, row: cells.row, registers: [{cell: cells.level, initial: 0, next}], marks: [left]}),
    sharedBits: [],
    sharedNumbers: [{position: cells.step, values: [0, grid / 4, 1]}],
    itemValues: range(0, 4),
  }
}

// The same through a field: a first loop keeps row + step per position, in a field whose cell the second loop declares
// a whole number, and the step is e.g. 0.25. The second loop marks relu(7 - 2 × kept) and counts the rows.
function buildFractionField(): Probe {
  const table = createSourceTable()
  const cells = table.declare({row: input([0, 4], {grid: 1}), step: input([0, 1]), kept: input([0, 5], {grid: 1}), count: input([0, positions], {grid: 1})})
  const circuit = table.createCircuit()
  const keep = circuit.roundAffine([[cells.row, 1], [cells.step, 1]])
  const twice = circuit.roundAffine([[cells.kept, 2]])
  const left = circuit.reglu([], 1, [[twice, -1]], 7)
  const nextCount = circuit.affine([[cells.count, 1]], 1)
  const {initialSource} = table.finish()
  return {
    loop: {
      positions,
      buffers: [{name: 'rows', cellsPerDocument: positions}],
      registers: [{name: 'count', initial: 0}],
      fields: [{name: 'kept', width: 1, bits: false}],
      outputGroups: [{name: 'count', kind: 'document', valuesPerDocument: 1, fill: 0}, {name: 'marks', kind: 'position', valuesPerDocument: positions, fill: 0}],
      stages: [
        createStage({
          name: 'keep', repeat: 'forward', circuit, sharedOffset: 0, bindings: new Map<Wire, Binding>([[cells.row, {kind: 'item', buffer: 0}]]),
          outputs: [{wire: keep, write: {kind: 'field', field: 0, component: 0}}],
        }),
        createStage({
          name: 'mark', repeat: 'backward', circuit, sharedOffset: 0,
          bindings: new Map<Wire, Binding>([[cells.kept, {kind: 'field', field: 0, component: 0}], [cells.count, {kind: 'register', register: 0}]]),
          outputs: [{wire: left, write: {kind: 'position', group: 1}}, {wire: nextCount, write: {kind: 'register', register: 0}}],
        }),
      ],
      results: [{group: 0, column: 0, register: 0}],
      sharedValues: new Float32Array(initialSource),
      lengthCell: undefined,
    },
    sharedBits: [],
    sharedNumbers: [{position: cells.step, values: [0, 0.25, 1]}],
    itemValues: range(0, 4),
  }
}

export const probes: Record<string, () => Probe> = {
  // Two gates that share two of their reads.
  sharedReads: () => buildFlags({...flagsDefaults, tables: 4, gates: [[0, 1, 2], [1, 2, 3]], read: ({circuit, row, flags, wanted}) => gatedRead(circuit, row, wanted, flags, 'clamp', 'zero')}),
  // The reads are built in another order than the tables are declared, and the tables' cells lie row by row with the
  // wanted cells before them.
  otherOrder: () => buildFlags({...flagsDefaults, tables: 4, gates: [[2, 0, 3, 1]], byRow: true, wantedFirst: true, read: ({circuit, row, flags, wanted}) => gatedRead(circuit, row, wanted, flags, 'clamp', 'zero')}),
  // Table 0 is read without a gating bit, table 1 when its wanted bit is 1, table 2 when its wanted bit is 0, and
  // table 3 behind a cell that is declared on a grid of 1 within 0..1 and always holds 1.
  constantTrue: () => buildFlags({
    ...flagsDefaults, tables: 4, gates: [[0, 1, 2, 3]], extraBits: 1,
    read: ({circuit, row, table, flags, wanted}) => table === 0 ? circuit.indexReadAffine([[row, 1]], 0, flags, 'clamp', 'zero')
      : table === 2 ? circuit.indexReadAffine([[row, 1], [wanted, flags.length]], 0, flags, 'clamp', 'zero')
        : gatedRead(circuit, row, wanted, flags, 'clamp', 'zero'),
  }),
  // More reads than a word holds: 33, 64 and 65.
  reads33: () => buildFlags({...flagsDefaults, tables: 33, gates: [range(0, 32)], read: ({circuit, row, flags, wanted}) => gatedRead(circuit, row, wanted, flags, 'clamp', 'zero')}),
  reads64: () => buildFlags({...flagsDefaults, tables: 64, gates: [range(0, 63)], read: ({circuit, row, flags, wanted}) => gatedRead(circuit, row, wanted, flags, 'clamp', 'zero')}),
  reads65: () => buildFlags({...flagsDefaults, tables: 65, gates: [range(0, 64)], read: ({circuit, row, flags, wanted}) => gatedRead(circuit, row, wanted, flags, 'clamp', 'zero')}),
  // 40 reads without a gating bit.
  reads40Ungated: () => buildFlags({...flagsDefaults, tables: 40, gates: [range(0, 39)], read: ({circuit, row, flags}) => circuit.indexReadAffine([[row, 1]], 0, flags, 'clamp', 'zero')}),
  // The gating bit is a comparison of the row with a wanted cell's sum, not a declared cell: [row >= 2 + wanted].
  comparedBits: () => buildFlags({
    ...flagsDefaults,
    read: ({circuit, row, flags, wanted}) => gatedRead(circuit, row, emitCompare(circuit, row, '>=', circuit.roundAffine([[wanted, 1]], 2)), flags, 'clamp', 'zero', flags.length + 1),
  }),
  // The gating bit is a comparison of two whole numbers, two gates: [row >= 2 + wanted × 2] with the wanted cell's
  // sum on a grid.
  comparedWholeBits: () => buildFlags({
    ...flagsDefaults, cell: 'bit',
    read: ({circuit, row, flags, table}) => gatedRead(circuit, row, emitCompare(circuit, row, '>=', circuit.constant(1 + table)), flags, 'clamp', 'zero', flags.length + 1),
  }),
  // Table 0 is gated by two bits that can both be 1, and then reads below the table, which is +0: wanted XOR extra.
  twoBitsZeroBelow: () => buildFlags({
    ...flagsDefaults, highestRow: 4, extraBits: 1,
    read: ({circuit, row, table, flags, wanted, extra}) => table === 0
      ? circuit.indexReadAffine([[row, 1], [wanted, -5], [extra[0]!, -5]], 5, flags, 'zero', 'zero')
      : gatedRead(circuit, row, wanted, flags, 'zero', 'zero'),
  }),
  // The same with rows up to 5, where both bits at 1 read row 0 from row 5.
  twoBitsReachRowZero: () => buildFlags({
    ...flagsDefaults, extraBits: 1,
    read: ({circuit, row, table, flags, wanted, extra}) => table === 0
      ? circuit.indexReadAffine([[row, 1], [wanted, -5], [extra[0]!, -5]], 5, flags, 'zero', 'zero')
      : gatedRead(circuit, row, wanted, flags, 'zero', 'zero'),
  }),
  // Three, four and five gating bits on every table.
  threeBits: () => buildFlags({
    ...flagsDefaults, highestRow: 4, extraBits: 2,
    read: ({circuit, row, flags, wanted, extra}) => circuit.indexReadAffine([[row, 1], [wanted, -5], [extra[0]!, -5], [extra[1]!, -5]], 5, flags, 'zero', 'zero'),
  }),
  fourBits: () => buildFlags({
    ...flagsDefaults, highestRow: 4, extraBits: 3,
    read: ({circuit, row, flags, wanted, extra}) => circuit.indexReadAffine([[row, 1], [wanted, -5], [extra[0]!, -5], [extra[1]!, 5], [extra[2]!, 10]], 5, flags, 'zero', 'zero'),
  }),
  fiveBits: () => buildFlags({
    ...flagsDefaults, highestRow: 4, extraBits: 4,
    read: ({circuit, row, flags, wanted, extra}) => circuit.indexReadAffine([[row, 1], [wanted, -5], ...extra.map(bit => [bit, -5] as const)], 5, flags, 'zero', 'zero'),
  }),
  // Tables whose cells aren't declared as exact bits.
  gridBitTables: () => buildFlags({...flagsDefaults, cell: 'gridBit', read: ({circuit, row, flags, wanted}) => gatedRead(circuit, row, wanted, flags, 'clamp', 'zero')}),
  constantTables: () => buildFlags({...flagsDefaults, cell: 'constant', read: ({circuit, row, flags, wanted}) => gatedRead(circuit, row, wanted, flags, 'clamp', 'zero')}),
  wholeTables: () => buildFlags({...flagsDefaults, cell: 'whole', read: ({circuit, row, flags, wanted}) => gatedRead(circuit, row, wanted, flags, 'clamp', 'zero')}),
  floatTables: () => buildFlags({...flagsDefaults, cell: 'float', read: ({circuit, row, flags, wanted}) => gatedRead(circuit, row, wanted, flags, 'clamp', 'zero')}),
  // Rows from -3 to 3 past the table, with each out-of-range rule on each side. With 'far', an unwanted read moves past
  // the table from every row. With 'near', it moves by the table's length, so an unwanted read of row -3 reads row 2.
  ...Object.fromEntries(sides.flatMap(below => sides.flatMap(above => (['far', 'near', 'ungated'] as const).map(gating => [`rows-${below}-${above}-${gating}`, () => buildFlags({
    ...flagsDefaults, lowestRow: -3, highestRow: 7,
    read: ({circuit, row, flags, wanted}) => gating === 'ungated' ? circuit.indexReadAffine([[row, 1]], 0, flags, below, above) : gatedRead(circuit, row, wanted, flags, below, above, gating === 'far' ? 8 : 5),
  })])))),
  // A table read backwards, row 4 first.
  reversedTables: () => buildFlags({...flagsDefaults, read: ({circuit, row, flags, wanted}) => gatedRead(circuit, row, wanted, flags.toReversed(), 'clamp', 'zero')}),
  // Tables of 1 row and of 2 rows.
  oneRow: () => buildFlags({...flagsDefaults, rows: 1, highestRow: 1, read: ({circuit, row, flags, wanted}) => gatedRead(circuit, row, wanted, flags, 'clamp', 'zero')}),
  twoRows: () => buildFlags({...flagsDefaults, rows: 2, highestRow: 2, read: ({circuit, row, flags, wanted}) => gatedRead(circuit, row, wanted, flags, 'zero', 'zero', 3)}),
  // Every table is read at a fixed row, row 2, when its wanted bit is 1: the index has no term but the gating bit.
  fixedRow: () => buildFlags({...flagsDefaults, read: ({circuit, flags, wanted}) => circuit.indexReadAffine([[wanted, -5]], 7, flags, 'clamp', 'zero')}),
  // Every table is read at twice the row.
  doubledRow: () => buildFlags({...flagsDefaults, highestRow: 3, read: ({circuit, row, flags, wanted}) => circuit.indexReadAffine([[row, 2], [wanted, -8]], 8, flags, 'clamp', 'zero')}),
  twoCircuits: buildTwoCircuits,
  splitField: buildSplitField,

  // Lanes.
  switches8: () => buildSwitches({switches: 8}),
  switches32: () => buildSwitches({switches: 32}),
  switches33: () => buildSwitches({switches: 33}),
  switches40: () => buildSwitches({switches: 40}),
  // Switch k reads switch 7 - k's register, table and cell.
  switchesReversed: () => buildSwitches({switches: 8, operandOf: index => 7 - index}),
  // Switch k reads switch k + 1's, and the last one switch 0's.
  switchesRotated: () => buildSwitches({switches: 8, operandOf: index => (index + 1) % 8}),
  // "No switch is on" over the switches 2 to 5 only.
  switchesPartNone: () => buildSwitches({switches: 8, noneOver: [2, 3, 4, 5]}),
  // The reads are gated by the switches themselves, as the search step's forward reads are by the reached bits.
  switchesGatedReads: () => buildSwitches({switches: 8, gatedBySwitch: true}),
  switchesGatedReads33: () => buildSwitches({switches: 33, gatedBySwitch: true}),
  // The loop carries two lists of 8 bits, the switches and "this switch was on at some row".
  switchesAndSeen: () => buildSwitches({switches: 8, seen: true}),

  // Gates over more shared bits than a word holds.
  noneOf40: () => buildGates(({circuit, bits}) => [none(circuit, bits)], 40),
  noneOf32: () => buildGates(({circuit, bits}) => [none(circuit, bits)], 32),
  noneOf33: () => buildGates(({circuit, bits}) => [none(circuit, bits)], 33),
  // JS: !bits.some(bit => !bit), over the negations as operations of their own.
  noneOfNegations40: () => buildGates(({circuit, bits}) => [none(circuit, bits.map(bit => circuit.roundAffine([[bit, -1]], 1)))], 40),
  // JS: !pairs.some(([a, b]) => a && !b), 20 gates of one form over 40 shared bits, then 40 gates.
  noneOfGates20: () => buildGates(({circuit, bits}) => [none(circuit, range(0, 19).map(index => andNot(circuit, bits[index]!, bits[20 + index]!) as Wire))], 40),
  noneOfGates40: () => buildGates(({circuit, bits}) => [none(circuit, range(0, 39).map(index => andNot(circuit, bits[index]!, bits[40 + index]!) as Wire))], 80),

  // The Gate rule's weights. A probe has at most four marks, so that its shader stays within WebGPU's default of 8
  // storage buffers.
  weights: () => buildGates(({circuit, bits, level}) => {
    const [a, b, c, d] = bits as [Wire, Wire, Wire, Wire]
    return [
      // a && b && !c, with weights other than 1: the bias plus the positive weights is 1.
      circuit.reglu([], 1, [[a, 2], [b, 1], [c, -2]], -2),
      // a alone, as relu(3a - 2).
      circuit.reglu([], 1, [[a, 3]], -2),
      // a && level === 0 && !d, with a whole number among the values that must be 0.
      circuit.reglu([], 1, [[a, 1], [level, -1], [d, -3]], 0),
      // A gate that can never be 1: relu(a - 1 - b).
      circuit.reglu([], 1, [[a, 1], [b, -1]], -1),
    ]
  }),
  // Gates that aren't of the Gate rule's form.
  otherGates: () => buildGates(({circuit, bits, level}) => {
    const [a, b] = bits as [Wire, Wire]
    return [
      // relu(2a - b) is 2 for a = 1, b = 0.
      circuit.reglu([], 1, [[a, 2], [b, -1]], 0),
      // relu(a + b) is 2 when both are 1.
      circuit.reglu([], 1, [[a, 1], [b, 1]], 0),
      // The bias plus the positive weights is 1, and the positive weight is on a whole number within 0..3.
      circuit.reglu([], 1, [[level, 1], [a, -1]], 0),
      // relu(1 - a - b) × (level + 2), a product.
      circuit.reglu([[level, 1]], 2, [[a, -1], [b, -1]], 1),
    ]
  }),
  // Comparisons inside gates: [row >= level] && a, [row === level], [row > level], and a comparison with a sum.
  comparisons: () => buildGates(({circuit, bits, row, level}) => [
    and(circuit, emitCompare(circuit, row, '>=', level), bits[0]!) as Wire,
    emitCompare(circuit, row, '===', level),
    emitCompare(circuit, row, '>', level),
    emitCompare(circuit, row, '<', circuit.roundAffine([[level, 2], [bits[1]!, -3]])),
  ]),
  // A comparison's inner gate, relu(level - row), that is also marked on its own.
  comparisonKept: () => buildGates(({circuit, bits, row, level}) => {
    const inner = circuit.reglu([], 1, [[level, 1], [row, -1]], 0)
    return [circuit.reglu([], 1, [[bits[2]!, 1], [inner, -1]], 0), circuit.roundAffine([[inner, 1]])]
  }),
  // A comparison of two values that are always 0, relu(a - b - 1) and relu(c + d - 3): the sign cascade multiplies
  // their difference by 2^127.
  comparedZeros: () => buildGates(({circuit, bits}) => {
    const [a, b, c, d] = bits as [Wire, Wire, Wire, Wire]
    return [emitCompare(circuit, circuit.reglu([], 1, [[a, 1], [b, -1]], -1), '>', circuit.reglu([], 1, [[c, 1], [d, 1]], -3))]
  }),
  // A weight of 2^31 on a value that is always 0.
  largeWeightOnZero: () => buildGates(({circuit, bits}) => {
    const [a, b, c] = bits as [Wire, Wire, Wire]
    return [circuit.reglu([], 1, [[circuit.reglu([], 1, [[a, 1], [b, -1]], -1), 2 ** 31], [c, 1]], 0)]
  }),
  registerFractionWritten: () => buildFractionRegister(1),
  registerOffGridWritten: () => buildFractionRegister(0.25),
  fieldFractionWritten: buildFractionField,

  // The search step's passes written again, then with one thing changed each.
  miniSearch: () => buildMiniSearch(miniDefaults),
  miniSearch32: () => buildMiniSearch({...miniDefaults, states: 32}),
  miniSearch3States40Classes: () => buildMiniSearch({...miniDefaults, states: 3, classes: 40}),
  miniSearch20States5Classes: () => buildMiniSearch({...miniDefaults, states: 20, classes: 5}),
  miniSearchByTable: () => buildMiniSearch({...miniDefaults, layout: 'byTable'}),
  miniSearchByClassReversed: () => buildMiniSearch({...miniDefaults, layout: 'byClassReversed'}),
  miniSearchDescending: () => buildMiniSearch({...miniDefaults, readOrder: 'descending'}),
  miniSearchRotated: () => buildMiniSearch({...miniDefaults, readOrder: 'rotated'}),
  miniSearchFieldReversed: () => buildMiniSearch({...miniDefaults, fieldReversed: true}),
  miniSearchAndGate: () => buildMiniSearch({...miniDefaults, form: 'andGate'}),
  miniSearchAndGateDescending: () => buildMiniSearch({...miniDefaults, form: 'andGate', readOrder: 'descending'}),
}

if (import.meta.main) {
  const only = process.argv[2]
  for (const [name, build] of Object.entries(probes)) {
    if (only !== undefined && name !== only) continue
    let line: string
    try {
      const probe = build()
      if (only !== undefined) console.log(emitBitLoopWgsl(probe.loop).code)
      const result = compareProbe(probe, 20261014)
      line = result.threw !== undefined
        ? `THREW ${result.threw}`
        : `${result.mismatches[1] === 0 ? 'same' : 'DIFFERENT'}: ${result.values} values, ${result.nonZero} not 0, ${result.mismatches[0]} and ${result.mismatches[1]} differ from the executor's; rules ${JSON.stringify(result.rules)}, ${result.packedWords} words; statements ${result.statements[0]} and ${result.statements[1]}${result.firstMismatch === undefined ? '' : `; ${result.firstMismatch}`}`
    } catch (error) {
      line = `THREW before bit-emit.ts ran: ${(error as Error).message}`
    }
    console.log(`${name}: ${line}`)
  }
}
