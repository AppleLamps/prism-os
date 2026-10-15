import {type FileEntry, FileStore, readText, textLimit} from './files.ts'

export class DocumentController {
  entry: FileEntry | null = null
  text = ''
  status = 'Saved'
  dirty = false
  private version = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private saving: Promise<void> | null = null
  constructor(private store: FileStore, private changed: () => void = () => {}) {}
  edit(text: string) {
    this.text = text; this.dirty = true; this.version++; this.status = 'Saving…'
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.flush().catch(() => {}) }, 500)
    this.changed()
  }
  private hasChanges() { return this.dirty }
  async flush(): Promise<void> {
    clearTimeout(this.timer)
    if (this.saving) { await this.saving; if (this.hasChanges()) return this.flush(); return }
    if (!this.dirty || !this.entry) return
    const version = this.version, entry = this.entry, text = this.text
    this.status = 'Saving…'; this.changed()
    this.saving = this.store.update(entry.id, new Blob([text], {type: entry.mime !== '' ? entry.mime : 'text/plain'}), entry.revision).then(updated => {
      this.entry = updated
      if (this.version === version) this.dirty = false
      this.status = this.dirty ? 'Saving…' : 'Saved'
    }).catch(error => {
      this.status = `Save failed: ${error instanceof Error ? error.message : String(error)}`
      throw error
    }).finally(() => { this.saving = null; this.changed() })
    await this.saving
    if (this.hasChanges()) await this.flush()
  }
  async open(entry: FileEntry) {
    await this.flush()
    const version = this.version
    const before = await this.store.get(entry.id)
    const text = await readText(await this.store.read(entry.id))
    const after = await this.store.get(entry.id)
    if (before.revision !== after.revision || after.trashed !== null) throw new Error('The file changed while opening. Please retry.')
    if (this.version !== version) throw new Error('Your draft changed while opening. Please try again.')
    this.entry = after; this.text = text; this.dirty = false; this.status = 'Saved'; this.changed()
    // Updating Recent is optional; a metadata write failure must not prevent reading.
    await this.store.opened(entry.id).catch(() => {})
  }
  async saveAs(parentId: string | null, name: string) {
    clearTimeout(this.timer)
    if (new Blob([this.text]).size > textLimit) throw new Error('Text documents must be 1 MiB or smaller.')
    if (this.saving) await this.saving.catch(() => {})
    const version = this.version
    const entry = await this.store.create(parentId, name, new Blob([this.text], {type: 'text/plain'}))
    this.entry = entry; this.dirty = this.version !== version; this.status = this.dirty ? 'Saving…' : 'Saved'; this.changed()
    if (this.hasChanges()) await this.flush()
    return entry
  }
  discard() { clearTimeout(this.timer); this.dirty = false; this.status = 'Saved'; this.changed() }
}
