import {downloadFile} from './file-dialog.ts'
import {type Cabinet} from './cabinet.ts'
import {type FileEntry} from './files.ts'

export type FileCommand =
  | {name: 'list_files' | 'open_file' | 'create_folder' | 'create_document' | 'save_note_as' | 'duplicate_file' | 'trash_file' | 'restore_file' | 'download_file' | 'delete_file', path: string}
  | {name: 'search_files', query: string}
  | {name: 'rename_file', path: string, new_name: string}
  | {name: 'move_file', path: string, destination: string}
  | {name: 'empty_trash' | 'import_files'}

export const fileCommandNames = ['list_files', 'open_file', 'create_folder', 'create_document', 'save_note_as', 'duplicate_file', 'trash_file', 'restore_file', 'download_file', 'delete_file', 'search_files', 'rename_file', 'move_file', 'empty_trash', 'import_files'] as const
export function isFileCommand(command: {name: string}): command is FileCommand { return (fileCommandNames as readonly string[]).includes(command.name) }
export function validateFileCommand(name: string, args: Readonly<Record<string, unknown>>): FileCommand {
  const text = (key: string) => {
    const value = args[key]
    if (typeof value !== 'string' || value.trim() === '' || value.length > 1024 || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error(`Provide a valid ${key.replaceAll('_', ' ')}.`)
    return value.trim().normalize('NFC')
  }
  switch (name) {
    case 'empty_trash': case 'import_files': return {name}
    case 'search_files': return {name, query: text('query')}
    case 'rename_file': return {name, path: text('path'), new_name: text('new_name')}
    case 'move_file': return {name, path: text('path'), destination: text('destination')}
    case 'list_files': return {name, path: args['path'] === undefined ? '.' : text('path')}
    case 'open_file': case 'create_folder': case 'create_document': case 'save_note_as': case 'duplicate_file': case 'trash_file': case 'restore_file': case 'download_file': case 'delete_file': return {name, path: text('path')}
    default: throw new Error('Unknown Cabinet command.')
  }
}

export async function runFileCommand(cabinet: Cabinet, command: FileCommand): Promise<string> {
  const store = await cabinet.files()
  const resolve = async (path: string, trash = false) => store.resolve(path, cabinet.folder, trash)
  const required = async (path: string, trash = false) => {
    const entry = await resolve(path, trash)
    if (!entry) throw new Error('Choose a file or folder below Files.')
    return entry
  }
  const destination = async (path: string) => {
    const split = path.lastIndexOf('/')
    const parent = split < 0 ? cabinet.folder : (await resolve(path.slice(0, split) === '' ? '/' : path.slice(0, split)))?.id ?? null
    return {parent, name: path.slice(split + 1)}
  }
  const list = async (entries: FileEntry[]) => (await Promise.all(entries.slice(0, 50).map(entry => store.path(entry.id)))).join('\n') + (entries.length > 50 ? `\n…and ${entries.length - 50} more. Refine your search.` : '')
  switch (command.name) {
    case 'list_files': {
      const entry = await resolve(command.path)
      if (entry && entry.kind !== 'folder') throw new Error('Choose a folder to list.')
      cabinet.navigate(entry?.id ?? null)
      const result = await list(await store.list(entry?.id ?? null)); return result === '' ? 'This folder is empty.' : result
    }
    case 'search_files': { const result = await list(await store.search(command.query)); return result === '' ? 'No matching files.' : result }
    case 'open_file': {
      let entry: FileEntry
      try { entry = await required(command.path) }
      catch (error) {
        if (command.path.includes('/')) throw error
        const matches = await store.search(command.path)
        if (matches.length !== 1) return matches.length ? `Choose a path:\n${await list(matches)}` : 'No matching files.'
        entry = matches[0]!
      }
      return await cabinet.open(entry) ? `Opened ${entry.name}.` : 'Kept the current document and its draft.'
    }
    case 'create_folder': case 'create_document': case 'save_note_as': {
      const {parent, name} = await destination(command.path)
      const entry = command.name === 'save_note_as' ? await cabinet.documents?.saveAs(parent, name)
        : await store.create(parent, name, command.name === 'create_document' ? new Blob([''], {type: 'text/plain'}) : undefined)
      return `Saved ${entry ? await store.path(entry.id) : name}.`
    }
    case 'rename_file': return `Renamed to ${(await store.rename((await required(command.path)).id, command.new_name)).name}.`
    case 'move_file': {
      const parent = await resolve(command.destination)
      await store.move((await required(command.path)).id, parent?.id ?? null); return 'Moved the item.'
    }
    case 'duplicate_file': return `Created ${(await store.duplicate((await required(command.path)).id)).name}.`
    case 'trash_file': return await cabinet.trash((await required(command.path)).id) ? 'Moved to Trash.' : 'Kept the item and its unsaved draft.'
    case 'restore_file': await store.restore((await required(command.path, true)).id); return 'Restored the item.'
    case 'delete_file': await store.remove((await required(command.path, true)).id); return 'Permanently deleted the item.'
    case 'download_file': {
      const entry = await required(command.path)
      if (entry.kind !== 'file') return 'Open the folder and download individual files.'
      downloadFile(await store.read(entry.id), entry.name); return `Downloaded ${entry.name}.`
    }
    case 'empty_trash': await store.remove(); return 'Trash is empty.'
    case 'import_files':
      await cabinet.show(); return 'Cabinet is open. Press Import to choose files from your device.'
  }
}
