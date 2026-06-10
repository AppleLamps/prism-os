import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {
  Circuit,
  type Terms,
  type Wire,
  emitArgmax,
  emitFirstActive,
  inlineCircuit,
  validateCircuit,
  validateTensorEvaluation,
  validateTensorProgram,
} from './numeric-ui-core.ts'

test('inlined circuits become one graph and share matching expressions', () => {
  const child = new Circuit(2)
  const childSum = child.affine([[0, 1], [1, 1]])
  const childProduct = child.reglu([[childSum, 1]], 0, [[0, 1]], 0)
  const parent = new Circuit(2)
  const existingSum = parent.affine([[0, 1], [1, 1]])
  const wireMap = inlineCircuit(parent, child, [0, 1])

  assert.equal(wireMap[childSum], existingSum)
  const output = wireMap[childProduct]!
  const program = parent.compileTensorProgram([output])
  parent.tensorProgram = program
  assert.equal(parent.evaluateTensor(new Float32Array([2, 3]))[output], 10)
})

test('tensor layers append only their new values', () => {
  const circuit = new Circuit(2)
  const first = circuit.affine([[0, 2]])
  circuit.affine([[first, 4]])
  circuit.affine([[1, 3]])
  const program = circuit.compileTensorProgram()

  assert.deepEqual(
    program.layers.map(layer => ({
      inputSize: layer.inputSize,
      outputSize: layer.outputSize,
      storedWeights: layer.weights.length,
    })),
    [
      {inputSize: 2, outputSize: 3, storedWeights: 3},
    ],
  )
  assert.deepEqual([...program.wireOrder], [0, 1, 2, 3, 4])
  const source = new Float32Array([5, 7])
  assert.deepEqual([...circuit.evaluateReference(source)], [5, 7, 10, 40, 21])
  assert.deepEqual([...circuit.evaluateTensor(source)], [5, 7, 10, 40, 21])
})

test('compiled tensor constants use native FP32 storage', () => {
  const circuit = new Circuit(1)
  circuit.affine([[0, 1 / 3]], 1 / 10)
  const layer = circuit.compileTensorProgram().layers[0]!

  assert.ok(layer.weights instanceof Float32Array)
  assert.ok(layer.bias instanceof Float32Array)
  assert.equal(layer.weights[0], Math.fround(1 / 3))
  assert.equal(layer.bias[0], Math.fround(1 / 10))
})

test('compiled indices use the smallest safe unsigned width', () => {
  const small = new Circuit(255)
  const smallOutput = small.affine([[254, 2]])
  const smallProgram = small.compileTensorProgram([smallOutput])
  assert.ok(smallProgram.roots instanceof Uint8Array)
  assert.ok(smallProgram.wireOrder instanceof Uint8Array)
  assert.ok(smallProgram.layers[0]!.inputIndices instanceof Uint8Array)

  const medium = new Circuit(257)
  const mediumOutput = medium.affine(
    Array.from({length: 257}, (_, wire) => [wire, 1] as const),
  )
  const mediumProgram = medium.compileTensorProgram([mediumOutput])
  assert.ok(mediumProgram.roots instanceof Uint16Array)
  assert.ok(mediumProgram.wireOrder instanceof Uint16Array)
  assert.ok(mediumProgram.layers[0]!.inputIndices instanceof Uint16Array)
  assert.ok(mediumProgram.layers[0]!.columns instanceof Uint16Array)
  assert.ok(mediumProgram.layers[0]!.rowOffsets instanceof Uint16Array)

  const large = new Circuit(65_537)
  const largeOutput = large.affine([[65_536, 2]])
  const largeProgram = large.compileTensorProgram([largeOutput])
  assert.ok(largeProgram.roots instanceof Uint32Array)
  assert.ok(largeProgram.wireOrder instanceof Uint32Array)
  assert.ok(largeProgram.layers[0]!.inputIndices instanceof Uint32Array)
})

