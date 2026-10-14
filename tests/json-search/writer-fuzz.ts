// An independent check of bit-emit.ts by a reviewer: random loop programs, each run as both writers' shaders through
// the strict WGSL interpreter and on the CPU executor, with writer-probes.ts's comparison.
//
//   bun tests/json-search/writer-fuzz.ts scalar 2000 [firstSeed]    random operations over bits, whole numbers and ordinary numbers
//   bun tests/json-search/writer-fuzz.ts lanes 2000 [firstSeed]     the same operation for every bit of a list, over registers, fields, shared cells and table reads
//   bun tests/json-search/writer-fuzz.ts broken 2000 [firstSeed]    'scalar' with two registers whose own stage breaks their declarations
//   bun tests/json-search/writer-fuzz.ts scalar 1 <seed> show       one program, with bit-emit.ts's shader
//
// A 'scalar' or 'lanes' program keeps its declarations: a cell declared as a bit only ever holds 0 or 1, and a cell
// declared within a range of whole numbers only holds such numbers. So a value that differs between the two shaders
// is the writer's mistake and not the program's. The generator tracks what each value can hold: a bit, a whole number
// within a range, or an ordinary number. A 'broken' program is built as if two of its registers kept their
// declarations, and its stage writes e.g. 1.5 into a register that is declared a whole number. The executor accepts
// that, since it checks a cell's range and not its grid, and bit-emit.ts has to find it and give loop-emit.ts's values.
import {type Wire, emitCompare} from '../../src/runtime/numeric-ui-core.ts'
import {createSourceTable, input, inputBit, list} from '../../src/runtime/cells.ts'
import {emitBitLoopWgsl} from '../../src/json-search/bit-emit.ts'
import {type Binding, type LoopProgram, createStage} from '../../src/json-search/loop-program.ts'
import {type Probe, compareProbe, createRandom, pick, positions} from './writer-probes.ts'

type Value =
  | {wire: Wire, kind: 'bit'}
  | {wire: Wire, kind: 'whole', minimum: number, maximum: number}
  | {wire: Wire, kind: 'float'}
type WholeValue = Extract<Value, {kind: 'bit' | 'whole'}>

const rangeOf = (value: WholeValue) => value.kind === 'bit' ? {minimum: 0, maximum: 1} : value
const integer = (random: () => number, from: number, to: number) => from + Math.floor(random() * (to - from + 1))
const chance = (random: () => number, probability: number) => random() < probability
function sample<Item>(random: () => number, items: readonly Item[], count: number): Item[] {
  const left = [...items]
  const picked: Item[] = []
  while (picked.length < count && left.length > 0) picked.push(left.splice(Math.floor(random() * left.length), 1)[0]!)
  return picked
}

// The range of bias + Σ weight × value.
function sumRange(terms: readonly (readonly [WholeValue, number])[], bias: number) {
  let minimum = bias
  let maximum = bias
  for (const [value, weight] of terms) {
    const range = rangeOf(value)
    minimum += weight > 0 ? weight * range.minimum : weight * range.maximum
    maximum += weight > 0 ? weight * range.maximum : weight * range.minimum
  }
  return {minimum, maximum}
}
const wholeOrBit = (wire: Wire, {minimum, maximum}: {minimum: number, maximum: number}): Value => minimum >= 0 && maximum <= 1 ? {wire, kind: 'bit'} : {wire, kind: 'whole', minimum, maximum}
const wires = (terms: readonly (readonly [WholeValue, number])[]) => terms.map(([value, weight]) => [value.wire, weight] as const)

// ---------------------------------------------------------------------------------------------------------------
// 'scalar': random operations.

