// Cells for batch/gpu's shaders, and a hash of cells that page.ts and shaders.ts both compute, so the page can check that
// Chrome wrote the same cells as Bun.
import type {BatchCapacity, BatchParagraph} from '../paragraphs.ts'
import {instanceCellCount, writeInstanceCells} from '../programs.ts'

// The shared-width shader's cells of one paragraph: writeInstanceCells's cells without maxWidth, i.e. startCursor, the
// segment widths and the break-after bits.
export const sharedWidthCellCount = (capacity: BatchCapacity) => instanceCellCount(capacity) - 1

export function createSharedWidthWriter(capacity: BatchCapacity) {
  const row = new Float32Array(instanceCellCount(capacity))
  return (target: Float32Array, offset: number, paragraph: BatchParagraph) => {
    writeInstanceCells(row, 0, capacity, paragraph, 0)
    target.set(row.subarray(1), offset)
  }
}

// FNV-1a over the cells' 32-bit words, in the order they are added.
export function createCellsHasher() {
  let hash = 0x811c9dc5
  return {
    add(cells: Float32Array) {
      const words = new Uint32Array(cells.buffer, cells.byteOffset, cells.length)
      for (let index = 0; index < words.length; index++) hash = Math.imul(hash ^ words[index]!, 16_777_619)
    },
    value: () => hash >>> 0,
  }
}
