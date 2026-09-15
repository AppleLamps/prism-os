// The three runtime operations and the first macros a UI needs, each next to the plain JavaScript it replaces.
// Every example is a whole circuit whose source cells are the inputs, e.g. in trackCenter wire 0 is trackLeft and
// wire 1 is trackWidth. atoms.test.ts evaluates each circuit and its JavaScript on the same inputs, and pins the
// compiled sizes that the guide quotes.
import {Circuit, type Wire, emitMaximum, emitMinimum, emitMultiply, emitRelu, emitSelect} from '../../../../../numeric-ui-core.ts'
import {emitAtLeast, emitClampZeroOne, emitConstant, emitIntegerAtLeast} from './helpers.ts'

export type Example<Inputs extends readonly number[]> = {
  circuit: Circuit
  output: Wire
  // The plain JavaScript version, reading the inputs in source cell order.
  reference: (...inputs: Inputs) => number
}

// An affine sum. JS: trackLeft + trackWidth / 2
export function trackCenter(): Example<[trackLeft: number, trackWidth: number]> {
  const circuit = new Circuit(2)
  const trackLeft = 0
  const trackWidth = 1
  circuit.assumeRange(trackLeft, 0, 16_384)
  circuit.assumeRange(trackWidth, 0, 1024)
  const trackCenterX = circuit.affine([[trackLeft, 1], [trackWidth, 0.5]])
  return {circuit, output: trackCenterX, reference: (left, width) => left + width / 2}
}

// A ReLU, which is a ReLU-gated product whose left side is the constant 1. JS: Math.max(0, contentHeight - viewportHeight)
export function scrollOverflow(): Example<[contentHeight: number, viewportHeight: number]> {
  const circuit = new Circuit(2)
  const contentHeight = 0
  const viewportHeight = 1
  circuit.assumeRange(contentHeight, 0, 1_048_576)
  circuit.assumeRange(viewportHeight, 0, 16_384)
  const overflow = emitRelu(circuit, circuit.affine([[contentHeight, 1], [viewportHeight, -1]]))
  return {circuit, output: overflow, reference: (content, viewport) => Math.max(0, content - viewport)}
}

// A ReLU-gated product used as a mask. JS: hovered ? highlightOpacity : 0
export function hoverOpacity(): Example<[hovered: number, highlightOpacity: number]> {
  const circuit = new Circuit(2)
  const hovered = 0
  const highlightOpacity = 1
  circuit.assumeRange(hovered, 0, 1)
  circuit.assumeRange(highlightOpacity, 0, 1)
  // highlightOpacity is declared nonnegative, so it can sit in the gate: hovered * max(0, highlightOpacity).
  const opacity = emitMultiply(circuit, hovered, highlightOpacity)
  return {circuit, output: opacity, reference: (isHovered, value) => isHovered === 1 ? value : 0}
}

// The exact bit. JS: score >= 0.5 ? 1 : 0, for a score in 0..1
export function roundScore(): Example<[score: number]> {
  const circuit = new Circuit(1)
  const score = 0
  circuit.assumeRange(score, 0, 1)
  return {circuit, output: circuit.boolean(score), reference: value => value >= 0.5 ? 1 : 0}
}

// if/else as a select. JS: isOn ? onColor : offColor
export function thumbColor(): Example<[isOn: number, offColor: number, onColor: number]> {
  const circuit = new Circuit(3)
  const isOn = 0
  const offColor = 1
  const onColor = 2
  circuit.assumeRange(isOn, 0, 1)
  // isOn * onColor + (1 - isOn) * offColor: two masked products and a sum. Both products run whatever isOn is.
  const color = emitSelect(circuit, isOn, offColor, onColor)
  return {circuit, output: color, reference: (on, offValue, onValue) => on === 1 ? onValue : offValue}
}

// JS: Math.min(maxPanelWidth, availableWidth)
export function panelWidth(): Example<[maxPanelWidth: number, availableWidth: number]> {
  const circuit = new Circuit(2)
  const maxPanelWidth = 0
  const availableWidth = 1
  circuit.assumeRange(maxPanelWidth, 0, 16_384)
  circuit.assumeRange(availableWidth, 0, 16_384)
  // maxPanelWidth - relu(maxPanelWidth - availableWidth)
  const width = emitMinimum(circuit, maxPanelWidth, availableWidth)
  return {circuit, output: width, reference: (maxWidth, available) => Math.min(maxWidth, available)}
}

// A clamp between runtime bounds, the way window-manager.ts writes it. JS: Math.min(Math.max(windowLeft, 0), maxLeft)
export function clampWindowLeft(): Example<[windowLeft: number, maxLeft: number]> {
  const circuit = new Circuit(2)
  const windowLeft = 0
  const maxLeft = 1
  circuit.assumeRange(windowLeft, -16_384, 16_384)
  circuit.assumeRange(maxLeft, 0, 16_384)
  const left = emitMinimum(circuit, emitMaximum(circuit, windowLeft, emitConstant(circuit, 0)), maxLeft)
  return {circuit, output: left, reference: (value, high) => Math.min(Math.max(value, 0), high)}
}

