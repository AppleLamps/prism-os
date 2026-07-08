import {Circuit, type Wire, emitMultiply} from '../../numeric-ui-core.ts'

// The benchmark circuit from the brief: a photo-library shape with slotCount
// items, readCount stored value fields per item (geometry cells and the like),
// and a one-hot selection over the slots, all in the source table. Each read
// looks up one field of the selected item through a one-hot-masked sum — the
// exact idiom the compiler lowers to a gather.
export function buildLibraryCircuit(slotCount: number, readCount: number) {
  const circuit = new Circuit(slotCount + slotCount * readCount)
  const bits = Array.from({length: slotCount}, (_, slot) => slot)
  circuit.assumeOneHot(bits)
  const valueWire = (field: number, slot: number) => slotCount + field * slotCount + slot
  for (let field = 0; field < readCount; field++) {
    for (let slot = 0; slot < slotCount; slot++) {
      circuit.assumeRange(valueWire(field, slot), 0, 1e6)
    }
  }
  const reads: Wire[] = []
  for (let field = 0; field < readCount; field++) {
    reads.push(circuit.affine(bits.map(slot => [
      emitMultiply(circuit, slot, valueWire(field, slot)),
      1,
    ])))
  }
  return {circuit, reads, valueWire}
}

// A deterministic source table for the library: every field value is distinct
// so a wrong gather index cannot accidentally produce the right answer.
export function fillLibrarySource(
  source: Float32Array,
  slotCount: number,
  readCount: number,
  selectedSlot: number,
) {
  source.fill(0)
  source[selectedSlot] = 1
  for (let field = 0; field < readCount; field++) {
    for (let slot = 0; slot < slotCount; slot++) {
      source[slotCount + field * slotCount + slot] = Math.fround(
        1 + field * 7919 + slot * 13.25,
      )
    }
  }
}
