import {expect, test} from 'bun:test'
import {ChatDemo, demoScript} from './chat-demo.ts'
import {loadPretext} from './fake-canvas.ts'
import {testFont} from './samples.ts'

const pretext = await loadPretext()
const frameMilliseconds = 1000 / 60

test('the demo streams, stops at the press, reflows at another width, and matches pretext at every state', () => {
  const demo = new ChatDemo(pretext, testFont, 0)
  let now = 0
  const advance = (frames: number) => {
    for (let frame = 0; frame < frames; frame++) {
      now += frameMilliseconds
      demo.frame(now)
    }
  }
  // About half of the first reply, then a press held for 7 frames.
  advance(150)
  const pressTime = now
  demo.pressStop(pressTime)
  advance(7)
  const clickTime = now
  demo.releaseStop(clickTime)
  for (let frame = 0; frame < 600 && demo.animating(); frame++) advance(1)
  const stopped = demo.stats()
  expect({mismatched: stopped.mismatchedStates, firstMismatch: demo.firstMismatch}).toEqual({mismatched: 0, firstMismatch: null})
  expect(stopped.checkedStates).toBeGreaterThan(20)
  expect(stopped.lastStopWrites).toBeGreaterThanOrEqual(1)
  // The reply stops at what had arrived at the press, not at the click, so the segments shown in
  // between fade out.
  expect(stopped.arrived).toBe(demo.session.stateAt(pressTime).arrivedCount)
  expect(stopped.arrived).toBeLessThan(demo.session.stateAt(clickTime).arrivedCount)
  expect(stopped.lastStopFading).toBeGreaterThan(0)
  expect(demo.animating()).toBe(false)
  const settled = demo.projection(demo.frame(now + frameMilliseconds))
  expect(settled.words.length).toBe(stopped.segments)
  // The user's message and the stopped reply; the later turns never arrive.
  expect(settled.bubbles.map(bubble => bubble.opacity)).toEqual([1, 1, 0, 0])
  expect(settled.words.filter(word => word.opacity === 1).length).toBe(stopped.arrived)

  demo.setWidth(260)
  advance(1)
  expect(demo.animating()).toBe(true)
  for (let frame = 0; frame < 600 && demo.animating(); frame++) advance(1)
  expect(demo.stats().mismatchedStates).toBe(0)

  // A fresh conversation with whole-word chunks and words sliding out of the previous word, to the end.
  demo.setChunkMode('word', now)
  demo.setSpawn('from-previous', now)
  for (let frame = 0; frame < 2000 && demo.animating(); frame++) advance(1)
  const finished = demo.stats()
  expect(finished.mismatchedStates).toBe(0)
  expect(finished.arrived).toBe(finished.segments)
  const projection = demo.projection(demo.frame(now + frameMilliseconds))
  expect(projection.bubbles.map(bubble => bubble.opacity)).toEqual(demoScript.map(() => 1))
})
