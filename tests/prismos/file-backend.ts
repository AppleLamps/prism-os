import type {FileBackend} from '../../src/prismos/files.ts'

// Transactional test backend: failed changes discard the entire snapshot.
export function memoryFiles(): FileBackend {
  type Snapshot = Awaited<ReturnType<FileBackend['read']>>
  let state: Snapshot = {entries: new Map(), blobs: new Map(), flags: new Map()}
  let queue = Promise.resolve()
  return {
    async read() { return structuredClone(state) },
    write<T>(change: (snapshot: Snapshot) => T) {
      const next = queue.then(() => {
        const copy = structuredClone(state)
        const result = change(copy)
        state = copy
        return result
      })
      queue = next.then(() => {}, () => {})
      return next
    },
    async blob(id) {
      const blob = state.blobs.get(id)
      if (!blob) throw new Error('File content is unavailable.')
      return blob
    },
  }
}
