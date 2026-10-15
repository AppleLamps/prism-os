import {memoryFiles} from './file-backend.ts'
import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {FileStore, fileName, readText, isText, isImage, textLimit, type FileBackend} from '../../src/prismos/files.ts'
import {DocumentController} from '../../src/prismos/documents.ts'
import {galleryPage} from '../../src/prismos/cabinet-gallery.ts'
import {quickCommands} from '../../src/prismos/quick-commands.ts'
import {needsConfirmation, validateCall} from '../../src/prismos/commands.ts'

test('migration commits once and preserves the original saved note', async () => {
  const backend = memoryFiles(), store = new FileStore(backend)
  await store.initialize('legacy note')
  await store.initialize('do not replace')
  assert.equal((await store.entries()).length, 3)
  const note = await store.resolve('/Documents/Notes.txt')
  assert.ok(note)
  assert.equal(await (await store.read(note.id)).text(), 'legacy note')
  assert.equal(await store.initialNote(), note.id)
})

test('imports preserve binary bytes, allocate unique names, and normalize names', async () => {
  const store = new FileStore(memoryFiles())
  const bytes = new Uint8Array([0, 255, 128, 13, 10])
  const original = await store.create(null, ' raw.bin ', new Blob([bytes]))
  const second = await store.create(null, 'RAW.bin', new Blob([bytes]))
  assert.equal(original.name, 'raw.bin'); assert.equal(second.name, 'RAW (2).bin')
  assert.deepEqual(new Uint8Array(await (await store.read(original.id)).arrayBuffer()), bytes)
  assert.equal(fileName('e\u0301.txt'), 'é.txt')
  for (const invalid of ['', '.', '..', 'a/b', 'a\\b', 'a\u0000b']) assert.throws(() => fileName(invalid))
})

test('folders reject descendant moves and non-folder parents without partial writes', async () => {
  const store = new FileStore(memoryFiles()), parent = await store.create(null, 'Parent')
  const child = await store.create(parent.id, 'Child'), file = await store.create(null, 'file', new Blob(['a']))
  await assert.rejects(store.move(parent.id, child.id), /inside itself/u)
  await assert.rejects(store.move(parent.id, file.id), /folder/u)
  await assert.rejects(store.create(file.id, 'invalid'), /folder/u)
  assert.equal((await store.get(parent.id)).parentId, null)
})

test('duplicate copies complete folder trees and does not share mutable file content', async () => {
  const store = new FileStore(memoryFiles()), folder = await store.create(null, 'Folder')
  const nested = await store.create(folder.id, 'Nested')
  const file = await store.create(nested.id, 'note.txt', new Blob(['original'], {type: 'text/plain'}))
  const copy = await store.duplicate(folder.id)
  assert.equal(copy.name, 'Folder (2)')
  const copiedFile = await store.resolve('/Folder (2)/Nested/note.txt'); assert.ok(copiedFile)
  await store.update(file.id, new Blob(['changed']), file.revision)
  assert.equal(await (await store.read(copiedFile.id)).text(), 'original')
})

test('Trash and restoration preserve trees, handle collisions and missing parents', async () => {
  const store = new FileStore(memoryFiles()), folder = await store.create(null, 'Folder')
  const child = await store.create(folder.id, 'note.txt', new Blob(['keep']))
  await store.trash(folder.id)
  assert.equal((await store.list(null)).length, 0)
  assert.notEqual((await store.get(child.id)).trashed, null)
  await store.create(null, 'Folder')
  const restored = await store.restore(folder.id)
  assert.equal(restored.name, 'Folder (2)')
  assert.equal((await store.get(child.id)).parentId, folder.id)
  assert.equal((await store.get(child.id)).trashed, null)
  await store.trash(child.id)
  await store.trash(folder.id)
  await store.remove(folder.id)
  await assert.rejects(store.get(child.id))
  const removedParent = await store.create(null, 'Removed')
  const orphan = await store.create(removedParent.id, 'orphan.txt', new Blob(['x']))
  await store.trash(orphan.id)
  // Move a separately trashed item out of the deleted subtree by restoring from a trashed parent.
  await store.trash(removedParent.id)
  assert.equal((await store.restore(orphan.id)).parentId, null)
  await store.remove(removedParent.id)
  assert.equal((await store.get(orphan.id)).trashed, null)
})

test('revisions reject stale writers and preserve the committed bytes', async () => {
  const store = new FileStore(memoryFiles()), file = await store.create(null, 'note.txt', new Blob(['old']))
  await store.update(file.id, new Blob(['winner']), 1)
  await assert.rejects(store.update(file.id, new Blob(['loser']), 1), /changed elsewhere/u)
  assert.equal(await (await store.read(file.id)).text(), 'winner')
  assert.equal((await store.get(file.id)).revision, 2)
})

test('restoring a folder leaves separately trashed children in Trash even at the same timestamp', async () => {
  const originalNow = Date.now
  Date.now = () => 100
  try {
    const store = new FileStore(memoryFiles()), folder = await store.create(null, 'Folder')
    const separate = await store.create(folder.id, 'separate.txt', new Blob(['one']))
    const together = await store.create(folder.id, 'together.txt', new Blob(['two']))
    await store.trash(separate.id); await store.trash(folder.id); await store.restore(folder.id)
    assert.notEqual((await store.get(separate.id)).trashed, null)
    assert.equal((await store.get(together.id)).trashed, null)
  } finally { Date.now = originalNow }
})

