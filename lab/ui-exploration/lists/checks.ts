// Differential checks shared by the tests and report.ts.
import {validateOneHotGroups} from '../../../numeric-ui-core.ts'
import {SourceLayout, createRandom} from './common.ts'
import {createListRunner, referenceVisibleRows, slotCount, stackLayout, type ListCircuit} from './list.ts'
import {referenceRouting, writeRoutingSource, type RoutingCircuit, type RoutingItem} from './routing.ts'
import {emitReleaseVelocity, type SampleWires} from './velocity.ts'

// ---------- list ----------

export function demoRowHeights(rowCount: number, seed: number, minimumHeight: number, maximumHeight: number) {
  const random = createRandom(seed)
  return Array.from({length: rowCount}, () => minimumHeight + Math.floor(random() * ((maximumHeight - minimumHeight) * 4 + 1)) / 4)
}

export function checkList(list: ListCircuit, heights: readonly number[], trials: number, seed: number) {
  const runner = createListRunner(list)
  const rowCount = heights.length
  const data = Array.from({length: rowCount}, (_, index) => (index * 7919) % 65536)
  if (list.variant.kind === 'variable') runner.setRows(heights)
  if (list.variant.dataRead === 'oneHot') runner.setData(data)
  const tops = stackLayout(heights, 0)
  const total = tops[rowCount - 1]! + heights[rowCount - 1]!
  const random = createRandom(seed)
  const quarter = (value: number) => Math.floor(value * 4) / 4
  let mismatches = 0
  let firstMismatch: string | undefined
  let visibleRows = 0
  for (let trial = 0; trial < trials; trial++) {
    const viewportHeight = trial % 17 === 0 ? list.maximumViewportHeight : quarter(random() * list.maximumViewportHeight)
    const someRow = Math.floor(random() * rowCount)
    const edgeCases = [0, tops[someRow]!, tops[someRow]! - 0.25, tops[someRow]! + 0.25, total - viewportHeight, total, total - 0.25, tops[someRow]! - viewportHeight]
    const scrollTop = Math.max(0, Math.min(total, trial < 64 ? edgeCases[trial % edgeCases.length]! : quarter(random() * total)))
    const frame = runner.run(scrollTop, viewportHeight)
    const expected = referenceVisibleRows(heights, tops, scrollTop, viewportHeight)
    visibleRows += expected.length
    const got = [...frame.rows].sort((left, right) => left.row - right.row)
    let ok = got.length === expected.length && frame.totalHeight === total
    for (let index = 0; ok && index < got.length; index++) {
      const row = expected[index]!.row
      ok = got[index]!.row === row && got[index]!.y === expected[index]!.y && got[index]!.slot === row % slotCount
      if (list.variant.dataRead === 'oneHot') ok &&= got[index]!.data === data[row]
    }
    if (!ok) {
      mismatches++
      firstMismatch ??= JSON.stringify({scrollTop, viewportHeight, got: got.slice(0, 3), expected: expected.slice(0, 3)})
    }
  }
  return {trials, mismatches, firstMismatch, averageVisibleRows: visibleRows / trials}
}

