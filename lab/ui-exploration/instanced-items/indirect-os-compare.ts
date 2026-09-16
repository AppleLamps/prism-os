// Runs window-manager.ts's machine and the staged IndirectOS through the same scripted session and
// compares every output and every next source cell, frame by frame. With resync, the staged cells
// are copied from the original before each frame, so every frame compares one evaluation from
// identical state.
import {controlField, photoField, thumbnailSpringField} from '../codegen/photo-gallery-copy.ts'
import {
  createWindowManagerMachine,
  dockOutputField,
  dragSourceField,
  photoFocusSourceField,
  photoSourceField,
  photoThumbnailSpringSourceField,
  resizeSourceField,
  sourceField,
  stackSourceField,
  windowCount,
  windowOutputField,
  windowSourceField,
  windowStateField,
} from '../codegen/window-manager-copy.ts'
import {animationFields, createStagedIndirectOSMachine, photoCount, type StagedIndirectOSMachine} from './indirect-os-staged.ts'
import type {Value} from './staged.ts'

type Driver = {
  pointerDown(x: number, y: number): void
  pointerMove(x: number, y: number): void
  pointerUp(x: number, y: number): void
  photoClick(x: number, y: number): void
  photoNext(): void
  photoPrevious(): void
  photoClose(): void
}

export const sessionFrames = 220
export const sessionFrameTime = (frame: number) => 16 + frame * 16.67 + (frame >= 150 ? 90 : 0)

// At 1280×800 from IndirectOS's initial layout: drag window 0 by its title bar, resize it by its grip,
// close window 1, reopen it from the dock, maximize Photos, open photo 0 from the grid, next twice,
// previous, close the lightbox, restore Photos, minimize window 1, with a 90 ms stall at frame 150.
export function applySession(machine: Driver, frame: number) {
  switch (frame) {
    case 5: machine.pointerDown(120, 70); break
    case 6: machine.pointerMove(180, 120); break
    case 7: machine.pointerUp(180, 120); break
    case 20: machine.pointerDown(622, 432); break
    case 21: machine.pointerMove(700, 480); break
    case 22: machine.pointerUp(700, 480); break
    case 40: machine.pointerDown(891, 126); break
    case 41: machine.pointerUp(891, 126); break
    case 60: machine.pointerDown(609, 762); break
    case 61: machine.pointerUp(609, 762); break
    case 80: machine.pointerDown(1163, 212); break
    case 81: machine.pointerUp(1163, 212); break
    case 100: machine.photoClick(100, 100); break
    case 120: case 130: machine.photoNext(); break
    case 140: machine.photoPrevious(); break
    case 160: machine.photoClose(); break
    case 180: machine.pointerDown(1221, 70); break
    case 181: machine.pointerUp(1221, 70); break
    case 200: machine.pointerDown(835, 126); break
    case 201: machine.pointerUp(835, 126); break
  }
}

const sharedNames = [
  'viewportWidth', 'viewportHeight', 'unit', 'margin', 'titleHeight', 'minWidth', 'minHeight', 'resizeGrip', 'buttonSize', 'buttonGap',
  'dockHeight', 'dockGap', 'dockItemWidth', 'downActive', 'downX', 'downY', 'moveActive', 'moveX', 'moveY', 'upActive', 'upX', 'upY',
  'pointerX', 'pointerY', 'systemBarHeight', 'frameTime', 'previousFrameTime', 'timeInitialized', 'springStiffness', 'springDamping',
  'springMaxFrameDuration', 'springSettleDistance', 'springSettleSpeed', 'springSettleDistanceScale', 'springSettleSpeedScale',
] as const