test('first-active selection resolves ordered candidates through a balanced tree', () => {
  const candidateCount = 16
  const circuit = new Circuit(candidateCount + 1)
  for (let wire = 0; wire < circuit.sourceSize; wire++) circuit.assumeRange(wire, 0, 1)
  const selected = emitFirstActive(
    circuit,
    0,
    Array.from({length: candidateCount}, (_, item) => item + 1),
  )
  circuit.tensorProgram = circuit.compileTensorProgram(selected)

  for (const [active, hits, winner] of [
    [1, [0], 0],
    [1, [2, 5], 2],
    [1, [1, 3, 14], 1],
    [1, [15], 15],
    [0, Array.from({length: candidateCount}, (_, item) => item), -1],
  ] as const) {
    const source = new Float32Array(circuit.sourceSize)
    source[0] = active
    for (const hit of hits) source[hit + 1] = 1
    const values = circuit.evaluateTensor(source)
    assert.deepEqual(
      selected.map(wire => values[wire]),
      selected.map((_, item) => Number(item === winner)),
    )
  }

  assert.ok(
    circuit.tensorProgram.layers.length
      <= 2 * Math.ceil(Math.log2(candidateCount)) + 2,
  )
})

test('argmax resolves continuous scores through a balanced tree', () => {
  const candidateCount = 7
  const circuit = new Circuit(candidateCount + 1)
  for (let wire = 0; wire < candidateCount; wire++) circuit.assumeRange(wire, 0, 1)
  circuit.assumeRange(candidateCount, 1, 1)
  const winner = emitArgmax(
    circuit,
    Array.from({length: candidateCount}, (_, item) => item),
    candidateCount,
  )
  circuit.tensorProgram = circuit.compileTensorProgram([
    ...winner.selected,
    winner.score,
  ])

  for (const [scores, winnerIndex] of [
    [[0.1, 0.7, 0.2, 0.4, 0.3, 0.6, 0.5], 1],
    [[0.8, 0.2, 0.8, 0.4, 0.8, 0.6, 0.5], 0],
    [[0, 0, 0, 0, 0, 0, 0], 0],
  ] as const) {
    const source = Float32Array.from([...scores, 1])
    const values = circuit.evaluateTensor(source)
    assert.deepEqual(
      winner.selected.map(wire => values[wire]),
      winner.selected.map((_, item) => Number(item === winnerIndex)),
    )
    assert.ok(
      Math.abs(values[winner.score]! - Math.fround(scores[winnerIndex])) < 1e-6,
    )
  }

  assert.ok(
    circuit.tensorProgram.layers.length
      <= 2 * Math.ceil(Math.log2(candidateCount)) + 3,
  )
})

test('the reference and tensor evaluators round every arithmetic step', () => {
  const circuit = new Circuit(2)
  const sum = circuit.affine([[0, 1], [1, 1]])
  const source = new Float32Array([16_777_216, 1])

  const reference = circuit.evaluateReference(source)
  const tensor = circuit.evaluateTensor(source)
  assert.ok(reference instanceof Float32Array)
  assert.ok(tensor instanceof Float32Array)
  assert.equal(reference[sum], 16_777_216)
  assert.equal(tensor[sum], 16_777_216)
})

test('reference backpropagation follows affine and ReGLU atoms', () => {
  const circuit = new Circuit(3)
  const output = circuit.reglu(
    [[0, 2], [2, 1]],
    0,
    [[0, 3], [1, -1]],
    0,
  )
  const values = circuit.evaluateReference(new Float32Array([2, 1, -1]))
  const outputGradients = new Float32Array(values.length)
  outputGradients[output] = 1
  const gradients = circuit.backpropagateReference(values, outputGradients)

  assert.equal(values[output], 15)
  assert.deepEqual([...gradients.subarray(0, 3)], [19, -3, 5])
})

test('reference backpropagation rejects hard boolean decisions', () => {
  const circuit = new Circuit(1)
  circuit.assumeRange(0, 0, 1)
  const output = circuit.boolean(0)
  const values = circuit.evaluateReference(new Float32Array([0.4]))
  const outputGradients = new Float32Array(values.length)
  outputGradients[output] = 1

  assert.throws(
    () => circuit.backpropagateReference(values, outputGradients),
    /cannot backpropagate through a boolean atom/,
  )
})

test('tensor and reference evaluators both reject a wrong-sized source table', () => {
  const circuit = new Circuit(2)
  circuit.affine([[0, 1], [1, 1]])

  for (const source of [
    new Float32Array([7]),
    new Float32Array([7, 8, 9]),
  ]) {
    assert.throws(
      () => circuit.evaluateTensor(source),
      /source table has the wrong length/,
    )
    assert.throws(
      () => circuit.evaluateReference(source),
      /source table has the wrong length/,
    )
  }
})