// Every quarter-pixel scrollTop of a uniform list, against the occlusion test from
// scroll-anchor (`y + height > visibleTop && y < visibleBottom`) and the slot rule
// (slot s holds the visible row r with r mod 24 = s). Checking rows alone would
// miss a wrong slot offset: every offset in 0..23 gives the same set of rows.
export function sweepUniformList(list: ListCircuit, rowHeight: number, viewportHeight: number) {
  const runner = createListRunner(list)
  const rowCount = list.variant.rowCount
  const total = rowCount * rowHeight
  let mismatches = 0
  let firstMismatch: string | undefined
  for (let quarterPixels = 0; quarterPixels <= total * 4; quarterPixels++) {
    const scrollTop = quarterPixels / 4
    const frame = runner.run(scrollTop, viewportHeight)
    // The occlusion test over the rows near the viewport; a viewport of at most
    // (slotCount - 1) rows can't reach further.
    const near = Math.floor(scrollTop / rowHeight)
    const expectedRows: number[] = []
    for (let row = Math.max(0, near - 2); row < Math.min(rowCount, near + slotCount + 2); row++) {
      const y = row * rowHeight
      if (y + rowHeight > scrollTop && y < scrollTop + viewportHeight) expectedRows.push(row)
    }
    const got = [...frame.rows].sort((left, right) => left.row - right.row)
    let ok = got.length === expectedRows.length
    for (let index = 0; ok && index < got.length; index++) {
      const row = expectedRows[index]!
      ok = got[index]!.row === row && got[index]!.y === row * rowHeight && got[index]!.slot === row % slotCount
    }
    if (!ok) {
      mismatches++
      firstMismatch ??= JSON.stringify({scrollTop, got: got.slice(0, 3), expected: expectedRows.slice(0, 3)})
    }
  }
  return {scrollTops: total * 4 + 1, mismatches, firstMismatch}
}

// ---------- routing ----------

export type RoutingPattern = {label: string, items: RoutingItem[], lower: number, upper: number, pointerX: number}

export function routingPatterns(itemCount: number, slotCount: number, randomCount: number, seed: number): RoutingPattern[] {
  const random = createRandom(seed)
  const payload = () => ({left: Math.floor(random() * 4000), width: 1 + Math.floor(random() * 400)})
  // Visible items get value 150 with lower 100 and upper 200; hidden items sit on either side.
  const withVisibility = (label: string, visible: (index: number) => boolean): RoutingPattern => ({
    label,
    items: Array.from({length: itemCount}, (_, index) => ({value: visible(index) ? 150 : random() < 0.5 ? 99 : 200, ...payload()})),
    lower: 100,
    upper: 200,
    pointerX: Math.floor(random() * 4400),
  })
  const patterns: RoutingPattern[] = [
    withVisibility('none visible', () => false),
    withVisibility('all visible', () => true),
    withVisibility('exactly slotCount visible', index => index % Math.floor(itemCount / slotCount) === 0 && index / Math.floor(itemCount / slotCount) < slotCount),
    withVisibility('slotCount - 1 visible', index => index < slotCount - 1),
    withVisibility('slotCount + 1 visible, at the end', index => index >= itemCount - slotCount - 1),
    withVisibility('only the last item', index => index === itemCount - 1),
    withVisibility('only the first item', index => index === 0),
    withVisibility('alternating', index => index % 2 === 1),
  ]
  for (let trial = 0; trial < randomCount; trial++) {
    const density = [0.001, 0.005, 0.02, 0.1, 0.5][trial % 5]!
    patterns.push({
      label: `random density ${density}`,
      items: Array.from({length: itemCount}, () => ({value: Math.floor(random() * 1024), ...payload()})),
      lower: 0,
      upper: Math.max(1, Math.round(density * 1024)),
      pointerX: Math.floor(random() * 4400),
    })
  }
  return patterns
}

export function checkRouting(routing: RoutingCircuit, patterns: readonly RoutingPattern[], validateGroupsFor = 0) {
  const run = routing.circuit.createTensorEvaluator(routing.roots)
  const source = new Float32Array(routing.circuit.sourceSize)
  const {slotCount} = routing.options
  let mismatches = 0
  let firstMismatch: string | undefined
  patterns.forEach((pattern, patternIndex) => {
    writeRoutingSource(routing, source, pattern.items, pattern.lower, pattern.upper, pattern.pointerX)
    const outputs = run(source)
    const expected = referenceRouting(pattern.items, pattern.lower, pattern.upper, slotCount, pattern.pointerX)
    let ok = true
    for (let slot = 0; ok && slot < slotCount; slot++) {
      const base = slot * 6
      const entry = expected[slot]
      ok = entry === undefined
        ? outputs[base + 1] === 0 && outputs[base + 5] === 0
        : outputs[base] === entry.index && outputs[base + 1] === 1 && outputs[base + 2] === entry.item.value
          && outputs[base + 3] === entry.item.left && outputs[base + 4] === entry.item.width && outputs[base + 5] === Number(entry.hover)
    }
    if (!ok) {
      mismatches++
      firstMismatch ??= pattern.label
    }
    if (patternIndex < validateGroupsFor) validateOneHotGroups(routing.circuit, routing.circuit.evaluateReference(source))
  })
  return {patterns: patterns.length, mismatches, firstMismatch}
}

