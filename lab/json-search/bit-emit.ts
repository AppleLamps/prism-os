// A second WGSL writer for loop programs. It takes the same LoopProgram as loop-emit.ts and writes the same shader
// around it: one invocation per document, a `for` loop per looped stage, the same buffers and parameters. What differs
// is how one operation is written. loop-emit.ts writes every operation as f32 arithmetic. This writer holds a value as
// an integer where it can prove that the value is a whole number, and writes the operation as integer or bit
// arithmetic. Every other operation is written by emit.ts's row writer, as loop-emit.ts writes it, with a conversion
// where a whole number meets an f32 statement. The program doesn't change, and each rule below is stated over what a
// compiled stage holds: an operation's kind, terms and weights, an index read's candidates and out-of-range rules, and
// the ranges, grids and exact bits that the circuit keeps per wire.
//
// What is proven. A value is "whole" when it is a whole number within a range inside ±2^24, e.g. a class within 0..16,
// and a whole number within 0..1 is a bit. A whole number is an i32 in the shader, and a bit is a u32 that holds 0 or 1.
// - A source cell is whole when its declaration says so: an exact bit (inputBit), or a grid of 1 or more with a range
//   inside ±2^24, e.g. input([0, 16], {grid: 1}).
// - An operation is whole when its operands are whole, its weights and biases are whole numbers, and the largest value
//   that any product or partial sum can take stays within 2^24. FP32 then computes every one of them without rounding,
//   in any order, so i32 arithmetic gives the same value. A boolean atom is a bit. An index read is whole when every
//   candidate that its index can reach is whole. An operation that the circuit declares on a grid with a small range
//   is whole too, e.g. the bit that emitCompare returns from a sign cascade.
// - A register or a field is held as an integer when the cells bound to it are declared whole and every stage that
//   writes it writes a proven whole number, a bit for a register of bits. The range of a cell that is bound to a
//   register comes from the cell's declaration, e.g. a match count within 0..512: the writer proves that every write is
//   a whole number, and doesn't prove that a counter stays below its declared maximum.
//
// The rules, each with why the integer statement gives the f32 statement's value:
// - Sum. An affine operation over whole numbers is an i32 sum, e.g. `1i - i32(b) + 2i * i32(c)`. JS: !bit, as 1 - bit,
//   is `bit ^ 1u`.
// - Gate. A ReLU gate max(0, bias + Σ weight × value) whose largest possible value is 1, where every value with a
//   positive weight is a bit and every value with a negative weight is never negative, is 1 exactly when every bit with
//   a positive weight is 1 and every value with a negative weight is 0: if one bit with a positive weight is 0, or one
//   value with a negative weight is 1 or more, the sum is 0 or less. E.g. relu(a - b) is `a & (b ^ 1u)`, and
//   relu(1 - a - b - c) is `(a | b | c) ^ 1u`. Any other gate within 0..1 is `u32(sum > 0i)`, and a gate that can
//   exceed 1 is `max(sum, 0i)`.
// - Comparison. In a gate, a value with a negative weight that is itself max(0, sum) of whole numbers is 0 exactly when
//   sum <= 0, so the pair of gates that emitCompare builds for [codePoint >= boundary], relu(1 - relu(boundary -
//   codePoint)), is `u32(boundary <= codePoint)`.
// - Read. An index read whose index form is whole computes the index in i32, without a floor, and drops a clamp or a
//   select that the index's range rules out.
// - Packed reads. A gated read is an index read of bits whose index form is base + gate: `gate` sums the bits whose
//   weight is at least the table's length, and for every combination of those bits either gate is one fixed number, and
//   the read is table[base], or the index lies past the table's end, where the read is +0. So the read is
//   table[base] && open, with `open` a function of the gating bits. JS for lab/regex-search's
//   transitions[class][from][to] && bit: an index of class + 16 × (1 - bit) in a table of 16. When two or more gated
//   reads with a negative weight in one gate have the same base, the gate needs "none of table_k[base] && open_k", which
//   is `(word[base] & opens) == 0u`: bit k of word[base] is table_k[base], and bit k of `opens` is open_k. The words are
//   in the buffer packed_words, which the runner fills from the shared cells with packWords. Two bits in one gate form
//   are an OR only when they are never both 1, which the writer proves by taking both as 1 and following what each gate
//   then says about its own operands until one value would be both 0 and 1, e.g. a start bit that needs "no state
//   continues" next to a bit that says "state 0 continues".
//
// Statements are written when a later statement or an output first needs them, so an operation that only feeds a packed
// read or a comparison gets no statement of its own.
import {type Circuit, type Wire, invariant} from '../../src/runtime/numeric-ui-core.ts'
import {type IndexRow, type Row, type Term, createRowWriter, flattenProgram, positionsOfWires, wgslFloat, wgslInt} from './emit.ts'
import type {LoopWgslModule} from './loop-emit.ts'
import type {Binding, LoopProgram, Stage} from './loop-program.ts'

// A whole number within minimum..maximum, both within ±2^24.
type Whole = {minimum: number, maximum: number}
type ReluRow = Extract<Row, {kind: 'reglu'}>
// How a register or a field is held: one u32 per bit, an i32, or an f32 as loop-emit.ts holds it.
type Storage = 'bit' | 'whole' | 'float'
// One value of a stage in the shader: the text that reads it, and the type of that text. A 'bit' is a u32 of 0 or 1.
type Held = {text: string, type: 'bit' | 'int' | 'float'}

