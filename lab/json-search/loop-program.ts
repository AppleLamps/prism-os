// A program written as loops over one document's positions, the form of docs/patterns.md's "A loop over items that mixes
// per-item work with values carried to the next item": the work of one position is ordinary builder code, compiled once
// as its own small program, and it runs once per position. JS for what a looped stage does:
//
//   for (let position = 0; position < positions; position++) {
//     const values = step(codePoints[position], carried)   // the compiled step, e.g. 115 operations
//     carried = values.next                                // carried to the next position
//     perPosition[position] = values.kept                  // kept for a later loop, or for the page
//   }
//
// What a step reads and writes besides its own shared cells, e.g. a pattern's tables:
//   item       the document's cell at the loop's position, e.g. the code point
//   cell       one cell of the document at a fixed column, e.g. the text's length
//   register   one number carried from a position to the next, with an initial value, e.g. a state machine's state
//   field      one number per position, written by one loop and read by a later one, e.g. the reverse pass's bits that
//              the forward pass reads
//   outputs    a document's results after the last stage, and per position values for the documents a page shows
//
// The same LoopProgram runs three ways, and the tests compare all three with the program that has every position written
// out: createLoopRunner on the CPU executor, createLoopRunner on generated JavaScript, and loop-emit.ts's WGSL, where
// each stage's statements are written once inside a `for` loop.
import {type Circuit, type Wire, invariant} from '../../src/runtime/numeric-ui-core.ts'
import {type TensorProgram, positionsOfWires} from './emit.ts'
import {compileChunks} from './generated-js.ts'

// Where the value of one source cell of a stage's circuit comes from. A source cell without a binding is a shared cell.
export type Binding =
  | {kind: 'item', buffer: number}
  | {kind: 'cell', buffer: number, column: number}
  | {kind: 'register', register: number}
  | {kind: 'field', field: number, component: number}

// Where one output of a stage goes.
export type Write =
  | {kind: 'register', register: number}
  | {kind: 'field', field: number, component: number}
  // One value per position in an output group of kind 'position'.
  | {kind: 'position', group: number}
  // One value per document in an output group of kind 'document'. Only a stage that runs once writes these.
  | {kind: 'document', group: number, column: number}

export type Stage = {
  name: string
  // 'once' runs the program one time. 'forward' runs it for positions 0, 1, 2, and so on, and 'backward' from the last
  // position down to 0.
  repeat: 'once' | 'forward' | 'backward'
  circuit: Circuit
  // Compiled for exactly the wires of `outputs`.
  program: TensorProgram
  // Where this stage's source table starts in the loop program's shared values.
  sharedOffset: number
  bindings: ReadonlyMap<Wire, Binding>
  outputs: readonly {wire: Wire, write: Write}[]
}

export type LoopProgram = {
  // How many positions the looped stages run, e.g. 512 code points.
  positions: number
  // The buffers of per-document cells that the stages read, e.g. buffer 0 with 513 cells per document.
  buffers: readonly {name: string, cellsPerDocument: number}[]
  registers: readonly {name: string, initial: number}[]
  // `bits` says every value of the field is 0 or 1, so the WGSL keeps a position's values in one 32-bit word.
  fields: readonly {name: string, width: number, bits: boolean}[]
  // A 'document' group holds valuesPerDocument values for every document. A 'position' group holds one value per
  // position, for the documents of a window that the caller picks, e.g. the ones on screen. `fill` is what a position
  // past the text's end gets when the loops stop there.
  outputGroups: readonly {name: string, kind: 'document' | 'position', valuesPerDocument: number, fill: number}[]
  stages: readonly Stage[]
  // After the last stage, these registers are written as a document's outputs.
  results: readonly {group: number, column: number, register: number}[]
  // Every stage's source table, one after the other, with the values a new evaluation starts from.
  sharedValues: Float32Array
  // The cell that holds the text's length in code points. With it, the looped stages run only the positions before the
  // text's end, which is only right for steps that leave every register as it is at a position past the end.
  lengthCell: {buffer: number, column: number} | undefined
}

// Compiles one stage. `outputs` may name a wire more than once, e.g. a bit that is both kept and carried.
export function createStage(description: Omit<Stage, 'program'>): Stage {
  const program = description.circuit.compileTensorProgram([...new Set(description.outputs.map(output => output.wire))])
  for (const wire of description.bindings.keys()) invariant(wire < program.sourceSize, 'a binding names a source cell')
  for (const {wire, write} of description.outputs) {
    invariant(wire >= program.sourceSize, `${description.name}: an output is a computed value, not a source cell`)
    invariant(write.kind !== 'document' || description.repeat === 'once', 'only a stage that runs once writes a document\'s outputs')
    invariant(write.kind !== 'position' || description.repeat !== 'once', 'only a looped stage writes per position')
  }
  for (const binding of description.bindings.values()) {
    invariant(description.repeat !== 'once' || (binding.kind !== 'item' && binding.kind !== 'field'), 'a stage that runs once reads no item and no field')
  }
  return {...description, program}
}

export function describeLoop(loop: LoopProgram) {
  return loop.stages.map(stage => ({
    name: stage.name, repeat: stage.repeat,
    operations: stage.program.valueCount - stage.program.sourceSize,
    layers: stage.program.layers.length,
    indexReads: stage.program.layers.reduce((total, layer) => total + layer.indexReads.length, 0),
  }))
}

