import type {PanelApp} from './apps.ts'
import {button, el, icons} from './dom.ts'
import {FileStore, indexedFiles, isImage, isText, readText, type FileEntry} from './files.ts'
import {DocumentController} from './documents.ts'
import {downloadFile, fileDialog} from './file-dialog.ts'

export type GalleryConnection = {open(entries: FileEntry[], selected: string, store: FileStore): Promise<void>}
export class Cabinet {
  store: FileStore | null = null
  documents: DocumentController | null = null
  folder: string | null = null
  error = ''
  ready: Promise<void>
  navigate: (folder: string | null) => void = folder => { this.folder = folder }
  importFiles: () => void = () => {}
  private listeners = new Set<() => void>()
  private openApp: (app: 'inkwell' | 'chroma' | 'cabinet') => Promise<void> = () => Promise.resolve()
  private gallery: GalleryConnection | null = null
  private note: HTMLTextAreaElement
  private channel: BroadcastChannel | null = null
  private pendingText: string | null = null
  constructor(note: HTMLTextAreaElement) {
    this.note = note
    this.ready = this.initialize()
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private changed = () => { for (const listener of this.listeners) listener() }
  private async initialize() {
    try {
      const backend = await indexedFiles(window.indexedDB)
      this.channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('prism-os.files')
      const store = new FileStore(backend, () => this.channel?.postMessage('changed'))
      this.store = store
      store.subscribe(this.changed)
      this.channel?.addEventListener('message', () => { store.refresh(); void this.checkExternal() })
      await store.initialize(this.note.value)
      this.documents = new DocumentController(store, () => { this.changed() })
      const id = await store.initialNote()
      if (id !== undefined) {
        const entry = (await store.entries()).find(item => item.id === id)
        if (entry?.trashed === null) await this.documents.open(entry)
      }
      if (!this.documents.entry) {
        const documents = (await store.list(null)).find(e => e.name === 'Documents' && e.kind === 'folder')
        await this.documents.open(await store.create(documents?.id ?? null, 'Untitled.txt', new Blob([this.note.value], {type: 'text/plain'})))
      }
      if (this.pendingText !== null) { this.documents.edit(this.pendingText); this.pendingText = null }
      this.note.value = this.documents.text
    } catch (error) {
      this.error = `Cabinet storage is unavailable: ${message(error)} Your existing note still works.`
      this.store = null; this.documents = null
    }
    this.changed()
  }
  private async checkExternal() {
    const doc = this.documents
    if (!doc?.entry || !this.store) return
    try {
      const latest = await this.store.get(doc.entry.id)
      if (latest.trashed !== null) { doc.status = 'This document is in Trash. Use Save As to keep a copy.'; this.changed(); return }
      if (latest.revision !== doc.entry.revision) {
        if (doc.dirty) { doc.status = 'Save failed: changed in another tab. Use Save As to preserve your draft.'; this.changed() }
        else { await doc.open(latest); this.note.value = doc.text }
      } else { doc.entry = latest; this.changed() }
    } catch { doc.status = 'This document was removed. Use Save As to keep a copy.'; this.changed() }
  }
  connect(open: typeof this.openApp, gallery: GalleryConnection) { this.openApp = open; this.gallery = gallery }
  async show() { await this.openApp('cabinet') }
  async files() { await this.ready; if (!this.store) throw new Error(this.error !== '' ? this.error : 'Cabinet is still opening.'); return this.store }
  edit(text: string) { if (this.documents) this.documents.edit(text); else this.pendingText = text }
  async flush() { await this.ready; await this.documents?.flush() }
  async resolveDraft(): Promise<boolean> {
    try { await this.flush(); return true }
    catch {
      const result = await fileDialog('Keep your unsaved draft', {message: this.documents?.status ?? 'Saving failed.', choices: ['Retry', 'Save As', 'Download', 'Discard']})
      if (!result) return false
      if (result.choice === 'Retry') return this.resolveDraft()
      if (result.choice === 'Save As') return this.saveAs()
      if (result.choice === 'Download') { downloadFile(new Blob([this.documents?.text ?? this.note.value], {type: 'text/plain'}), this.documents?.entry?.name ?? 'Draft.txt'); return false }
      const doc = this.documents
      doc?.discard()
      if (doc?.entry && this.store) {
        const latest = (await this.store.entries()).find(entry => entry.id === doc.entry?.id && entry.trashed === null)
        if (latest) { await doc.open(latest); this.note.value = doc.text }
        else { doc.entry = null; doc.text = ''; this.note.value = ''; this.changed() }
      }
      return true
    }
  }
  async saveAs(): Promise<boolean> {
    await this.files()
    const name = await fileDialog('Save document as', {value: this.documents?.entry?.name ?? 'Untitled.txt'})
    if (!name) return false
    const destination = await this.pickFolder()
    if (destination === undefined) return false
    await this.documents?.saveAs(destination, name.value)
    this.changed()
    return true
  }
  async pickFolder() {
    const store = await this.files()
    const folders = [{id: '', path: '/Files'}, ...await Promise.all((await store.entries()).filter(e => e.kind === 'folder' && e.trashed === null).map(async e => ({id: e.id, path: await store.path(e.id)})))]
    const result = await fileDialog('Choose a folder', {folders, value: this.folder ?? ''})
    return result ? result.value === '' ? null : result.value : undefined
  }
  async open(entry: FileEntry): Promise<boolean> {
    const store = await this.files()
    if (entry.kind === 'folder') { await this.openApp('cabinet'); this.navigate(entry.id); return true }
    if (isText(entry)) {
      this.note.readOnly = true
      try {
        if (!await this.resolveDraft()) return false
        await this.documents!.open(entry); this.note.value = this.documents!.text
        await this.openApp('inkwell')
      } finally { this.note.readOnly = false }
    } else if (isImage(entry)) {
      await this.openApp('chroma')
      await this.gallery?.open((await store.list(entry.parentId)).filter(isImage).sort((a, b) => a.name.localeCompare(b.name)), entry.id, store)
      await store.opened(entry.id).catch(() => {})
    } else downloadFile(await store.read(entry.id), entry.name)
    return true
  }
  async trash(id: string): Promise<boolean> {
    const store = await this.files(), doc = this.documents
    if (doc?.entry) {
      let current: FileEntry | undefined = doc.entry
      const all = new Map((await store.entries()).map(e => [e.id, e]))
      while (current) {
        if (current.id === id && !await this.resolveDraft()) return false
        current = current.parentId !== null ? all.get(current.parentId) : undefined
      }
    }
    await store.trash(id)
    if (doc?.entry && (await store.get(doc.entry.id)).trashed !== null) {
      doc.entry = null; doc.text = ''; doc.discard(); this.note.value = ''
      const next = await store.create(null, 'Untitled.txt', new Blob([''], {type: 'text/plain'})); await doc.open(next)
    }
    return true
  }
}
export function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
const bytes = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`

export const cabinetApp: PanelApp = {
  id: 'cabinet', name: 'Cabinet', glyph: icons.cabinet, width: 760, height: 520, resizable: true,
  build(root, body, context) {
    const candidate = context.cabinet
    if (!candidate) { body.append(el('p', '', 'Cabinet is unavailable.')); return {} }
    const cabinet: Cabinet = candidate
    const toolbar = el('div', 'cabinet-toolbar'), sidebar = el('nav', 'cabinet-sidebar'), content = el('div', 'cabinet-content')
    sidebar.setAttribute('aria-label', 'Cabinet locations')
    const breadcrumbs = el('nav', 'cabinet-breadcrumbs'); breadcrumbs.setAttribute('aria-label', 'Folder path')
    const search = el('input'); search.type = 'search'; search.placeholder = 'Search all files'; search.setAttribute('aria-label', 'Search all files')
    const sorting = el('select'); sorting.setAttribute('aria-label', 'Sort files')
    for (const [value, label] of [['name', 'Name'], ['modified', 'Modified'], ['mime', 'Type'], ['size', 'Size']]) { const option = el('option', '', label); option.value = value!; sorting.append(option) }
    const list = el('div', 'cabinet-list'); list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Files'); list.tabIndex = 0
    const preview = el('aside', 'cabinet-preview'); preview.setAttribute('aria-label', 'File preview')
    const status = el('div', 'cabinet-status'); status.setAttribute('role', 'status')
    const layout = el('div', 'cabinet-layout'); content.append(breadcrumbs, list); layout.append(sidebar, content, preview)
    const actions = el('div', 'cabinet-actions')
    body.append(toolbar, layout, actions, status)
    let mode: 'files' | 'recent' | 'trash' = 'files', selected: string | null = null, shown = false, importing = false, generation = 0, previewUrl: string | null = null
    const isShown = () => shown
    let history: (string | null)[] = [null], historyIndex = 0, grid = false, entries: FileEntry[] = []
    const run = (operation: () => Promise<unknown>) => { void operation().catch(error => { status.textContent = message(error) }) }
    const clearPreview = () => { if (previewUrl !== null) URL.revokeObjectURL(previewUrl); previewUrl = null; preview.replaceChildren() }
    const action = (label: string, operation: () => Promise<unknown> | void, target = actions) => {
      const item = button('', label, label); item.addEventListener('click', () => run(async () => operation())); target.append(item); return item
    }
    const navigate = (folder: string | null, remember = true) => {
      mode = 'files'; cabinet.folder = folder; selected = null; search.value = ''
      if (remember) { history = history.slice(0, historyIndex + 1); history.push(folder); historyIndex++ }
      run(render)
    }
    cabinet.navigate = navigate
    action('Back', () => { if (historyIndex > 0) navigate(history[--historyIndex]!, false) }, toolbar)
    action('Forward', () => { if (historyIndex < history.length - 1) navigate(history[++historyIndex]!, false) }, toolbar)
    toolbar.append(search, sorting)
    action('Grid / List', () => { grid = !grid; run(render) }, toolbar)
    const previewToggle = action('Preview', () => {
      const expanded = body.classList.toggle('cabinet-show-preview')
      previewToggle.setAttribute('aria-pressed', String(expanded))
    }, toolbar)
    previewToggle.setAttribute('aria-pressed', 'false')
    const picker = el('input'); picker.type = 'file'; picker.multiple = true; picker.hidden = true; body.append(picker)
    const importBatch = async (files: File[]) => {
      if (importing) throw new Error('Wait for the current import to finish.')
      const store = await cabinet.files()
      const destination = cabinet.folder
      const failures: string[] = []
      importing = true
      try {
        for (const [index, file] of files.entries()) {
          status.textContent = `Importing ${index + 1}/${files.length}: ${file.name}`
          try { await store.create(destination, file.name, file) } catch (error) { failures.push(`${file.name}: ${message(error)}`) }
        }
      } finally { importing = false }
      await render(); status.textContent = `Imported ${files.length - failures.length}/${files.length} files.${failures.length ? ' ' + failures.join('; ') : ''}`
      picker.value = ''
    }
    cabinet.importFiles = () => { if (mode === 'trash') { status.textContent = 'Choose a folder before importing.'; return } picker.click() }
    action('Import', () => cabinet.importFiles(), toolbar)
    picker.addEventListener('change', () => run(() => importBatch([...picker.files ?? []])))
    root.addEventListener('dragover', event => { event.preventDefault() })
    root.addEventListener('drop', event => {
      event.preventDefault()
      if (mode === 'trash') { status.textContent = 'Choose a folder before importing.'; return }
      const items = [...event.dataTransfer?.items ?? []]
      if (items.some(item => item.webkitGetAsEntry()?.isDirectory)) { status.textContent = 'Import files individually; folder import is not available.'; return }
      run(() => importBatch([...event.dataTransfer?.files ?? []]))
    })
    const newFolder = action('New Folder', async () => { const result = await fileDialog('New folder', {value: 'New Folder'}); if (result) await (await cabinet.files()).create(cabinet.folder, result.value) })
    const newDocument = action('New Text Document', async () => { const result = await fileDialog('New text document', {value: 'Untitled.txt'}); if (result) await cabinet.open(await (await cabinet.files()).create(cabinet.folder, result.value, new Blob([''], {type: 'text/plain'}))) })
    const chosen = () => { const entry = entries.find(e => e.id === selected); if (!entry) throw new Error('Select an item first.'); return entry }
    const openButton = action('Open', () => cabinet.open(chosen()))
    const rename = action('Rename', async () => { const entry = chosen(), result = await fileDialog('Rename item', {value: entry.name}); if (result) await (await cabinet.files()).rename(entry.id, result.value) })
    const move = action('Move', async () => { const entry = chosen(), destination = await cabinet.pickFolder(); if (destination !== undefined) await (await cabinet.files()).move(entry.id, destination) })
    const duplicate = action('Duplicate', async () => (await cabinet.files()).duplicate(chosen().id))
    const download = action('Download', async () => { const entry = chosen(); if (entry.kind === 'folder') throw new Error('Open the folder to download individual files.'); downloadFile(await (await cabinet.files()).read(entry.id), entry.name) })
    const trash = action('Trash', async () => cabinet.trash(chosen().id))
    const restore = action('Restore', async () => (await cabinet.files()).restore(chosen().id))
    const remove = action('Delete Permanently', async () => { const entry = chosen(); if (await fileDialog('Delete permanently?', {message: entry.name, choices: ['Delete']})) await (await cabinet.files()).remove(entry.id) })
    const empty = action('Empty Trash', async () => { if (await fileDialog('Empty Trash?', {message: 'Permanently delete everything in Trash?', choices: ['Delete All']})) await (await cabinet.files()).remove() })
    const updateActions = () => {
      for (const item of [rename, move, duplicate, trash, openButton]) item.disabled = selected === null || mode === 'trash'
      download.disabled = selected === null || chosen().kind === 'folder'
      restore.hidden = remove.hidden = empty.hidden = mode !== 'trash'
      restore.disabled = remove.disabled = selected === null
      newFolder.disabled = newDocument.disabled = mode === 'trash'
    }
    const select = (id: string | null) => {
      selected = id
      for (const row of list.querySelectorAll<HTMLElement>('[data-id]')) row.setAttribute('aria-selected', String(row.dataset['id'] === id))
      updateActions()
      run(() => showPreview(entries.find(entry => entry.id === id), ++generation))
    }
    list.addEventListener('click', event => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-id]') : null
      const entry = entries.find(item => item.id === row?.dataset['id'])
      if (!entry) return
      select(entry.id)
      if (event.detail >= 2 && mode !== 'trash') run(() => cabinet.open(entry))
    })
    search.addEventListener('input', () => { selected = null; run(render) }); sorting.addEventListener('change', () => run(render))
    async function showPreview(entry: FileEntry | undefined, token: number) {
      clearPreview()
      if (!entry) { preview.append(el('p', '', 'Select a file to preview it.')); return }
      preview.append(el('strong', '', entry.name), el('p', '', entry.kind === 'folder' ? 'Folder' : `${entry.mime === '' ? 'File' : entry.mime} · ${bytes(entry.size)}`), el('p', '', new Date(entry.modified).toLocaleString()))
      if (entry.kind === 'folder' || entry.trashed !== null || !isShown()) return
      const blob = await (await cabinet.files()).read(entry.id)
      if (token !== generation || !isShown()) return
      if (isImage(entry)) {
        const img = el('img'); img.alt = entry.name; previewUrl = URL.createObjectURL(blob); img.src = previewUrl
        img.addEventListener('error', () => { img.replaceWith(el('p', '', 'Image preview unavailable. Download the file to open it.')) })
        preview.append(img)
      } else if (isText(entry)) {
        try { const text = await readText(blob); if (token === generation && isShown()) preview.append(el('pre', '', text.slice(0, 12000))) }
        catch (error) { if (token === generation) preview.append(el('p', '', message(error))) }
      } else preview.append(el('p', '', 'Preview unavailable. Download to open this file.'))
    }
    async function render() {
      if (!isShown()) return
      const token = ++generation
      await cabinet.ready
      if (token !== generation) return
      if (!cabinet.store) { status.textContent = cabinet.error; return }
      const store = cabinet.store, all = await store.entries()
      if (token !== generation) return
      if (cabinet.folder !== null && !all.some(e => e.id === cabinet.folder && e.trashed === null)) cabinet.folder = null
      const byId = new Map(all.map(e => [e.id, e]))
      const path = (entry: FileEntry) => { const parts = [entry.name]; let parent = entry.parentId; while (parent !== null) { const p = byId.get(parent); if (!p) break; parts.unshift(p.name); parent = p.parentId }; return '/' + parts.join('/') }
      sidebar.replaceChildren()
      for (const name of ['Files', 'Documents', 'Pictures', 'Recent', 'Trash']) {
        const item = button('', name, name)
        item.addEventListener('click', () => {
          if (name === 'Recent' || name === 'Trash') { mode = name === 'Recent' ? 'recent' : 'trash'; selected = null; search.value = ''; run(render) }
          else navigate(name === 'Files' ? null : all.find(e => e.kind === 'folder' && e.parentId === null && e.name === name && e.trashed === null)?.id ?? null)
        }); sidebar.append(item)
      }
      breadcrumbs.replaceChildren()
      const home = button('', 'Files', 'Files'); home.addEventListener('click', () => navigate(null)); breadcrumbs.append(home)
      if (mode === 'files' && cabinet.folder !== null) {
        const parents: FileEntry[] = []; let current = byId.get(cabinet.folder)
        while (current) { parents.unshift(current); current = current.parentId !== null ? byId.get(current.parentId) : undefined }
        for (const parent of parents) { const crumb = button('', parent.name, parent.name); crumb.addEventListener('click', () => navigate(parent.id)); breadcrumbs.append(crumb) }
      } else if (mode !== 'files') breadcrumbs.append(el('span', '', mode === 'trash' ? 'Trash' : 'Recent'))
      entries = all.filter(e => mode === 'trash' ? e.trashed !== null && (e.parentId === null || byId.get(e.parentId)?.trashed === null) : e.trashed === null && (search.value !== '' ? e.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()) : mode === 'recent' ? e.kind === 'file' && e.opened > 0 : e.parentId === cabinet.folder))
      if (mode === 'recent' && search.value === '') entries = entries.sort((a, b) => b.opened - a.opened).slice(0, 30)
      else entries.sort((a, b) => {
        if (sorting.value === 'modified') return b.modified - a.modified
        if (sorting.value === 'size') return b.size - a.size
        if (sorting.value === 'mime') return a.kind.localeCompare(b.kind) || a.mime.localeCompare(b.mime) || a.name.localeCompare(b.name)
        return Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name)
      })
      const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement)
      list.replaceChildren(); list.classList.toggle('cabinet-grid', grid)
      if (!entries.some(e => e.id === selected)) selected = null
      for (const entry of entries) {
        const row = button('cabinet-item', entry.name)
        row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(entry.id === selected)); row.dataset['id'] = entry.id
        row.append(el('span', 'cabinet-file-icon', entry.kind === 'folder' ? '▰' : isImage(entry) ? '▧' : '▤'), el('span', '', entry.name), el('small', '', search.value !== '' || mode === 'recent' ? path(entry) : entry.kind === 'folder' ? 'Folder' : bytes(entry.size)))
        list.append(row)
      }
      if (!entries.length) list.append(el('p', 'cabinet-empty', search.value !== '' ? 'No matching files.' : mode === 'trash' ? 'Trash is empty.' : 'This folder is empty. Import a file or create a document.'))
      if (focused) list.querySelector<HTMLElement>(`[data-id="${selected}"]`)?.focus()
      updateActions()
      status.textContent = `${entries.length} items · Files stay in this browser. Download copies to keep them.`
      void navigator.storage.estimate().then(estimate => { if (token === generation) status.textContent += ` · ${bytes(estimate.usage ?? 0)} used` }).catch(() => {})
      await showPreview(entries.find(e => e.id === selected), token)
    }
    list.addEventListener('keydown', event => {
      const index = entries.findIndex(e => e.id === selected)
      if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : Math.max(0, Math.min(entries.length - 1, index + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1)))
        select(entries[next]?.id ?? null)
        list.querySelector<HTMLElement>(`[data-id="${selected}"]`)?.focus()
      } else if (event.key === 'Enter' && selected !== null && mode !== 'trash') { event.preventDefault(); run(() => cabinet.open(chosen())) }
    })
    cabinet.subscribe(() => { if (shown && !importing) run(render) })
    return {visible(visible) { shown = visible; if (visible) run(render); else { generation++; clearPreview() } }}
  },
}
