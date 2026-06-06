// Two runtime atoms, plus compile-time expansions that lower into those atoms.
export type Wire = number

export type Terms = readonly (readonly [wire: Wire, coefficient: number])[]

type AtomKind = 'affine' | 'reglu'

type Operation = {
  kind: AtomKind
  leftTerms: Terms
  leftBias: number
  gateTerms: Terms
  gateBias: number
  depth: number
}

export type TensorLayer = {
  inputSize: number
  leftBias: Float64Array
  gateBias: Float64Array
  leftWeights: Float64Array
  gateWeights: Float64Array
}

export type TensorProgram = {
  layers: TensorLayer[]
  roots: Uint32Array
  sourceSize: number
  valueCount: number
  wireOrder: Uint32Array
  width: number
}

export class Circuit {
  sourceSize: number
  operations: Operation[]
  depths: number[]
  constants: (number | undefined)[]
  expressionWires: Map<string, Wire>
  tensorProgram: TensorProgram | null

  constructor(sourceSize: number) {
    this.sourceSize = sourceSize
    this.operations = []
    this.depths = Array<number>(sourceSize).fill(0)
    this.constants = Array<number | undefined>(sourceSize).fill(undefined)
    this.expressionWires = new Map()
    this.tensorProgram = null
  }

  affine(terms: Terms, bias = 0): Wire {
    return this.append('affine', terms, bias, [], 0)
  }

  reglu(leftTerms: Terms, leftBias: number, gateTerms: Terms, gateBias: number): Wire {
    return this.append('reglu', leftTerms, leftBias, gateTerms, gateBias)
  }

  append(kind: AtomKind, leftTerms: Terms, leftBias: number, gateTerms: Terms, gateBias: number): Wire {
    ;[leftTerms, leftBias] = foldConstantTerms(normalizeTerms(leftTerms), leftBias, this.constants)
    ;[gateTerms, gateBias] = foldConstantTerms(normalizeTerms(gateTerms), gateBias, this.constants)
    const initialAlias = kind === 'affine' ? identityWire(leftTerms, leftBias) : undefined
    if (initialAlias !== undefined) return initialAlias
    ;[leftTerms, leftBias] = composeAffineTerms(
      leftTerms,
      leftBias,
      this.sourceSize,
      this.operations,
    )
    ;[gateTerms, gateBias] = composeAffineTerms(
      gateTerms,
      gateBias,
      this.sourceSize,
      this.operations,
    )
    if (kind === 'reglu' && gateTerms.length === 0) {
      const gate = Math.max(0, gateBias)
      kind = 'affine'
      leftTerms = gate === 0
        ? []
        : leftTerms.map(([wire, coefficient]) => [wire, coefficient * gate])
      leftBias *= gate
      gateBias = 0
    } else if (kind === 'reglu' && leftTerms.length === 0 && leftBias === 0) {
      kind = 'affine'
      gateTerms = []
      gateBias = 0
    }
    const composedAlias = kind === 'affine' ? identityWire(leftTerms, leftBias) : undefined
    if (composedAlias !== undefined) return composedAlias
    const expressionKey = serializeExpression(kind, leftTerms, leftBias, gateTerms, gateBias)
    const existingWire = this.expressionWires.get(expressionKey)
    if (existingWire !== undefined) return existingWire
    const wire = this.sourceSize + this.operations.length
    const dependencies = kind === 'affine' ? leftTerms : [...leftTerms, ...gateTerms]
    let depth = 0
    for (const [dependency] of dependencies) depth = Math.max(depth, this.depths[dependency]!)
    this.operations.push({kind, leftTerms, leftBias, gateTerms, gateBias, depth: depth + 1})
    this.depths.push(depth + 1)
    this.constants.push(kind === 'affine' && leftTerms.length === 0 ? leftBias : undefined)
    this.expressionWires.set(expressionKey, wire)
    this.tensorProgram = null
    return wire
  }

  evaluateReadable(source: Float64Array): Float64Array {
    return evaluateOperationStream(source, this)
  }

  evaluateTensor(source: Float64Array): Float64Array {
    return evaluateTensorProgram(source, this.tensorProgram ??= this.compileTensorProgram())
  }

