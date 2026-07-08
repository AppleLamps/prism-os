import {expect, test} from 'bun:test'
import {
  type BehaviorConfig,
  type FrameInput,
  createOracleState,
  oracleTick,
} from './oracle.ts'
import {authoredRelations, createBehaviorConfig, generateTrace, summarizeTrace} from './trace.ts'

function fixedConfig(): BehaviorConfig {
  return {
    viewportWidth: 1280,
    viewportHeight: 800,
    slop: 4,
    titleHeight: 30,
    rectangles: [
      {width: 300, height: 200, initialLeft: 100, initialTop: 100},
      {width: 250, height: 180, initialLeft: 500, initialTop: 300},
      {width: 200, height: 150, initialLeft: 150, initialTop: 120},
      {width: 320, height: 240, initialLeft: 800, initialTop: 400},
    ],
    relations: {...authoredRelations},
  }
}

function run(config: BehaviorConfig, inputs: FrameInput[]) {
  const state = createOracleState(config)
  const outputs = inputs.map(input => oracleTick(config, state, input))
  return {state, outputs, last: outputs.at(-1)!}
}

test('pointer-down on a rectangle focuses it; empty space clears focus', () => {
  const config = fixedConfig()
  const focusOn = run(config, [
    {kind: 'down', x: 150, y: 150},
    {kind: 'up', x: 150, y: 150},
  ])
  expect(focusOn.last.focused).toBe(0)
  const focusOff = run(config, [
    {kind: 'down', x: 150, y: 150},
    {kind: 'up', x: 150, y: 150},
    {kind: 'down', x: 50, y: 700},
    {kind: 'up', x: 50, y: 700},
  ])
  expect(focusOff.last.focused).toBe(-1)
})

test('overlapping rectangles: the lowest index wins', () => {
  const config = fixedConfig()
  // (200, 130) is inside rectangle 0 and rectangle 2; rectangle 0 must win.
  const {last} = run(config, [{kind: 'down', x: 200, y: 130}])
  expect(last.focused).toBe(0)
})

test('hits are strictly inside: the left edge itself misses', () => {
  const config = fixedConfig()
  const onEdge = run(config, [{kind: 'down', x: 100, y: 150}])
  expect(onEdge.last.focused).toBe(-1)
  const insideEdge = run(config, [{kind: 'down', x: 101, y: 150}])
  expect(insideEdge.last.focused).toBe(0)
})

test('the first body click focuses; the second toggles maximized', () => {
  const config = fixedConfig()
  const bodyPoint = {x: 250, y: 250}
  const first = run(config, [
    {kind: 'down', ...bodyPoint},
    {kind: 'up', ...bodyPoint},
  ])
  expect(first.last.maximized).toEqual([false, false, false, false])
  const second = run(config, [
    {kind: 'down', ...bodyPoint},
    {kind: 'up', ...bodyPoint},
    {kind: 'down', ...bodyPoint},
    {kind: 'up', ...bodyPoint},
  ])
  expect(second.last.maximized).toEqual([true, false, false, false])
  expect(second.last.displayed[0]).toEqual({left: 0, top: 0, width: 1280, height: 800})
})

test('a title click never toggles maximized', () => {
  const config = fixedConfig()
  const titlePoint = {x: 250, y: 110}
  const {last} = run(config, [
    {kind: 'down', ...titlePoint},
    {kind: 'up', ...titlePoint},
    {kind: 'down', ...titlePoint},
    {kind: 'up', ...titlePoint},
  ])
  expect(last.maximized).toEqual([false, false, false, false])
})

test('the title region boundary sits exactly at titleHeight pixels below the top', () => {
  const config = fixedConfig()
  const focusFirst: FrameInput[] = [
    {kind: 'down', x: 250, y: 110},
    {kind: 'up', x: 250, y: 110},
  ]
  // y = 129 is the last title row (relative y 29 < 30): a click there must not toggle.
  const stillTitle = run(config, [...focusFirst, {kind: 'down', x: 250, y: 129}, {kind: 'up', x: 250, y: 129}])
  expect(stillTitle.last.maximized[0]).toBe(false)
  // y = 130 is the first body row (relative y 30): the click toggles.
  const firstBodyRow = run(config, [...focusFirst, {kind: 'down', x: 250, y: 130}, {kind: 'up', x: 250, y: 130}])
  expect(firstBodyRow.last.maximized[0]).toBe(true)
})