test('failed transaction does not publish success or modify prior content', async () => {
  const backend = memoryFiles()
  let fail = false, notices = 0
  const failing: FileBackend = {...backend, write: change => fail ? Promise.reject(new DOMException('Full', 'QuotaExceededError')) : backend.write(change)}
  const store = new FileStore(failing); store.subscribe(() => { notices++ })
  const file = await store.create(null, 'note.txt', new Blob(['committed']))
  fail = true
  await assert.rejects(store.update(file.id, new Blob(['not saved']), 1))
  assert.equal(notices, 1)
  assert.equal(await (await store.read(file.id)).text(), 'committed')
})

test('full storage still permits existing documents to open and preserves failed drafts', async () => {
  const backend = memoryFiles()
  let full = false
  const store = new FileStore({...backend, write: change => full ? Promise.reject(new DOMException('Full', 'QuotaExceededError')) : backend.write(change)})
  await store.initialize('already stored')
  const entry = await store.resolve('/Documents/Notes.txt'); assert.ok(entry)
  full = true
  await store.initialize('do not migrate twice')
  const doc = new DocumentController(store)
  await doc.open(entry)
  assert.equal(doc.text, 'already stored')
  doc.edit('keep my draft')
  await assert.rejects(doc.flush(), /Download files or empty Trash/u)
  assert.equal(doc.text, 'keep my draft')
  assert.equal(await (await store.read(entry.id)).text(), 'already stored')
})

test('Inkwell flushes before switching and Save As preserves the draft after a conflict', async () => {
  const store = new FileStore(memoryFiles()), a = await store.create(null, 'a.txt', new Blob(['A'], {type: 'text/plain'})), b = await store.create(null, 'b.txt', new Blob(['B'], {type: 'text/plain'}))
  const doc = new DocumentController(store)
  await doc.open(a); doc.edit('saved A'); await doc.open(b)
  assert.equal(await (await store.read(a.id)).text(), 'saved A')
  doc.edit('my draft')
  await store.update(b.id, new Blob(['other tab']), b.revision)
  await assert.rejects(doc.open(a), /changed elsewhere/u)
  assert.equal(doc.text, 'my draft'); assert.equal(doc.entry?.id, b.id); assert.equal(doc.dirty, true)
  const copy = await doc.saveAs(null, 'draft.txt')
  assert.equal(await (await store.read(copy.id)).text(), 'my draft')
  assert.equal(await (await store.read(b.id)).text(), 'other tab')
  assert.equal(doc.status, 'Saved'); assert.equal(doc.dirty, false)
})

test('invalid UTF-8, oversized text and executable preview formats remain downloads', async () => {
  await assert.rejects(readText(new Blob([new Uint8Array([255])])), /UTF-8/u)
  await assert.rejects(readText(new Blob(['x'.repeat(textLimit + 1)])), /1 MiB/u)
  const store = new FileStore(memoryFiles())
  assert.equal(isText(await store.create(null, 'page.html', new Blob(['<script>'], {type: 'text/html'}))), false)
  assert.equal(isText(await store.create(null, 'image.svg', new Blob(['<svg>'], {type: 'image/svg+xml'}))), false)
  assert.equal(isImage(await store.create(null, 'photo.png', new Blob(['x'], {type: 'image/png'}))), true)
  assert.equal(isImage(await store.create(null, 'photo.AVIF', new Blob(['x']))), true)
})

test('gallery pages cover empty, partial, exact, and multiple pages', () => {
  assert.deepEqual(galleryPage(0, 0), {page: 0, count: 0, slot: -1})
  assert.deepEqual(galleryPage(1, 0), {page: 0, count: 1, slot: 0})
  assert.deepEqual(galleryPage(12, 11), {page: 0, count: 12, slot: 11})
  assert.deepEqual(galleryPage(13, 12), {page: 1, count: 1, slot: 0})
  assert.deepEqual(galleryPage(25, 24), {page: 2, count: 1, slot: 0})
})

test('Cabinet commands keep file name case and confirm permanent deletion', () => {
  assert.deepEqual(quickCommands('create document /Documents/My Plan.txt'), [{name: 'create_document', path: '/Documents/My Plan.txt'}])
  assert.deepEqual(quickCommands('rename file /Documents/My Plan.txt to Next Plan.txt'), [{name: 'rename_file', path: '/Documents/My Plan.txt', new_name: 'Next Plan.txt'}])
  assert.deepEqual(quickCommands('open files'), [{name: 'open_app', app: 'cabinet'}])
  assert.equal(validateCall('move_file', {path: 'a', destination: ''}).ok, false)
  assert.equal(needsConfirmation({name: 'empty_trash'}), 'Permanently delete everything in Trash?')
  assert.notEqual(needsConfirmation({name: 'delete_file', path: '/Documents/a.txt'}), null)
  assert.equal(needsConfirmation({name: 'trash_file', path: '/Documents/a.txt'}), null)
})
