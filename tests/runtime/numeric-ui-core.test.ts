import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {
  Circuit,
  type Wire,
  emitArgmax,
  emitFirstActive,
  inlineCircuit,
  asWire,
} from '../../src/runtime/numeric-ui-core.ts'

test('inlined circuits become one graph and share matching expressions', () => {
  const child = new Circuit(2)
  const childSum = child.affine([[child.source(0), 1], [child.source(1), 1]])
  const childProduct = child.reglu([[childSum, 1]], 0, [[child.source(0), 1]], 0)
  const parent = new Circuit(2)
  const existingSum = parent.affine([[parent.source(0), 1], [parent.source(1), 1]])
  const wireMap = inlineCircuit(parent, child, [parent.source(0), parent.source(1)])

  assert.equal(wireMap[childSum], existingSum)
  const output = wireMap[childProduct]!
  const program = parent.compileTensorProgram([output])
  parent.tensorProgram = program
  assert.equal(parent.evaluateTensor(new Float32Array([2, 3]))[output], 10)
})

test('tensor layers append only their new values', () => {
  const circuit = new Circuit(2)
  const first = circuit.affine([[circuit.source(0), 2]])
  circuit.affine([[first, 4]])
  circuit.affine([[circuit.source(1), 3]])
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
  circuit.affine([[circuit.source(0), 1 / 3]], 1 / 10)
  const layer = circuit.compileTensorProgram().layers[0]!

  assert.ok(layer.weights instanceof Float32Array)
  assert.ok(layer.bias instanceof Float32Array)
  assert.equal(layer.weights[0], Math.fround(1 / 3))
  assert.equal(layer.bias[0], Math.fround(1 / 10))
})

test('compiled indices use the smallest safe unsigned width', () => {
  const small = new Circuit(255)
  const smallOutput = small.affine([[small.source(254), 2]])
  const smallProgram = small.compileTensorProgram([smallOutput])
  assert.ok(smallProgram.roots instanceof Uint8Array)
  assert.ok(smallProgram.wireOrder instanceof Uint8Array)
  assert.ok(smallProgram.layers[0]!.inputIndices instanceof Uint8Array)

  const medium = new Circuit(257)
  const mediumOutput = medium.affine(
    Array.from({length: 257}, (_, wire) => [medium.source(wire), 1] as const),
  )
  const mediumProgram = medium.compileTensorProgram([mediumOutput])
  assert.ok(mediumProgram.roots instanceof Uint16Array)
  assert.ok(mediumProgram.wireOrder instanceof Uint16Array)
  assert.ok(mediumProgram.layers[0]!.inputIndices instanceof Uint16Array)
  assert.ok(mediumProgram.layers[0]!.columns instanceof Uint16Array)
  assert.ok(mediumProgram.layers[0]!.rowOffsets instanceof Uint16Array)

  const large = new Circuit(65_537)
  const largeOutput = large.affine([[large.source(65_536), 2]])
  const largeProgram = large.compileTensorProgram([largeOutput])
  assert.ok(largeProgram.roots instanceof Uint32Array)
  assert.ok(largeProgram.wireOrder instanceof Uint32Array)
  assert.ok(largeProgram.layers[0]!.inputIndices instanceof Uint32Array)
})

test('first-active selection resolves ordered candidates through a balanced tree', () => {
  const candidateCount = 16
  const circuit = new Circuit(candidateCount + 1)
  for (let wire = 0; wire < circuit.sourceSize; wire++) circuit.assumeRange(asWire(wire), 0, 1)
  const selected = emitFirstActive(
    circuit,
    circuit.source(0),
    Array.from({length: candidateCount}, (_, item) => item + 1).map(asWire),
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
      <= 5 * Math.ceil(Math.log2(candidateCount)) + 1,
  )
})

test('argmax resolves continuous scores through a balanced tree', () => {
  const candidateCount = 7
  const circuit = new Circuit(candidateCount + 1)
  for (let wire = 0; wire < candidateCount; wire++) circuit.assumeRange(asWire(wire), 0, 1)
  circuit.assumeRange(circuit.source(candidateCount), 1, 1)
  const winner = emitArgmax(
    circuit,
    Array.from({length: candidateCount}, (_, item) => item).map(asWire),
    circuit.source(candidateCount),
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
      <= 6 * Math.ceil(Math.log2(candidateCount)),
  )
})

