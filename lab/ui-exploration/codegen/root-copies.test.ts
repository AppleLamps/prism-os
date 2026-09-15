import {expect, test} from 'bun:test'
import * as rootCandidateGallery from '../../../candidate-gallery.ts'
import * as rootWindowManager from '../../../window-manager.ts'
import * as candidateGalleryCopy from './candidate-gallery-copy.ts'
import {applyInteraction, interactionFrameTime} from './indirect-os-machine.ts'
import * as windowManagerCopy from './window-manager-copy.ts'

// The folder imports copies of candidate-gallery.ts and window-manager.ts without their mount at import time (see the
// comment at the top of each copy). Headless runs have no `document`, so the root modules can be imported here without
// mounting anything, and these tests check that each copy still builds the same program as its root module, e.g. after
// someone edits the root module and forgets the copy.

test('candidate-gallery-copy.ts builds the same program and steps to the same values as candidate-gallery.ts', () => {
  expect(candidateGalleryCopy.sourceField).toEqual(rootCandidateGallery.sourceField)
  expect(candidateGalleryCopy.geometryField).toEqual(rootCandidateGallery.geometryField)
  expect(candidateGalleryCopy.layoutNames).toEqual(rootCandidateGallery.layoutNames)
  expect(candidateGalleryCopy.photoCount).toBe(rootCandidateGallery.photoCount)
  const root = rootCandidateGallery.createCandidateGalleryMachine()
  const copy = candidateGalleryCopy.createCandidateGalleryMachine()
  expect(copy.tensorProgram).toEqual(root.tensorProgram)
  expect(copy.output).toEqual(root.output)
  expect(copy.source).toEqual(root.source)
  for (const [viewportWidth, viewportHeight] of [[320, 480], [1280, 800], [2400, 1400]] as const) {
    copy.click(viewportWidth / 2, viewportHeight / 2)
    root.click(viewportWidth / 2, viewportHeight / 2)
    expect(copy.step(viewportWidth, viewportHeight)).toEqual(root.step(viewportWidth, viewportHeight))
    expect(copy.source).toEqual(root.source)
  }
})

test('window-manager-copy.ts builds the same program as window-manager.ts and tracks it over the scripted session', () => {
  expect(windowManagerCopy.sourceField).toEqual(rootWindowManager.sourceField)
  expect(windowManagerCopy.windowStateField).toEqual(rootWindowManager.windowStateField)
  expect(windowManagerCopy.windowOutputField).toEqual(rootWindowManager.windowOutputField)
  expect(windowManagerCopy.dockOutputField).toEqual(rootWindowManager.dockOutputField)
  expect(windowManagerCopy.photoSourceField).toEqual(rootWindowManager.photoSourceField)
  const root = rootWindowManager.createWindowManagerMachine()
  const copy = windowManagerCopy.createWindowManagerMachine()
  expect(copy.tensorProgram).toEqual(root.tensorProgram)
  expect(copy.output).toEqual(root.output)
  expect(copy.source).toEqual(root.source)
  for (let frame = 0; frame < 240; frame++) {
    applyInteraction(root, frame)
    applyInteraction(copy, frame)
    const rootValues = root.step(1280, 800, interactionFrameTime(frame))
    const copyValues = copy.step(1280, 800, interactionFrameTime(frame))
    if (!Buffer.from(copyValues.buffer, copyValues.byteOffset, copyValues.byteLength).equals(Buffer.from(rootValues.buffer, rootValues.byteOffset, rootValues.byteLength))) {
      throw new Error(`frame ${frame}: the copy's values differ from window-manager.ts`)
    }
  }
  expect(copy.source).toEqual(root.source)
})