const wholeLimit = 2 ** 24
const isBit = (whole: Whole) => whole.minimum >= 0 && whole.maximum <= 1

export type RuleCounts = {
  // Operations written as integer or bit statements, by rule.
  sum: number
  gate: number
  // The inner gates that became one `<=`.
  comparison: number
  // Other ReLU gates and products in i32.
  product: number
  read: number
  // Index reads that became one bit of a packed word, and how many words are read for them per position.
  packedRead: number
  packedWord: number
  // Operations written as loop-emit.ts writes them.
  float: number
}

export type BitLoopWgslModule = LoopWgslModule & {
  // The plan of the buffer packed_words, for the runner: bit b of word w is the shared cell packedCells[w][b], which
  // holds 0 or 1. A word without cells is 0. Empty when the shader has no such buffer.
  packedCells: readonly (readonly number[])[]
  rules: RuleCounts
}

// The contents of packed_words for the given shared values, e.g. after a new pattern's cells were written.
export function packWords(packedCells: BitLoopWgslModule['packedCells'], shared: Float32Array, target = new Uint32Array(packedCells.length)) {
  invariant(target.length === packedCells.length, 'the target has one word per packed word')
  for (let word = 0; word < packedCells.length; word++) {
    const cells = packedCells[word]!
    let bits = 0
    for (let bit = 0; bit < cells.length; bit++) if (shared[cells[bit]!] !== 0) bits |= 1 << bit
    target[word] = bits
  }
  return target
}

// What a wire's own declarations prove: an exact bit, or a grid of whole numbers with a small range.
function declaredWhole(circuit: Circuit, wire: number): Whole | undefined {
  const range = circuit.ranges[wire]!
  if (circuit.exactBits[wire] === true) return {minimum: 0, maximum: 1}
  const grid = circuit.grids[wire]
  if (grid === undefined || !Number.isInteger(grid) || !(range.minimum >= -wholeLimit && range.maximum <= wholeLimit)) return undefined
  return {minimum: Math.ceil(range.minimum), maximum: Math.floor(range.maximum)}
}

// The range of bias + Σ weight × value when every value is whole and nothing can round, see the top of the file.
function sumRange(proofs: readonly (Whole | undefined)[], terms: readonly Term[], bias: number): Whole | undefined {
  if (!Number.isInteger(bias)) return undefined
  let minimum = bias
  let maximum = bias
  let magnitude = Math.abs(bias)
  for (const {weight, position} of terms) {
    const operand = proofs[position]
    if (operand === undefined || !Number.isInteger(weight)) return undefined
    minimum += weight > 0 ? weight * operand.minimum : weight * operand.maximum
    maximum += weight > 0 ? weight * operand.maximum : weight * operand.minimum
    magnitude += Math.abs(weight) * Math.max(Math.abs(operand.minimum), Math.abs(operand.maximum))
  }
  return magnitude <= wholeLimit ? {minimum, maximum} : undefined
}

type StageProof = {
  rows: Row[]
  // By packed position: the source cells, then the operations.
  proofs: (Whole | undefined)[]
  // By packed position: true for an operation whose own sums are whole and can't round, so that integer statements
  // give its value. For an index read, the sum is the index form.
  exact: boolean[]
}

function proveStage(stage: Stage, sourceProof: (position: number) => Whole | undefined): StageProof {
  const {program, circuit} = stage
  const rows = flattenProgram(program)
  const proofs: (Whole | undefined)[] = []
  const exact: boolean[] = []
  for (let position = 0; position < program.sourceSize; position++) {
    proofs.push(sourceProof(position))
    exact.push(false)
  }
  for (const row of rows) {
    let inferred: Whole | undefined
    let rowExact = false
    switch (row.kind) {
      case 'affine':
        inferred = sumRange(proofs, row.terms, row.bias)
        rowExact = inferred !== undefined
        break
      case 'reglu': {
        const left = sumRange(proofs, row.terms, row.bias)
        const gate = sumRange(proofs, row.gateTerms, row.gateBias)
        if (left === undefined || gate === undefined) break
        const low = Math.max(0, gate.minimum)
        const high = Math.max(0, gate.maximum)
        const products = [left.minimum * low, left.minimum * high, left.maximum * low, left.maximum * high]
        inferred = {minimum: Math.min(...products), maximum: Math.max(...products)}
        if (Math.max(Math.abs(inferred.minimum), Math.abs(inferred.maximum)) > wholeLimit) inferred = undefined
        rowExact = inferred !== undefined
        break
      }
      case 'boolean':
        inferred = {minimum: 0, maximum: 1}
        break
      case 'index': {
        const index = sumRange(proofs, row.indexTerms, row.indexBias)
        rowExact = index !== undefined
        const last = row.candidateCount - 1
        // The candidates that the index can reach, and +0 from a side that reads zero.
        const first = index === undefined ? 0 : Math.min(last, Math.max(0, index.minimum))
        const final = index === undefined ? last : Math.min(last, Math.max(0, index.maximum))
        const zero = (row.belowZero && (index === undefined || index.minimum < 0)) || (row.aboveZero && (index === undefined || index.maximum > last))
        inferred = zero ? {minimum: 0, maximum: 0} : {minimum: Number.POSITIVE_INFINITY, maximum: Number.NEGATIVE_INFINITY}
        for (let candidate = first; candidate <= final; candidate++) {
          const whole = proofs[row.candidateBase + candidate * row.candidateStride]
          if (whole === undefined) {
            inferred = undefined
            break
          }
          inferred = {minimum: Math.min(inferred.minimum, whole.minimum), maximum: Math.max(inferred.maximum, whole.maximum)}
        }
        break
      }
    }
    const wire = program.wireOrder[row.position]!
    const range = circuit.ranges[wire]!
    const proof = inferred ?? declaredWhole(circuit, wire)
    proofs.push(proof === undefined ? undefined : {minimum: Math.max(proof.minimum, Math.ceil(range.minimum)), maximum: Math.min(proof.maximum, Math.floor(range.maximum))})
    exact.push(rowExact)
  }
  return {rows, proofs, exact}
}