test('a title drag beyond slop moves the rectangle and commits at release', () => {
  const config = fixedConfig()
  const {outputs, state} = run(config, [
    {kind: 'down', x: 250, y: 110},
    {kind: 'move', x: 250, y: 110},
    {kind: 'move', x: 290, y: 160},
    null,
    {kind: 'up', x: 300, y: 170},
  ])
  // While pressed within slop, nothing moves.
  expect(outputs[1]!.displayed[0]!.left).toBe(100)
  // Beyond slop, the rectangle follows the pointer with the grab offset.
  expect(outputs[2]!.displayed[0]).toEqual({left: 140, top: 150, width: 300, height: 200})
  expect(outputs[2]!.dragOwner).toBe(0)
  // A frame with no event keeps showing the dragged position.
  expect(outputs[3]!.displayed[0]!.left).toBe(140)
  // The release position commits into stored state.
  expect(outputs[4]!.displayed[0]).toEqual({left: 150, top: 160, width: 300, height: 200})
  expect(state.rectangleLeft[0]).toBe(150)
  expect(state.rectangleTop[0]).toBe(160)
  expect(outputs[4]!.dragOwner).toBe(-1)
})

test('movement of exactly slop pixels stays a click; one more pixel cancels it', () => {
  const config = fixedConfig()
  const focusFirst: FrameInput[] = [
    {kind: 'down', x: 250, y: 250},
    {kind: 'up', x: 250, y: 250},
  ]
  const withinSlop = run(config, [
    ...focusFirst,
    {kind: 'down', x: 250, y: 250},
    {kind: 'move', x: 254, y: 246},
    {kind: 'up', x: 250, y: 250},
  ])
  expect(withinSlop.last.maximized[0]).toBe(true)
  const beyondSlop = run(config, [
    ...focusFirst,
    {kind: 'down', x: 250, y: 250},
    {kind: 'move', x: 255, y: 250},
    {kind: 'up', x: 250, y: 250},
  ])
  expect(beyondSlop.last.maximized[0]).toBe(false)
})

test('the up position does not affect the click-versus-drag decision', () => {
  const config = fixedConfig()
  // Focus, then press and release far away without any move event: still a click.
  const {last} = run(config, [
    {kind: 'down', x: 250, y: 250},
    {kind: 'up', x: 250, y: 250},
    {kind: 'down', x: 250, y: 250},
    {kind: 'up', x: 600, y: 600},
  ])
  expect(last.maximized[0]).toBe(true)
})

test('a body drag beyond slop moves nothing but still cancels the click', () => {
  const config = fixedConfig()
  const {last, state} = run(config, [
    {kind: 'down', x: 250, y: 250},
    {kind: 'up', x: 250, y: 250},
    {kind: 'down', x: 250, y: 250},
    {kind: 'move', x: 350, y: 350},
    {kind: 'up', x: 350, y: 350},
  ])
  expect(state.rectangleLeft[0]).toBe(100)
  expect(last.maximized[0]).toBe(false)
})

test('drag ownership persists while the pointer passes over other rectangles', () => {
  const config = fixedConfig()
  const {outputs} = run(config, [
    {kind: 'down', x: 250, y: 110},
    // Far into rectangle 1's area; rectangle 0 still follows.
    {kind: 'move', x: 600, y: 400},
  ])
  expect(outputs[1]!.dragOwner).toBe(0)
  expect(outputs[1]!.displayed[0]!.left).toBe(450)
})

test('dragged positions clamp to the viewport', () => {
  const config = fixedConfig()
  const {outputs} = run(config, [
    {kind: 'down', x: 250, y: 110},
    {kind: 'move', x: -100, y: -100},
  ])
  expect(outputs[1]!.displayed[0]!.left).toBe(0)
  expect(outputs[1]!.displayed[0]!.top).toBe(0)
  const other = run(config, [
    {kind: 'down', x: 250, y: 110},
    {kind: 'move', x: 1400, y: 900},
  ])
  expect(other.outputs[1]!.displayed[0]).toEqual({left: 980, top: 600, width: 300, height: 200})
})