export function buildScalar(seed: number, breakDeclarations = false): Probe {
  const random = createRandom(seed)
  const rows = integer(random, 1, 6)
  const lowestRow = pick(random, [0, 0, -1, -2])
  const highestRow = rows - 1 + pick(random, [0, 1, 1, 3])
  const bitTableCount = integer(random, 2, 7)
  const registerCount = integer(random, 2, 5)
  const registerInitials = list(registerCount, () => integer(random, 0, 1))
  const table = createSourceTable()
  const cells = table.declare({
    row: input([lowestRow, highestRow], {initial: 0, grid: 1}),
    bitTables: list(bitTableCount, () => list(rows, () => inputBit())),
    wholeTable: list(rows, () => input([0, 3], {grid: 1})),
    floatTable: list(rows, () => input([0, 1])),
    bits: list(5, () => inputBit()),
    levels: list(2, () => input([0, 3], {grid: 1})),
    offset: input([-2, 2], {grid: 1}),
    fraction: input([0, 1]),
    registers: registerInitials.map(initial => inputBit(initial)),
    count: input([0, positions], {grid: 1}),
    level: input([0, 3], {grid: 1}),
    total: input([-4096, 4096]),
  })
  const circuit = table.createCircuit()
  const row: Value = {wire: cells.row, kind: 'whole', minimum: lowestRow, maximum: highestRow}
  const pool: Value[] = [
    row,
    ...cells.bits.map((wire): Value => ({wire, kind: 'bit'})),
    ...cells.levels.map((wire): Value => ({wire, kind: 'whole', minimum: 0, maximum: 3})),
    {wire: cells.offset, kind: 'whole', minimum: -2, maximum: 2},
    {wire: cells.fraction, kind: 'float'},
    ...cells.registers.map((wire): Value => ({wire, kind: 'bit'})),
    {wire: cells.count, kind: 'whole', minimum: 0, maximum: positions},
    {wire: cells.level, kind: 'whole', minimum: 0, maximum: 3},
    {wire: cells.total, kind: 'float'},
  ]
  const bitsOf = () => pool.filter(value => value.kind === 'bit')
  // Whole numbers that stay small, so that sums of them stay far below 2^24.
  const wholesOf = () => pool.filter((value): value is WholeValue => value.kind === 'bit' || (value.kind === 'whole' && value.minimum >= -64 && value.maximum <= 64))
  const push = (value: Value) => {
    pool.push(value)
    return value
  }
  const bit = (wire: Wire) => push({wire, kind: 'bit'})

  // An index read of one table at base + gate, see bit-emit.ts's Packed reads rule. `base` is the row, the row plus a
  // small whole number, or a whole number.
  type ReadForm = {baseTerms: (readonly [WholeValue, number])[], baseBias: number, below: 'clamp' | 'zero', above: 'clamp' | 'zero'}
  const readForm = (): ReadForm => {
    const baseTerms: (readonly [WholeValue, number])[] = chance(random, 0.75) ? [[row, 1]] : [[pick(random, wholesOf()), pick(random, [1, 1, 2, -1])]]
    if (chance(random, 0.2)) baseTerms.push([pick(random, wholesOf()), pick(random, [1, -1])])
    return {baseTerms, baseBias: pick(random, [0, 0, 0, 1, -1]), below: pick(random, ['clamp', 'zero']), above: pick(random, ['clamp', 'zero', 'zero'])}
  }
  const read = (form: ReadForm, candidates: readonly Wire[], gatingCount: number) => {
    const terms = [...form.baseTerms]
    let bias = form.baseBias
    for (const gating of sample(random, bitsOf(), gatingCount)) {
      // How far the bit moves the index: past the table from every row, exactly the table's length, or one less.
      const magnitude = Math.max(1, candidates.length + pick(random, [4, 4, 4, 1, 0, 0, -1]))
      if (chance(random, 0.7)) {
        // JS: table[base] && bit, the read moves away while the bit is 0.
        terms.push([gating, -magnitude])
        bias += magnitude
      } else {
        terms.push([gating, chance(random, 0.8) ? magnitude : -magnitude])
      }
    }
    return circuit.indexReadAffine(wires(terms), bias, candidates, form.below, form.above)
  }
  const gatingCounts = [0, 1, 1, 1, 1, 2, 2, 3, 5]

  const operations = integer(random, 6, 28)
  for (let operation = 0; operation < operations; operation++) {
    const bits = bitsOf()
    const wholes = wholesOf()
    switch (pick(random, ['not', 'conjunction', 'conjunction', 'relu', 'product', 'sum', 'exclusive', 'compare', 'read', 'readGroup', 'readGroup', 'readGroup', 'boolean', 'copy', 'large'] as const)) {
      case 'not':
        // As an operation of its own, or as a small sum that the builder copies into whatever reads it.
        bit(chance(random, 0.5) ? circuit.roundAffine([[pick(random, bits).wire, -1]], 1) : circuit.affine([[pick(random, bits).wire, -1]], 1))
        break
      case 'conjunction': {
        // The Gate rule's form: the bias plus the positive weights is 1.
        const all = sample(random, bits, integer(random, 0, 3)).map(value => [value.wire, pick(random, [1, 1, 1, 2, 3])] as const)
        const zeros = sample(random, wholes.filter(value => rangeOf(value).minimum >= 0), integer(random, all.length === 0 ? 1 : 0, 5)).map(value => [value.wire, -pick(random, [1, 1, 1, 2])] as const)
        if (all.length + zeros.length === 0) break
        bit(circuit.reglu([], 1, [...all, ...zeros], 1 - all.reduce((total, [, weight]) => total + weight, 0)))
        break
      }
      case 'relu': {
        const terms = sample(random, wholes, integer(random, 1, 4)).map(value => [value, pick(random, [1, 1, -1, -1, 2, -2, 3])] as const)
        const bias = integer(random, -3, 3)
        const range = sumRange(terms, bias)
        push(wholeOrBit(circuit.reglu([], 1, wires(terms), bias), {minimum: Math.max(0, range.minimum), maximum: Math.max(0, range.maximum)}))
        break
      }
      case 'product': {
        const leftTerms = sample(random, wholes, integer(random, 1, 2)).map(value => [value, pick(random, [1, 1, -1, 2])] as const)
        const gateTerms = sample(random, wholes, integer(random, 1, 3)).map(value => [value, pick(random, [1, 1, -1, -1, 2])] as const)
        const left = sumRange(leftTerms, integer(random, -2, 2))
        const leftBias = left.minimum - sumRange(leftTerms, 0).minimum
        const gateBias = integer(random, -2, 2)
        const gate = sumRange(gateTerms, gateBias)
        const products = [left.minimum, left.maximum].flatMap(side => [side * Math.max(0, gate.minimum), side * Math.max(0, gate.maximum)])
        push(wholeOrBit(circuit.reglu(wires(leftTerms), leftBias, wires(gateTerms), gateBias), {minimum: Math.min(...products), maximum: Math.max(...products)}))
        break
      }
      case 'sum': {
        const terms = sample(random, wholes, integer(random, 1, 3)).map(value => [value, pick(random, [1, 1, -1, 2, -2])] as const)
        const bias = integer(random, -2, 2)
        const wire = chance(random, 0.5) ? circuit.roundAffine(wires(terms), bias) : circuit.affine(wires(terms), bias)
        push(wholeOrBit(wire, sumRange(terms, bias)))
        break
      }
      case 'exclusive': {
        // JS: (x && !y) + (x && y), two bits that are never both 1, so their sum is a bit, which only the gates say.
        const [x, y] = sample(random, bits, 2)
        if (x === undefined || y === undefined) break
        const first = bit(circuit.reglu([], 1, [[x.wire, 1], [y.wire, -1]], 0))
        const second = bit(circuit.reglu([], 1, [[x.wire, 1], [y.wire, 1]], -1))
        bit(circuit.affine([[first.wire, 1], [second.wire, 1]]))
        break
      }
      case 'compare': {
        const [a, b] = sample(random, chance(random, 0.85) ? wholes : pool.filter(value => value.wire !== cells.total), 2)
        if (a === undefined || b === undefined) break
        bit(emitCompare(circuit, a.wire, pick(random, ['>', '>=', '<', '<=', '===']), b.wire))
        break
      }
      case 'read': {
        const kind = pick(random, ['bit', 'bit', 'whole', 'float'] as const)
        const wire = read(readForm(), kind === 'bit' ? pick(random, cells.bitTables) : kind === 'whole' ? cells.wholeTable : cells.floatTable, pick(random, gatingCounts))
        push(kind === 'bit' ? {wire, kind: 'bit'} : kind === 'whole' ? {wire, kind: 'whole', minimum: 0, maximum: 3} : {wire, kind: 'float'})
        break
      }
      case 'readGroup': {
        // Several tables read at the same index, and one gate over the reads and a few other values.
        const form = readForm()
        const tables = sample(random, cells.bitTables, integer(random, 2, bitTableCount))
        const gatingCount = pick(random, gatingCounts)
        const reads = tables.map(candidates => bit(read(form, chance(random, 0.1) ? candidates.toReversed() : candidates, chance(random, 0.8) ? gatingCount : pick(random, gatingCounts))))
        const others = sample(random, wholes.filter(value => rangeOf(value).minimum >= 0), pick(random, [0, 0, 0, 1, 2]))
        const all = sample(random, bits, pick(random, [0, 0, 0, 1]))
        bit(circuit.reglu([], 1, [...all.map(value => [value.wire, 1] as const), ...reads.map(value => [value.wire, -1] as const), ...others.map(value => [value.wire, -1] as const)], 1 - all.length))
        break
      }
      case 'boolean':
        bit(circuit.boolean(pick(random, [...bits.map(value => value.wire), cells.fraction])))
        break
      case 'copy':
        bit(circuit.roundAffine([[pick(random, bits).wire, 1]]))
        break
      case 'large': {
        // A sum past 2^24, where FP32 rounds: an ordinary number.
        const terms = sample(random, wholes, 2).map(value => [value.wire, pick(random, [2 ** 24, 2 ** 23, 2 ** 24 - 1, 3])] as const)
        push({wire: circuit.roundAffine(terms, pick(random, [0, 1, 2 ** 24 - 1])), kind: 'float'})
        break
      }
    }
  }

  // A stage's output is an operation, so a source cell is copied.
  const computed = (value: Value) => value.wire >= circuit.sourceSize ? value.wire : circuit.roundAffine([[value.wire, 1]])
  const bits = bitsOf()
  // JS for a broken register of bits: bit - fraction, e.g. 0.75, which is still within the cell's range of 0..1.
  const nextRegisters = cells.registers.map((_, index) => breakDeclarations && index === 0 ? circuit.reglu([], 1, [[pick(random, bits).wire, 1], [cells.fraction, -1]], 0) : computed(pick(random, bits)))
  const nextCount = circuit.affine([[cells.count, 1], [pick(random, bits).wire, 1]])
  const levels = pool.filter(value => value.kind === 'bit' || (value.kind === 'whole' && value.minimum >= 0 && value.maximum <= 3))
  // JS for a broken level: half a whole number of 0 to 3, e.g. 1.5.
  const nextLevel = breakDeclarations ? circuit.roundAffine([[pick(random, levels).wire, 0.5]]) : computed(pick(random, levels))
  const addends = pool.filter(value => value.wire !== cells.total && (value.kind !== 'whole' || (value.minimum >= -64 && value.maximum <= 64)) && circuit.ranges[value.wire]!.minimum >= -64 && circuit.ranges[value.wire]!.maximum <= 64)
  const nextTotal = circuit.roundAffine([[cells.total, 1], [pick(random, addends).wire, 1]])
  const marks = sample(random, pool.filter(value => value.wire !== cells.total), integer(random, 1, 4)).map(computed)
  const {initialSource} = table.finish()
  const registers = [
    ...cells.registers.map((cell, index) => ({cell, initial: registerInitials[index]!, next: nextRegisters[index]!})),
    {cell: cells.count, initial: 0, next: nextCount}, {cell: cells.level, initial: 0, next: nextLevel}, {cell: cells.total, initial: 0, next: nextTotal},
  ]
  const loop: LoopProgram = {
    positions,
    buffers: [{name: 'rows', cellsPerDocument: positions}],
    registers: registers.map((register, index) => ({name: `register ${index}`, initial: register.initial})),
    fields: [],
    outputGroups: [
      {name: 'registers', kind: 'document', valuesPerDocument: registers.length, fill: 0},
      ...marks.map((_, index) => ({name: `mark ${index}`, kind: 'position' as const, valuesPerDocument: positions, fill: 0})),
    ],
    stages: [createStage({
      name: 'rows', repeat: 'forward', circuit, sharedOffset: 0,
      bindings: new Map<Wire, Binding>([[cells.row, {kind: 'item', buffer: 0}], ...registers.map(({cell}, index): [Wire, Binding] => [cell, {kind: 'register', register: index}])]),
      outputs: [
        ...marks.map((wire, index) => ({wire, write: {kind: 'position', group: 1 + index} as const})),
        ...registers.map(({next}, index) => ({wire: next, write: {kind: 'register', register: index} as const})),
      ],
    })],
    results: registers.map((_, index) => ({group: 0, column: index, register: index})),
    sharedValues: new Float32Array(initialSource),
    lengthCell: undefined,
  }
  return {
    loop,
    sharedBits: [...cells.bitTables.flat(), ...cells.bits],
    sharedNumbers: [
      ...cells.wholeTable.map(position => ({position, values: [0, 1, 2, 3]})), ...cells.floatTable.map(position => ({position, values: [0, 0.5, 0.75, 1]})),
      ...cells.levels.map(position => ({position, values: [0, 1, 2, 3]})), {position: cells.offset, values: [-2, -1, 0, 1, 2]}, {position: cells.fraction, values: [0, 0.25, 0.5, 1]},
    ],
    itemValues: Array.from({length: highestRow - lowestRow + 1}, (_, index) => lowestRow + index),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 'lanes': lists of bits, with one operation for every bit of a list.
//
// Two stages over one circuit, as in the search step: a backward stage carries the bits P and keeps the bits F of every
// position in a field, and a forward stage reads F, carries the bits Q, and marks. A list has `width` bits. JS for one
// program that the generator can write:
//
//   for (row of rows.toReversed()) { F[row] = P.map((p, k) => p && !tables[k][row]); P = F[row].map((f, k) => !f || shared[k]) }
//   for (row of rows) { Q = Q.map((q, k) => q && !F[row][k]); marks.push(!Q.some(q => q)) }
//
// In three programs of ten, a document has one more cell, which both loops stop at as the text's length, and which the
// stages also read as a number, `limit`.

export function buildLanes(seed: number): Probe {
  const random = createRandom(seed)
  const width = pick(random, [2, 3, 4, 5, 8, 8, 9, 16, 31, 32])
  const rows = integer(random, 2, 5)
  const highestRow = rows - 1 + pick(random, [0, 1, 2])
  // A square of tables, tables[from][to], for the forms that read one table per pair of bits, as the search step does.
  const square = width <= 5
  const withLength = chance(random, 0.3)
  const initials = list(2, () => list(width, () => integer(random, 0, 1)))
  const table = createSourceTable()
  const cells = table.declare({
    row: input([0, highestRow], {initial: 0, grid: 1}),
    tables: list(3, () => list(width, () => list(rows, () => inputBit()))),
    square: list(square ? width : 0, () => list(width, () => list(rows, () => inputBit()))),
    shared: list(2, () => list(width, () => inputBit())),
    bits: list(3, () => inputBit()),
    limit: input([0, highestRow], {grid: 1}),
    p: initials[0]!.map(initial => inputBit(initial)),
    kept: list(width, () => inputBit()),
    q: initials[1]!.map(initial => inputBit(initial)),
    count: input([0, positions], {grid: 1}),
  })
  const circuit = table.createCircuit()
  const lanes = Array.from({length: width}, (_, lane) => lane)

  type Pool = {lists: Wire[][], bits: Wire[]}
  const grow = (pool: Pool, operations: number) => {
    const {lists, bits} = pool
    // A list as it is, or sometimes with its bits in another order, which is no longer one word's neighboring lanes.
    const operand = () => {
      const picked = pick(random, lists)
      if (chance(random, 0.85)) return picked
      return chance(random, 0.5) ? picked.toReversed() : lanes.map(lane => picked[(lane + 1) % width]!)
    }
    const readList = (tables: readonly (readonly Wire[])[], gating: readonly Wire[] | undefined, form: {bias: number, below: 'clamp' | 'zero', above: 'clamp' | 'zero'}) => tables.map((candidates, lane) => {
      const reach = candidates.length + 3
      const gate = gating?.[lane]
      return gate === undefined
        ? circuit.indexReadAffine([[cells.row, 1]], form.bias, candidates, form.below, form.above)
        : circuit.indexReadAffine([[cells.row, 1], [gate, -reach]], form.bias + reach, candidates, form.below, 'zero')
    })
    const form = () => ({bias: pick(random, [0, 0, 0, 1, -1]), below: pick(random, ['clamp', 'zero'] as const), above: pick(random, ['clamp', 'zero', 'zero'] as const)})
    for (let operation = 0; operation < operations; operation++) {
      switch (pick(random, ['not', 'gate', 'gate', 'gate', 'reads', 'reads', 'none', 'none', 'noneOfPart', 'start', 'transition', 'bitGate', 'oddOne', 'limit'] as const)) {
        case 'limit':
          bits.push(emitCompare(circuit, cells.row, pick(random, ['>=', '<', '===']), cells.limit))
          break
        case 'not': {
          const list = operand()
          const kept = chance(random, 0.5)
          lists.push(list.map(bit => kept ? circuit.roundAffine([[bit, -1]], 1) : circuit.affine([[bit, -1]], 1)))
          break
        }
        case 'gate': {
          // JS: all.every(list => list[k]) && !zeros.some(list => list[k]), for every k.
          const all = Array.from({length: integer(random, 0, 2)}, operand)
          const zeros = Array.from({length: integer(random, all.length === 0 ? 1 : 0, 3)}, operand)
          // Sometimes one bit of the scalar pool in every gate.
          const scalar = chance(random, 0.2) ? pick(random, bits) : undefined
          lists.push(lanes.map(lane => circuit.reglu([], 1, [
            ...all.map(list => [list[lane]!, 1] as const), ...zeros.map(list => [list[lane]!, -1] as const), ...(scalar === undefined ? [] : [[scalar, -1] as const]),
          ], 1 - all.length)))
          break
        }
        case 'reads':
          lists.push(readList(pick(random, cells.tables), chance(random, 0.6) ? operand() : undefined, form()))
          break
        case 'none':
          bits.push(circuit.reglu([], 1, pick(random, lists).map(bit => [bit, -1] as const), 1))
          break
        case 'noneOfPart': {
          const list = pick(random, lists)
          const from = integer(random, 0, width - 1)
          const to = integer(random, from, width - 1)
          bits.push(circuit.reglu([], 1, list.slice(from, to + 1).map(bit => [bit, -1] as const), 1))
          break
        }
        case 'start': {
          // JS: start = !list.some(bit => bit) && other, then list[0] || start, two bits that are never both 1, as a sum.
          const list = pick(random, lists)
          const noneOfList = circuit.reglu([], 1, list.map(bit => [bit, -1] as const), 1)
          const start = circuit.reglu([], 1, [[noneOfList, 1], [pick(random, bits), -1]], 0)
          bits.push(start)
          const lane = pick(random, [0, 0, width - 1])
          lists.push(list.map((bit, index) => index === lane ? circuit.affine([[bit, 1], [start, 1]]) : bit))
          break
        }
        case 'transition': {
          if (!square) break
          // JS: next[to] = lanes.some(from => list[from] && square[from][to][row]), or the same with from and to swapped.
          const list = operand()
          const byColumn = chance(random, 0.5)
          const shape = form()
          const negated = chance(random, 0.5)
          lists.push(lanes.map(to => {
            const reads = readList(lanes.map(from => byColumn ? cells.square[from]![to]! : cells.square[to]![from]!), list, shape)
            const noneOfReads = circuit.reglu([], 1, reads.map(read => [read, -1] as const), 1)
            return negated ? circuit.roundAffine([[noneOfReads, -1]], 1) : noneOfReads
          }))
          break
        }
        case 'bitGate': {
          const [a, b] = sample(random, bits, 2)
          if (a === undefined || b === undefined) break
          bits.push(chance(random, 0.5) ? circuit.reglu([], 1, [[a, 1], [b, -1]], 0) : circuit.reglu([], 1, [[a, 1], [b, 1]], -1))
          break
        }
        case 'oddOne': {
          // One gate of the list has another form than the others.
          const a = operand()
          const b = operand()
          const odd = integer(random, 0, width - 1)
          lists.push(lanes.map(lane => lane === odd ? circuit.reglu([], 1, [[a[lane]!, 1], [b[lane]!, 1]], -1) : circuit.reglu([], 1, [[a[lane]!, 1], [b[lane]!, -1]], 0)))
          break
        }
      }
    }
  }
  const sharedLists = (): Wire[][] => cells.shared.map(list => [...list])
  // A list whose every bit is an operation, for a stage's outputs.
  const computed = (list: readonly Wire[]) => list.map(bit => bit >= circuit.sourceSize ? bit : circuit.roundAffine([[bit, 1]]))

  const backward: Pool = {lists: [[...cells.p], ...sharedLists()], bits: [...cells.bits]}
  grow(backward, integer(random, 2, 7))
  const keptNext = computed(pick(random, backward.lists))
  const pNext = computed(pick(random, backward.lists))

  const forward: Pool = {lists: [[...cells.kept], [...cells.q], ...sharedLists()], bits: [...cells.bits]}
  grow(forward, integer(random, 2, 8))
  const qNext = computed(pick(random, forward.lists))
  const marks = [...sample(random, forward.bits, 2), pick(random, pick(random, forward.lists))].map(bit => bit >= circuit.sourceSize ? bit : circuit.roundAffine([[bit, 1]]))
  const nextCount = circuit.affine([[cells.count, 1], [pick(random, forward.bits), 1]])
  const {initialSource} = table.finish()

  const limitBinding: [Wire, Binding][] = withLength ? [[cells.limit, {kind: 'cell', buffer: 0, column: positions}]] : []
  const pRegister = (lane: number) => lane
  const qRegister = (lane: number) => width + lane
  const countRegister = 2 * width
  const loop: LoopProgram = {
    positions,
    buffers: [{name: 'rows', cellsPerDocument: withLength ? positions + 1 : positions}],
    registers: [...initials[0]!.map((initial, lane) => ({name: `p[${lane}]`, initial})), ...initials[1]!.map((initial, lane) => ({name: `q[${lane}]`, initial})), {name: 'count', initial: 0}],
    // Sometimes the field is declared as plain numbers, which bit-emit.ts may still hold as a word.
    fields: [{name: 'kept', width, bits: chance(random, 0.7)}],
    outputGroups: [
      {name: 'registers', kind: 'document', valuesPerDocument: 2 * width + 1, fill: 0},
      ...marks.map((_, index) => ({name: `mark ${index}`, kind: 'position' as const, valuesPerDocument: positions, fill: 0})),
    ],
    stages: [
      createStage({
        name: 'backward', repeat: 'backward', circuit, sharedOffset: 0,
        bindings: new Map<Wire, Binding>([[cells.row, {kind: 'item', buffer: 0}], ...limitBinding, ...cells.p.map((wire, lane): [Wire, Binding] => [wire, {kind: 'register', register: pRegister(lane)}])]),
        outputs: [
          ...keptNext.map((wire, lane) => ({wire, write: {kind: 'field', field: 0, component: lane} as const})),
          ...pNext.map((wire, lane) => ({wire, write: {kind: 'register', register: pRegister(lane)} as const})),
        ],
      }),
      createStage({
        name: 'forward', repeat: 'forward', circuit, sharedOffset: 0,
        bindings: new Map<Wire, Binding>([
          [cells.row, {kind: 'item', buffer: 0}], ...limitBinding,
          ...cells.kept.map((wire, lane): [Wire, Binding] => [wire, {kind: 'field', field: 0, component: lane}]),
          ...cells.q.map((wire, lane): [Wire, Binding] => [wire, {kind: 'register', register: qRegister(lane)}]),
          [cells.count, {kind: 'register', register: countRegister}],
        ]),
        outputs: [
          ...marks.map((wire, index) => ({wire, write: {kind: 'position', group: 1 + index} as const})),
          ...qNext.map((wire, lane) => ({wire, write: {kind: 'register', register: qRegister(lane)} as const})),
          {wire: nextCount, write: {kind: 'register', register: countRegister}},
        ],
      }),
    ],
    results: Array.from({length: 2 * width + 1}, (_, register) => ({group: 0, column: register, register})),
    sharedValues: new Float32Array(initialSource),
    lengthCell: withLength ? {buffer: 0, column: positions} : undefined,
  }
  return {
    loop,
    sharedBits: [...cells.tables.flat(2), ...cells.square.flat(2), ...cells.shared.flat(), ...cells.bits],
    sharedNumbers: withLength ? [] : [{position: cells.limit, values: Array.from({length: highestRow + 1}, (_, index) => index)}],
    itemValues: Array.from({length: highestRow + 1}, (_, index) => index),
  }
}

if (import.meta.main) {
  const [kind, countText, seedText, show] = process.argv.slice(2)
  const build = kind === 'lanes' ? buildLanes : kind === 'broken' ? (seed: number) => buildScalar(seed, true) : buildScalar
  const count = Number(countText ?? 200)
  const firstSeed = Number(seedText ?? 1)
  const totals = {programs: 0, refused: 0, threw: 0, different: 0, todayDiffers: 0, values: 0}
  const refusals = new Map<string, number>()
  const ruleTotals: Record<string, number> = {}
  const failures: string[] = []
  for (let seed = firstSeed; seed < firstSeed + count; seed++) {
    let probe: Probe
    try {
      probe = build(seed)
    } catch (error) {
      // The builder refused the random program, e.g. a boolean atom of a sum of two bits, whose range is 0..2.
      totals.refused++
      refusals.set((error as Error).message, (refusals.get((error as Error).message) ?? 0) + 1)
      continue
    }
    if (show !== undefined) console.log(emitBitLoopWgsl(probe.loop).code)
    let result
    try {
      result = compareProbe(probe, seed, 14)
    } catch (error) {
      // The executor or loop-emit.ts's shader stopped, so the program is no test.
      totals.refused++
      refusals.set((error as Error).message, (refusals.get((error as Error).message) ?? 0) + 1)
      continue
    }
    totals.programs++
    totals.values += result.values
    for (const [rule, fired] of Object.entries(result.rules)) ruleTotals[rule] = (ruleTotals[rule] ?? 0) + fired
    if (result.mismatches[0] > 0) totals.todayDiffers++
    if (result.threw !== undefined) {
      totals.threw++
      failures.push(`seed ${seed} threw ${result.threw.slice(0, 300)}`)
    } else if (result.mismatches[1] > 0) {
      totals.different++
      failures.push(`seed ${seed}: ${result.mismatches[1]} values differ (loop-emit.ts's shader: ${result.mismatches[0]}); ${result.firstMismatch}`)
    }
  }
  for (const failure of failures.slice(0, 40)) console.log(failure)
  console.log(`${kind ?? 'scalar'}, seeds ${firstSeed} to ${firstSeed + count - 1}: ${JSON.stringify(totals)}`)
  console.log(`rules that fired, summed: ${JSON.stringify(ruleTotals)}`)
  for (const [message, programs] of refusals) console.log(`refused, ${programs} programs: ${message.slice(0, 200)}`)
}