// How a register or a field can be held, from the declarations of the cells bound to it: bits when every such cell is
// a bit, whole numbers when every one is whole, and f32 values otherwise, or when no stage reads it.
function declaredStorage(wholes: readonly (Whole | undefined)[]): Storage {
  if (wholes.length === 0 || wholes.includes(undefined)) return 'float'
  return wholes.every(whole => isBit(whole!)) ? 'bit' : 'whole'
}

export function emitBitLoopWgsl(loop: LoopProgram, options: {workgroupSize?: number} = {}): BitLoopWgslModule {
  const workgroupSize = options.workgroupSize ?? 64
  const {positions} = loop
  for (const field of loop.fields) invariant(!field.bits || field.width <= 32, 'a field of bits holds at most 32 bits per position')

  // How each register and field is held. It starts from the declarations of the cells bound to it, and a register or
  // field that some stage writes a value into that isn't proven to fit is held as f32 instead, until nothing changes:
  // the stages are proven again, since a cell bound to an f32 register proves nothing.
  const boundWholes = (isBound: (binding: Binding) => boolean) => loop.stages.flatMap(stage =>
    [...stage.bindings].filter(([, binding]) => isBound(binding)).map(([wire]) => declaredWhole(stage.circuit, wire)))
  const registerStorage = loop.registers.map(({initial}, index): Storage => {
    const storage = declaredStorage(boundWholes(binding => binding.kind === 'register' && binding.register === index))
    if (storage === 'bit' && (initial === 0 || initial === 1)) return 'bit'
    return storage !== 'float' && Number.isInteger(initial) && Math.abs(initial) <= wholeLimit ? 'whole' : 'float'
  })
  const fieldStorage = loop.fields.map((_, index) => declaredStorage(boundWholes(binding => binding.kind === 'field' && binding.field === index)))
  let stageProofs: StageProof[]
  for (;;) {
    stageProofs = loop.stages.map(stage => proveStage(stage, position => {
      const binding = stage.bindings.get(position as Wire)
      if (binding?.kind === 'register' && registerStorage[binding.register] === 'float') return undefined
      if (binding?.kind === 'field' && fieldStorage[binding.field] === 'float') return undefined
      return declaredWhole(stage.circuit, position)
    }))
    let changed = false
    for (const [stageIndex, stage] of loop.stages.entries()) {
      const outputPositions = positionsOfWires(stage.program, stage.outputs.map(output => output.wire))
      for (const [index, {write}] of stage.outputs.entries()) {
        if (write.kind !== 'register' && write.kind !== 'field') continue
        const storages = write.kind === 'register' ? registerStorage : fieldStorage
        const at = write.kind === 'register' ? write.register : write.field
        const proof = stageProofs[stageIndex]!.proofs[outputPositions[index]!]
        const fits = storages[at] === 'float' || (proof !== undefined && (storages[at] === 'whole' || isBit(proof)))
        if (!fits) {
          storages[at] = 'float'
          changed = true
        }
      }
    }
    if (!changed) break
  }
  // A field of bits is one u32 word per position, as in loop-emit.ts: when the loop program says so, or when the bits
  // are proven and fit a word.
  const fieldWords = loop.fields.map((field, index) => field.bits || (fieldStorage[index] === 'bit' && field.width <= 32))

  const bufferName = (buffer: number) => buffer === 0 ? 'instance_sources' : `instance_inputs_${buffer}`
  const baseName = (buffer: number) => buffer === 0 ? 'source_base' : `input_base_${buffer}`
  // The `let`s before the first stage, by name: shared cells and a document's cells at fixed columns.
  const hoisted = new Map<string, string>()
  const packedCells: number[][] = []
  const packedTables = new Map<string, number>()
  const rules: RuleCounts = {sum: 0, gate: 0, comparison: 0, product: 0, read: 0, packedRead: 0, packedWord: 0, float: 0}
  const rowCounts = {affine: 0, reglu: 0, boolean: 0, index: 0}
  const stageLines: string[] = []

  loop.stages.forEach((stage, stageIndex) => {
    const {program} = stage
    const {sourceSize} = program
    const {rows, proofs, exact} = stageProofs[stageIndex]!
    for (const row of rows) rowCounts[row.kind]++
    const prefix = `${String.fromCharCode(97 + stageIndex)}_`
    const rowAt = (position: number) => position < sourceSize ? undefined : rows[position - sourceSize]!
    const held = new Map<number, Held>()
    const wordsRead = new Set<number>()
    // The f32 `let` of an operation that is held as an integer, for an f32 statement that reads it.
    const floatLets = new Set<number>()
    // Sums and words that several statements of this stage read, by their text, e.g. the word of a gate's open bits.
    const sharedLets = new Map<string, string>()
    const excluded = new Map<string, boolean>()
    const candidateText = (row: IndexRow, index: string) => {
      for (let candidate = 0; candidate < row.candidateCount; candidate++) {
        invariant(!stage.bindings.has((row.candidateBase + candidate * row.candidateStride) as Wire), 'in a loop program, an index read\'s candidates are shared cells')
      }
      const first = stage.sharedOffset + row.candidateBase
      return `shared_values[u32(${first}i + ${index}${row.candidateStride === 1 ? '' : ` * ${wgslInt(row.candidateStride)}`})]`
    }
    const writer = createRowWriter(sourceSize, {
      guard: 'none', prefix,
      // writeFloat holds every operand before the row writer asks for it.
      source: position => floatText(position),
      candidate: candidateText,
    })
    const {body} = writer

    // The value at a position, loaded or written the first time something needs it.
    function hold(position: number): Held {
      let value = held.get(position)
      if (value === undefined) {
        const row = rowAt(position)
        value = row === undefined ? loadSource(position) : writeRow(row)
        held.set(position, value)
      }
      return value
    }
    const bitText = (position: number) => {
      const value = hold(position)
      invariant(proofs[position] !== undefined && isBit(proofs[position]), 'only a proven bit is read as a bit')
      return value.type === 'bit' ? value.text : `u32(${value.text})`
    }
    const intText = (position: number) => {
      const value = hold(position)
      invariant(proofs[position] !== undefined, 'only a proven whole number is read as an integer')
      return value.type === 'int' ? value.text : `i32(${value.text})`
    }
    function floatText(position: number) {
      const value = hold(position)
      if (value.type === 'float') return value.text
      if (position < sourceSize) return `f32(${value.text})`
      // The row writer names an operation's f32 value itself, e.g. b_v150.
      const name = `${prefix}v${position}`
      if (!floatLets.has(position)) {
        floatLets.add(position)
        body.push(`let ${name}: f32 = f32(${value.text});`)
      }
      return name
    }

    function loadSource(position: number): Held {
      const proof = proofs[position]
      const type = proof === undefined ? 'float' : isBit(proof) ? 'bit' : 'int'
      // A cell that is read from an f32 buffer, as a `let` of the proven type, e.g. `let s131b: u32 = u32(shared_values[131u]);`.
      const converted = (name: string, read: string, lines: {push: (line: string) => void} | undefined) => {
        const text = type === 'float' ? name : `${name}${type === 'bit' ? 'b' : 'i'}`
        const line = type === 'float' ? `let ${text}: f32 = ${read};` : `let ${text}: ${type === 'bit' ? 'u32' : 'i32'} = ${type === 'bit' ? 'u32' : 'i32'}(${read});`
        if (lines === undefined) hoisted.set(text, line)
        else lines.push(line)
        return {text, type} as const
      }
      const binding = stage.bindings.get(position as Wire)
      if (binding === undefined) return converted(`s${stage.sharedOffset + position}`, `shared_values[${stage.sharedOffset + position}u]`, undefined)
      switch (binding.kind) {
        case 'cell': return converted(`d${binding.buffer}_${binding.column}`, `${bufferName(binding.buffer)}[${baseName(binding.buffer)} + ${binding.column}u]`, undefined)
        case 'item': return converted(`${prefix}c${position}`, `${bufferName(binding.buffer)}[${baseName(binding.buffer)} + j]`, body)
        case 'register': {
          const storage = registerStorage[binding.register]!
          return {text: `r${binding.register}`, type: storage === 'bit' ? 'bit' : storage === 'whole' ? 'int' : 'float'}
        }
        case 'field': {
          const field = loop.fields[binding.field]!
          const storage = fieldStorage[binding.field]!
          const name = `${prefix}f${position}`
          if (fieldWords[binding.field]!) {
            const word = `${prefix}w${binding.field}`
            if (!wordsRead.has(binding.field)) {
              wordsRead.add(binding.field)
              body.push(`let ${word}: u32 = field${binding.field}[j];`)
            }
            const bit = `(${word} >> ${binding.component}u) & 1u`
            if (storage === 'bit') {
              body.push(`let ${name}b: u32 = ${bit};`)
              return {text: `${name}b`, type: 'bit'}
            }
            body.push(`let ${name}: f32 = f32(${bit});`)
            return {text: name, type: 'float'}
          }
          const read = `field${binding.field}[j * ${field.width}u + ${binding.component}u]`
          if (storage === 'float') {
            body.push(`let ${name}: f32 = ${read};`)
            return {text: name, type: 'float'}
          }
          body.push(`let ${name}i: i32 = ${read};`)
          return {text: `${name}i`, type: 'int'}
        }
      }
    }

    // bias + Σ weight × value as an i32 expression, e.g. `16i * i32(r3) + a_v208i`.
    function intSum(terms: readonly Term[], bias: number) {
      let text = ''
      for (const {weight, position} of terms) {
        const magnitude = Math.abs(weight)
        const product = magnitude === 1 ? intText(position) : `${magnitude}i * ${intText(position)}`
        if (text === '') text = weight < 0 ? `-${product}` : product
        else text = `${text} ${weight < 0 ? '-' : '+'} ${product}`
      }
      if (text === '') return wgslInt(bias)
      return bias === 0 ? text : `${text} ${bias < 0 ? '-' : '+'} ${Math.abs(bias)}i`
    }
    // A sum as one factor of a product.
    const grouped = (sum: string) => sum.includes(' ') ? `(${sum})` : sum
    // A sum as one operand of a larger expression: a name as it is, anything else as a `let` that later statements
    // with the same sum read too.
    function sharedLet(type: 'i32' | 'u32', text: string) {
      if (/^\w+$/.test(text)) return text
      let name = sharedLets.get(text)
      if (name === undefined) {
        name = `${prefix}${type === 'i32' ? 'x' : 'm'}${sharedLets.size}`
        sharedLets.set(text, name)
        body.push(`let ${name}: ${type} = ${text};`)
      }
      return name
    }
    // `sum <= 0` for a sum of whole numbers, with the terms that are subtracted on the right, e.g. `s1i <= a_c0i` for
    // boundary - codePoint.
    function atMostZero(terms: readonly Term[], bias: number) {
      const added = terms.filter(term => term.weight > 0)
      const subtracted = terms.filter(term => term.weight < 0).map(term => ({weight: -term.weight, position: term.position}))
      return `${intSum(added, Math.max(bias, 0))} <= ${intSum(subtracted, Math.max(-bias, 0))}`
    }

    // JS: !bit, as 1 - bit. The bit's position, or undefined for any other operation.
    const negatedBit = (row: Row) => row.kind === 'affine' && exact[row.position]! && row.bias === 1 && row.terms.length === 1 && row.terms[0]!.weight === -1 && isBit(proofs[row.terms[0]!.position]!)
      ? row.terms[0]!.position
      : undefined
    // The Gate rule's two lists for max(0, bias + Σ weight × value): the bits that must all be 1 and the values that
    // must all be 0 for the gate to be 1, or undefined when the gate isn't of that form.
    function conjunction(row: ReluRow): {all: number[], none: number[]} | undefined {
      if (!exact[row.position]! || row.terms.length > 0 || row.bias !== 1) return undefined
      let largest = row.gateBias
      const all: number[] = []
      const none: number[] = []
      for (const {weight, position} of row.gateTerms) {
        const operand = proofs[position]!
        if (weight > 0) {
          if (!isBit(operand)) return undefined
          all.push(position)
          largest += weight
        } else {
          if (operand.minimum < 0) return undefined
          none.push(position)
        }
      }
      return largest === 1 ? {all, none} : undefined
    }

    // Whether two bits are never both 1. Both are taken as 1, and each gate that is then 1 says what its own operands
    // are, until one value would have to be both 0 and 1, e.g. `start` needs notContinuing, which needs every
    // continuing[s] to be 0, next to continuing[0] taken as 1.
    function neverBothOne(first: number, second: number) {
      const key = `${Math.min(first, second)},${Math.max(first, second)}`
      let proven = excluded.get(key)
      if (proven === undefined) {
        proven = false
        const forced = new Map<number, boolean>()
        const pending: [position: number, one: boolean][] = [[first, true], [second, true]]
        while (pending.length > 0 && !proven) {
          const [position, one] = pending.pop()!
          const known = forced.get(position)
          if (known !== undefined) {
            proven = known !== one
            continue
          }
          forced.set(position, one)
          const row = rowAt(position)
          if (row === undefined) continue
          const negated = negatedBit(row)
          if (negated !== undefined) {
            pending.push([negated, !one])
          } else if (row.kind === 'reglu' && one) {
            const gate = conjunction(row)
            if (gate === undefined) continue
            for (const operand of gate.all) pending.push([operand, true])
            for (const operand of gate.none) pending.push([operand, false])
          }
        }
        excluded.set(key, proven)
      }
      return proven
    }

    // The Packed reads rule's reading of one index read, or undefined when the read isn't a gated read of bits.
    type Gated = {
      // The index that the read has when it is open, a whole number within `range`.
      baseTerms: Term[]
      baseBias: number
      range: Whole
      // The bits that decide whether the read is open, and for each combination of them, bit 0 first, whether it is.
      gating: number[]
      open: number
      // Two reads with the same key read their tables at the same index, under the same out-of-range rules.
      key: string
    }
    const maximumGatingBits = 4
    function gatedRead(row: IndexRow): Gated | undefined {
      if (!exact[row.position]!) return undefined
      // The words are packed from every candidate, so each one has to be a cell that the pattern's writer fills with 0 or 1.
      for (let candidate = 0; candidate < row.candidateCount; candidate++) {
        const cell = row.candidateBase + candidate * row.candidateStride
        if (stage.circuit.exactBits[cell] !== true || stage.bindings.has(cell as Wire)) return undefined
      }
      const isGating = (term: Term) => isBit(proofs[term.position]!) && Math.abs(term.weight) >= row.candidateCount
      const gatingTerms = row.indexTerms.filter(isGating)
      const baseTerms = row.indexTerms.filter(term => !isGating(term))
      const base = sumRange(proofs, baseTerms, 0)
      if (gatingTerms.length > maximumGatingBits || base === undefined) return undefined
      const last = row.candidateCount - 1
      let open = 0
      let baseBias: number | undefined
      for (let combination = 0; combination < 2 ** gatingTerms.length; combination++) {
        let gate = row.indexBias
        let possible = true
        for (const [bit, term] of gatingTerms.entries()) {
          if (((combination >> bit) & 1) === 0) continue
          gate += term.weight
          for (let earlier = 0; earlier < bit; earlier++) {
            if (((combination >> earlier) & 1) === 1 && neverBothOne(gatingTerms[earlier]!.position, term.position)) possible = false
          }
        }
        // A combination that never happens can count as open, which keeps e.g. an OR of two bits an OR.
        const closed = (row.aboveZero && gate + base.minimum > last) || (row.belowZero && gate + base.maximum < 0)
        if (!possible || closed) {
          if (!possible) open |= 1 << combination
          continue
        }
        if (baseBias !== undefined && baseBias !== gate) return undefined
        baseBias = gate
        open |= 1 << combination
      }
      if (baseBias === undefined) return undefined
      return {
        baseTerms, baseBias, range: {minimum: base.minimum + baseBias, maximum: base.maximum + baseBias}, gating: gatingTerms.map(term => term.position), open,
        key: `${row.candidateCount},${row.belowZero},${row.aboveZero},${baseBias},${baseTerms.map(term => `${term.position}*${term.weight}`).join(',')}`,
      }
    }
    // `open` as a u32 expression of 0 or 1 over the gating bits.
    function openText({gating, open}: Gated) {
      const combinations = 2 ** gating.length
      const every = 2 ** combinations - 1
      if (open === every) return '1u'
      const bits = gating.map(bitText)
      if (gating.length === 1) return open === 2 ? bits[0]! : `(${bits[0]!} ^ 1u)`
      if (open === every - 1) return `(${bits.join(' | ')})`
      return `((${open}u >> (${bits.map((bit, index) => index === 0 ? bit : `(${bit} << ${index}u)`).join(' | ')})) & 1u)`
    }
    // "None of these gated reads is 1" as one read of a packed word and one AND, for reads that share a key.
    function nonePacked(gated: Gated, reads: readonly IndexRow[]) {
      const first = reads[0]!
      const last = first.candidateCount - 1
      // A word of zeros before or after the table stands for a side that reads +0.
      const zeroBefore = first.belowZero && gated.range.minimum < 0
      const zeroAfter = first.aboveZero && gated.range.maximum > last
      const tableKey = `${stage.sharedOffset},${zeroBefore},${zeroAfter},${first.candidateCount},${reads.map(read => `${read.candidateBase}:${read.candidateStride}`).join(',')}`
      let start = packedTables.get(tableKey)
      if (start === undefined) {
        start = packedCells.length
        packedTables.set(tableKey, start)
        if (zeroBefore) packedCells.push([])
        for (let candidate = 0; candidate <= last; candidate++) packedCells.push(reads.map(read => stage.sharedOffset + read.candidateBase + candidate * read.candidateStride))
        if (zeroAfter) packedCells.push([])
      }
      const lowest = zeroBefore ? -1 : 0
      const highest = zeroAfter ? last + 1 : last
      let index = sharedLet('i32', intSum(gated.baseTerms, gated.baseBias))
      if (gated.range.minimum < lowest || gated.range.maximum > highest) index = `clamp(${index}, ${wgslInt(lowest)}, ${wgslInt(highest)})`
      const opens = sharedLet('u32', reads.map((read, bit) => {
        const open = openText(gatedRead(read)!)
        return bit === 0 ? open : `(${open} << ${bit}u)`
      }).join(' | '))
      rules.packedRead += reads.length
      rules.packedWord++
      return `u32((packed_words[u32(${start - lowest === 0 ? '' : `${start - lowest}i + `}${index})] & ${opens}) == 0u)`
    }

    // The Gate rule's statement: a u32 expression of 0 or 1.
    function gateText({all, none}: {all: number[], none: number[]}) {
      const factors = all.map(bitText)
      // The gated reads by key, and the other values that must be 0.
      const groups = new Map<string, {gated: Gated, reads: IndexRow[]}>()
      const zeroBits: string[] = []
      for (const position of none) {
        const row = rowAt(position)
        const gated = row?.kind === 'index' && isBit(proofs[position]!) ? gatedRead(row) : undefined
        if (row?.kind === 'index' && gated !== undefined) {
          const group = groups.get(gated.key)
          if (group === undefined) groups.set(gated.key, {gated, reads: [row]})
          else group.reads.push(row)
        } else if (row?.kind === 'reglu' && exact[position]! && row.terms.length === 0 && row.bias === 1 && conjunction(row) === undefined) {
          // The Comparison rule: max(0, sum) is 0 exactly when sum <= 0.
          rules.comparison++
          factors.push(`u32(${atMostZero(row.gateTerms, row.gateBias)})`)
        } else if (isBit(proofs[position]!)) {
          zeroBits.push(bitText(position))
        } else {
          factors.push(`u32(${intText(position)} == 0i)`)
        }
      }
      for (const {gated, reads} of groups.values()) {
        // One gated read alone is an ordinary bit.
        if (reads.length === 1) zeroBits.push(bitText(reads[0]!.position))
        else for (let from = 0; from < reads.length; from += 32) factors.push(nonePacked(gated, reads.slice(from, from + 32)))
      }
      if (zeroBits.length > 0) factors.push(`(${zeroBits.length === 1 ? zeroBits[0]! : `(${zeroBits.join(' | ')})`} ^ 1u)`)
      return factors.join(' & ')
    }

    // Today's f32 statement, from emit.ts's row writer.
    function writeFloat(row: Row): Held {
      const terms = row.kind === 'index' ? row.indexTerms : row.kind === 'reglu' ? [...row.gateTerms, ...row.terms] : row.terms
      for (const term of terms) floatText(term.position)
      writer.write(row)
      rules.float++
      return {text: `${prefix}v${row.position}`, type: 'float'}
    }

    function writeRow(row: Row): Held {
      const proof = proofs[row.position]
      const name = `${prefix}v${row.position}`
      if (!exact[row.position]! || (row.kind !== 'index' && proof === undefined)) return writeFloat(row)
      const bit = (expression: string): Held => {
        body.push(`let ${name}b: u32 = ${expression};`)
        return {text: `${name}b`, type: 'bit'}
      }
      // An i32 expression, held as a bit when the operation is proven to be one.
      const whole = (expression: string): Held => {
        if (isBit(proof!)) return bit(`u32(${expression})`)
        body.push(`let ${name}i: i32 = ${expression};`)
        return {text: `${name}i`, type: 'int'}
      }
      switch (row.kind) {
        case 'boolean': return writeFloat(row)
        case 'affine': {
          rules.sum++
          const negated = negatedBit(row)
          if (negated !== undefined) return bit(`${bitText(negated)} ^ 1u`)
          // A copy of a bit, e.g. a roundAffine of one term, stays a bit without a conversion.
          const copied = row.bias === 0 && row.terms.length === 1 && row.terms[0]!.weight === 1 && isBit(proofs[row.terms[0]!.position]!)
          return copied ? bit(bitText(row.terms[0]!.position)) : whole(intSum(row.terms, row.bias))
        }
        case 'reglu': {
          const gate = sumRange(proofs, row.gateTerms, row.gateBias)!
          if (row.terms.length > 0 || row.bias !== 1) {
            rules.product++
            const gateSum = intSum(row.gateTerms, row.gateBias)
            return whole(`${grouped(intSum(row.terms, row.bias))} * ${gate.minimum >= 0 ? grouped(gateSum) : `max(${gateSum}, 0i)`}`)
          }
          const form = conjunction(row)
          if (form !== undefined) {
            rules.gate++
            return bit(gateText(form))
          }
          rules.product++
          return isBit(proof!) ? bit(`u32(${intSum(row.gateTerms, row.gateBias)} > 0i)`) : whole(`max(${intSum(row.gateTerms, row.gateBias)}, 0i)`)
        }
        case 'index': {
          rules.read++
          const range = sumRange(proofs, row.indexTerms, row.indexBias)!
          const last = row.candidateCount - 1
          const index = sharedLet('i32', intSum(row.indexTerms, row.indexBias))
          let read = candidateText(row, range.minimum < 0 || range.maximum > last ? `clamp(${index}, 0i, ${last}i)` : index)
          if (row.aboveZero && range.maximum > last) read = `select(${read}, 0.0f, ${index} > ${last}i)`
          if (row.belowZero && range.minimum < 0) read = `select(${read}, 0.0f, ${index} < 0i)`
          if (proof === undefined) {
            body.push(`let ${name}: f32 = ${read};`)
            return {text: name, type: 'float'}
          }
          return isBit(proof) ? bit(`u32(${read})`) : whole(`i32(${read})`)
        }
      }
    }

    const outputPositions = positionsOfWires(program, stage.outputs.map(output => output.wire))
    const fieldWrites: string[] = []
    const windowWrites: string[] = []
    const documentWrites: string[] = []
    const registerWrites: string[] = []
    const bitsOfField = new Map<number, string[]>()
    // A value as the type that a register or field is held in.
    const stored = (position: number, storage: Storage) => storage === 'bit' ? bitText(position) : storage === 'whole' ? intText(position) : floatText(position)
    stage.outputs.forEach(({write}, index) => {
      const position = outputPositions[index]!
      switch (write.kind) {
        case 'register':
          registerWrites.push(`r${write.register} = ${stored(position, registerStorage[write.register]!)};`)
          break
        case 'field': {
          const field = loop.fields[write.field]!
          const storage = fieldStorage[write.field]!
          if (fieldWords[write.field]!) {
            const bits = bitsOfField.get(write.field) ?? Array<string>(field.width).fill('')
            const bit = storage === 'bit' ? bitText(position) : `u32(${floatText(position)})`
            bits[write.component] = write.component === 0 ? bit : `(${bit} << ${write.component}u)`
            bitsOfField.set(write.field, bits)
          } else {
            fieldWrites.push(`field${write.field}[j * ${field.width}u + ${write.component}u] = ${stored(position, storage === 'bit' ? 'whole' : storage)};`)
          }
          break
        }
        case 'position':
          windowWrites.push(`instance_outputs_${write.group}[window_base_${write.group} + j] = ${floatText(position)};`)
          break
        case 'document':
          documentWrites.push(`instance_outputs_${write.group}[output_base_${write.group} + ${write.column}u] = ${floatText(position)};`)
          break
      }
    })
    for (const [field, bits] of bitsOfField) {
      invariant(bits.every(bit => bit !== ''), 'a stage that writes a field of bits writes every bit of it')
      fieldWrites.push(`field${field}[j] = ${bits.join(' | ')};`)
    }
    const lines = [
      ...body, ...fieldWrites,
      ...(windowWrites.length > 0 ? ['if (in_window) {', ...windowWrites, '}'] : []),
      ...documentWrites,
      // Last, so that every statement above read the registers of the previous position.
      ...registerWrites,
    ]
    if (stage.repeat === 'once') stageLines.push(...lines)
    else if (stage.repeat === 'forward') stageLines.push('for (var j: u32 = 0u; j < positions; j++) {', ...lines, '}')
    else stageLines.push('for (var back: u32 = 0u; back < positions; back++) {', 'let j: u32 = positions - 1u - back;', ...lines, '}')
  })

  // The rest is loop-emit.ts's shader around the stages, with a type per register and field, and the packed words.
  const groups = loop.outputGroups
  if (loop.lengthCell !== undefined) {
    const fills = groups.flatMap((group, index) => group.kind === 'position' ? [`instance_outputs_${index}[window_base_${index} + j] = ${wgslFloat(group.fill)};`] : [])
    if (fills.length > 0) stageLines.push('if (in_window) {', `for (var j: u32 = positions; j < ${positions}u; j++) {`, ...fills, '}', '}')
  }
  for (const result of loop.results) {
    const register = `r${result.register}`
    stageLines.push(`instance_outputs_${result.group}[output_base_${result.group} + ${result.column}u] = ${registerStorage[result.register] === 'float' ? register : `f32(${register})`};`)
  }
  let lengthName: string | undefined
  if (loop.lengthCell !== undefined) {
    const {buffer, column} = loop.lengthCell
    lengthName = `d${buffer}_${column}`
    hoisted.set(lengthName, `let ${lengthName}: f32 = ${bufferName(buffer)}[${baseName(buffer)} + ${column}u];`)
  }
  const packedBinding = 2 + loop.buffers.length + groups.length
  const main = [
    'let i: u32 = id.x;',
    'if (i >= params.count) {',
    'return;',
    '}',
    '_ = arrayLength(&shared_values);',
    ...loop.buffers.map((_, buffer) => `_ = arrayLength(&${bufferName(buffer)});`),
    'let row: u32 = params.first + i;',
    ...loop.buffers.map((buffer, index) => `let ${baseName(index)}: u32 = row * ${buffer.cellsPerDocument}u;`),
    ...groups.flatMap((group, index) => group.kind === 'document' ? [`let output_base_${index}: u32 = row * ${group.valuesPerDocument}u;`] : []),
    'let in_window: bool = row >= params.window_first && row - params.window_first < params.window_count;',
    ...groups.flatMap((group, index) => group.kind === 'position' ? [`let window_base_${index}: u32 = (row - params.window_first) * ${positions}u;`] : []),
    ...[...hoisted.values()],
    `let positions: u32 = ${lengthName === undefined ? `${positions}u` : `min(u32(${lengthName}), ${positions}u)`};`,
    ...loop.registers.map((register, index) => {
      const storage = registerStorage[index]!
      return storage === 'float' ? `var r${index}: f32 = ${wgslFloat(register.initial)};` : `var r${index}: ${storage === 'bit' ? `u32 = ${register.initial}u` : `i32 = ${wgslInt(register.initial)}`};`
    }),
    ...loop.fields.map((field, index) => fieldWords[index]!
      ? `var field${index}: array<u32, ${positions}>;`
      : `var field${index}: array<${fieldStorage[index] === 'float' ? 'f32' : 'i32'}, ${positions * field.width}>;`),
    ...stageLines,
  ]
  const code = [
    'struct Params {',
    '  count: u32,',
    '  window_first: u32,',
    '  window_count: u32,',
    '  first: u32,',
    '}',
    '@group(0) @binding(0) var<uniform> params: Params;',
    '@group(0) @binding(1) var<storage, read> shared_values: array<f32>;',
    ...loop.buffers.map((_, buffer) => `@group(0) @binding(${2 + buffer}) var<storage, read> ${bufferName(buffer)}: array<f32>;`),
    ...groups.map((_, group) => `@group(0) @binding(${2 + loop.buffers.length + group}) var<storage, read_write> instance_outputs_${group}: array<f32>;`),
    // After the bindings that loop-emit.ts's shader has, so that a runner binds those as before.
    ...(packedCells.length > 0 ? [`@group(0) @binding(${packedBinding}) var<storage, read> packed_words: array<u32>;`] : []),
    '',
    `@compute @workgroup_size(${workgroupSize})`,
    'fn main(@builtin(global_invocation_id) id: vec3<u32>) {',
    ...main,
    '}',
    '',
  ].join('\n')
  return {
    code, workgroupSize, statementCount: main.length, bytes: code.length, sharedLength: loop.sharedValues.length,
    cellsPerInstance: loop.buffers[0]!.cellsPerDocument, inputCells: loop.buffers.slice(1).map(buffer => buffer.cellsPerDocument),
    outputCounts: groups.map(group => group.valuesPerDocument), windowedGroups: groups.map(group => group.kind === 'position'), rowCounts,
    packedCells, rules,
  }
}