test('a maximized rectangle takes hit priority and cannot be dragged', () => {
  const config = fixedConfig()
  const maximize: FrameInput[] = [
    {kind: 'down', x: 900, y: 500},
    {kind: 'up', x: 900, y: 500},
    {kind: 'down', x: 900, y: 500},
    {kind: 'up', x: 900, y: 500},
  ]
  // Rectangle 3 is now maximized. A press at rectangle 0's old area hits 3.
  const covered = run(config, [...maximize, {kind: 'down', x: 150, y: 150}])
  expect(covered.last.focused).toBe(3)
  // A drag from the maximized title strip moves nothing.
  const dragAttempt = run(config, [
    ...maximize,
    {kind: 'down', x: 640, y: 10},
    {kind: 'move', x: 740, y: 200},
    {kind: 'up', x: 740, y: 200},
  ])
  expect(dragAttempt.last.displayed[3]).toEqual({left: 0, top: 0, width: 1280, height: 800})
  expect(dragAttempt.state.rectangleLeft[3]).toBe(800)
  // A click on the maximized body (well below the title strip) toggles it back,
  // restoring the untouched stored geometry.
  const restore = run(config, [
    ...maximize,
    {kind: 'down', x: 640, y: 400},
    {kind: 'up', x: 640, y: 400},
  ])
  expect(restore.last.maximized[3]).toBe(false)
  expect(restore.last.displayed[3]).toEqual({left: 800, top: 400, width: 320, height: 240})
})

test('hover moves change only the pointer', () => {
  const config = fixedConfig()
  const {last, state} = run(config, [
    {kind: 'move', x: 250, y: 250},
    {kind: 'move', x: 600, y: 400},
  ])
  expect(last.focused).toBe(-1)
  expect(last.pressed).toBe(false)
  expect(state.pointerX).toBe(600)
  expect(state.rectangleLeft).toEqual([100, 500, 150, 800])
})

test('trace statistics over the 12 exactness seeds match the README exactly', () => {
  // The README's per-trace means come from these totals divided by 12.
  const totals = {
    downs: 0,
    moves: 0,
    ups: 0,
    rectanglePresses: 0,
    emptyPresses: 0,
    drags: 0,
    cancelledClicks: 0,
    clicks: 0,
    maximizeToggles: 0,
  }
  for (let seed = 1; seed <= 12; seed++) {
    const config = createBehaviorConfig(seed * 7919 + 13)
    const summary = summarizeTrace(config, generateTrace(config, seed, 10_000))
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
      totals[key] += summary[key]
    }
  }
  expect(totals).toEqual({
    downs: 14_633,
    moves: 46_092,
    ups: 14_624,
    rectanglePresses: 12_424,
    emptyPresses: 2_209,
    drags: 3_429,
    cancelledClicks: 9_957,
    clicks: 3_967,
    maximizeToggles: 795,
  })
}, 30_000)

test('generated traces are legal and exercise every behavior', () => {
  for (const seed of [1, 2, 3]) {
    const config = createBehaviorConfig(seed * 1000 + 7)
    const trace = generateTrace(config, seed, 10_000)
    expect(trace.length).toBe(10_000)
    // Legality: down only while released, up only while pressed, integers only.
    let pressed = false
    for (const input of trace) {
      if (input === null) continue
      expect(Number.isInteger(input.x)).toBe(true)
      expect(Number.isInteger(input.y)).toBe(true)
      if (input.kind === 'down') {
        expect(pressed).toBe(false)
        pressed = true
      } else if (input.kind === 'up') {
        expect(pressed).toBe(true)
        pressed = false
      }
    }
    const summary = summarizeTrace(config, trace)
    expect(summary.downs).toBeGreaterThan(300)
    expect(summary.rectanglePresses).toBeGreaterThan(150)
    expect(summary.emptyPresses).toBeGreaterThan(30)
    expect(summary.drags).toBeGreaterThan(50)
    expect(summary.clicks).toBeGreaterThan(50)
    expect(summary.cancelledClicks).toBeGreaterThan(50)
    expect(summary.maximizeToggles).toBeGreaterThan(10)
  }
})