test('weighted sums normalize duplicate, zero, and unordered terms', () => {
  const circuit = new Circuit(3)
  circuit.affine([
    [2, 0],
    [1, 4],
    [0, 3],
    [1, -1],
    [0, -3],
    [2, 5],
  ], 7)

  assert.deepEqual(circuit.operations[0]!.leftTerms, [[1, 3], [2, 5]])
  assert.equal(circuit.evaluateTensor(new Float32Array([11, 13, 17]))[3], 131)
})

test('constant terms and constant gates fold before compilation', () => {
  const circuit = new Circuit(1)
  const three = circuit.affine([], 3)
  circuit.affine([[0, 4], [three, 2]], 1)
  circuit.reglu([[0, 2]], 5, [[three, 1]], -1)
  circuit.reglu([[0, 7]], 11, [[three, -1]], 2)

  assert.deepEqual(circuit.operations.map(operation => ({
    kind: operation.kind,
    leftTerms: operation.leftTerms,
    leftBias: operation.leftBias,
  })), [
    {kind: 'affine', leftTerms: [], leftBias: 3},
    {kind: 'affine', leftTerms: [[0, 4]], leftBias: 7},
    {kind: 'affine', leftTerms: [[0, 4]], leftBias: 10},
    {kind: 'affine', leftTerms: [], leftBias: 0},
  ])
  assert.deepEqual(
    [...circuit.evaluateTensor(new Float32Array([13]))].slice(1),
    [3, 59, 62, 0],
  )
})

test('identity affine operations return an alias without allocating a wire', () => {
  const circuit = new Circuit(2)
  const alias = circuit.affine([[1, 1]])

  assert.equal(alias, 1)
  assert.equal(circuit.operations.length, 0)
  assert.equal(circuit.compileTensorProgram().width, 2)
})

test('affine forms compose through affine producers', () => {
  const circuit = new Circuit(2)
  const first = circuit.affine([[0, 2], [1, -1]], 3)
  const second = circuit.affine([[first, 4], [1, 5]], -2)
  circuit.reglu([[second, 2]], 1, [[first, -3]], 7)

  assert.deepEqual(circuit.operations[1], {
    kind: 'affine',
    leftTerms: [[0, 8], [1, 1]],
    leftBias: 10,
    gateTerms: [],
    gateBias: 0,
    depth: 1,
  })
  assert.deepEqual(circuit.operations[2]!.leftTerms, [[0, 16], [1, 2]])
  assert.deepEqual(circuit.operations[2]!.gateTerms, [[0, -6], [1, 3]])
})

test('identical normalized expressions share one wire', () => {
  const circuit = new Circuit(2)
  const firstAffine = circuit.affine([[1, 3], [0, 2]], 4)
  const secondAffine = circuit.affine([[0, 1], [1, 3], [0, 1]], 4)
  const firstReglu = circuit.reglu([[firstAffine, 2]], 1, [[1, -1]], 3)
  const secondReglu = circuit.reglu([[secondAffine, 2]], 1, [[1, -1]], 3)

  assert.equal(secondAffine, firstAffine)
  assert.equal(secondReglu, firstReglu)
  assert.equal(circuit.operations.length, 2)
})

test('tensor roots remove operations that cannot affect an output', () => {
  const circuit = new Circuit(2)
  const liveDependency = circuit.reglu([[0, 2]], 0, [[1, 1]], 0)
  const liveOutput = circuit.affine([[liveDependency, 1]], 3)
  circuit.reglu([[0, 7]], 11, [[1, -2]], 5)
  const program = circuit.compileTensorProgram([liveOutput])

  assert.equal(program.width, 5)
  assert.equal(program.valueCount, 4)
  assert.deepEqual([...program.wireOrder], [0, 1, liveDependency, liveOutput])
  assert.equal(evaluateOutput(circuit, program, [13, 17], liveOutput), 445)
})

test('tensor layers gather only the values they read', () => {
  const circuit = new Circuit(2)
  const first = circuit.reglu([[0, 1]], 0, [[1, 1]], 0)
  const second = circuit.reglu([[first, 2]], 1, [[first, -1]], 5)
  const program = circuit.compileTensorProgram([second])

  assert.deepEqual(program.layers.map(layer => ({
    inputIndices: [...layer.inputIndices],
    inputSize: layer.inputSize,
    outputSize: layer.outputSize,
  })), [
    {inputIndices: [0, 1], inputSize: 2, outputSize: 1},
    {inputIndices: [2], inputSize: 1, outputSize: 1},
  ])
})

