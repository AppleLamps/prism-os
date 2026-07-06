import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {Circuit, emitMaximum} from '../numeric-ui-core.ts'
import {
  emitClampZeroOneGuarded,
  emitMaximumGuarded,
  emitMinimumGuarded,
  emitSelectGuarded,
} from './exp-range-guard.ts'

test('guarded macros are transparent when ranges are provably safe', () => {
  // realistic UI ranges: coordinates in the thousands, scores in 0..1
  const guarded = new Circuit(3)
  guarded.assumeRange(0, 0, 4096)
  guarded.assumeRange(1, 0, 4096)
  guarded.assumeRange(2, 1, 1)
  const guardedMax = emitMaximumGuarded(guarded, 0, 1)
  const guardedMin = emitMinimumGuarded(guarded, 0, 1)
  guarded.tensorProgram = guarded.compileTensorProgram([guardedMax, guardedMin])

  const raw = new Circuit(3)
  raw.assumeRange(0, 0, 4096)
  raw.assumeRange(1, 0, 4096)
  raw.assumeRange(2, 1, 1)
  // the guard is a pure pass-through: it returns the very wire the raw macro
  // would allocate (identical construction shares the wire via hash-consing)
  assert.equal(emitMaximum(raw, 0, 1), guardedMax)

  for (const [a, b] of [[100, 900], [4096, 0], [12, 12], [3000, 3001]] as const) {
    const values = guarded.evaluateTensor(Float32Array.from([a, b, 1]))
    assert.equal(values[guardedMax], Math.max(a, b))
    assert.equal(values[guardedMin], Math.min(a, b))
  }
})

test('guarded max throws on a provably out-of-band operand', () => {
  const circuit = new Circuit(2)
  circuit.assumeRange(0, 0, 1e7) // 1e7 > 2**23
  circuit.assumeRange(1, 0, 10)
  assert.throws(() => emitMaximumGuarded(circuit, 0, 1), /2\*\*23|re-round/)
})

test('guarded clamp throws when its input can exceed 2**24', () => {
  const circuit = new Circuit(2)
  circuit.assumeRange(0, 0, 2e7) // > 2**24
  circuit.assumeRange(1, 1, 1)
  assert.throws(() => emitClampZeroOneGuarded(circuit, 0, 1), /2\*\*24|re-round/)
})

test('guarded macros stay silent when a range is unknown', () => {
  const circuit = new Circuit(2)
  // wire 0 has no assumeRange -> unbounded; policy is silent, not throw
  circuit.assumeRange(1, 0, 10)
  assert.doesNotThrow(() => emitMaximumGuarded(circuit, 0, 1))
})

test('guarded select skips the magnitude check on the off=0 rail', () => {
  const offZero = new Circuit(3)
  offZero.assumeRange(0, 0, 1)    // gate
  offZero.assumeRange(1, 0, 0)    // off = 0, so reconstructing `on` is exact
  offZero.assumeRange(2, 0, 1e30) // on: enormous but harmless on this rail
  assert.doesNotThrow(() => emitSelectGuarded(offZero, 0, 1, 2))

  const offNonzero = new Circuit(3)
  offNonzero.assumeRange(0, 0, 1)
  offNonzero.assumeRange(1, 1, 1)   // off nonzero
  offNonzero.assumeRange(2, 0, 1e9) // on huge -> hazard
  assert.throws(() => emitSelectGuarded(offNonzero, 0, 1, 2), /2\*\*23|re-round/)
})

test('representative UI layout math triggers zero false positives', () => {
  const circuit = new Circuit(5)
  circuit.assumeRange(0, 1, 4096) // viewportWidth
  circuit.assumeRange(1, 1, 4096) // viewportHeight
  circuit.assumeRange(2, 0, 512)  // gap
  circuit.assumeRange(3, 0, 1)    // a score
  circuit.assumeRange(4, 1, 1)    // unit
  let calls = 0
  let falsePositives = 0
  const tryGuard = (build: () => void) => {
    calls++
    try {
      build()
    } catch {
      falsePositives++
    }
  }

  tryGuard(() => emitMinimumGuarded(circuit, 0, 1))         // min(width, height)
  tryGuard(() => emitMaximumGuarded(circuit, 2, 4))         // max(gap, 1)
  tryGuard(() => emitSelectGuarded(circuit, 3, 0, 1))       // blend width/height by a score
  tryGuard(() => emitClampZeroOneGuarded(circuit, 3, 4))    // clamp a score
  tryGuard(() => emitClampZeroOneGuarded(circuit, 2, 4))    // clamp a gap (0..512, safe)

  console.log(`range-guard false positives on UI ranges: ${falsePositives}/${calls}`)
  assert.equal(calls, 5)
  assert.equal(falsePositives, 0)
})
