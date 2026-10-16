// The command center's vocabulary as the model sees it: Prism OS's 50 commands grouped
// into 16 function declarations, e.g. one `app` tool with an action for open, minimize,
// maximize, restore, close, move and resize, instead of seven tools that each repeat the
// list of apps. Every request carries every declaration, so the grouping halves the
// prompt (about 1,700 tokens instead of 3,300), which is half the work for a 270M model
// in the browser before it writes a word.
//
// The page sends `modelTools` with every request, and `expandCall` turns each call the
// model makes into the commands of commands.ts, which validateCall checks as it checks
// the quick parser's. scripts/prismos-dataset.ts writes the fine-tuning data from the
// same declarations, through `groupCall`, the inverse. After changing anything here,
// run the dataset script and the training job again (see src/prismos/README.md).
import {type CommandName, accentNames, apps, arcVisibilities, browserActions, onOff, positions, programApps, sceneNames, scopeListActions, scopeViews, sizes, stopwatchActions, themes, topics} from './commands.ts'

type Parameter = {type: 'STRING', description: string, enum?: readonly string[]}
export type ModelTool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {type: 'OBJECT', properties: Record<string, Parameter>, required: string[]}
  }
}

// A call by name with its arguments: the model's, or one of commands.ts.
export type Call = {name: string, arguments: Record<string, unknown>}

const fileActions = ['list', 'open', 'create_folder', 'create_document', 'save_note_as', 'duplicate', 'rename', 'move', 'trash', 'restore', 'delete', 'empty_trash', 'download', 'search', 'import'] as const
const appActions = ['open', 'minimize', 'maximize', 'restore', 'close', 'move', 'resize'] as const
const layoutActions = ['side_by_side', 'show_desktop', 'reset'] as const
const photoActions = ['open', 'next', 'previous', 'close', 'start_slideshow', 'stop_slideshow'] as const
const scopeActions = [...scopeViews, ...scopeListActions] as const
const noteActions = ['append', 'replace', 'clear', 'read'] as const
const timerActions = ['start', 'pause', 'resume', 'cancel'] as const

const text = (description: string): Parameter => ({type: 'STRING', description})
const choice = (description: string, values: readonly string[]): Parameter => ({type: 'STRING', description, enum: values})

function tool(name: string, description: string, properties: Record<string, Parameter>, required: string[]): ModelTool {
  return {type: 'function', function: {name, description, parameters: {type: 'OBJECT', properties, required}}}
}

// Short descriptions on purpose: every request carries all of them.
export const modelTools: readonly ModelTool[] = [
  tool('app', 'Open, minimize, maximize, restore, close, move or resize an app', {
    action: choice('What to do', appActions),
    app: choice('The app', apps),
    position: choice('Where to move it', positions),
    size: choice('The new size, for scope, inkwell or chroma', sizes),
  }, ['action', 'app']),
  tool('layout', 'Arrange the windows', {
    action: choice('side_by_side puts two program windows on halves of the screen, show_desktop minimizes every window, reset puts the program windows back', layoutActions),
    left: choice('The window on the left', programApps),
    right: choice('The window on the right', programApps),
  }, ['action']),
  tool('files', 'Files and folders in Cabinet', {
    action: choice('What to do', fileActions),
    path: text('Cabinet path, absolute or relative to the current folder'),
    to: text('The new name, or the folder to move it to'),
    query: text('Part of a file name, to search'),
  }, ['action']),
  tool('photos', 'Photos in Chroma', {
    action: choice('What to do', photoActions),
    photo: text('The photo name, or its number from 1 to 12'),
  }, ['action']),
  tool('scope', 'Show a list in Scope, the inspector of the program, or move through it', {
    action: choice('The list to show, or how to move', scopeActions),
  }, ['action']),
  tool('note', 'The note in Inkwell', {
    action: choice('append adds text, replace replaces the note, clear erases it, read reads it', noteActions),
    text: text('The text to write'),
  }, ['action']),
  tool('settings', 'Change one or more settings', {
    theme: choice('Appearance, auto follows the device', themes),
    accent: choice('Accent color', accentNames),
    wallpaper: choice('Wallpaper scene', sceneNames),
    motion: choice('Wallpaper animation', onOff),
    arcs: choice('The arcs of the program weights behind the windows', arcVisibilities),
  }, []),
  tool('calculate', 'Do arithmetic', {expression: text('The arithmetic, e.g. 17 * 23')}, ['expression']),
  tool('timer', 'The countdown timer in Clock', {
    action: choice('What to do', timerActions),
    duration: text('How long, e.g. 5 minutes'),
  }, ['action']),
  tool('stopwatch', 'The stopwatch in Clock', {action: choice('What to do', stopwatchActions)}, ['action']),
  tool('world_time', 'Tell the time in a city', {city: text('The city, or here')}, ['city']),
  tool('open_website', 'Open a web page in Browser', {address: text('The web address, e.g. wikipedia.org')}, ['address']),
  tool('search_web', 'Search the web in Browser, also to answer questions about the world', {query: text('What to search for')}, ['query']),
  tool('browser', 'Go back, forward, reload, or to Favorites in Browser', {action: choice('What to do', browserActions)}, ['action']),
  tool('get_stats', 'Report the live numbers of the program that runs Prism OS', {}, []),
  tool('explain', 'Explain a part of Prism OS', {topic: choice('What to explain', topics)}, ['topic']),
]

