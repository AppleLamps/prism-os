// What a compiled program is made of, on one small UI job: is the pointer
// inside a window's close button?
//
//   const buttonLeft = windowLeft + windowWidth - buttonInset - buttonSize
//   const buttonTop = windowTop + (titleHeight - buttonSize) / 2
//   const pressed = buttonLeft <= pointerX && pointerX < buttonLeft + buttonSize
//     && buttonTop <= pointerY && pointerY < buttonTop + buttonSize
//
// Coordinates are whole pixels, so every comparison is an integer bit, and the
// AND of four exact bits is relu(bit1 + bit2 + bit3 + bit4 - 3).
//
// The circuit is built two ways:
// - edges copied: buttonLeft and buttonTop are ordinary `affine` sums of fewer
//   than 4 terms, so the builder copies their terms into every operation that
//   reads them, and they never exist as values of their own.
// - edges kept: buttonLeft and buttonTop are built with `roundAffine`, which
//   the builder never copies, so each is its own operation one layer earlier.
//
// `describeProgram` prints each compiled layer: its operations, how many values
// it reads, its matrix rows, and its stored weights.
import {Circuit, type Terms, type Wire, asWire} from '../../../../../src/runtime/numeric-ui-core.ts'

export const buttonSize = 16
export const buttonInset = 6
export const titleHeight = 28

export const cellNames = ['pointerX', 'pointerY', 'windowLeft', 'windowTop', 'windowWidth'] as const
export type HitTestInput = Record<typeof cellNames[number], number>

export type HitTestCircuit = {
  circuit: Circuit
  pressed: Wire
  // An output nothing in the hit test reads, e.g. where a tooltip would go.
  buttonCenterX: Wire
  names: Map<Wire, string>
}

// [terms + bias >= 0] for an integer-valued affine form: relu(v + 1) - relu(v).
function emitAtLeastZero(
  circuit: Circuit,
  names: Map<Wire, string>,
  label: string,
  terms: Terms,
  bias: number,
): Wire {
  const upperRamp = circuit.reglu([], 1, terms, bias + 1)
  const lowerRamp = circuit.reglu([], 1, terms, bias)
  names.set(upperRamp, `${label}.upper`)
  names.set(lowerRamp, `${label}.lower`)
  const bit = circuit.affine([[upperRamp, 1], [lowerRamp, -1]])
  circuit.assumeRange(bit, 0, 1)
  return bit
}

export function buildCloseButtonHitTest(keepButtonEdges: boolean): HitTestCircuit {
  // Source layout: pointerX, pointerY, windowLeft, windowTop, windowWidth.
  const circuit = new Circuit(cellNames.length)
  const pointerX = circuit.source(0)
  const pointerY = circuit.source(1)
  const windowLeft = circuit.source(2)
  const windowTop = circuit.source(3)
  const windowWidth = circuit.source(4)
  for (let wire = 0; wire < cellNames.length; wire++) circuit.assumeRange(circuit.source(wire), 0, 16_384)
  const names = new Map<Wire, string>(cellNames.map((name, wire) => [circuit.source(wire), name]))

  const edgeTerms: [Terms, number][] = [
    [[[windowLeft, 1], [windowWidth, 1]], -buttonInset - buttonSize],
    [[[windowTop, 1]], (titleHeight - buttonSize) / 2],
  ]
  const [buttonLeft, buttonTop] = edgeTerms.map(([terms, bias]) =>
    keepButtonEdges ? circuit.roundAffine(terms, bias) : circuit.affine(terms, bias)) as [Wire, Wire]
  names.set(buttonLeft, 'buttonLeft')
  names.set(buttonTop, 'buttonTop')

  const bits = [
    // pointerX >= buttonLeft
    emitAtLeastZero(circuit, names, 'rightOfLeftEdge', [[pointerX, 1], [buttonLeft, -1]], 0),
    // pointerX < buttonLeft + buttonSize, i.e. buttonLeft + buttonSize - 1 - pointerX >= 0
    emitAtLeastZero(circuit, names, 'leftOfRightEdge', [[buttonLeft, 1], [pointerX, -1]], buttonSize - 1),
    // pointerY >= buttonTop
    emitAtLeastZero(circuit, names, 'belowTopEdge', [[pointerY, 1], [buttonTop, -1]], 0),
    // pointerY < buttonTop + buttonSize
    emitAtLeastZero(circuit, names, 'aboveBottomEdge', [[buttonTop, 1], [pointerY, -1]], buttonSize - 1),
  ]
  const pressed = circuit.reglu([], 1, bits.map((bit): [Wire, number] => [bit, 1]), -(bits.length - 1))
  circuit.assumeRange(pressed, 0, 1)
  names.set(pressed, 'pressed')

  const buttonCenterX = circuit.affine([[buttonLeft, 1]], buttonSize / 2)
  names.set(buttonCenterX, 'buttonCenterX')
  return {circuit, pressed, buttonCenterX, names}
}