test('argmax breaks exact ties toward the lower-indexed candidate', () => {
  // patterns.md, "`findIndex` when passing items can be anywhere": equal scores
  // resolve to the left (lower) candidate, like a loop that replaces the best
  // only on a strictly larger score.
  // The 0.5 +/- 2^-24 comparison constants are what guarantee this; a plain 0.5
  // comparison sends some ties (e.g. 0.3 vs 0.3) to the right instead, so this
  // pins the tie-break direction the agreement oracles cannot see.
  const candidateCount = 4
  const circuit = new Circuit(candidateCount + 1)
  for (let wire = 0; wire < candidateCount; wire++) circuit.assumeRange(asWire(wire), 0, 1)
  circuit.assumeRange(circuit.source(candidateCount), 1, 1)
  const winner = emitArgmax(
    circuit,
    Array.from({length: candidateCount}, (_, item) => item).map(asWire),
    circuit.source(candidateCount),
  )
  circuit.tensorProgram = circuit.compileTensorProgram(winner.selected)

  for (const tie of [0, 0.25, 0.3, 0.5, 0.7, 1] as const) {
    const source = Float32Array.from([tie, tie, tie, tie, 1])
    const values = circuit.evaluateTensor(source)
    assert.deepEqual(winner.selected.map(wire => values[wire]), [1, 0, 0, 0])
  }
})

test('the reference and tensor evaluators round every arithmetic step', () => {
  const circuit = new Circuit(2)
  const sum = circuit.affine([[circuit.source(0), 1], [circuit.source(1), 1]])
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
    [[circuit.source(0), 2], [circuit.source(2), 1]],
    0,
    [[circuit.source(0), 3], [circuit.source(1), -1]],
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
  circuit.assumeRange(circuit.source(0), 0, 1)
  const output = circuit.boolean(circuit.source(0))
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
  circuit.affine([[circuit.source(0), 1], [circuit.source(1), 1]])

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
    [circuit.source(2), 0],
    [circuit.source(1), 4],
    [circuit.source(0), 3],
    [circuit.source(1), -1],
    [circuit.source(0), -3],
    [circuit.source(2), 5],
  ], 7)

  assert.deepEqual(circuit.operations[0]!.leftTerms, [[1, 3], [2, 5]])
  assert.equal(circuit.evaluateTensor(new Float32Array([11, 13, 17]))[3], 131)
})

test('a sum shared by many consumers stays one materialized wire', () => {
  // A wide sum read by many consumers must not be copied into each consumer, or
  // stored weights grow with consumers x terms (quadratically). It is kept as one
  // wire that consumers reference, so total stored weights stay linear in n.
  function sharedSumWeights(n: number) {
    const circuit = new Circuit(n + n)
    for (let wire = 0; wire < n; wire++) circuit.assumeRange(asWire(wire), 0, 1)
    const shared = circuit.affine(
      Array.from({length: n}, (_, wire): [Wire, number] => [asWire(wire), 1]),
    )
    const outputs = Array.from({length: n}, (_, item) =>
      circuit.affine([[shared, 0.5], [asWire(n + item), 1]]))
    const program = circuit.compileTensorProgram(outputs)
    let weights = 0
    for (const layer of program.layers) weights += layer.weights.length
    return weights
  }

  // Doubling n must not quadruple the weights. A quadratic copy would; referencing
  // one shared wire keeps the ratio near 2.
  assert.ok(sharedSumWeights(64) < 3 * sharedSumWeights(32))
  assert.ok(sharedSumWeights(128) < 3 * sharedSumWeights(64))
})

test('wide affine sharing is independent of consumer order', () => {
  const source = Float32Array.from([
    -0.00002327098263776861,
    -6.589837084902683e-7,
    0.0015497038839384913,
    -0.02216961793601513,
  ])

  function build(withUnusedConsumer: boolean) {
    const circuit = new Circuit(4)
    const shared = circuit.affine([[circuit.source(0), 1], [circuit.source(1), 1], [circuit.source(2), 1], [circuit.source(3), 1]])
    if (withUnusedConsumer) circuit.affine([[shared, 2]], 1)
    const live = circuit.affine([[shared, 2]], 1)
    return {circuit, live}
  }

  const clean = build(false)
  const withUnusedConsumer = build(true)
  assert.equal(
    clean.circuit.evaluateReference(source)[clean.live],
    withUnusedConsumer.circuit.evaluateReference(source)[withUnusedConsumer.live],
  )
})