// Each grouped action and the command it stands for.
const fileCommands: Record<(typeof fileActions)[number], CommandName> = {
  list: 'list_files', open: 'open_file', create_folder: 'create_folder', create_document: 'create_document',
  save_note_as: 'save_note_as', duplicate: 'duplicate_file', rename: 'rename_file', move: 'move_file',
  trash: 'trash_file', restore: 'restore_file', delete: 'delete_file', empty_trash: 'empty_trash',
  download: 'download_file', search: 'search_files', import: 'import_files',
}
const appCommands: Record<(typeof appActions)[number], CommandName> = {
  open: 'open_app', minimize: 'minimize_app', maximize: 'maximize_app', restore: 'restore_app',
  close: 'close_app', move: 'move_app', resize: 'resize_app',
}
const settingCommands = {theme: ['set_theme', 'theme'], accent: ['set_accent', 'color'], wallpaper: ['set_wallpaper', 'scene'], motion: ['set_motion', 'motion'], arcs: ['set_arcs', 'visibility']} as const

const invert = <Key extends string, Value extends string>(table: Record<Key, Value>) =>
  Object.fromEntries(Object.entries(table).map(([key, value]) => [value, key])) as Record<Value, Key>
const fileActionOf = invert(fileCommands)
const appActionOf = invert(appCommands)

export type Expansion = {ok: true, calls: Call[]} | {ok: false, reason: string}

// The action a call names, as the declarations spell it, or null.
function actionOf<const Values extends readonly string[]>(values: Values, value: unknown): Values[number] | null {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase().replace(/[\s-]+/gu, '_')
  return values.includes(key) ? key : null
}

