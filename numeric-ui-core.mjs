// Two runtime atoms, plus compile-time expansions that lower into those atoms.
export class Circuit {
  constructor(sourceSize) {
    this.sourceSize = sourceSize
    this.operations = []
    this.depths = Array(sourceSize).fill(0)
    this.tensorProgram = null
  }

  affine(terms, bias = 0) {
    return this.append('affine', terms, bias, [], 0)
  }

  reglu(leftTerms, leftBias, gateTerms, gateBias) {
    return this.append('reglu', leftTerms, leftBias, gateTerms, gateBias)
  }

  append(kind, leftTerms, leftBias, gateTerms, gateBias) {
    const wire = this.sourceSize + this.operations.length
    const dependencies = kind === 'affine' ? leftTerms : [...leftTerms, ...gateTerms]
    let depth = 0
    for (const [dependency] of dependencies) depth = Math.max(depth, this.depths[dependency])
    this.operations.push({kind, leftTerms, leftBias, gateTerms, gateBias, depth: depth + 1})
    this.depths.push(depth + 1)
    this.tensorProgram = null
    return wire
  }

  evaluateReadable(source) {
    return evaluateOperationStream(source, this)
  }

  evaluateTensor(source) {
    return evaluateTensorProgram(source, this.tensorProgram ??= this.compileTensorProgram())
  }

  compileTensorProgram() {
    const width = this.sourceSize + this.operations.length
    const operationsByLayer = []
    for (let operationIndex = 0; operationIndex < this.operations.length; operationIndex++) {
      const operation = this.operations[operationIndex]
      const layerIndex = operation.depth - 1
      if (operationsByLayer[layerIndex] == null) operationsByLayer[layerIndex] = []
      operationsByLayer[layerIndex].push(operationIndex)
    }

    const layers = []
    for (let layerIndex = 0; layerIndex < operationsByLayer.length; layerIndex++) {
      const layer = {
        leftBias: new Float64Array(width),
        gateBias: new Float64Array(width),
        leftWeights: new Float64Array(width * width),
        gateWeights: new Float64Array(width * width),
        writeMask: new Float64Array(width),
      }
      for (const operationIndex of operationsByLayer[layerIndex]) {
        const operation = this.operations[operationIndex]
        const outputWire = this.sourceSize + operationIndex
        const rowOffset = outputWire * width
        layer.writeMask[outputWire] = 1
        layer.leftBias[outputWire] = operation.leftBias
        layer.gateBias[outputWire] = operation.kind === 'affine' ? 1 : operation.gateBias
        writeWeights(layer.leftWeights, rowOffset, operation.leftTerms)
        if (operation.kind === 'reglu') writeWeights(layer.gateWeights, rowOffset, operation.gateTerms)
      }
      layers.push(layer)
    }
    return {layers, width}
  }

