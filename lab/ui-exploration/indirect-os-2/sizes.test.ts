// The compiled size of every step from window-manager.ts to the whole program.
import {expect, test} from 'bun:test'
import {configurations} from './configurations.ts'
import {lineFitEpsilon, loadPretext} from '../text-walker/fake-canvas.ts'
import {fastParagraph} from './fast-walker.ts'
import {buildIndirectOS} from './indirect-os.ts'
import {programSize} from './measure.ts'
import {notesText, testFont} from './paragraph.ts'
import {leafWires} from './table.ts'

const pretext = await loadPretext()
const sets = configurations(fastParagraph(pretext.prepareWithSegments(notesText, testFont)), lineFitEpsilon)
const sizes = new Map<unknown, number[]>()
const sizeOf = (options: Parameters<typeof buildIndirectOS>[0]) => {
  let size = sizes.get(options)
  if (size === undefined) {
    const built = buildIndirectOS(options)
    const {live, layers, weights} = programSize(built.circuit, [...built.nextSource, ...leafWires(built.output)])
    size = [live, layers, weights]
    sizes.set(options, size)
  }
  return size
}

test('live operations, layers and stored weights of each step, from window-manager.ts to the whole program', () => {
  expect(sets.steps.map(step => sizeOf(step.options))).toEqual([
    [5253, 192, 11598],
    [4933, 184, 10958],
    [3580, 137, 8447],
    [3583, 91, 8455],
    [8059, 169, 21611],
    [19854, 343, 49900],
  ])
})

test('changes applied in other orders: the bank saves as much with the queue as with latches, and more with Notes', () => {
  const [queueOriginal, queueBank, notesOriginal] = sets.interference.map(configuration => sizeOf(configuration.options))
  const queueWithBank = sizeOf(sets.steps[4]!.options)
  const notesWithBank = sizeOf(sets.steps[5]!.options)
  expect(queueOriginal![0]! - queueWithBank[0]!).toBe(1350)
  expect(notesOriginal![0]! - notesWithBank[0]!).toBe(4478)
  // With the queue, Photos reading stepped springs no longer removes layers.
  expect(queueBank![1]).toBe(queueWithBank[1])
})