// ---------- release velocity ----------

// With velocityLimit, both the circuit and the loop clamp the velocity to
// ±velocityLimit px/s per axis.
export function checkReleaseVelocity(trials: number, seed: number, velocityLimit?: number) {
  const capacity = 24
  const layout = new SourceLayout()
  const count = layout.cell(1, capacity)
  const samples: SampleWires[] = Array.from({length: capacity}, () => ({x: layout.cell(-32768, 32768), y: layout.cell(-32768, 32768), time: layout.cell(-65536, 1024), real: layout.cell(0, 1)}))
  const circuit = layout.createCircuit()
  const result = emitReleaseVelocity(circuit, samples, count, {velocityLimit})
  const run = circuit.createTensorEvaluator([result.velocityX, result.velocityY])
  const random = createRandom(seed)
  let worstRelativeError = 0
  let failures = 0
  let checked = 0
  let clampedTrials = 0
  for (let trial = 0; trial < trials; trial++) {
    const length = 1 + Math.floor(random() * capacity)
    const pointer: {x: number, y: number, time: number, real: boolean}[] = []
    let time = -Math.floor(random() * 64 * 3000) / 64
    for (let index = 0; index < length; index++) {
      // mostly increasing times, with occasional out-of-order samples
      time += Math.floor(random() * 64 * (random() < 0.2 ? 60 : 20)) / 64 - (random() < 0.05 ? 5 : 0)
      pointer.push({x: Math.round(random() * 2000) / 2, y: Math.round(random() * 2000) / 2, time: Math.min(0, time), real: !(index === 0 && random() < 0.3)})
    }
    const last = pointer[length - 1]!
    if (!last.real) continue
    checked++
    const source = new Float32Array(circuit.sourceSize)
    source[count] = length
    for (let age = 0; age < length; age++) {
      const sample = pointer[length - 1 - age]!
      source[samples[age]!.x] = sample.x
      source[samples[age]!.y] = sample.y
      source[samples[age]!.time] = sample.real ? sample.time : -65536
      source[samples[age]!.real] = sample.real ? 1 : 0
    }
    // draggable-cards index.ts:188-196; the reset sample (page time 0) never passes the window test
    let i = length - 1
    while (i > 0 && pointer[i - 1]!.real && last.time - pointer[i - 1]!.time <= 100) i--
    const deltaTime = last.time - pointer[i]!.time
    let vx = 0
    let vy = 0
    if (deltaTime > 0) {
      vx = (last.x - pointer[i]!.x) / deltaTime * 1000
      vy = (last.y - pointer[i]!.y) / deltaTime * 1000
    }
    if (velocityLimit !== undefined && (Math.abs(vx) > velocityLimit || Math.abs(vy) > velocityLimit)) {
      clampedTrials++
      vx = Math.max(-velocityLimit, Math.min(velocityLimit, vx))
      vy = Math.max(-velocityLimit, Math.min(velocityLimit, vy))
    }
    const outputs = run(source)
    const relative = Math.max(Math.abs(outputs[0]! - vx), Math.abs(outputs[1]! - vy)) / Math.max(1, Math.abs(vx), Math.abs(vy))
    worstRelativeError = Math.max(worstRelativeError, relative)
    if (relative > 1e-6) failures++
  }
  return {checked, failures, worstRelativeError, clampedTrials}
}
