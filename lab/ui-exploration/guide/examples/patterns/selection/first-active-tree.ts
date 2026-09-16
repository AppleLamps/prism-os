// The first active candidate, in a tree: e.g. the click target under a press, when targets overlap
// and have a fixed priority, like Photos' previous and next controls in front of the thumbnails and
// the main image.
//
// JS, in the shape of chenglou.github.io's index.ts click test (hitTestPresented2DMode), with the
// targets listed in priority order, i.e. the topmost first:
//   for (let target = 0; target < targets.length; target++) {
//     const {left, top, width, height} = targets[target]
//     if (left <= pointerX && pointerX < left + width && top <= pointerY && pointerY < top + height) return target
//   }
//   return -1
//
// The circuit tests every target at once, then picks the first hit, either with a chain that visits
// one candidate after another, or with emitFirstActive's tree, which takes the maximum of neighboring
// candidates up a balanced tree and routes the gate back down to the first candidate that holds a 1.
import {Circuit, emitCompare, emitFirstActive, type Wire, asWire} from '../../../../../../numeric-ui-core.ts'

export type Rectangle = {left: number, top: number, width: number, height: number}

export function firstTargetUnderPointerReference(
  targets: readonly Rectangle[],
  pressed: number,
  pointerX: number,
  pointerY: number,
): number {
  if (pressed === 0) return -1
  for (let target = 0; target < targets.length; target++) {
    const {left, top, width, height} = targets[target]!
    if (left <= pointerX && pointerX < left + width && top <= pointerY && pointerY < top + height) return target
  }
  return -1
}

export type FirstActiveForm = 'tree' | 'chain'

// The loop written as a chain, the way Photos selected its click target until June 9, 2026:
// `remaining` holds the gate until the first active candidate, and 0 after it, so each candidate's
// result depends on a chain through every earlier candidate. Each step is the same combining step as
// the tree's, applied from left to right.
export function emitFirstActiveChain(circuit: Circuit, gate: Wire, candidates: readonly Wire[]): Wire[] {
  let remaining = gate
  return candidates.map(candidate => {
    const selected = circuit.multiply(remaining, candidate)
    remaining = circuit.affine([[remaining, 1], [selected, -1]])
    circuit.assumeRange(remaining, 0, 1)
    return selected
  })
}

function emitFirstActiveForm(circuit: Circuit, gate: Wire, candidates: readonly Wire[], form: FirstActiveForm) {
  return form === 'tree' ? emitFirstActive(circuit, gate, candidates) : emitFirstActiveChain(circuit, gate, candidates)
}

// Only the selection, over hit bits in source cells, for measuring how the two forms grow.
// Source table: [gate, then one hit bit per candidate in priority order].
export function buildFirstActiveSelection(candidateCount: number, form: FirstActiveForm) {
  const circuit = new Circuit(1 + candidateCount)
  const gate = circuit.source(0)
  const hits = Array.from({length: candidateCount}, (_, candidate) => circuit.source(1 + candidate))
  for (let wire = 0; wire < circuit.sourceSize; wire++) circuit.assumeRange(circuit.source(wire), 0, 1)
  const selected = emitFirstActiveForm(circuit, gate, hits, form)
  return {circuit, gate, hits, selected}
}

export const pointerLimit = 16_384
export const rectangleLimit = 8_192

// Source table: [pressed, pointerX, pointerY, then left, top, width and height of each target in
// priority order]. Host contract: pointer coordinates are multiples of 1/64 px within ±16,384 px, and
// rectangle fields are multiples of 1/4 px within 0..8,192 px.
export function buildFirstTargetUnderPointer(targetCount: number, form: FirstActiveForm) {
  const circuit = new Circuit(3 + 4 * targetCount)
  const pressed = circuit.source(0)
  const pointerX = circuit.source(1)
  const pointerY = circuit.source(2)
  circuit.assumeRange(pressed, 0, 1)
  for (const coordinate of [pointerX, pointerY]) {
    circuit.assumeRange(coordinate, -pointerLimit, pointerLimit)
    circuit.assumeGrid(coordinate, 1 / 64)
  }
  const targets = Array.from({length: targetCount}, (_, target) => {
    const firstCell = 3 + 4 * target
    const rectangle = {
      left: circuit.source(firstCell),
      top: circuit.source(firstCell + 1),
      width: circuit.source(firstCell + 2),
      height: circuit.source(firstCell + 3),
    }
    for (const field of [rectangle.left, rectangle.top, rectangle.width, rectangle.height]) {
      circuit.assumeRange(field, 0, rectangleLimit)
      circuit.assumeGrid(field, 1 / 4)
    }
    return rectangle
  })

  // One hit bit per target, all in the same layers: the AND of 4 integer bits on the 1/64 grid,
  // relu(sum of the bits - 3).
  const hits = targets.map(({left, top, width, height}) => {
    const right = circuit.affine([[left, 1], [width, 1]])
    const bottom = circuit.affine([[top, 1], [height, 1]])
    const insideBits = [
      emitCompare(circuit, left, '<=', pointerX),
      emitCompare(circuit, pointerX, '<', right),
      emitCompare(circuit, top, '<=', pointerY),
      emitCompare(circuit, pointerY, '<', bottom),
    ]
    const hit = circuit.reglu([], 1, insideBits.map(bit => [bit, 1] as const), -3)
    circuit.assumeRange(hit, 0, 1)
    return hit
  })

  const selected = emitFirstActiveForm(circuit, pressed, hits, form)
  // Exactly one 1 when the press hits a target, and all zeros otherwise. emitFirstActive declares
  // this group itself only when it can prove that the gate and every candidate are exact bits, and
  // neither a 0..1 source cell nor an AND built with a ReLU counts, so the example declares it. The
  // test checks the declaration with validateOneHotGroups.
  circuit.assumeOneHot(selected, true)
  const pressedTarget = circuit.roundAffine(selected.map((bit, target) => [bit, target] as const))
  const pressedAny = circuit.roundAffine(selected.map(bit => [bit, 1] as const))
  // The pressed target's left edge, e.g. where a drag starts: a masked sum over the one-hot, which the
  // compiler lowers to one gather.
  const pressedLeft = circuit.affine(selected.map((bit, target) => [circuit.multiply(asWire(targets[target]!.left), bit), 1] as const))
  return {circuit, pressed, pointerX, pointerY, targets, hits, selected, pressedTarget, pressedAny, pressedLeft}
}