// JS: Math.min(1, Math.max(0, thumbPosition))
export function fillAmount(): Example<[thumbPosition: number]> {
  const circuit = new Circuit(1)
  const thumbPosition = 0
  circuit.assumeRange(thumbPosition, -1_048_576, 1_048_576)
  return {circuit, output: emitClampZeroOne(circuit, thumbPosition), reference: value => Math.min(1, Math.max(0, value))}
}

// A decision bit on continuous values. JS: pointerX >= trackLeft ? 1 : 0
export function pointerPastTrackLeft(): Example<[pointerX: number, trackLeft: number]> {
  const circuit = new Circuit(2)
  const pointerX = 0
  const trackLeft = 1
  circuit.assumeRange(pointerX, -16_384, 16_384)
  circuit.assumeRange(trackLeft, 0, 16_384)
  // |pointerX - trackLeft| <= 32,768 = 2^15, so a scale of 64 keeps 64 * |difference| <= 2^21.
  const bit = emitAtLeast(circuit, pointerX, trackLeft, 64)
  return {circuit, output: bit, reference: (x, left) => x >= left ? 1 : 0}
}

// A decision bit on an integer. JS: columnCount >= 3 ? 1 : 0
export function atLeastThreeColumns(): Example<[columnCount: number]> {
  const circuit = new Circuit(1)
  const columnCount = 0
  circuit.assumeRange(columnCount, 0, 64)
  return {circuit, output: emitIntegerAtLeast(circuit, columnCount, 3), reference: count => count >= 3 ? 1 : 0}
}

// A pitfall: both sides of a select compute. JS: isOpen ? scale * scale : 1 returns 1 while isOpen is 0, but the circuit
// still computes scale * scale, which overflows FP32 to Infinity, and 0 * Infinity is NaN.
export function selectAfterOverflow(): Example<[isOpen: number, scale: number]> {
  const circuit = new Circuit(2)
  const isOpen = 0
  const scale = 1
  circuit.assumeRange(isOpen, 0, 1)
  circuit.assumeRange(scale, 0, Math.fround(1e30))
  const squared = emitMultiply(circuit, scale, scale)
  const result = emitSelect(circuit, isOpen, emitConstant(circuit, 1), squared)
  return {circuit, output: result, reference: (open, value) => open === 1 ? Math.fround(value * value) : 1}
}

// Declared ranges determine how a product compiles. JS: velocity * timestep
export function velocityTimesTimestep(declareTimestepNonNegative: boolean): Example<[velocity: number, timestep: number]> {
  const circuit = new Circuit(2)
  const velocity = 0
  const timestep = 1
  circuit.assumeRange(velocity, -1_048_576, 1_048_576)
  if (declareTimestepNonNegative) circuit.assumeRange(timestep, 0, Math.fround(0.008))
  // With the declaration: velocity * max(0, timestep), 1 operation.
  // Without it: velocity * max(0, timestep) - velocity * max(0, -timestep), 3 operations.
  const distance = emitMultiply(circuit, velocity, timestep)
  return {circuit, output: distance, reference: (v, t) => Math.fround(v * t)}
}

// Absolute timestamps in cells, the way window-manager.ts writes requestAnimationFrame times and subtracts them in the
// circuit. JS: frameTime - previousFrameTime. A Float32Array stores each timestamp on FP32's grid, which is 0.5 ms wide
// from 2^22 ms (about 70 minutes after page load), so the duration comes out as a multiple of 0.5 ms.
export function frameDurationFromTimestamps(): Example<[frameTime: number, previousFrameTime: number]> {
  const circuit = new Circuit(2)
  const frameTime = 0
  const previousFrameTime = 1
  circuit.assumeRange(frameTime, 0, Number.POSITIVE_INFINITY)
  circuit.assumeRange(previousFrameTime, 0, Number.POSITIVE_INFINITY)
  const duration = circuit.roundAffine([[frameTime, 1], [previousFrameTime, -1]])
  return {circuit, output: duration, reference: (time, previousTime) => time - previousTime}
}

// Builder behavior. JS: const buttonTop = windowTop + 13; const closeBottom = buttonTop + 18
// A small affine read by an ordinary affine is copied into it, and an identical expression returns the existing wire.
export function buttonTopReadTwice() {
  const circuit = new Circuit(1)
  const windowTop = 0
  circuit.assumeRange(windowTop, 0, 16_384)
  const buttonTop = circuit.affine([[windowTop, 1]], 13)
  const closeBottom = circuit.affine([[buttonTop, 1]], 18)
  const sameButtonTop = circuit.affine([[windowTop, 1]], 13)
  return {circuit, windowTop, buttonTop, closeBottom, sameButtonTop}
}
