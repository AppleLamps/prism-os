// Runs the toggle switch circuit and its plain JavaScript version over the scripted trace and compares them every frame.
import {expect, test} from 'bun:test'
import {measure} from './helpers.ts'
import {createToggleSwitchReference} from './toggle-switch-reference.ts'
import {type ToggleFrame, applyEvents, scriptedToggleTrace} from './toggle-switch-trace.ts'
import {type ToggleSwitchOutput, createToggleSwitchMachine, renderToggleSwitch, thumbTravel, validateCells} from './toggle-switch.ts'

function runTrace(frames: readonly ToggleFrame[]) {
  const machine = createToggleSwitchMachine()
  const reference = createToggleSwitchReference()
  return frames.map(frame => {
    applyEvents(machine, frame.events)
    applyEvents(reference, frame.events)
    // The table this frame evaluates, for the reference evaluator check.
    const table = new Float32Array(machine.source)
    table[machine.cells.viewportWidth] = frame.viewportWidth
    table[machine.cells.viewportHeight] = frame.viewportHeight
    table[machine.cells.frameDuration] = frame.frameDuration
    const referenceValues = machine.circuit.evaluateReference(table)
    const circuitOutput = machine.step(frame)
    const expected = reference.render(frame)
    return {
      circuitOutput,
      expected,
      referenceRootValues: machine.roots.map(root => referenceValues[root]!),
      // After step, the source table holds the next-state values, which are the first roots.
      stepRootValues: [...machine.source, ...Object.values(circuitOutput)],
      thumbPosition: machine.source[machine.cells.thumbPosition]!,
      thumbVelocity: machine.source[machine.cells.thumbVelocity]!,
      expectedThumbPosition: reference.st.thumbPosition,
    }
  })
}

test('the whole switch compiles to 129 live operations in 47 layers over 16 source cells', () => {
  const machine = createToggleSwitchMachine()
  expect(machine.specs.length).toBe(16)
  expect(measure(machine.circuit, machine.roots)).toEqual({liveOperations: 129, layers: 47, storedWeights: 227})
  // One hit test, e.g. the hover bit alone, with the track rectangle it reads.
  expect(measure(machine.circuit, [machine.output.hovered])).toEqual({liveOperations: 22, layers: 6, storedWeights: 33})
  // The builder appends 189 operations; compiling keeps 129, since the builder copied the other 60 into their readers.
  expect(machine.circuit.operations.length).toBe(189)
  // nextOn, the switch's next on bit, is 12 layers deep.
  expect(measure(machine.circuit, [machine.output.on]).layers).toBe(12)
  // Wire 16, the first appended operation, is the constant 1: an affine sum with no terms and a bias of 1.
  const firstOperation = machine.circuit.operations[0]!
  expect([firstOperation.kind, firstOperation.leftTerms.length, firstOperation.leftBias]).toEqual(['affine', 0, 1])
})

test('decisions equal the plain JavaScript on every frame, and positions stay within 1e-4 px', () => {
  const {frames} = scriptedToggleTrace()
  const results = runTrace(frames)
  let animatingFrames = 0
  let largestThumbError = 0
  for (const {circuitOutput, expected, thumbPosition, expectedThumbPosition} of results) {
    for (const field of ['on', 'armed', 'clicked', 'hovered', 'trackLeft', 'trackTop', 'thumbTop'] as const) {
      expect([field, circuitOutput[field]]).toEqual([field, expected[field]])
    }
    expect(circuitOutput.animationActive === 0).toBe(expected.animationActive === 0)
    expect(Math.abs(circuitOutput.animationActive - expected.animationActive)).toBeLessThan(1e-3)
    largestThumbError = Math.max(largestThumbError, Math.abs(circuitOutput.thumbLeft - expected.thumbLeft))
    expect(Math.abs(thumbPosition - expectedThumbPosition)).toBeLessThan(1e-6)
    if (circuitOutput.animationActive > 0) animatingFrames++
  }
  expect(results.length).toBe(280)
  expect(animatingFrames).toBe(109)
  expect(largestThumbError).toBeLessThan(1e-4)
})

test('every scripted check does what the trace says', () => {
  const {frames, checks} = scriptedToggleTrace()
  const results = runTrace(frames)
  expect(checks.length).toBe(20)
  expect(frames.reduce((count, frame) => count + frame.events.length, 0)).toBe(25)
  for (const check of checks) {
    const output = results[check.frame]!.circuitOutput
    for (const [field, value] of Object.entries(check.expected)) {
      expect([check.description, field, output[field as keyof ToggleSwitchOutput]]).toEqual([check.description, field, value])
    }
  }
  // 7 checks land while the thumb still moves, including the click that changes the spring's destination.
  const whileMoving = checks.filter(check => results[check.frame - 1]!.circuitOutput.animationActive > 0)
  expect(whileMoving.length).toBe(7)
  expect(whileMoving.some(check => check.description.includes('mid-animation'))).toBe(true)
})

test('the thumb lands exactly on its side 27 frames of 16 ms after the first click from rest', () => {
  const {frames, checks} = scriptedToggleTrace()
  const results = runTrace(frames)
  const firstClick = checks.find(check => check.expected.clicked === 1)!.frame
  expect(results[firstClick - 1]!.circuitOutput.animationActive).toBe(0)
  const settled = results.findIndex((result, index) => index > firstClick && result.circuitOutput.animationActive === 0)
  expect(settled - firstClick).toBe(27)
  const {circuitOutput, thumbPosition, thumbVelocity} = results[settled]!
  expect(thumbPosition).toBe(1)
  expect(Math.abs(thumbVelocity)).toBe(0)
  expect(circuitOutput.fill).toBe(1)
  expect(circuitOutput.thumbLeft).toBe(circuitOutput.trackLeft + 4 + thumbTravel)
})

