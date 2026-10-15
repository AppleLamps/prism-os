import {itemCount, photoNames} from '../handwiredos/photo-gallery.ts'
import {photoFocusSourceField, sourceField, type mountWindowManager} from '../handwiredos/window-manager.ts'
import {button, el} from './dom.ts'
import {type FileEntry, type FileStore, isImage} from './files.ts'

type Manager = ReturnType<typeof mountWindowManager>
export function galleryPage(total: number, selected: number) {
  const page = Math.floor(Math.max(0, selected) / itemCount)
  return {page, count: Math.max(0, Math.min(itemCount, total - page * itemCount)), slot: total === 0 ? -1 : selected % itemCount}
}

export class CabinetGallery {
  private entries: FileEntry[] | null = null
  private page = 0
  private urls: string[] = []
  private token = 0
  private unsubscribe: (() => void) | null = null
  private pending = false
  private before = -1
  private direction = 0
  private toolbar = el('div', 'cabinet-gallery-toolbar')
  private label = el('span')
  private error = el('span')
  private status: (text: string) => void
  constructor(private manager: Manager, report: (text: string) => void) {
    this.status = report
    this.toolbar.dataset['prismLayer'] = ''
    const bundled = button('', 'Bundled gallery', 'Bundled')
    bundled.addEventListener('click', () => { void this.bundled().catch(error => this.status(String(error))) })
    const previous = button('', 'Previous page', '‹'), next = button('', 'Next page', '›')
    previous.addEventListener('click', () => this.pageBy(-1)); next.addEventListener('click', () => this.pageBy(1))
    this.toolbar.append(bundled, previous, this.label, next, this.error)
    document.querySelector('.photos-content')?.append(this.toolbar)
    this.toolbar.hidden = true
    const machine = manager.machine
    machine.observe({
      beforeEvaluate: (table, evaluation) => {
        this.direction = 0
        if (this.entries === null || this.pending) return
        this.before = this.slot()
        if (evaluation.events.some(event => event.kind === 'photo next')) this.direction = 1
        else if (evaluation.events.some(event => event.kind === 'photo previous')) this.direction = -1
        else if (evaluation.events.some(event => event.kind === 'pointer up') && this.before >= 0) {
          const x = table[sourceField.upX]!, y = table[sourceField.upY]!
          for (const [selector, direction] of [['.photos-previous', -1], ['.photos-next', 1]] as const) {
            const rect = document.querySelector(selector)?.getBoundingClientRect()
            if (rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) this.direction = direction
          }
        }
      },
      afterEvaluate: (_values, _table, evaluation) => {
        if (this.entries === null || this.pending || this.direction === 0 || !evaluation.writesBack || this.before < 0) return
        const count = Math.min(itemCount, this.entries.length - this.page * itemCount)
        const crossing = this.direction > 0 ? this.before === count - 1 && this.slot() === 0 : this.before === 0 && this.slot() === count - 1
        if (crossing) {
          const index = this.page * itemCount + this.before
          const next = (index + this.direction + this.entries.length) % this.entries.length
          if (Math.floor(next / itemCount) !== this.page) {
            this.pending = true
            queueMicrotask(() => { void this.load(next).catch(error => this.status(String(error))).finally(() => { this.pending = false }) })
          }
        }
        this.direction = 0
      },
    })
  }
  active() { return this.entries !== null }
  private slot() {
    for (let index = 0; index < itemCount; index++) if (this.manager.machine.source[photoFocusSourceField(index)] === 1) return index
    return -1
  }
  name() { const slot = this.slot(); return this.entries?.[this.page * itemCount + slot]?.name ?? '' }
  private pageBy(direction: number) {
    const total = this.entries?.length ?? 0
    if (total === 0) return
    const pages = Math.ceil(total / itemCount)
    const page = (this.page + direction + pages) % pages
    void this.load(page * itemCount, false).catch(error => this.status(String(error)))
  }
  private store: FileStore | null = null
  async open(entries: FileEntry[], selected: string, store: FileStore) {
    this.unsubscribe?.(); this.store = store; this.entries = entries
    this.toolbar.hidden = false
    await this.load(Math.max(0, entries.findIndex(e => e.id === selected)))
    this.unsubscribe = store.subscribe(() => { void this.refresh().catch(error => this.status(String(error))) })
  }
  private async refresh() {
    const entries = this.entries, store = this.store
    if (entries === null || !store || entries.length === 0) return
    const selected = entries[this.page * itemCount + Math.max(0, this.slot())]
    const next = (await store.list(entries[0]!.parentId)).filter(isImage).sort((a, b) => a.name.localeCompare(b.name))
    if (next.length === entries.length && next.every((entry, index) => entry.id === entries[index]!.id && entry.name === entries[index]!.name && entry.revision === entries[index]!.revision)) return
    this.entries = next
    const index = Math.max(0, next.findIndex(e => e.id === selected?.id))
    await this.load(index, this.slot() >= 0)
  }
  private async load(index: number, focused = true) {
    const entries = this.entries, store = this.store
    if (entries === null || !store) return
    const token = ++this.token, {page, count, slot} = galleryPage(entries.length, index)
    const urls: string[] = [], broken: string[] = []
    const items: {name: string, url: string}[] = []
    try {
      for (const entry of entries.slice(page * itemCount, page * itemCount + count)) {
        const blob = await store.read(entry.id)
        const url = URL.createObjectURL(blob); urls.push(url)
        const image = new Image(); image.src = url
        await image.decode().catch(() => { broken.push(entry.name) })
        items.push({name: entry.name, url})
      }
      if (token !== this.token) { for (const url of urls) URL.revokeObjectURL(url); return }
      const old = this.urls; this.urls = urls; this.page = page
      this.manager.setPhotoItems(items)
      this.manager.machine.photoPage(count, focused ? slot : -1, 36)
      await this.manager.nextFrame()
      for (const url of old) URL.revokeObjectURL(url)
      this.label.textContent = entries.length === 0 ? 'Empty folder' : `${await store.path(entries[0]!.parentId)} · ${page + 1}/${Math.ceil(entries.length / itemCount)}`
      this.error.textContent = broken.length ? `Cannot preview: ${broken.join(', ')}` : ''
    } catch (error) { for (const url of urls) if (!this.urls.includes(url)) URL.revokeObjectURL(url); throw error }
  }
  async show(photo: number | string) {
    if (typeof photo === 'string') {
      const matches = this.entries?.map((entry, index) => ({entry, index})).filter(({entry}) => entry.name.toLocaleLowerCase() === photo.toLocaleLowerCase()) ?? []
      if (matches.length !== 1) throw new Error(matches.length ? 'Choose the image in Cabinet; that name is ambiguous.' : `No image named ${photo} in this folder.`)
      await this.load(matches[0]!.index)
    } else {
      if (this.entries === null || photo >= this.entries.length) throw new Error('No image at that number in this folder.')
      await this.load(photo)
    }
    return `Opened ${this.name()}.`
  }
  async step(direction: number) {
    if (this.entries === null || this.entries.length === 0) return 'This folder has no images.'
    const slot = this.slot()
    const index = slot < 0 ? (direction > 0 ? 0 : this.entries.length - 1) : (this.page * itemCount + slot + direction + this.entries.length) % this.entries.length
    await this.load(index)
    return `Showing ${this.name()}.`
  }
  async close() { this.manager.machine.photoClose(); await this.manager.nextFrame(); return 'Back to the grid.' }
  async bundled() {
    this.token++; this.unsubscribe?.(); this.unsubscribe = null; this.entries = null; this.toolbar.hidden = true
    this.manager.setPhotoItems(null); this.manager.machine.photoPage(photoNames.length)
    await this.manager.nextFrame(); for (const url of this.urls) URL.revokeObjectURL(url); this.urls = []
  }
}