test('identical consumers of a wide affine share one wire', () => {
  const circuit = new Circuit(4)
  const shared = circuit.affine([[circuit.source(0), 1], [circuit.source(1), 1], [circuit.source(2), 1], [circuit.source(3), 1]])
  const first = circuit.affine([[shared, 2]], 1)
  const second = circuit.affine([[shared, 2]], 1)

  assert.equal(second, first)
})

test('duplicate-wire terms merge into one exact FP32 coefficient', () => {
  // Two terms on the same wire must collapse to one summed coefficient, so the
  // evaluator rounds a single product fround(c1+c2)*x rather than two separate
  // products fround(c1)*x + fround(c2)*x, which differ by a ULP at some x. Both
  // evaluators run the same stored stream, so only this build-time check sees it.
  const merged = 1 / 3 + 0.1
  const circuit = new Circuit(1)
  const sum = circuit.affine([[circuit.source(0), 1 / 3], [circuit.source(0), 0.1]])
  assert.deepEqual(circuit.operations[0]!.leftTerms, [[0, merged]])

  const x = -17.309
  const expected = Math.fround(Math.fround(merged) * x)
  const unmerged = Math.fround(
    Math.fround(Math.fround(1 / 3) * x) + Math.fround(Math.fround(0.1) * x),
  )
  assert.notEqual(expected, unmerged) // the chosen x genuinely separates the two
  assert.equal(circuit.evaluateReference(new Float32Array([x]))[sum], expected)
  assert.equal(circuit.evaluateTensor(new Float32Array([x]))[sum], expected)
})

test('constant terms and constant gates fold before compilation', () => {
  const circuit = new Circuit(1)
  const three = circuit.affine([], 3)
  circuit.affine([[circuit.source(0), 4], [three, 2]], 1)
  circuit.reglu([[circuit.source(0), 2]], 5, [[three, 1]], -1)
  circuit.reglu([[circuit.source(0), 7]], 11, [[three, -1]], 2)

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
  const alias = circuit.affine([[circuit.source(1), 1]])

  assert.equal(alias, 1)
  assert.equal(circuit.operations.length, 0)
  assert.equal(circuit.compileTensorProgram().width, 2)
})

test('affine forms compose through affine producers', () => {
  const circuit = new Circuit(2)
  const first = circuit.affine([[circuit.source(0), 2], [circuit.source(1), -1]], 3)
  const second = circuit.affine([[first, 4], [circuit.source(1), 5]], -2)
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
  const firstAffine = circuit.affine([[circuit.source(1), 3], [circuit.source(0), 2]], 4)
  const secondAffine = circuit.affine([[circuit.source(0), 1], [circuit.source(1), 3], [circuit.source(0), 1]], 4)
  const firstReglu = circuit.reglu([[firstAffine, 2]], 1, [[circuit.source(1), -1]], 3)
  const secondReglu = circuit.reglu([[secondAffine, 2]], 1, [[circuit.source(1), -1]], 3)

  assert.equal(secondAffine, firstAffine)
  assert.equal(secondReglu, firstReglu)
  assert.equal(circuit.operations.length, 2)
})

test('tensor roots remove operations that cannot affect an output', () => {
  const circuit = new Circuit(2)
  const liveDependency = circuit.reglu([[circuit.source(0), 2]], 0, [[circuit.source(1), 1]], 0)
  const liveOutput = circuit.affine([[liveDependency, 1]], 3)
  circuit.reglu([[circuit.source(0), 7]], 11, [[circuit.source(1), -2]], 5)
  const program = circuit.compileTensorProgram([liveOutput])

  assert.equal(program.width, 5)
  assert.equal(program.valueCount, 4)
  assert.deepEqual([...program.wireOrder], [0, 1, liveDependency, liveOutput])
  assert.equal(evaluateOutput(circuit, program, [13, 17], liveOutput), 445)
})

test('tensor layers gather only the values they read', () => {
  const circuit = new Circuit(2)
  const first = circuit.reglu([[circuit.source(0), 1]], 0, [[circuit.source(1), 1]], 0)
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
  const affine = circuit.affine([[circuit.source(0), 2]], 1)
  const reglu = circuit.reglu([[circuit.source(0), 3]], 2, [[circuit.source(1), -1]], 5)
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
  circuit.assumeRange(circuit.source(0), 0, 1)
  const decision = circuit.boolean(circuit.source(0))
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

function evaluateOutput(
  circuit: Circuit,
  program: ReturnType<Circuit['compileTensorProgram']>,
  source: number[],
  wire: number,
) {
  circuit.tensorProgram = program
  return circuit.evaluateTensor(Float32Array.from(source))[wire]
}
