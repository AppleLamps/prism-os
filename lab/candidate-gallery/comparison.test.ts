import {describe, expect, test} from 'bun:test'
import {asWire} from '../../numeric-ui-core.ts'
import {createCandidateGalleryMachine} from './candidate-gallery.ts'

// The candidate gallery's part of comparison.test.ts, which moved here with the gallery.

describe('rounding points', () => {
  test('existing circuits record exactly their boolean atoms', () => {
    const {circuit} = createCandidateGalleryMachine()
    const points = circuit.roundingPoints()
    const booleanWires = circuit.operations.flatMap((operation, operationIndex) => (operation.kind === 'boolean' ? [asWire(circuit.sourceSize + operationIndex)] : []))
    expect(booleanWires.length).toBe(14)
    expect(points).toEqual(booleanWires.map(wire => ({wire, kind: 'boolean'})))
  })
})