// The commands a call of the model stands for: one, or for `settings`, one for each
// setting it names. The commands' own arguments are left to validateCall.
export function expandCall(name: string, args: Readonly<Record<string, unknown>>): Expansion {
  const one = (command: CommandName, commandArgs: Record<string, unknown> = {}): Expansion => ({ok: true, calls: [{name: command, arguments: commandArgs}]})
  const fail = (reason: string): Expansion => ({ok: false, reason})
  switch (name) {
    case 'app': {
      const action = actionOf(appActions, args['action'])
      if (action === null) return fail('I can open, minimize, maximize, restore, close, move or resize an app.')
      const commandArgs: Record<string, unknown> = {app: args['app']}
      if (action === 'move') commandArgs['position'] = args['position']
      if (action === 'resize') commandArgs['size'] = args['size']
      return one(appCommands[action], commandArgs)
    }
    case 'layout': {
      const action = actionOf(layoutActions, args['action'])
      if (action === 'side_by_side') return one('side_by_side', {left: args['left'], right: args['right']})
      if (action === 'show_desktop') return one('show_desktop')
      return action === 'reset' ? one('reset_layout') : fail('I can put two windows side by side, show the desktop, or reset the layout.')
    }
    case 'files': {
      const action = actionOf(fileActions, args['action'])
      if (action === null) return fail('I can list, open, create, rename, move, trash, restore, delete, download or search files.')
      const command = fileCommands[action]
      const path = args['path']
      switch (command) {
        case 'empty_trash':
        case 'import_files':
          return one(command)
        case 'search_files':
          return one(command, {query: args['query'] ?? path})
        case 'rename_file':
          return one(command, {path, new_name: args['to']})
        case 'move_file':
          return one(command, {path, destination: args['to']})
        case 'list_files':
          return one(command, path === undefined ? {} : {path})
        default:
          return one(command, {path})
      }
    }
    case 'photos': {
      const action = actionOf(photoActions, args['action'])
      switch (action) {
        case 'open': return one('open_photo', {photo: args['photo']})
        case 'next': return one('next_photo')
        case 'previous': return one('previous_photo')
        case 'close': return one('close_photo')
        case 'start_slideshow': return one('slideshow', {action: 'start'})
        case 'stop_slideshow': return one('slideshow', {action: 'stop'})
        default: return fail('Chroma can open a photo, show the next or previous one, close it, or start or stop a slideshow.')
      }
    }
    case 'scope': {
      const action = actionOf(scopeActions, args['action'])
      if (action === null) return fail('Scope shows state, operations or outputs, and moves up, down, a page at a time, to the top or to the bottom.')
      return (scopeViews as readonly string[]).includes(action) ? one('scope_show', {view: action}) : one('scope_list', {action})
    }
    case 'note': {
      // Text with no action adds to the note.
      const action = args['action'] === undefined && args['text'] !== undefined ? 'append' : actionOf(noteActions, args['action'])
      if (action === 'clear') return one('clear_note')
      if (action === 'read') return one('read_note')
      return action === null ? fail('I can add to the note, replace it, clear it or read it.') : one('write_note', {text: args['text'], mode: action})
    }
    case 'settings': {
      const calls = Object.entries(settingCommands)
        .filter(([key]) => args[key] !== undefined)
        .map(([key, [command, argument]]) => ({name: command, arguments: {[argument]: args[key]}}))
      return calls.length > 0 ? {ok: true, calls} : fail('Which setting? The appearance, accent, wallpaper, motion or arcs.')
    }
    case 'timer': {
      // A length with no action starts a timer.
      const action = args['action'] === undefined && args['duration'] !== undefined ? 'start' : actionOf(timerActions, args['action'])
      if (action === 'start') return one('start_timer', {duration: args['duration']})
      return action === null ? fail('The timer can start, pause, resume or cancel.') : one('timer', {action})
    }
    case 'browser':
      return one('browser_navigate', {action: args['action']})
    case 'calculate':
    case 'stopwatch':
    case 'world_time':
    case 'open_website':
    case 'search_web':
    case 'get_stats':
    case 'explain':
      return one(name, {...args})
    default:
      return fail(`I don't have a command called "${name}".`)
  }
}

// The call of the model that stands for a command's call: the inverse of expandCall, for
// writing the fine-tuning data.
export function groupCall(call: Call): Call {
  const args = call.arguments
  const grouped = (name: string, groupedArgs: Record<string, unknown> = {}): Call => ({name, arguments: groupedArgs})
  const name = call.name as CommandName
  if (Object.hasOwn(fileActionOf, name)) {
    const action = fileActionOf[name]
    const {path, new_name: newName, destination, query} = args
    return grouped('files', Object.fromEntries(Object.entries({action, path, query, to: newName ?? destination}).filter(([, value]) => value !== undefined)))
  }
  if (Object.hasOwn(appActionOf, name)) {
    return grouped('app', {action: appActionOf[name], ...args})
  }
  switch (name) {
    case 'side_by_side': return grouped('layout', {action: 'side_by_side', ...args})
    case 'show_desktop': return grouped('layout', {action: 'show_desktop'})
    case 'reset_layout': return grouped('layout', {action: 'reset'})
    case 'open_photo': return grouped('photos', {action: 'open', ...args})
    case 'next_photo': return grouped('photos', {action: 'next'})
    case 'previous_photo': return grouped('photos', {action: 'previous'})
    case 'close_photo': return grouped('photos', {action: 'close'})
    case 'slideshow': return grouped('photos', {action: `${String(args['action'])}_slideshow`})
    case 'scope_show': return grouped('scope', {action: args['view']})
    case 'scope_list': return grouped('scope', {action: args['action']})
    case 'write_note': return grouped('note', {action: args['mode'] ?? 'append', text: args['text']})
    case 'clear_note': return grouped('note', {action: 'clear'})
    case 'read_note': return grouped('note', {action: 'read'})
    case 'set_theme': return grouped('settings', {theme: args['theme']})
    case 'set_accent': return grouped('settings', {accent: args['color']})
    case 'set_wallpaper': return grouped('settings', {wallpaper: args['scene']})
    case 'set_motion': return grouped('settings', {motion: args['motion']})
    case 'set_arcs': return grouped('settings', {arcs: args['visibility']})
    case 'start_timer': return grouped('timer', {action: 'start', ...args})
    case 'timer': return grouped('timer', {...args})
    case 'browser_navigate': return grouped('browser', {...args})
    default: return grouped(name, {...args})
  }
}
