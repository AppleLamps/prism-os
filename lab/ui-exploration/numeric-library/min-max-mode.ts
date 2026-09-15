// The minimum and maximum used by the IndirectOS copies (window-manager-copy.ts and
// photo-gallery-copy.ts). A build runs inside withMinMaxMode, which picks either the
// drifting macros from numeric-ui-core.ts or the exact ones from comparison.ts.
// Exact forms need finite declared ranges on both operands. Other call sites keep
// the drifting macro, except in the promised mode, which assumes a magnitude bound.
import {type Circuit, type Wire, emitMaximum, emitMinimum, invariant} from '../../../numeric-ui-core.ts'
import {
  compareCost,
  differenceBound,
  emitMaximumExact,
  emitMinimumExact,
  planCompare,
  powerOfTwoAtLeast,
  smallestFloat32,
} from './comparison.ts'

export type MinMaxMode =
  | 'drifting'
  // The cheapest exact comparison the declared range allows: a resolution of
  // 2^-45 times the difference bound, e.g. 2^-30 px for operands in [0, 16384].
  | 'exact-one-stage'
  // Like exact-one-stage, and the copies also declare pointer and click coordinate
  // ranges of [-2^16, 2^16], which evaluation checks like any other source range.
  | 'exact-one-stage-pointer-ranges'
  // Like exact-one-stage-pointer-ranges, and sites with open ranges promise
  // |operand| <= 2^16. Nothing checks the promise; the harnesses count violations.
  | 'exact-one-stage-promised'
  // Resolves every pair of distinct finite FP32 values, with today's declared ranges.
  | 'exact-every-float32'

export const promisedMagnitude = 2 ** 16
export const pointerCoordinateLimit = 2 ** 16

export type MinMaxSites = {
  exact: number
  promised: number
  drifting: number
  fallback: number
  // Unique sites by the layer count of their comparison.
  comparisonLayers: Record<number, number>
  fallbackBounds: string[]
  // Unique fallback sites by the calling line in the copies.
  fallbackOrigins: Record<string, number>
  // Operand wires the promised mode assumed bounded, in the one circuit every
  // promised site ends up in, for checks at evaluation time.
  promisedOperands: Wire[]
  // The calling line in the copies for each promised operand wire.
  promisedOrigins: Record<number, string>
}

type PromisedEntry = {circuit: Circuit, wire: Wire, origin: string}

let currentMode: MinMaxMode = 'drifting'
let sites = createSites()
let seen = new Set<string>()
let promisedEntries: PromisedEntry[] = []

function createSites(): MinMaxSites {
  return {exact: 0, promised: 0, drifting: 0, fallback: 0, comparisonLayers: {}, fallbackBounds: [], fallbackOrigins: {}, promisedOperands: [], promisedOrigins: {}}
}

export function declaresPointerRanges() {
  return currentMode === 'exact-one-stage-pointer-ranges' || currentMode === 'exact-one-stage-promised'
}

// A child circuit built on its own and inlined into a parent: move its promised
// operands onto the parent's wires, using the map inlineCircuit returned.
export function remapPromisedOperands(child: Circuit, parent: Circuit, wireMap: readonly Wire[]) {
  promisedEntries = promisedEntries.map(entry =>
    entry.circuit === child ? {circuit: parent, wire: wireMap[entry.wire]!, origin: entry.origin} : entry)
}

export function withMinMaxMode<T>(mode: MinMaxMode, build: () => T): {result: T, sites: MinMaxSites} {
  const previousMode = currentMode
  const previousSites = sites
  const previousSeen = seen
  const previousEntries = promisedEntries
  currentMode = mode
  sites = createSites()
  seen = new Set()
  promisedEntries = []
  try {
    const result = build()
    const circuits = new Set(promisedEntries.map(entry => entry.circuit))
    invariant(circuits.size <= 1, 'promised operands from a child circuit were never remapped onto the parent')
    for (const entry of promisedEntries) sites.promisedOrigins[entry.wire] ??= entry.origin
    sites.promisedOperands = [...new Set(promisedEntries.map(entry => entry.wire))]
    return {result, sites}
  } finally {
    currentMode = previousMode
    sites = previousSites
    seen = previousSeen
    promisedEntries = previousEntries
  }
}

function callingLine() {
  return new Error().stack?.split('\n').find(line => line.includes('-copy.ts'))?.match(/([\w-]+-copy\.ts:\d+)/)?.[1] ?? 'unknown'
}

function emit(kind: 'minimum' | 'maximum', circuit: Circuit, a: Wire, b: Wire): Wire {
  const drifting = kind === 'minimum' ? emitMinimum : emitMaximum
  const key = `${kind}|${a}|${b}|${circuit.sourceSize}`
  const firstVisit = !seen.has(key)
  seen.add(key)
  if (currentMode === 'drifting') {
    if (firstVisit) sites.drifting++
    return drifting(circuit, a, b)
  }
  const declaredBound = differenceBound(circuit, a, b)
  const promised = !Number.isFinite(declaredBound) && currentMode === 'exact-one-stage-promised'
  if (!Number.isFinite(declaredBound) && !promised) {
    if (firstVisit) {
      sites.fallback++
      const origin = callingLine()
      sites.fallbackOrigins[origin] = (sites.fallbackOrigins[origin] ?? 0) + 1
      sites.fallbackBounds.push(`${kind}: [${circuit.ranges[a]!.minimum}, ${circuit.ranges[a]!.maximum}] against [${circuit.ranges[b]!.minimum}, ${circuit.ranges[b]!.maximum}]`)
    }
    return drifting(circuit, a, b)
  }
  const bound = promised ? 2 * promisedMagnitude : declaredBound
  const resolution = currentMode === 'exact-every-float32' ? smallestFloat32 : 2 ** (powerOfTwoAtLeast(bound) - 45)
  if (firstVisit) {
    if (promised) {
      sites.promised++
      const origin = callingLine()
      promisedEntries.push(
        {circuit, wire: a, origin: `${kind} first operand at ${origin}`},
        {circuit, wire: b, origin: `${kind} second operand at ${origin}`},
      )
    } else {
      sites.exact++
    }
    const layers = compareCost(planCompare(bound, resolution)).layers
    sites.comparisonLayers[layers] = (sites.comparisonLayers[layers] ?? 0) + 1
  }
  const options = promised ? {resolution, operandMagnitude: promisedMagnitude} : {resolution}
  return kind === 'minimum'
    ? emitMinimumExact(circuit, a, b, options)
    : emitMaximumExact(circuit, a, b, options)
}

export const minMax = {
  minimum: (circuit: Circuit, a: Wire, b: Wire) => emit('minimum', circuit, a, b),
  maximum: (circuit: Circuit, a: Wire, b: Wire) => emit('maximum', circuit, a, b),
}
