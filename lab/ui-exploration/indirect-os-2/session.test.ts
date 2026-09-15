// The scripted session's presses land on the parts it names, and each changes the state it should.
import {expect, test} from 'bun:test'
import {createOracleState, oracleEvaluation} from './oracle.ts'
import {sessionEvents, sessionFrameCount, sessionViewport} from './session.ts'

test('every step of the scripted session takes effect', () => {
  const oracle = createOracleState()
  const checks: Record<string, boolean> = {}
  for (let frame = 0; frame < sessionFrameCount; frame++) {
    oracleEvaluation(oracle, sessionViewport, sessionEvents(frame))
    if (frame === 31) checks['Files dragged over Notes'] = oracle.windows[0]!.left === 354 && oracle.windows[0]!.top === 154 && oracle.order[3] === 0
    if (frame === 60) checks['Notes raised'] = oracle.order[3] === 1
    if (frame === 111) checks['Photos dragged over Notes'] = oracle.windows[3]!.left === 350 && oracle.windows[3]!.top === 290 && oracle.order[3] === 3
    if (frame === 140) checks['Photos maximized'] = oracle.windows[3]!.maximized
    if (frame === 170) checks['photo 5 opened'] = oracle.photoFocus === 5
    if (frame === 200) checks['two ArrowRights'] = oracle.photoFocus === 7
    if (frame === 215) checks['ArrowLeft'] = oracle.photoFocus === 6
    if (frame === 230) checks['Escape closes the lightbox'] = oracle.photoFocus === -1
    if (frame === 250) checks['Photos restored'] = !oracle.windows[3]!.maximized
    if (frame === 280) checks['Photos minimized'] = oracle.windows[3]!.minimized
    if (frame === 331) checks['Notes resized'] = oracle.windows[1]!.width === 600 && oracle.windows[1]!.height === 426
    if (frame === 360) checks['Photos reopened from the dock'] = !oracle.windows[3]!.minimized && oracle.order[3] === 3
  }
  expect(Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)).toEqual([])
  expect(Object.keys(checks).length).toBe(12)
})