  compileTensorProgram(roots?: readonly Wire[]): TensorProgram {
    const width = this.sourceSize + this.operations.length
    const normalizedRoots = roots ?? Array.from(
      {length: this.operations.length},
      (_, operationIndex) => this.sourceSize + operationIndex,
    )
    const liveOperations = findLiveOperations(
      normalizedRoots,
      this.sourceSize,
      this.operations,
      width,
    )
    const operationsByLayer: number[][] = []
    for (let operationIndex = 0; operationIndex < this.operations.length; operationIndex++) {
      if (liveOperations[operationIndex] === 0) continue
      const operation = this.operations[operationIndex]!
      const layerIndex = operation.depth - 1
      const operationIndices = operationsByLayer[layerIndex] ??= []
      operationIndices.push(operationIndex)
    }

    const layers: TensorLayer[] = []
    const liveOperationCount = liveOperations.reduce((sum, live) => sum + live, 0)
    const valueCount = this.sourceSize + liveOperationCount
    const wireOrder = new Uint32Array(valueCount)
    const packedIndexByWire = new Int32Array(width)
    packedIndexByWire.fill(-1)
    for (let wire = 0; wire < this.sourceSize; wire++) {
      wireOrder[wire] = wire
      packedIndexByWire[wire] = wire
    }
    let availableValues = this.sourceSize
    for (let layerIndex = 0; layerIndex < operationsByLayer.length; layerIndex++) {
      const operationIndices = operationsByLayer[layerIndex]
      if (operationIndices === undefined) continue
      const outputSize = operationIndices.length
      const layer: TensorLayer = {
        inputSize: availableValues,
        leftBias: new Float64Array(outputSize),
        gateBias: new Float64Array(outputSize),
        leftWeights: new Float64Array(outputSize * availableValues),
        gateWeights: new Float64Array(outputSize * availableValues),
      }
      for (let row = 0; row < operationIndices.length; row++) {
        const operationIndex = operationIndices[row]!
        const operation = this.operations[operationIndex]!
        const outputWire = this.sourceSize + operationIndex
        const packedOutput = availableValues + row
        const rowOffset = row * availableValues
        wireOrder[packedOutput] = outputWire
        packedIndexByWire[outputWire] = packedOutput
        layer.leftBias[row] = operation.leftBias
        layer.gateBias[row] = operation.kind === 'affine' ? 1 : operation.gateBias
        writePackedWeights(layer.leftWeights, rowOffset, operation.leftTerms, packedIndexByWire)
        if (operation.kind === 'reglu') {
          writePackedWeights(layer.gateWeights, rowOffset, operation.gateTerms, packedIndexByWire)
        }
      }
      layers.push(layer)
      availableValues += outputSize
    }
    return {
      layers,
      roots: Uint32Array.from(normalizedRoots),
      sourceSize: this.sourceSize,
      valueCount,
      wireOrder,
      width,
    }
  }

  stats() {
    let affineCount = 0
    let regluCount = 0
    for (const operation of this.operations) {
      if (operation.kind === 'affine') affineCount++
      else regluCount++
    }
    return {
      sourceCells: this.sourceSize,
      temporaryCells: this.operations.length,
      affineCount,
      regluCount,
      depth: Math.max(...this.depths),
    }
  }
}

function findLiveOperations(
  roots: readonly Wire[],
  sourceSize: number,
  operations: readonly Operation[],
  width: number,
): Uint8Array {
  const liveOperations = new Uint8Array(operations.length)
  const pending = [...roots]
  while (pending.length > 0) {
    const wire = pending.pop()!
    assertWire(wire, width)
    if (wire < sourceSize) continue
    const operationIndex = wire - sourceSize
    if (liveOperations[operationIndex] === 1) continue
    liveOperations[operationIndex] = 1
    const operation = operations[operationIndex]!
    for (const [dependency] of operation.leftTerms) pending.push(dependency)
    for (const [dependency] of operation.gateTerms) pending.push(dependency)
  }
  return liveOperations
}

function serializeExpression(
  kind: AtomKind,
  leftTerms: Terms,
  leftBias: number,
  gateTerms: Terms,
  gateBias: number,
): string {
  return [
    kind,
    leftBias,
    ...leftTerms.flatMap(([wire, coefficient]) => [wire, coefficient]),
    '|',
    gateBias,
    ...gateTerms.flatMap(([wire, coefficient]) => [wire, coefficient]),
  ].join(',')
}

function identityWire(terms: Terms, bias: number): Wire | undefined {
  if (bias !== 0 || terms.length !== 1 || terms[0]![1] !== 1) return undefined
  return terms[0]![0]
}

function composeAffineTerms(
  terms: Terms,
  bias: number,
  sourceSize: number,
  operations: readonly Operation[],
): [terms: Terms, bias: number] {
  const composedTerms: [wire: Wire, coefficient: number][] = []
  for (const [wire, coefficient] of terms) {
    const operation = wire < sourceSize ? undefined : operations[wire - sourceSize]
    if (operation?.kind !== 'affine') {
      composedTerms.push([wire, coefficient])
      continue
    }
    bias += coefficient * operation.leftBias
    for (const [dependency, dependencyCoefficient] of operation.leftTerms) {
      composedTerms.push([dependency, coefficient * dependencyCoefficient])
    }
  }
  return [normalizeTerms(composedTerms), bias]
}