test('a viewport resize moves the track without disturbing the thumb spring', () => {
  const {frames} = scriptedToggleTrace()
  const resizeStart = frames.findIndex(frame => frame.viewportWidth === 1000)
  const nextEventFrame = frames.findIndex((frame, index) => index > resizeStart && frame.events.length > 0)
  const withoutResize = frames.map((frame, index) =>
    index >= resizeStart && index < nextEventFrame ? {...frame, viewportWidth: 1280, viewportHeight: 800} : frame)
  const resized = runTrace(frames)
  const steady = runTrace(withoutResize)
  expect(resized[resizeStart]!.circuitOutput.trackLeft).toBe(474)
  expect(resized[resizeStart]!.circuitOutput.animationActive).toBeGreaterThan(0)
  for (let index = 0; index < nextEventFrame; index++) {
    expect(resized[index]!.thumbPosition).toBe(steady[index]!.thumbPosition)
    expect(resized[index]!.thumbVelocity).toBe(steady[index]!.thumbVelocity)
  }
})

test('the compiled executor matches the literal reference evaluator bit for bit on every frame', () => {
  const {frames} = scriptedToggleTrace()
  let compared = 0
  for (const {referenceRootValues, stepRootValues} of runTrace(frames)) {
    expect(stepRootValues.length).toBe(referenceRootValues.length)
    stepRootValues.forEach((value, index) => {
      expect(value === referenceRootValues[index]).toBe(true)
      compared++
    })
  }
  // 16 next-state values and 10 outputs per frame.
  expect(compared).toBe(280 * 26)
})

test('a latch keeps only the latest event of its kind, so a down, up, down within one frame loses the click', () => {
  const idleFrame = {viewportWidth: 1280, viewportHeight: 800, frameDuration: 16}
  const inOneFrame = createToggleSwitchMachine()
  const inOneFrameReference = createToggleSwitchReference()
  for (const target of [inOneFrame, inOneFrameReference]) {
    target.pointerDown(640, 400)
    target.pointerUp(640, 400)
    target.pointerDown(700, 400)
  }
  // The second down overwrote the first, so the frame reads a press off the track followed by a release.
  expect(inOneFrame.step(idleFrame).clicked).toBe(0)
  expect(inOneFrameReference.render(idleFrame).clicked).toBe(0)
  // The same events spread over two frames click.
  const overTwoFrames = createToggleSwitchMachine()
  overTwoFrames.pointerDown(640, 400)
  overTwoFrames.pointerUp(640, 400)
  expect(overTwoFrames.step(idleFrame).clicked).toBe(1)
  overTwoFrames.pointerDown(700, 400)
  expect(overTwoFrames.step(idleFrame).armed).toBe(0)
})

test('the executor range check rejects NaN, while validateCells also rejects Infinity in an open range and fractional bits', () => {
  const machine = createToggleSwitchMachine()
  const withNaN = new Float32Array(machine.source)
  withNaN[machine.cells.viewportWidth] = Number.NaN
  expect(() => machine.circuit.evaluateReference(withNaN)).toThrow('outside its assumed range')
  const withInfinity = new Float32Array(machine.source)
  withInfinity[machine.cells.thumbPosition] = Number.POSITIVE_INFINITY
  expect(() => machine.circuit.evaluateReference(withInfinity)).not.toThrow()
  expect(() => validateCells(machine.specs, withInfinity)).toThrow('thumbPosition must be finite')
  const withHalfBit = new Float32Array(machine.source)
  withHalfBit[machine.cells.on] = 0.5
  expect(() => machine.circuit.evaluateReference(withHalfBit)).not.toThrow()
  expect(() => validateCells(machine.specs, withHalfBit)).toThrow('on must be exactly 0 or 1')
})

test('renderToggleSwitch writes the transforms, the fill, the pressed look, aria-checked and the cursor from output numbers', () => {
  const writes: string[] = []
  const element = (name: string) => ({
    style: {
      set transform(value: string) {
        writes.push(`${name}.transform=${value}`)
      },
      get transform() {
        return ''
      },
      setProperty(property: string, value: string) {
        writes.push(`${name}.${property}=${value}`)
      },
    },
    setAttribute(attribute: string, value: string) {
      writes.push(`${name}[${attribute}]=${value}`)
    },
  })
  const cursorTarget = {
    style: {
      set cursor(value: string) {
        writes.push(`body.cursor=${value}`)
      },
      get cursor() {
        return ''
      },
    },
  }
  const output: ToggleSwitchOutput = {
    trackLeft: 614, trackTop: 384, thumbLeft: 628.5, thumbTop: 388, fill: 0.525, on: 1, armed: 1, hovered: 1, clicked: 0, animationActive: 1,
  }
  renderToggleSwitch({track: element('track'), thumb: element('thumb'), cursorTarget}, output)
  expect(writes).toEqual([
    'track.transform=translate3d(614px,384px,0)',
    'track.--fill=0.525',
    'track.--pressed=1',
    'track[aria-checked]=true',
    'thumb.transform=translate3d(628.5px,388px,0)',
    'body.cursor=pointer',
  ])
})
