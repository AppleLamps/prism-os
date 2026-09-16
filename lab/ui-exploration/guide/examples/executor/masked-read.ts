// Reading one row's top out of `rowCount` candidates, e.g. the top of the
// selected row, `rowTops[selectedIndex]`.
//
// - Integer index: the selected index is a source cell. The circuit builds a
//   one-hot of it (exactly one bit is 1), multiplies each bit with its row top,
//   and adds the products. That sum is the "masked sum".
// - Stored one-hot: the selection is kept as one bit per row in source cells,
//   the way IndirectOS keeps a photo's focus. The circuit only builds the
//   masked sum.
//
// Each circuit compiles two ways: dense, where the executor runs every product,
// and with gather lowering, where the compiler recognizes the masked sum over a
// declared one-hot group and reads the selected candidate by position instead.
import {Circuit, type Wire, asWire} from '../../../../../numeric-ui-core.ts'

export type ReadCircuit = {circuit: Circuit, selectedTop: Wire}

const maximumRowTop = 16_384

function relu(circuit: Circuit, terms: readonly (readonly [Wire, number])[], bias: number): Wire {
  return circuit.reglu([], 1, terms, bias)
}

// Source layout: selectedIndex in cell 0, rowTops in cells 1..rowCount.
export function buildIntegerIndexRead(rowCount: number): ReadCircuit {
  const circuit = new Circuit(1 + rowCount)
  circuit.assumeRange(circuit.source(0), 0, rowCount - 1)
  for (let row = 0; row < rowCount; row++) circuit.assumeRange(asWire(1 + row), 0, maximumRowTop)
  // For an integer index i, relu(i - p + 1) - 2 relu(i - p) + relu(i - p - 1)
  // is 1 at i = p and 0 at every other integer. Neighboring members share
  // relus, because the builder returns the existing wire for an identical
  // expression.
  const members = Array.from({length: rowCount}, (_, position) => circuit.affine([
    [relu(circuit, [[circuit.source(0), 1]], -position + 1), 1],
    [relu(circuit, [[circuit.source(0), 1]], -position), -2],
    [relu(circuit, [[circuit.source(0), 1]], -position - 1), 1],
  ]))
  circuit.assumeOneHot(members)
  const selectedTop = circuit.affine(members.map((member, row): [Wire, number] =>
    [circuit.multiply(member, asWire(1 + row)), 1]))
  return {circuit, selectedTop}
}

// Source layout: rowTops in cells 0..rowCount-1, selection bits in cells rowCount..2*rowCount-1.
export function buildStoredOneHotRead(rowCount: number): ReadCircuit {
  const circuit = new Circuit(2 * rowCount)
  for (let row = 0; row < rowCount; row++) circuit.assumeRange(asWire(row), 0, maximumRowTop)
  const bits = Array.from({length: rowCount}, (_, row) => circuit.source(rowCount + row))
  // Declares that the host writes a one-hot, like assumeRange. Only the 0..1 ranges are
  // checked on every evaluation; validateOneHotGroups checks the rest in tests.
  circuit.assumeOneHot(bits)
  const selectedTop = circuit.affine(bits.map((bit, row): [Wire, number] =>
    [circuit.multiply(asWire(bit), asWire(row)), 1]))
  return {circuit, selectedTop}
}

export function integerIndexSource(rowTops: Float32Array, selectedIndex: number): Float32Array {
  const source = new Float32Array(1 + rowTops.length)
  source[0] = selectedIndex
  source.set(rowTops, 1)
  return source
}

export function storedOneHotSource(rowTops: Float32Array, selectedIndex: number): Float32Array {
  const source = new Float32Array(2 * rowTops.length)
  source.set(rowTops, 0)
  source[rowTops.length + selectedIndex] = 1
  return source
}