function foldConstantTerms(
  terms: Terms,
  bias: number,
  constants: readonly (number | undefined)[],
): [terms: Terms, bias: number] {
  const dynamicTerms: [wire: Wire, coefficient: number][] = []
  for (const [wire, coefficient] of terms) {
    const constant = constants[wire]
    if (constant === undefined) dynamicTerms.push([wire, coefficient])
    else bias += coefficient * constant
  }
  return [dynamicTerms, bias]
}

function normalizeTerms(terms: Terms): Terms {
  const sortedTerms = [...terms].sort(([leftWire], [rightWire]) => leftWire - rightWire)
  const normalizedTerms: [wire: Wire, coefficient: number][] = []
  for (const [wire, coefficient] of sortedTerms) {
    const previous = normalizedTerms.at(-1)
    if (previous?.[0] === wire) previous[1] += coefficient
    else normalizedTerms.push([wire, coefficient])
  }
  return normalizedTerms.filter(([, coefficient]) => coefficient !== 0)
}

export function evaluateOperationStream(source: Float64Array, circuit: Circuit): Float64Array {
  invariant(source.length === circuit.sourceSize, 'source table has the wrong length')
  const values = new Float64Array(circuit.sourceSize + circuit.operations.length)
  values.set(source)
  for (let operationIndex = 0; operationIndex < circuit.operations.length; operationIndex++) {
    const operation = circuit.operations[operationIndex]!
    let value = evaluateTerms(values, operation.leftTerms, operation.leftBias)
    if (operation.kind === 'reglu') {
      value *= Math.max(0, evaluateTerms(values, operation.gateTerms, operation.gateBias))
    }
    values[circuit.sourceSize + operationIndex] = value
  }
  return values
}

export function evaluateTensorProgram(source: Float64Array, program: TensorProgram): Float64Array {
  invariant(source.length === program.sourceSize, 'source table has the wrong length')
  const {layers, valueCount, wireOrder, width} = program
  const packedValues = new Float64Array(valueCount)
  let maxOutputSize = 0
  for (const layer of layers) maxOutputSize = Math.max(maxOutputSize, layer.leftBias.length)
  const left = new Float64Array(maxOutputSize)
  const gate = new Float64Array(maxOutputSize)
  packedValues.set(source)
  let availableValues = source.length
  for (const layer of layers) {
    const outputSize = layer.leftBias.length
    matmulAddBias(left, layer.leftWeights, packedValues, layer.leftBias, outputSize, layer.inputSize)
    matmulAddBias(gate, layer.gateWeights, packedValues, layer.gateBias, outputSize, layer.inputSize)
    for (let row = 0; row < outputSize; row++) {
      packedValues[availableValues + row] = left[row]! * Math.max(0, gate[row]!)
    }
    availableValues += outputSize
  }
  const values = new Float64Array(width)
  for (let packedIndex = 0; packedIndex < width; packedIndex++) {
    values[wireOrder[packedIndex]!] = packedValues[packedIndex]!
  }
  return values
}

function matmulAddBias(
  output: Float64Array,
  weights: Float64Array,
  input: Float64Array,
  bias: Float64Array,
  outputSize: number,
  inputSize: number,
) {
  for (let row = 0; row < outputSize; row++) {
    const rowOffset = row * inputSize
    let value = bias[row]!
    for (let column = 0; column < inputSize; column++) value += weights[rowOffset + column]! * input[column]!
    output[row] = value
  }
}

function evaluateTerms(values: Float64Array, terms: Terms, bias: number): number {
  let value = bias
  for (const [wire, coefficient] of terms) value += coefficient * values[wire]!
  return value
}

function writePackedWeights(
  weights: Float64Array,
  rowOffset: number,
  terms: Terms,
  packedIndexByWire: Int32Array,
) {
  for (const [wire, coefficient] of terms) {
    const column = packedIndexByWire[wire]!
    invariant(column >= 0, 'tensor dependency is not available')
    weights[rowOffset + column] = weights[rowOffset + column]! + coefficient
  }
}

export function emitRelu(circuit: Circuit, value: Wire): Wire {
  return circuit.reglu([], 1, [[value, 1]], 0)
}

export function emitMultiply(circuit: Circuit, a: Wire, b: Wire): Wire {
  const positive = circuit.reglu([[a, 1]], 0, [[b, 1]], 0)
  const negative = circuit.reglu([[a, 1]], 0, [[b, -1]], 0)
  return circuit.affine([[positive, 1], [negative, -1]])
}