// The staged cell behind each of window-manager.ts's 201 source cells, and whether the cell holds a decision.
export function cellTable(staged: StagedIndirectOSMachine) {
  const {shared, window, photo} = staged.built
  const table: ({value: Value, instance: number, label: string, decision: boolean} | undefined)[] = Array(sourceField.size)
  const place = (index: number, value: Value, instance: number, label: string, decision: boolean) => {
    if (table[index] !== undefined) throw new Error(`source cell ${index} mapped twice`)
    table[index] = {value, instance, label, decision}
  }
  for (const name of sharedNames) place(sourceField[name], shared[name], 0, `cell ${name}`, ['downActive', 'moveActive', 'upActive', 'timeInitialized'].includes(name))
  place(photoSourceField.gap, shared.photoGap, 0, 'cell photo gap', false)
  place(photoSourceField.mainInset, shared.mainInset, 0, 'cell main inset', false)
  place(photoSourceField.thumbnailHeight, shared.thumbnailHeight, 0, 'cell thumbnail height', false)
  place(photoSourceField.controlSize, shared.controlSize, 0, 'cell control size', false)
  place(photoSourceField.clickActive, shared.clickActive, 0, 'cell click active', true)
  place(photoSourceField.clickX, shared.clickX, 0, 'cell click x', false)
  place(photoSourceField.clickY, shared.clickY, 0, 'cell click y', false)
  place(photoSourceField.previousActive, shared.previousActive, 0, 'cell previous active', true)
  place(photoSourceField.nextActive, shared.nextActive, 0, 'cell next active', true)
  place(photoSourceField.closeActive, shared.closeActive, 0, 'cell close active', true)
  for (let index = 0; index < windowCount; index++) {
    for (const field of ['left', 'top', 'width', 'height'] as const) place(windowSourceField(index, windowStateField[field]), window[field], index, `window ${field}`, false)
    for (const field of ['open', 'minimized', 'maximized', 'present'] as const) place(windowSourceField(index, windowStateField[field]), window[field], index, `window ${field}`, field !== 'present')
    place(dragSourceField(index), window.drag, index, 'window drag', true)
    place(resizeSourceField(index), window.resize, index, 'window resize', true)
    for (let rank = 0; rank < windowCount; rank++) place(stackSourceField(rank, index), window.ranks[rank]!, index, 'window rank bit', true)
    animationFields.forEach((field, lane) => {
      place(sourceField.springStart + index * 10 + lane, window.springs[field].position, index, `window spring ${field} position`, false)
      place(sourceField.springStart + index * 10 + 5 + lane, window.springs[field].velocity, index, `window spring ${field} velocity`, false)
    })
  }
  for (let item = 0; item < photoCount; item++) {
    place(photoFocusSourceField(item), photo.focus, item, 'photo focus', true)
    place(photoThumbnailSpringSourceField(item, thumbnailSpringField.centerX), photo.centerX, item, 'thumbnail spring centerX', false)
    place(photoThumbnailSpringSourceField(item, thumbnailSpringField.centerXVelocity), photo.centerXVelocity, item, 'thumbnail spring centerX velocity', false)
    place(photoThumbnailSpringSourceField(item, thumbnailSpringField.scale), photo.scale, item, 'thumbnail spring scale', false)
    place(photoThumbnailSpringSourceField(item, thumbnailSpringField.scaleVelocity), photo.scaleVelocity, item, 'thumbnail spring scale velocity', false)
  }
  table.forEach((entry, index) => {
    if (entry === undefined) throw new Error(`source cell ${index} has no staged cell`)
  })
  return table as {value: Value, instance: number, label: string, decision: boolean}[]
}

type Original = ReturnType<typeof createWindowManagerMachine>

// Each output of window-manager.ts, paired with the staged value and instance that computes it.
export function outputTable(original: Original, staged: StagedIndirectOSMachine) {
  const {outputs} = staged.built
  const pairs: {label: string, wire: number, value: Value, instance: number, decision: boolean}[] = []
  const windowFields = ['translateX', 'translateY', 'width', 'height', 'scale', 'opacity', 'focused', 'stack', 'maximized', 'contentWidth', 'contentHeight'] as const
  for (let index = 0; index < windowCount; index++) {
    for (const field of windowFields) {
      const value = field === 'maximized' ? outputs.dockFlags.maximized : outputs.windows[field]
      pairs.push({label: `window ${field}`, wire: original.output.windows[index * windowOutputField.size + windowOutputField[field]]!, value, instance: index, decision: ['opacity', 'focused', 'stack', 'maximized'].includes(field)})
    }
    for (const field of ['left', 'top', 'width', 'height', 'inactive', 'focused', 'open'] as const) {
      const value = field === 'inactive' || field === 'focused' || field === 'open' ? outputs.dockFlags[field] : outputs.dock[field]
      pairs.push({label: `dock ${field}`, wire: original.output.dockItems[index * dockOutputField.size + dockOutputField[field]]!, value, instance: value.axis === 'shared' ? 0 : index, decision: ['inactive', 'focused', 'open'].includes(field)})
    }
  }
  pairs.push({label: 'animationActive', wire: original.output.animationActive, value: outputs.animationActive, instance: 0, decision: true})
  pairs.push({label: 'photos backdropOpacity', wire: original.output.photos.backdropOpacity, value: outputs.backdropOpacity, instance: 0, decision: true})
  for (let item = 0; item < photoCount; item++) {
    for (const field of ['left', 'top', 'width', 'height', 'opacity', 'focused'] as const) {
      pairs.push({label: `photo ${field}`, wire: original.output.photos.photos[item * photoField.size + photoField[field]]!, value: outputs.photos[field], instance: item, decision: field === 'focused' || field === 'opacity'})
      pairs.push({label: `thumbnail ${field}`, wire: original.output.photos.thumbnails[item * photoField.size + photoField[field]]!, value: outputs.thumbnails[field], instance: item, decision: field === 'focused'})
    }
  }
  for (const [name, control, wires] of [['previous control', outputs.previousControl, original.output.photos.previousControl], ['next control', outputs.nextControl, original.output.photos.nextControl]] as const) {
    for (const field of ['left', 'top', 'width', 'height', 'opacity'] as const) {
      pairs.push({label: `${name} ${field}`, wire: wires[controlField[field]]!, value: control[field], instance: 0, decision: field === 'opacity'})
    }
  }
  return pairs
}

