import {expect, test} from 'bun:test'
import {itemCount as photoCount} from '../../../photo-gallery.ts'
import {createWindowManagerMachine, photoFocusSourceField, sourceField, windowSourceField, windowStateField} from './window-manager-copy.ts'
import {sameFloat} from './codegen.ts'
import {applyInteraction, createIndirectOSMachine, interactionFrameTime} from './indirect-os-machine.ts'
import {ownerCode, referenceOwnership, regionCode} from './window-ownership.ts'

// The part of IndirectOS under each pointer press of the session, by frame.
const pressTargets = new Map([
  [5, {owner: ownerCode.firstWindow + 0, region: regionCode.titleBar}],
  [60, {owner: ownerCode.firstWindow + 0, region: regionCode.resizeGrip}],
  [100, {owner: ownerCode.firstWindow + 1, region: regionCode.close}],
  [115, {owner: ownerCode.firstDockItem + 1, region: regionCode.content}],
  [130, {owner: ownerCode.firstWindow + 3, region: regionCode.maximize}],
  [210, {owner: ownerCode.firstWindow + 3, region: regionCode.maximize}],
  [225, {owner: ownerCode.firstWindow + 1, region: regionCode.minimize}],
])

function windowCell(source: Float32Array, windowIndex: number, field: keyof typeof windowStateField) {
  return source[windowSourceField(windowIndex, windowStateField[field])]
}

function focusedPhotos(source: Float32Array) {
  return Array.from({length: photoCount}, (_, item) => item).filter(item => source[photoFocusSourceField(item)] === 1).join(',')
}

// The state change each event causes, checked right after that frame's step.
const transitions: [frame: number, description: string, holds: (source: Float32Array) => boolean][] = [
  [31, 'window 0 moved by its title bar', source => windowCell(source, 0, 'left') === 254 && windowCell(source, 0, 'top') === 154],
  [81, 'window 0 resized by its grip', source => windowCell(source, 0, 'width') === 620 && windowCell(source, 0, 'height') === 400],
  [100, 'window 1 closed', source => windowCell(source, 1, 'open') === 0],
  [115, 'window 1 reopened from the dock', source => windowCell(source, 1, 'open') === 1],
  [130, 'Photos maximized', source => windowCell(source, 3, 'maximized') === 1],
  [160, 'photo 5 focused by a click in the grid', source => focusedPhotos(source) === '5'],
  [175, 'Photos moved to photo 6', source => focusedPhotos(source) === '6'],
  [190, 'Photos moved back to photo 5', source => focusedPhotos(source) === '5'],
  [200, 'the focused photo closed', source => focusedPhotos(source) === ''],
  [210, 'Photos restored', source => windowCell(source, 3, 'maximized') === 0],
  [225, 'window 1 minimized', source => windowCell(source, 1, 'minimized') === 1],
]

test('the IndirectOS frame loop with generated JS or the executor tracks the production machine bit for bit over a scripted session', () => {
  const production = createWindowManagerMachine()
  const generated = createIndirectOSMachine({evaluator: 'generated', validate: true, rowsPerFunction: 128})
  const executor = createIndirectOSMachine({evaluator: 'executor', validate: false})
  // The root list repeats some wires, e.g. a window's next-source cell that is also a projected output.
  const roots = [...new Set(production.tensorProgram.roots)]
  expect(production.tensorProgram.roots.length).toBe(429)
  expect(roots.length).toBe(348)
  let comparedCells = 0
  const pressFrames: number[] = []
  const observedTransitions: string[] = []
  for (let frame = 0; frame < 240; frame++) {
    for (const machine of [production, generated, executor]) applyInteraction(machine, frame)
    if (production.source[sourceField.downActive] === 1) {
      pressFrames.push(frame)
      const target = referenceOwnership(production.source, production.source[sourceField.downX]!, production.source[sourceField.downY]!)
      expect({frame, ...target}).toEqual({frame, ...pressTargets.get(frame)!})
    }
    const time = interactionFrameTime(frame)
    const productionValues = production.step(1280, 800, time)
    generated.step(1280, 800, time)
    executor.step(1280, 800, time)
    for (let field = 0; field < production.source.length; field++) {
      if (!sameFloat(production.source[field]!, generated.source[field]!) || !sameFloat(production.source[field]!, executor.source[field]!)) {
        throw new Error(`frame ${frame} source cell ${field}: production ${production.source[field]}, generated ${generated.source[field]}, executor ${executor.source[field]}`)
      }
    }
    for (const root of roots) {
      if (!sameFloat(productionValues[root]!, generated.read(root)) || !sameFloat(productionValues[root]!, executor.read(root))) {
        throw new Error(`frame ${frame} root ${root}: production ${productionValues[root]}, generated ${generated.read(root)}, executor ${executor.read(root)}`)
      }
    }
    for (const [transitionFrame, description, holds] of transitions) {
      if (transitionFrame !== frame) continue
      if (!holds(production.source)) throw new Error(`frame ${frame}: expected ${description}`)
      observedTransitions.push(description)
    }
    comparedCells += production.source.length + roots.length
  }
  expect(pressFrames).toEqual([...pressTargets.keys()])
  expect(observedTransitions).toEqual(transitions.map(([, description]) => description))
  expect(comparedCells).toBe(240 * (201 + 348))
})