// How many operations one document takes when every looped stage runs every position.
export function operationsPerDocument(loop: LoopProgram) {
  return describeLoop(loop).reduce((total, stage) => total + stage.operations * (stage.repeat === 'once' ? 1 : loop.positions), 0)
}

export type LoopRunner = ReturnType<typeof createLoopRunner>

// Runs a loop program on the CPU, one document per call. With 'executor', every stage runs on the CPU executor, the
// repo's definition of a program's values. With 'generated', a stage's operations are JavaScript statements, see
// generated-js.ts, which gives the same values several times faster.
export function createLoopRunner(loop: LoopProgram, backend: 'executor' | 'generated') {
  const {positions} = loop
  const registers = new Float32Array(loop.registers.length)
  const fields = loop.fields.map(field => new Float32Array(positions * field.width))
  const stages = loop.stages.map(stage => {
    const {program} = stage
    const outputPositions = positionsOfWires(program, stage.outputs.map(output => output.wire))
    // `values` starts with the stage's source table. `compute` returns the array that holds the outputs, at `outputAt`.
    let values: Float32Array
    let compute: () => Float32Array
    let outputAt: number[]
    if (backend === 'executor') {
      const evaluate = stage.circuit.createTensorProgramEvaluator(program)
      values = new Float32Array(program.sourceSize)
      compute = () => evaluate(values)
      outputAt = stage.outputs.map(output => program.roots.indexOf(output.wire))
    } else {
      const {chunks} = compileChunks(program)
      const all = new Float32Array(program.valueCount)
      values = all
      compute = () => {
        for (let index = 0; index < chunks.length; index++) chunks[index]!(all)
        return all
      }
      outputAt = outputPositions
    }
    const bound = [...stage.bindings].map(([wire, binding]) => ({position: wire as number, binding}))
    return {
      stage, values, compute,
      items: bound.filter(entry => entry.binding.kind === 'item') as {position: number, binding: Extract<Binding, {kind: 'item'}>}[],
      cells: bound.filter(entry => entry.binding.kind === 'cell') as {position: number, binding: Extract<Binding, {kind: 'cell'}>}[],
      registers: bound.filter(entry => entry.binding.kind === 'register') as {position: number, binding: Extract<Binding, {kind: 'register'}>}[],
      fields: bound.filter(entry => entry.binding.kind === 'field') as {position: number, binding: Extract<Binding, {kind: 'field'}>}[],
      writes: stage.outputs.map((output, index) => ({at: outputAt[index]!, write: output.write})),
    }
  })

  // The shared values, e.g. after writing a new pattern's cells into them.
  function setShared(shared: Float32Array) {
    invariant(shared.length === loop.sharedValues.length, 'the shared values have the loop program\'s length')
    for (const {stage, values} of stages) values.set(shared.subarray(stage.sharedOffset, stage.sharedOffset + stage.program.sourceSize))
  }
  setShared(loop.sharedValues)

  // Runs document `row` of the buffers. The document's outputs go to row `documentRow` of each 'document' group, and
  // with windowRow >= 0, the per position values go to row `windowRow` of each 'position' group.
  function run(buffers: readonly Float32Array[], row: number, outputs: readonly Float32Array[], documentRow: number, windowRow: number) {
    const bases = loop.buffers.map(buffer => row * buffer.cellsPerDocument)
    loop.registers.forEach((register, index) => {
      registers[index] = register.initial
    })
    const limit = loop.lengthCell === undefined ? positions : Math.min(positions, buffers[loop.lengthCell.buffer]![bases[loop.lengthCell.buffer]! + loop.lengthCell.column]!)
    for (const {stage, values, compute, items, cells, registers: registerReads, fields: fieldReads, writes} of stages) {
      for (const {position, binding} of cells) values[position] = buffers[binding.buffer]![bases[binding.buffer]! + binding.column]!
      const count = stage.repeat === 'once' ? 1 : limit
      for (let step = 0; step < count; step++) {
        const position = stage.repeat === 'backward' ? limit - 1 - step : step
        for (let index = 0; index < items.length; index++) {
          const {position: at, binding} = items[index]!
          values[at] = buffers[binding.buffer]![bases[binding.buffer]! + position]!
        }
        for (let index = 0; index < registerReads.length; index++) values[registerReads[index]!.position] = registers[registerReads[index]!.binding.register]!
        for (let index = 0; index < fieldReads.length; index++) {
          const {position: at, binding} = fieldReads[index]!
          values[at] = fields[binding.field]![position * loop.fields[binding.field]!.width + binding.component]!
        }
        const computed = compute()
        for (let index = 0; index < writes.length; index++) {
          const {at, write} = writes[index]!
          const value = computed[at]!
          switch (write.kind) {
            case 'register':
              registers[write.register] = value
              break
            case 'field':
              fields[write.field]![position * loop.fields[write.field]!.width + write.component] = value
              break
            case 'position':
              if (windowRow >= 0) outputs[write.group]![windowRow * positions + position] = value
              break
            case 'document':
              outputs[write.group]![documentRow * loop.outputGroups[write.group]!.valuesPerDocument + write.column] = value
              break
          }
        }
      }
    }
    if (windowRow >= 0) {
      loop.outputGroups.forEach((group, index) => {
        if (group.kind === 'position') outputs[index]!.fill(group.fill, windowRow * positions + limit, (windowRow + 1) * positions)
      })
    }
    for (const result of loop.results) outputs[result.group]![documentRow * loop.outputGroups[result.group]!.valuesPerDocument + result.column] = registers[result.register]!
  }

  return {setShared, run}
}