test('affine outputs do not allocate fake gate rows', () => {
  const circuit = new Circuit(2)
  const affine = circuit.affine([[0, 2]], 1)
  const reglu = circuit.reglu([[0, 3]], 2, [[1, -1]], 5)
  const program = circuit.compileTensorProgram([affine, reglu])
  const layer = program.layers[0]!

  assert.equal(layer.outputSize, 2)
  assert.deepEqual([...layer.gateRows], [1])
  assert.equal(layer.bias.length, 3)
  assert.deepEqual([...layer.rowOffsets], [0, 1, 2, 3])
  assert.deepEqual([...layer.columns], [0, 0, 1])
  assert.equal(layer.weights.length, 3)
  assert.equal(evaluateOutput(circuit, program, [7, 2], affine), 15)
  assert.equal(evaluateOutput(circuit, program, [7, 2], reglu), 69)
})

test('boolean outputs make complete decisions with an explicit tie rule', () => {
  const circuit = new Circuit(1)
  circuit.assumeRange(0, 0, 1)
  const decision = circuit.boolean(0)
  const program = circuit.compileTensorProgram([decision])

  assert.equal(circuit.operations[0]!.kind, 'boolean')
  assert.deepEqual([...program.layers[0]!.booleanRows], [0])
  for (const [score, expected] of [
    [0, 0],
    [0.49, 0],
    [0.5, 1],
    [0.51, 1],
    [1, 1],
  ] as const) {
    assert.equal(evaluateOutput(circuit, program, [score], decision), expected)
    assert.equal(circuit.evaluateReference(new Float32Array([score]))[decision], expected)
  }
})

test('random circuits preserve every live FP32 wire', () => {
  const random = createRandom(0x1d1ec7)
  for (let circuitIndex = 0; circuitIndex < 500; circuitIndex++) {
    const sourceSize = 2 + randomInteger(random, 5)
    const circuit = new Circuit(sourceSize)
    circuit.assumeRange(0, 0, 1)
    circuit.assumeRange(1, 0, 1)
    const wires = Array.from({length: sourceSize}, (_, wire) => wire)
    const booleanWires: Wire[] = [0, 1]
    const operationCount = 4 + randomInteger(random, 20)

    for (let operation = 0; operation < operationCount; operation++) {
      const kind = randomInteger(random, 5)
      let wire: Wire
      if (kind <= 1) {
        wire = circuit.affine(randomTerms(random, wires), randomCoefficient(random))
      } else if (kind <= 3) {
        wire = circuit.reglu(
          randomTerms(random, wires),
          randomCoefficient(random),
          randomTerms(random, wires),
          randomCoefficient(random),
        )
      } else {
        wire = circuit.boolean(booleanWires[randomInteger(random, booleanWires.length)]!)
        booleanWires.push(wire)
      }
      wires.push(wire)
    }

    validateCircuit(circuit)
    const roots = Array.from(
      {length: 1 + randomInteger(random, 4)},
      () => wires[sourceSize + randomInteger(random, wires.length - sourceSize)]!,
    )
    const program = circuit.compileTensorProgram(roots)
    circuit.tensorProgram = program
    validateTensorProgram(circuit, program)

    for (let inputIndex = 0; inputIndex < 4; inputIndex++) {
      const source = Float32Array.from(
        {length: sourceSize},
        (_, wire) => wire < 2 ? randomInteger(random, 2) : random() * 2 - 1,
      )
      const tensor = circuit.evaluateTensor(source)
      validateTensorEvaluation(source, circuit, tensor)
    }
  }
})

function evaluateOutput(
  circuit: Circuit,
  program: ReturnType<Circuit['compileTensorProgram']>,
  source: number[],
  wire: number,
) {
  circuit.tensorProgram = program
  return circuit.evaluateTensor(Float32Array.from(source))[wire]
}

function createRandom(seed: number) {
  return () => {
    seed |= 0
    seed = seed + 0x6d2b79f5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

function randomInteger(random: () => number, limit: number) {
  return Math.floor(random() * limit)
}

function randomCoefficient(random: () => number) {
  return [-1, -0.5, 0, 0.5, 1][randomInteger(random, 5)]!
}

function randomTerms(random: () => number, wires: readonly Wire[]): Terms {
  return Array.from(
    {length: randomInteger(random, 5)},
    () => [
      wires[randomInteger(random, wires.length)]!,
      randomCoefficient(random),
    ] as const,
  )
}