export type LabelComparison = {compared: number, identical: number, maximumDifference: number, worst: string}

export function runIndirectOSComparison(options: {frames?: number, resync: boolean, rebuildSmallAffines?: boolean}) {
  const frames = options.frames ?? sessionFrames
  const original = createWindowManagerMachine()
  const staged = createStagedIndirectOSMachine({rebuildSmallAffines: options.rebuildSmallAffines})
  const cells = cellTable(staged)
  const pairs = outputTable(original, staged)
  const byLabel = new Map<string, LabelComparison>()
  let compared = 0
  let identical = 0
  let decisionMismatches = 0
  const firstDecisionMismatches: string[] = []
  const record = (label: string, decision: boolean, expected: number, actual: number, context: string) => {
    let entry = byLabel.get(label)
    if (entry === undefined) {
      entry = {compared: 0, identical: 0, maximumDifference: 0, worst: ''}
      byLabel.set(label, entry)
    }
    entry.compared++
    compared++
    if (expected === actual) {
      entry.identical++
      identical++
      return
    }
    const difference = Math.abs(expected - actual)
    if (!(difference <= entry.maximumDifference)) {
      entry.maximumDifference = difference
      entry.worst = `${context}: original ${expected}, staged ${actual}`
    }
    if (decision) {
      decisionMismatches++
      if (firstDecisionMismatches.length < 10) firstDecisionMismatches.push(`${label} ${context}: original ${expected}, staged ${actual}`)
    }
  }
  const states: {frame: number, windowLeft0: number, windowTop0: number, windowWidth0: number, windowHeight0: number, window1Open: number, window1Minimized: number, photosMaximized: number, focusedPhoto: number}[] = []
  for (let frame = 0; frame < frames; frame++) {
    applySession(original, frame)
    if (options.resync) {
      cells.forEach(({value, instance}, index) => staged.executor.set(value, original.source[index]!, instance))
    } else {
      applySession(staged, frame)
    }
    const values = original.step(1280, 800, sessionFrameTime(frame))
    staged.step(1280, 800, sessionFrameTime(frame))
    for (const pair of pairs) record(pair.label, pair.decision, values[pair.wire]!, staged.executor.get(pair.value, pair.instance), `frame ${frame} instance ${pair.instance}`)
    cells.forEach(({value, instance, label, decision}, index) => record(`next ${label}`, decision, original.source[index]!, staged.executor.get(value, instance), `frame ${frame} instance ${instance}`))
    const read = (value: Value, instance: number) => staged.executor.get(value, instance)
    const {window, photo} = staged.built
    let focusedPhoto = -1
    for (let item = 0; item < photoCount; item++) if (read(photo.focus, item) === 1) focusedPhoto = item
    states.push({
      frame,
      windowLeft0: read(window.left, 0), windowTop0: read(window.top, 0), windowWidth0: read(window.width, 0), windowHeight0: read(window.height, 0),
      window1Open: read(window.open, 1), window1Minimized: read(window.minimized, 1), photosMaximized: read(window.maximized, 3), focusedPhoto,
    })
  }
  return {frames, compared, identical, decisionMismatches, firstDecisionMismatches, byLabel, states, original, staged}
}
