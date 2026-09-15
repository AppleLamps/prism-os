// How the prototype's executor runs a map stage: generated JavaScript with one loop over items.
//
// This builds a small staged program with lab/ui-exploration/instanced-items' builder: one map stage
// that hit-tests each card against the pointer, and a `firstActive` reduction that picks the first card
// whose bit is 1. createExecutor (instanced-items/executor.ts) turns the map stage into generated JS,
// where the operation that reads no per-card cell (pointerX + scrollX) runs once per evaluation and the
// other operations run inside a loop over cards. generatedCode prints that JS, and the WGSL compute
// shader that instanced-items/gpu-executor.ts would dispatch for the same stage.
import {createExecutor} from '../../../instanced-items/executor.ts'
import {generateColumnInstanceModule} from '../../../instanced-items/columns.ts'
import {planInstances} from '../../../instanced-items/instance.ts'
import {aboveZero, atLeastZero, emitAll} from '../../../instanced-items/kit.ts'
import {StagedProgram} from '../../../instanced-items/staged.ts'
import {emitInstanceWgsl} from '../../../instanced-items/wgsl.ts'

export function buildHitTestProgram(count: number) {
  const program = new StagedProgram()
  const pointerX = program.sharedCell('pointerX', -65536, 65536)
  const scrollX = program.sharedCell('scrollX', -4096, 4096)
  const pointerPresent = program.sharedCell('pointerPresent', 0, 1)
  const cards = program.array('cards', count)
  const left = cards.cell('left', -4096, 4096)
  const width = cards.cell('width', 0, 4096)
  const hit = program.map(cards, 'hit test', {pointerX, scrollX, left, width}, (circuit, input) => {
    // Reads no per-card cell, so the executor computes it once per evaluation, before the loop over cards.
    const localX = circuit.roundAffine([[input.pointerX, 1], [input.scrollX, 1]])
    return {
      bit: emitAll(circuit, [
        atLeastZero(circuit.roundAffine([[localX, 1], [input.left, -1]])),
        aboveZero(circuit.roundAffine([[input.left, 1], [input.width, 1], [localX, -1]])),
      ], {booleanAtom: true}),
    }
  })
  const firstHit = program.firstActive(hit.bit, pointerPresent, 'first card under the pointer')
  program.output({bit: hit.bit, index: firstHit.index, present: firstHit.present})
  return {program, cells: {pointerX, scrollX, pointerPresent, left, width}, hit, firstHit}
}

// The generated JS and WGSL for the map stage, plus how many compiled operations run once per
// evaluation (sharedRows) and once per card (instanceRows).
export function generatedCode() {
  const {program} = buildHitTestProgram(5)
  const step = program.steps[0]
  if (step?.kind !== 'stage') throw new Error('expected the hit test stage first')
  const {stage} = step
  const roots = program.stageRoots(stage)
  const compiled = stage.circuit.compileTensorProgram(roots)
  const perCardSources = stage.sourceValues.flatMap((id, wire) => program.values[id]!.axis === 'shared' ? [] : [wire])
  const plan = planInstances(compiled, perCardSources, roots)
  const js = generateColumnInstanceModule(plan, {rowsPerFunction: 128})
  const wgsl = emitInstanceWgsl(plan, {guard: 'max', workgroupSize: 64})
  return {counts: plan.counts, sharedSource: js.sharedSource, instanceSource: js.instanceSource, wgsl: wgsl.code}
}

export type HitTestInput = {pointerX: number, scrollX: number, pointerPresent: boolean, lefts: Float32Array, widths: Float32Array}

export function createHitTestRunner(count: number) {
  const built = buildHitTestProgram(count)
  const executor = createExecutor(built.program)
  return (input: HitTestInput) => {
    executor.set(built.cells.pointerX, input.pointerX)
    executor.set(built.cells.scrollX, input.scrollX)
    executor.set(built.cells.pointerPresent, input.pointerPresent ? 1 : 0)
    for (let card = 0; card < count; card++) {
      executor.set(built.cells.left, input.lefts[card]!, card)
      executor.set(built.cells.width, input.widths[card]!, card)
    }
    executor.step()
    return {
      bits: Float32Array.from(executor.column(built.hit.bit)),
      index: executor.get(built.firstHit.index),
      present: executor.get(built.firstHit.present),
    }
  }
}

// The plain JavaScript version: a containment test per card, then a loop that stops at the first hit.
export function hitTestReference(input: HitTestInput) {
  const localX = input.pointerX + input.scrollX
  const bits = Array.from(input.lefts, (left, card) => left <= localX && localX < left + input.widths[card]! ? 1 : 0)
  let index = 0
  let present = 0
  if (input.pointerPresent) {
    const first = bits.indexOf(1)
    if (first >= 0) {
      index = first
      present = 1
    }
  }
  return {bits, index, present}
}
