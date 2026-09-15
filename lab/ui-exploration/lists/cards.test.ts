import {expect, test} from 'bun:test'
import {buildCards, createCardsMachine, type CardsFrameInput} from './cards.ts'
import {createCardsState, renderCards} from './cards-reference.ts'
import {demoCardSizes, runCardsDifferential} from './traces.ts'

test('draggable cards, 5 cards: order, z bands, dragged card, cursor, and animating match the demo on every frame', () => {
  const built = buildCards(demoCardSizes(5))
  for (const seed of [1, 2]) {
    const result = runCardsDifferential(seed, 5, 500, built)
    expect(result.firstDecisionMismatch).toBeUndefined()
    expect(result.animatingMismatchFrames).toBe(0)
    expect(result.maximumPositionError).toBeLessThan(0.05)
    expect(result.reorderFrames).toBeGreaterThan(5)
    expect(result.cardReleases).toBeGreaterThan(5)
  }
})

test('draggable cards, 20 cards: decisions match the demo on every frame', () => {
  const result = runCardsDifferential(3, 20, 400)
  expect(result.firstDecisionMismatch).toBeUndefined()
  expect(result.maximumPositionErrorBeforeAnimatingMismatch).toBeLessThan(0.05)
})

test('draggable cards, incremental layout (O(n) per frame): decisions match the demo on every frame', () => {
  const built = buildCards(demoCardSizes(20), {layout: 'incremental'})
  const result = runCardsDifferential(4, 20, 400, built)
  expect(result.firstDecisionMismatch).toBeUndefined()
  expect(result.maximumPositionErrorBeforeAnimatingMismatch).toBeLessThan(0.05)
  expect(result.reorderFrames).toBeGreaterThan(5)
})

test('draggable cards: declared one-hot groups hold on the reference evaluator on press frames, with the event latches written', () => {
  for (const layout of ['rankCount', 'incremental'] as const) {
    const built = buildCards(demoCardSizes(5), {layout})
    const result = runCardsDifferential(6, 5, 400, built, {validateOneHotGroupsOnPressFrames: true})
    expect(result.firstDecisionMismatch).toBeUndefined()
    expect(result.oneHotValidatedFrames).toBeGreaterThan(10)
  }
})

test('draggable cards: both sides keep the newest 24 pointer samples when frames with an up, a move, and a down grow the buffer', () => {
  const sizes = demoCardSizes(5)
  const built = buildCards(sizes)
  const machine = createCardsMachine(built, 1024)
  const reference = createCardsState(sizes, 1024)
  type Point = [x: number, y: number]
  const script: {up?: Point, move?: Point, down?: Point}[] = [{}, {down: [500, 20]}]
  for (let move = 0; move < 25; move++) script.push({move: [500, 20 + move]})
  // The demo pushes 3 samples and shifts once on each of these frames, and never
  // resets, because each frame ends with the pointer down.
  for (let tap = 0; tap < 6; tap++) script.push({up: [500, 45], move: [500, 45], down: [500, 45]})
  script.push({move: [520, 60]}, {up: [540, 80]})
  let frameTime = 5000
  const lengths: number[] = []
  for (const entry of script) {
    frameTime += 16 + 11 / 16
    const event = (point: Point | undefined, millisecondsBeforeFrame: number) => point === undefined ? null : {pageX: point[0], pageY: point[1], timeStamp: frameTime - millisecondsBeforeFrame}
    const events: CardsFrameInput['events'] = {mouseup: event(entry.up, 3), mousemove: event(entry.move, 2), pointerdown: event(entry.down, 1)}
    reference.events = {...events}
    const expected = renderCards(reference, frameTime, 1024, 24)
    const got = machine.step({frameTime, windowSizeX: 1024, events})
    expect(got.pointerLength).toBe(expected.pointerLength)
    expect(got.dragged).toEqual(expected.dragged)
    expect(got.order).toEqual(expected.order)
    for (let c = 0; c < sizes.length; c++) expect(Math.abs(got.y[c]! - expected.y[c]!)).toBeLessThan(0.05)
    lengths.push(expected.pointerLength)
  }
  expect(Math.max(...lengths)).toBe(24)
})