export function emitMaximum(circuit: Circuit, a: Wire, b: Wire): Wire {
  return circuit.affine([[b, 1], [emitRelu(circuit, circuit.affine([[a, 1], [b, -1]])), 1]])
}

export function emitMinimum(circuit: Circuit, a: Wire, b: Wire): Wire {
  return circuit.affine([[a, 1], [emitRelu(circuit, circuit.affine([[a, 1], [b, -1]])), -1]])
}

export function validateCircuit(circuit: Circuit): number {
  const wireCount = circuit.sourceSize + circuit.operations.length
  for (let operationIndex = 0; operationIndex < circuit.operations.length; operationIndex++) {
    const operation = circuit.operations[operationIndex]!
    invariant(Number.isFinite(operation.leftBias), 'left bias must be finite')
    invariant(Number.isFinite(operation.gateBias), 'gate bias must be finite')
    validateTerms(operation.leftTerms, circuit.sourceSize + operationIndex)
    validateTerms(operation.gateTerms, circuit.sourceSize + operationIndex)
  }
  return wireCount
}

export function validateTensorProgram(circuit: Circuit, program: TensorProgram) {
  const {layers, roots, valueCount, wireOrder, width} = program
  invariant(program.sourceSize === circuit.sourceSize, 'tensor source size mismatch')
  invariant(width === circuit.sourceSize + circuit.operations.length, 'tensor width mismatch')
  invariant(valueCount <= width, 'tensor value count exceeds circuit width')
  invariant(wireOrder.length === valueCount, 'tensor wire order size mismatch')
  const seenWires = new Uint8Array(width)
  for (let wire = 0; wire < circuit.sourceSize; wire++) {
    invariant(wireOrder[wire] === wire, 'tensor source order mismatch')
    seenWires[wire] = 1
  }
  let availableValues = circuit.sourceSize
  for (const layer of layers) {
    const outputSize = layer.leftBias.length
    invariant(outputSize > 0, 'tensor layer must produce at least one value')
    invariant(layer.inputSize === availableValues, 'tensor layer input size mismatch')
    invariant(layer.gateBias.length === outputSize, 'gate bias shape mismatch')
    invariant(layer.leftWeights.length === outputSize * availableValues, 'left matrix shape mismatch')
    invariant(layer.gateWeights.length === outputSize * availableValues, 'gate matrix shape mismatch')
    assertFiniteValues(layer.leftBias, 'left bias')
    assertFiniteValues(layer.gateBias, 'gate bias')
    assertFiniteValues(layer.leftWeights, 'left matrix')
    assertFiniteValues(layer.gateWeights, 'gate matrix')
    for (let row = 0; row < outputSize; row++) {
      const wire = wireOrder[availableValues + row]!
      invariant(wire >= circuit.sourceSize && wire < width, 'tensor output wire is invalid')
      invariant(seenWires[wire] === 0, 'tensor wire must be written exactly once')
      seenWires[wire] = 1
    }
    availableValues += outputSize
  }
  invariant(availableValues === valueCount, 'tensor program output size mismatch')
  for (const root of roots) invariant(seenWires[root] === 1, 'every tensor root must be present')
}

export function validateTensorEvaluation(source: Float64Array, circuit: Circuit, tensorValues: Float64Array) {
  const expectedValues = evaluateOperationStream(source, circuit)
  invariant(expectedValues.length === tensorValues.length, 'tensor result width mismatch')
  const program = circuit.tensorProgram ??= circuit.compileTensorProgram()
  for (const wire of program.wireOrder) {
    assertApproximatelyEqual(tensorValues[wire]!, expectedValues[wire]!, `tensor wire ${wire}`)
  }
}

export function assertWire(wire: number, limit: number) {
  invariant(Number.isInteger(wire) && wire >= 0 && wire < limit, 'wire is outside the compiled circuit')
}

export function assertNonNegativeFinite(value: number | undefined, label: string): asserts value is number {
  invariant(value !== undefined && Number.isFinite(value) && value >= 0, `${label} must be non-negative and finite`)
}

export function assertFiniteValues(values: Iterable<number>, label: string) {
  for (const value of values) invariant(Number.isFinite(value), `${label} contains a non-finite number`)
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (condition !== true) throw new Error(message)
}

function validateTerms(terms: Terms, wireLimit: number) {
  for (const [wire, coefficient] of terms) {
    assertWire(wire, wireLimit)
    invariant(Number.isFinite(coefficient), 'weight must be finite')
  }
}

function assertApproximatelyEqual(actual: number, expected: number, label: string) {
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected))
  invariant(Math.abs(actual - expected) <= 1e-9 * scale, `${label} does not match the readable atom program`)
}
