export const fileLimit = 50 * 1024 * 1024
export const textLimit = 1024 * 1024
export type FileEntry = {
  id: string, parentId: string | null, name: string, kind: 'file' | 'folder',
  mime: string, size: number, created: number, modified: number, revision: number,
  opened: number, trashed: number | null, originalParent: string | null, trashRoot: string | null,
}
type Snapshot = {entries: Map<string, FileEntry>, blobs: Map<string, Blob | null>, flags: Map<string, string>}
export interface FileBackend {
  read(): Promise<Snapshot>
  write<T>(change: (snapshot: Snapshot) => T): Promise<T>
  blob(id: string): Promise<Blob>
}
const request = <T>(operation: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  operation.onsuccess = () => resolve(operation.result)
  operation.onerror = () => reject(operation.error)
})

export async function indexedFiles(factory: IDBFactory): Promise<FileBackend> {
  const opening = factory.open('prism-os.files', 1)
  opening.onupgradeneeded = () => {
    for (const name of ['entries', 'blobs', 'flags']) opening.result.createObjectStore(name)
  }
  opening.onblocked = () => { /* The caller displays the opening state until the old tab closes. */ }
  const db = await request(opening)
  db.onversionchange = () => db.close()
  const transaction = <T>(write: boolean, change: (snapshot: Snapshot) => T): Promise<T> => new Promise((resolve, reject) => {
    const tx = db.transaction(['entries', 'blobs', 'flags'], write ? 'readwrite' : 'readonly')
    let result: T
    tx.oncomplete = () => resolve(result)
    tx.onabort = () => reject(tx.error ?? new Error('File transaction was cancelled.'))
    tx.onerror = () => { /* onabort reports the transaction failure. */ }
    const entries = tx.objectStore('entries').getAll()
    const keys = tx.objectStore('flags').getAllKeys()
    const flags = tx.objectStore('flags').getAll()
    flags.onsuccess = () => {
      try {
        const snapshot: Snapshot = {
          entries: new Map((entries.result as FileEntry[]).map(entry => [entry.id, entry])),
          blobs: new Map(), flags: new Map(keys.result.map((key, index) => [typeof key === 'string' ? key : JSON.stringify(key), String(flags.result[index])])),
        }
        const before = new Set(snapshot.entries.keys())
        result = change(snapshot)
        if (write) {
          for (const id of before) if (!snapshot.entries.has(id)) tx.objectStore('entries').delete(id)
          for (const entry of snapshot.entries.values()) tx.objectStore('entries').put(entry, entry.id)
          for (const [id, blob] of snapshot.blobs) {
            if (blob === null) tx.objectStore('blobs').delete(id)
            else tx.objectStore('blobs').put(blob, id)
          }
          for (const [key, value] of snapshot.flags) tx.objectStore('flags').put(value, key)
        }
      } catch (error) { reject(error); tx.abort() }
    }
  })
  return {
    read: () => transaction(false, snapshot => snapshot),
    write: change => transaction(true, change),
    async blob(id) {
      const blob = await request(db.transaction('blobs').objectStore('blobs').get(id)) as Blob | undefined
      if (!blob) throw new Error('File content is unavailable.')
      return blob
    },
  }
}