  stats() {
    let affineCount = 0
    let regluCount = 0
    for (const operation of this.operations) {
      invariant(operation.kind === 'affine' || operation.kind === 'reglu', 'unknown atom kind')
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

export function evaluateOperationStream(source, circuit) {
  invariant(source.length === circuit.sourceSize, 'source table has the wrong length')
  const values = new Float64Array(circuit.sourceSize + circuit.operations.length)
  values.set(source)
  for (let operationIndex = 0; operationIndex < circuit.operations.length; operationIndex++) {
    const operation = circuit.operations[operationIndex]
    let value = evaluateTerms(values, operation.leftTerms, operation.leftBias)
    if (operation.kind === 'reglu') {
      value *= Math.max(0, evaluateTerms(values, operation.gateTerms, operation.gateBias))
    }
    values[circuit.sourceSize + operationIndex] = value
  }
  return values
}

export function evaluateTensorProgram(source, program) {
  invariant(source.length <= program.width, 'source table is wider than the tensor program')
  const {layers, width} = program
  const values = new Float64Array(width)
  const left = new Float64Array(width)
  const gate = new Float64Array(width)
  values.set(source)
  for (const layer of layers) {
    matmulAddBias(left, layer.leftWeights, values, layer.leftBias, width)
    matmulAddBias(gate, layer.gateWeights, values, layer.gateBias, width)
    for (let row = 0; row < width; row++) {
      values[row] += layer.writeMask[row] * left[row] * Math.max(0, gate[row])
    }
  }
  return values
}

function matmulAddBias(output, weights, input, bias, width) {
  for (let row = 0; row < width; row++) {
    const rowOffset = row * width
    let value = bias[row]
    for (let column = 0; column < width; column++) value += weights[rowOffset + column] * input[column]
    output[row] = value
  }
}

function evaluateTerms(values, terms, bias) {
  let value = bias
  for (const [wire, coefficient] of terms) value += coefficient * values[wire]
  return value
}

function writeWeights(weights, rowOffset, terms) {
  for (const [wire, coefficient] of terms) weights[rowOffset + wire] += coefficient
}

export function emitRelu(circuit, value) {
  return circuit.reglu([], 1, [[value, 1]], 0)
}

export function emitMultiply(circuit, a, b) {
  const positive = circuit.reglu([[a, 1]], 0, [[b, 1]], 0)
  const negative = circuit.reglu([[a, 1]], 0, [[b, -1]], 0)
  return circuit.affine([[positive, 1], [negative, -1]])
}

export function emitStepForInteger(circuit, value) {
  const positiveWithOffset = circuit.reglu([], 1, [[value, 1]], 1)
  const positive = circuit.reglu([], 1, [[value, 1]], 0)
  return circuit.affine([[positiveWithOffset, 1], [positive, -1]])
}

export function emitGreaterThanOrEqualForInteger(circuit, a, b) {
  return emitStepForInteger(circuit, circuit.affine([[a, 1], [b, -1]]))
}

export function emitGreaterThanForInteger(circuit, a, b) {
  return emitStepForInteger(circuit, circuit.affine([[a, 1], [b, -1]], -1))
}

export function emitEqualForInteger(circuit, a, b) {
  return emitMultiply(
    circuit,
    emitGreaterThanOrEqualForInteger(circuit, a, b),
    emitGreaterThanOrEqualForInteger(circuit, b, a),
  )
}

export function emitAnd(circuit, values) {
  let result = values[0]
  for (let i = 1; i < values.length; i++) result = emitMultiply(circuit, result, values[i])
  return result
}

export function emitMaximum(circuit, a, b) {
  return circuit.affine([[b, 1], [emitRelu(circuit, circuit.affine([[a, 1], [b, -1]])), 1]])
}

export function emitMinimum(circuit, a, b) {
  return circuit.affine([[a, 1], [emitRelu(circuit, circuit.affine([[a, 1], [b, -1]])), -1]])
}

export function emitSelect(circuit, mask, yes, no) {
  return circuit.affine([
    [emitMultiply(circuit, mask, yes), 1],
    [emitMultiply(circuit, circuit.affine([[mask, -1]], 1), no), 1],
  ])
}

export function validateCircuit(circuit) {
  const wireCount = circuit.sourceSize + circuit.operations.length
  for (let operationIndex = 0; operationIndex < circuit.operations.length; operationIndex++) {
    const operation = circuit.operations[operationIndex]
    invariant(operation.kind === 'affine' || operation.kind === 'reglu', 'unknown atom kind')
    invariant(Number.isFinite(operation.leftBias), 'left bias must be finite')
    invariant(Number.isFinite(operation.gateBias), 'gate bias must be finite')
    validateTerms(operation.leftTerms, circuit.sourceSize + operationIndex)
    validateTerms(operation.gateTerms, circuit.sourceSize + operationIndex)
  }
  return wireCount
}

export function validateTensorProgram(circuit, program) {
  const {layers, width} = program
  invariant(width === circuit.sourceSize + circuit.operations.length, 'tensor width mismatch')
  const available = new Uint8Array(width)
  const writeCount = new Uint8Array(width)
  available.fill(1, 0, circuit.sourceSize)
  for (const layer of layers) {
    invariant(layer.leftBias.length === width, 'left bias shape mismatch')
    invariant(layer.gateBias.length === width, 'gate bias shape mismatch')
    invariant(layer.leftWeights.length === width * width, 'left matrix shape mismatch')
    invariant(layer.gateWeights.length === width * width, 'gate matrix shape mismatch')
    invariant(layer.writeMask.length === width, 'write mask shape mismatch')
    assertFiniteValues(layer.leftBias, 'left bias')
    assertFiniteValues(layer.gateBias, 'gate bias')
    assertFiniteValues(layer.leftWeights, 'left matrix')
    assertFiniteValues(layer.gateWeights, 'gate matrix')
    for (let row = 0; row < width; row++) {
      const mask = layer.writeMask[row]
      const rowOffset = row * width
      assertBoolean(mask, 'write mask')
      if (mask === 1) {
        invariant(row >= circuit.sourceSize, 'tensor layer cannot overwrite source cells')
        invariant(writeCount[row] === 0, 'tensor wire must be written exactly once')
        writeCount[row] = 1
      } else {
        invariant(layer.leftBias[row] === 0 && layer.gateBias[row] === 0, 'masked row must have zero bias')
      }
      for (let column = 0; column < width; column++) {
        const hasWeight = layer.leftWeights[rowOffset + column] !== 0 || layer.gateWeights[rowOffset + column] !== 0
        if (hasWeight) {
          invariant(mask === 1, 'masked row must have zero weights')
          invariant(available[column] === 1, 'tensor layer read before dependency was available')
        }
      }
    }
    for (let row = circuit.sourceSize; row < width; row++) {
      if (layer.writeMask[row] === 1) available[row] = 1
    }
  }
  for (let row = circuit.sourceSize; row < width; row++) {
    invariant(writeCount[row] === 1, 'every temporary tensor wire must be written once')
  }
}

export function validateTensorEvaluation(source, circuit, tensorValues) {
  const expectedValues = evaluateOperationStream(source, circuit)
  invariant(expectedValues.length === tensorValues.length, 'tensor result width mismatch')
  for (let wire = 0; wire < tensorValues.length; wire++) {
    assertApproximatelyEqual(tensorValues[wire], expectedValues[wire], `tensor wire ${wire}`)
  }
}

export function assertWire(wire, limit) {
  invariant(Number.isInteger(wire) && wire >= 0 && wire < limit, 'wire is outside the compiled circuit')
}

export function assertBoolean(value, label) {
  invariant(value === 0 || value === 1, `${label} must be 0 or 1`)
}

export function assertInteger(value, label) {
  invariant(Number.isInteger(value), `${label} must be an integer`)
}

export function assertNonNegativeInteger(value, label) {
  invariant(Number.isInteger(value) && value >= 0, `${label} must be a non-negative integer`)
}

export function assertIntegerBetween(value, low, high, label) {
  invariant(Number.isInteger(value) && value >= low && value <= high, `${label} is outside its valid range`)
}

export function assertNonNegativeFinite(value, label) {
  invariant(Number.isFinite(value) && value >= 0, `${label} must be non-negative and finite`)
}

export function assertFiniteValues(values, label) {
  for (const value of values) invariant(Number.isFinite(value), `${label} contains a non-finite number`)
}

export function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function validateTerms(terms, wireLimit) {
  for (const [wire, coefficient] of terms) {
    assertWire(wire, wireLimit)
    invariant(Number.isFinite(coefficient), 'weight must be finite')
  }
}

function assertApproximatelyEqual(actual, expected, label) {
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected))
  invariant(Math.abs(actual - expected) <= 1e-9 * scale, `${label} does not match the readable atom program`)
}
