import {expect, test} from 'bun:test'
import * as rootCandidateGallery from '../../candidate-gallery/candidate-gallery.ts'
import * as candidateGalleryCopy from './candidate-gallery-copy.ts'
import {applyInteraction, interactionFrameTime} from './handwired-os-machine.ts'
import * as windowManagerCopy from './window-manager-copy.ts'

// The folder imports copies of candidate-gallery.ts and window-manager.ts without their mount at import time (see the
// comment at the top of each copy). Headless runs have no `document`, so the original modules can be imported here without
// mounting anything, and the candidate-gallery test checks that its copy still builds the same program as its original
// module, e.g. after someone edits the original module and forgets the copy.

test('candidate-gallery-copy.ts builds the same program and steps to the same values as candidate-gallery.ts', () => {
  expect<unknown>(candidateGalleryCopy.sourceField).toEqual(rootCandidateGallery.sourceField)
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

// Until September 15, 2026, this test compared window-manager-copy.ts with window-manager.ts. The root module then moved
// to host-timed springs, and the copy, with photo-gallery-copy.ts, keeps the program from commit ce37920, which the lab
// folders that measure the original HandwiredOS import. So the test pins that program and the table after the session.
test('window-manager-copy.ts keeps the HandwiredOS program from commit ce37920 and steps to the same table over the scripted session', () => {
  const copy = windowManagerCopy.createWindowManagerMachine()
  const program = copy.tensorProgram
  expect([
    program.valueCount - program.sourceSize,
    program.layers.length,
    program.layers.reduce((sum, layer) => sum + layer.weights.length, 0),
    program.layers.reduce((sum, layer) => sum + layer.gatherReads.length, 0),
  ]).toEqual([5253, 192, 11598, 12])
  for (let frame = 0; frame < 240; frame++) {
    applyInteraction(copy, frame)
    copy.step(1280, 800, interactionFrameTime(frame))
  }
  const tableHash = new Bun.CryptoHasher('sha256')
    .update(new Uint8Array(copy.source.buffer, copy.source.byteOffset, copy.source.byteLength))
    .digest('hex')
  // Recorded at commit ce37920, when the copy built the same program as window-manager.ts.
  expect(tableHash).toBe('0953827a90136c395b05c7dc1e838978dee586a02e75b4cd2cf597105e026915')
})