export function fileName(name: string): string {
  const normalized = name.trim().normalize('NFC')
  if (normalized === '' || normalized === '.' || normalized === '..' || (/[\\/]/u.test(normalized) || Array.from(normalized).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) throw new Error('Choose a name without slashes or control characters.')
  return normalized
}
export function isImage(entry: FileEntry) { return entry.kind === 'file' && /^(image\/(png|jpeg|webp|gif|avif))$/u.test(entry.mime) }
function inferredType(name: string) {
  const types: Record<string, string> = {png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', txt: 'text/plain', md: 'text/markdown'}
  return types[name.split('.').at(-1)?.toLowerCase() ?? ''] ?? ''
}
export function isText(entry: FileEntry) {
  return entry.kind === 'file' && entry.size <= textLimit && (entry.mime.startsWith('text/') || /\.(txt|md|json|csv|tsv|log|js|ts|css)$/iu.test(entry.name)) && !/\.(html?|svg)$/iu.test(entry.name) && !/html|svg/iu.test(entry.mime)
}
export async function readText(blob: Blob) {
  if (blob.size > textLimit) throw new Error('Text documents must be 1 MiB or smaller.')
  try { return new TextDecoder('utf-8', {fatal: true}).decode(await blob.arrayBuffer()) }
  catch { throw new Error('This file is not valid UTF-8 text. Download it instead.') }
}
function unique(entries: Map<string, FileEntry>, parentId: string | null, name: string, except?: string) {
  const used = (candidate: string) => [...entries.values()].some(e => e.id !== except && e.parentId === parentId && e.trashed === null && e.name.toLocaleLowerCase() === candidate.toLocaleLowerCase())
  let candidate = fileName(name)
  const dot = candidate.lastIndexOf('.')
  const base = dot > 0 ? candidate.slice(0, dot) : candidate
  const extension = dot > 0 ? candidate.slice(dot) : ''
  for (let index = 2; used(candidate); index++) candidate = `${base} (${index})${extension}`
  return candidate
}
function descendants(entries: Map<string, FileEntry>, id: string): FileEntry[] {
  return [...entries.values()].filter(entry => {
    let current: FileEntry | undefined = entry
    while (current) {
      if (current.id === id) return true
      current = current.parentId !== null ? entries.get(current.parentId) : undefined
    }
    return false
  })
}

export class FileStore {
  private listeners = new Set<() => void>()
  constructor(private backend: FileBackend, private broadcast: () => void = () => {}) {}
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  refresh() { for (const listener of this.listeners) listener() }
  private async change<T>(action: (snapshot: Snapshot) => T) {
    let result: T
    try { result = await this.backend.write(action) }
    catch (error) {
      if (error instanceof DOMException && error.name === 'QuotaExceededError') throw new Error('Browser storage is full. Download files or empty Trash, then retry.')
      throw error
    }
    this.refresh(); this.broadcast()
    return result
  }
  async entries() { return [...(await this.backend.read()).entries.values()] }
  async get(id: string) {
    const entry = (await this.backend.read()).entries.get(id)
    if (!entry) throw new Error('This item no longer exists.')
    return entry
  }
  async list(parentId: string | null) { return (await this.entries()).filter(e => e.parentId === parentId && e.trashed === null) }
  async search(query: string) { return (await this.entries()).filter(e => e.trashed === null && e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) }
  async path(id: string | null) {
    const all = new Map((await this.entries()).map(e => [e.id, e]))
    const parts: string[] = []
    while (id !== null) { const entry = all.get(id); if (!entry) break; parts.unshift(entry.name); id = entry.parentId }
    return '/' + parts.join('/')
  }
  async resolve(path: string, from: string | null = null, trash = false): Promise<FileEntry | null> {
    const all = await this.entries()
    let current = path.startsWith('/') ? null : from
    for (const part of path.split('/').filter(Boolean)) {
      if (part === '.') continue
      if (part === '..') { current = all.find(e => e.id === current)?.parentId ?? null; continue }
      const matches = all.filter(e => e.parentId === current && (trash || e.trashed === null) && e.name.toLocaleLowerCase() === part.toLocaleLowerCase())
      if (matches.length !== 1) throw new Error(matches.length ? 'That path is ambiguous. Choose an item in Cabinet.' : `No item at ${path}.`)
      current = matches[0]!.id
    }
    return current !== null ? all.find(e => e.id === current)! : null
  }
  read(id: string) { return this.backend.blob(id) }
  async create(parentId: string | null, name: string, blob?: Blob) {
    if (blob && blob.size > fileLimit) throw new Error('Files must be 50 MiB or smaller.')
    const content = blob?.type === '' ? new Blob([blob], {type: inferredType(name)}) : blob
    return this.change(({entries, blobs}) => {
      this.parent(entries, parentId)
      const now = Date.now()
      const entry: FileEntry = {id: crypto.randomUUID(), parentId, name: unique(entries, parentId, name), kind: content ? 'file' : 'folder', mime: content?.type ?? '', size: content?.size ?? 0, created: now, modified: now, revision: 1, opened: 0, trashed: null, originalParent: null, trashRoot: null}
      entries.set(entry.id, entry)
      if (content) blobs.set(entry.id, content)
      return entry
    })
  }
  async update(id: string, blob: Blob, revision: number) {
    if (blob.size > textLimit) throw new Error('Text documents must be 1 MiB or smaller.')
    return this.change(({entries, blobs}) => {
      const entry = this.live(entries, id)
      if (entry.kind !== 'file' || entry.revision !== revision) throw new Error('This file changed elsewhere. Save As a copy to keep your draft.')
      const updated = {...entry, size: blob.size, mime: blob.type, modified: Date.now(), revision: entry.revision + 1}
      entries.set(id, updated); blobs.set(id, blob)
      return updated
    })
  }
  async opened(id: string) { return this.change(({entries}) => { const entry = this.live(entries, id); entries.set(id, {...entry, opened: Date.now()}) }) }
  async rename(id: string, name: string) {
    return this.change(({entries}) => { const entry = this.live(entries, id); const updated = {...entry, name: unique(entries, entry.parentId, name, id), modified: Date.now()}; entries.set(id, updated); return updated })
  }
  async move(id: string, parentId: string | null) {
    return this.change(({entries}) => {
      const entry = this.live(entries, id); this.parent(entries, parentId)
      if (descendants(entries, id).some(e => e.id === parentId)) throw new Error('A folder cannot be moved inside itself.')
      const updated = {...entry, parentId, name: unique(entries, parentId, entry.name, id), modified: Date.now()}
      entries.set(id, updated); return updated
    })
  }
  async duplicate(id: string) {
    const all = new Map((await this.entries()).map(e => [e.id, e]))
    const original = this.live(all, id)
    const contents = new Map<string, Blob>()
    for (const entry of descendants(all, id)) if (entry.kind === 'file') contents.set(entry.id, await this.read(entry.id))
    return this.change(({entries, blobs}) => {
      const source = this.live(entries, id)
      const copy = (entry: FileEntry, parentId: string | null): FileEntry => {
        const now = Date.now()
        const next = {...entry, id: crypto.randomUUID(), parentId, name: unique(entries, parentId, entry.name), revision: 1, created: now, modified: now, opened: 0}
        entries.set(next.id, next)
        if (entry.kind === 'file') {
          const blob = contents.get(entry.id)
          if (!blob || all.get(entry.id)?.revision !== entry.revision) throw new Error('Files changed while copying. Please retry.')
          blobs.set(next.id, blob)
        }
        for (const child of [...entries.values()].filter(e => e.parentId === entry.id && e.trashed === null)) copy(child, next.id)
        return next
      }
      if (source.parentId !== original.parentId) throw new Error('The item moved while copying. Please retry.')
      return copy(source, source.parentId)
    })
  }
  async trash(id: string) {
    return this.change(({entries}) => {
      const entry = this.live(entries, id), now = Date.now()
      for (const child of descendants(entries, id)) if (child.trashed === null) entries.set(child.id, {...child, trashed: now, originalParent: child.parentId, trashRoot: id})
      entries.set(id, {...entry, trashed: now, originalParent: entry.parentId, trashRoot: id})
    })
  }
  async restore(id: string) {
    return this.change(({entries}) => {
      const entry = entries.get(id)
      if (!entry || entry.trashed === null) throw new Error('Choose an item in Trash.')
      const oldParent = entry.originalParent !== null ? entries.get(entry.originalParent) : undefined
      const parentId = oldParent?.trashed === null ? oldParent.id : null
      const restored = {...entry, parentId, name: unique(entries, parentId, entry.name), trashed: null, originalParent: null, trashRoot: null}
      for (const child of descendants(entries, id)) if (child.trashRoot === entry.trashRoot) entries.set(child.id, {...child, trashed: null, originalParent: null, trashRoot: null})
      entries.set(id, restored); return restored
    })
  }
  async remove(id?: string) {
    return this.change(({entries, blobs}) => {
      if (id !== undefined && entries.get(id)?.trashed == null) throw new Error('Move this item to Trash first.')
      const removing = id !== undefined ? descendants(entries, id) : [...entries.values()].filter(e => e.trashed !== null)
      for (const entry of removing) { entries.delete(entry.id); blobs.set(entry.id, null) }
    })
  }
  async initialize(note: string) {
    if ((await this.backend.read()).flags.get('initialized') !== undefined) return
    return this.change(snapshot => {
      if (snapshot.flags.get('initialized') !== undefined) return
      const now = Date.now()
      const folder = (name: string) => {
        const id = crypto.randomUUID()
        const entry: FileEntry = {id, name, parentId: null, kind: 'folder', mime: '', size: 0, created: now, modified: now, revision: 1, opened: 0, trashed: null, originalParent: null, trashRoot: null}
        snapshot.entries.set(id, entry); return id
      }
      const documents = folder('Documents'); folder('Pictures')
      const blob = new Blob([note], {type: 'text/plain'})
      const id = crypto.randomUUID()
      snapshot.entries.set(id, {id, parentId: documents, name: 'Notes.txt', kind: 'file', mime: blob.type, size: blob.size, created: now, modified: now, revision: 1, opened: 0, trashed: null, originalParent: null, trashRoot: null})
      snapshot.blobs.set(id, blob); snapshot.flags.set('initialized', '1')
      snapshot.flags.set('note', id)
    })
  }
  async initialNote() { return (await this.backend.read()).flags.get('note') }
  private live(entries: Map<string, FileEntry>, id: string) {
    const entry = entries.get(id)
    if (!entry || entry.trashed !== null) throw new Error('This item is no longer in Files.')
    return entry
  }
  private parent(entries: Map<string, FileEntry>, id: string | null) {
    if (id !== null && this.live(entries, id).kind !== 'folder') throw new Error('Choose a folder.')
  }
}
