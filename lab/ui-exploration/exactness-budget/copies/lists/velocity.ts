// Release velocity from a pointer ring buffer, as in draggable-cards
// (index.ts:186-196) and gesture-flick-snap-target (index.ts:208-219):
//
//   let i = pointer.length - 1
//   while (i > 0 && last.time - pointer[i - 1].time <= 100) i--
//   const dt = last.time - pointer[i].time
//   if (dt > 0) vx = (last.x - pointer[i].x) / dt * 1000
//
// The loop finds the longest run of samples, ending at the newest one, whose
// times are within 100 ms of the newest. As a circuit:
// - inWindow[a] = [sample at age a exists, is a real sample, and is within 100 ms]
// - allWithin[a] = [inWindow[0] + ... + inWindow[a] >= a + 1], an exact count
// - the oldest in-window sample's one-hot is allWithin[a] - allWithin[a + 1]
// - a gather reads its x, y, and time
// - a bounded Newton division computes 1 / dt for dt in 0..128 ms
// Nothing assumes that sample times are sorted.
import {emitMaximum, emitMinimum, type Circuit, type Wire} from '../../../../../numeric-ui-core.ts'
import {constant, emitSymmetricClamp, integerAtLeastOne, integerAtLeastZero} from './common.ts'

export const timeGrid = 64 // event times and frame times are multiples of 1/64 ms
export const velocityWindowMs = 100
// The card and flick ports clamp the release velocity to this many px/s per axis,
// and so do their references. The demos have no clamp. Without one, a release
// shortly after the pointer jumps (e.g. a move sample at the old position and a
// pointerdown far away in the same frame) gives hundreds of thousands of px/s, and
// dt can be as small as 1/64 ms, so no fixed velocity range would hold.
export const releaseVelocityLimit = 2 ** 16

export type SampleWires = {x: Wire, y: Wire, time: Wire, real: Wire}

export function emitReleaseVelocity(
  circuit: Circuit,
  samplesByAge: readonly SampleWires[],
  count: Wire,
  options: {newtonSteps?: number, velocityLimit?: number | undefined} = {},
) {
  const newtonSteps = options.newtonSteps ?? 4
  const newest = samplesByAge[0]!
  const inWindow = samplesByAge.map((sample, age) => {
    const exists = integerAtLeastOne(circuit, [[count, 1]], -age)
    // [100 - (newest.time - sample.time) >= 0], exact on the 1/64 ms grid.
    const recent = integerAtLeastZero(circuit, [[newest.time, -timeGrid], [sample.time, timeGrid]], velocityWindowMs * timeGrid)
    return integerAtLeastOne(circuit, [[exists, 1], [sample.real, 1], [recent, 1]], -2)
  })
  const allWithin = inWindow.map((_, age) => {
    const terms = inWindow.slice(0, age + 1).map(bit => [bit, 1] as [Wire, number])
    return integerAtLeastOne(circuit, terms, -age)
  })
  const oldest = allWithin.map((bit, age) => {
    const next = allWithin[age + 1]
    return circuit.roundAffine(next === undefined ? [[bit, 1]] : [[bit, 1], [next, -1]])
  })
  circuit.assumeOneHot(oldest, true)
  const read = (field: 'x' | 'y' | 'time') => circuit.affine(oldest.map((member, age) => [circuit.multiply(member, samplesByAge[age]![field]), 1]))
  const oldestX = read('x')
  const oldestY = read('y')
  const oldestTime = read('time')
  const found = circuit.affine(oldest.map(member => [member, 1]))
  circuit.assumeRange(found, 0, 1)

  // The velocity is computed on every frame and masked by the caller. On frames
  // without a real newest sample (e.g. right after the buffer reset), the raw
  // difference is far outside 0..100 and Newton's iteration would overflow to
  // Infinity, and 0 * Infinity is NaN even behind a zero gate. Clamping keeps
  // every intermediate finite; for a found sample the clamp is exact and inert.
  const dtRaw = circuit.roundAffine([[newest.time, 1], [oldestTime, -1]])
  const dt = emitMinimum(circuit, emitMaximum(circuit, dtRaw, constant(circuit, 0)), constant(circuit, 128))
  circuit.assumeRange(dt, 0, 128)
  const positive = integerAtLeastOne(circuit, [[integerAtLeastOne(circuit, [[dt, timeGrid]], 0), 1], [found, 1]], -1) // found and dt >= 1/64
  const reciprocal = emitBoundedReciprocal(circuit, dt, newtonSteps)
  const scaledX = circuit.multiply(circuit.roundAffine([[newest.x, 1], [oldestX, -1]]), reciprocal)
  const scaledY = circuit.multiply(circuit.roundAffine([[newest.y, 1], [oldestY, -1]]), reciprocal)
  const unclampedX = circuit.multiply(positive, circuit.roundAffine([[scaledX, 1000]]))
  const unclampedY = circuit.multiply(positive, circuit.roundAffine([[scaledY, 1000]]))
  const limit = options.velocityLimit
  const velocityX = limit === undefined ? unclampedX : emitSymmetricClamp(circuit, unclampedX, limit)
  const velocityY = limit === undefined ? unclampedY : emitSymmetricClamp(circuit, unclampedY, limit)
  return {velocityX, velocityY, oldest, inWindow, dt, positive, reciprocal, oldestX}
}

// 1 / dt for dt on the 1/64 grid in 0..128. One exact threshold bit per octave
// picks a seed within 1/3 relative error; each Newton step x * (2 - dt * x)
// squares the error (4 steps reach the FP32 floor, about 1e-7). dt = 0 gives a
// finite garbage value that the caller masks.
export function emitBoundedReciprocal(circuit: Circuit, dt: Wire, newtonSteps: number, seedForm: 'materialized' | 'composed' = 'materialized'): Wire {
  const lowestExponent = -6
  const highestExponent = 7
  const seedAt = (exponent: number) => 1 / (1.5 * 2 ** exponent)
  const seedTerms: [Wire, number][] = []
  for (let exponent = lowestExponent + 1; exponent < highestExponent; exponent++) {
    const atLeast = integerAtLeastZero(circuit, [[dt, timeGrid]], -timeGrid * 2 ** exponent)
    seedTerms.push([atLeast, seedAt(exponent) - seedAt(exponent - 1)])
  }
  // roundAffine keeps each bit as its own wire. A plain affine would inline both
  // relus of every bit, and with fractional weights on relus as large as
  // 64 * 128 the running sum rounds at magnitudes near 1e5, putting about 0.01
  // of error into a seed of 0.0104.
  let estimate = seedForm === 'materialized'
    ? circuit.roundAffine(seedTerms, seedAt(lowestExponent))
    : circuit.affine(seedTerms, seedAt(lowestExponent))
  circuit.assumeRange(estimate, 0, 64)
  for (let step = 0; step < newtonSteps; step++) {
    const product = circuit.multiply(dt, estimate)
    const correction = circuit.roundAffine([[product, -1]], 2)
    circuit.assumeRange(correction, 0, 2)
    estimate = circuit.multiply(estimate, correction)
    circuit.assumeRange(estimate, 0, 64 * 2 ** (step + 1))
  }
  return estimate
}