export function hitTestSource(input: HitTestInput): Float32Array {
  return Float32Array.from(cellNames, name => input[name])
}

export function hitTestReference(input: HitTestInput): number {
  const buttonLeft = input.windowLeft + input.windowWidth - buttonInset - buttonSize
  const buttonTop = input.windowTop + (titleHeight - buttonSize) / 2
  const pressed = buttonLeft <= input.pointerX && input.pointerX < buttonLeft + buttonSize
    && buttonTop <= input.pointerY && input.pointerY < buttonTop + buttonSize
  return pressed ? 1 : 0
}

function formatTerms(terms: Terms, bias: number, names: ReadonlyMap<Wire, string>): string {
  let text = ''
  for (const [wire, coefficient] of terms) {
    const name = names.get(wire) ?? `value${wire}`
    const scaled = Math.abs(coefficient) === 1 ? name : `${Math.abs(coefficient)} × ${name}`
    text += text === '' ? `${coefficient < 0 ? '-' : ''}${scaled}` : ` ${coefficient < 0 ? '-' : '+'} ${scaled}`
  }
  if (text === '') return `${bias}`
  return bias === 0 ? text : `${text} ${bias < 0 ? '-' : '+'} ${Math.abs(bias)}`
}

function formatOperation(circuit: Circuit, wire: Wire, names: ReadonlyMap<Wire, string>): string {
  const operation = circuit.operations[wire - circuit.sourceSize]!
  const left = formatTerms(operation.leftTerms, operation.leftBias, names)
  if (operation.kind === 'affine') return left
  if (operation.kind === 'boolean') return `boolean(${left})`
  const gate = formatTerms(operation.gateTerms, operation.gateBias, names)
  return operation.leftTerms.length === 0 && operation.leftBias === 1 ? `relu(${gate})` : `(${left}) × relu(${gate})`
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

// One line per layer, then one line per operation in that layer. With
// `showMatrix`, also the layer's sparse matrix in compressed sparse row form.
export function describeProgram(
  circuit: Circuit,
  roots: readonly Wire[],
  names: ReadonlyMap<Wire, string>,
  showMatrix = false,
): string[] {
  const program = circuit.compileTensorProgram(roots)
  const lines: string[] = []
  let availableValues = program.sourceSize
  program.layers.forEach((layer, layerIndex) => {
    lines.push(
      `layer ${layerIndex + 1}: ${plural(layer.outputSize, 'operation')}, reads ${plural(layer.inputSize, 'value')}, `
        + `${plural(layer.bias.length, 'matrix row')} (${plural(layer.outputSize, 'output row')} + `
        + `${plural(layer.gateRows.length, 'gate row')}), ${plural(layer.weights.length, 'stored weight')}`,
    )
    for (let row = 0; row < layer.outputSize; row++) {
      const wire = program.wireOrder[availableValues + row]!
      lines.push(`  ${names.get(asWire(wire)) ?? `value${wire}`} = ${formatOperation(circuit, asWire(wire), names)}`)
    }
    if (showMatrix) {
      lines.push(`  rowOffsets [${[...layer.rowOffsets].join(', ')}]`)
      lines.push(`  columns    [${[...layer.columns].join(', ')}]`)
      lines.push(`  weights    [${[...layer.weights].join(', ')}]`)
      lines.push(`  bias       [${[...layer.bias].join(', ')}]`)
    }
    availableValues += layer.outputSize
  })
  return lines
}
