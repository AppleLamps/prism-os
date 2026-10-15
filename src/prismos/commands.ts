// The command center's vocabulary: every action the operator can take in Prism OS, as
// function declarations for FunctionGemma, and the validator that turns a call the model
// (or the quick parser) produced into a typed command, or rejects it.
//
// This file is the single source of truth for both sides of the model. The page sends
// `toolDeclarations` with every request, and scripts/prismos-dataset.ts writes the
// fine-tuning data from the same declarations, so a command added here and nowhere else
// is a command the next training run learns. After changing anything below, run the
// dataset script and the training job again (see src/prismos/README.md).
import {photoNames} from '../handwiredos/photo-gallery.ts'

export const apps = ['scope', 'inkwell', 'chroma'] as const
export type App = (typeof apps)[number]
// The window manager's order: window 0 is Scope (Monitor), 1 Inkwell (Notes), 2 Chroma
// (Photos).
export const appWindowIndex: Record<App, number> = {scope: 0, inkwell: 1, chroma: 2}
export const appTitle: Record<App, string> = {scope: 'Scope', inkwell: 'Inkwell', chroma: 'Chroma'}

export const positions = ['left', 'right', 'center', 'top_left', 'top_right', 'bottom_left', 'bottom_right'] as const
export const sizes = ['small', 'medium', 'large', 'bigger', 'smaller'] as const
export const scopeViews = ['state', 'operations', 'outputs'] as const
export const scopeListActions = ['up', 'down', 'page_up', 'page_down', 'top', 'bottom'] as const
export const themes = ['light', 'dark', 'system'] as const
export const accents = ['blue', 'teal', 'green', 'sand', 'graphite'] as const
export const wallpaperModes = ['animated', 'still'] as const
export const transparencyLevels = ['normal', 'reduced'] as const
export const arcVisibilities = ['shown', 'hidden'] as const
export const links = ['demos', 'source'] as const
export const topics = ['prism_os', 'scope', 'inkwell', 'chroma', 'handwired', 'command_center'] as const
export const noteModes = ['append', 'replace'] as const
export const slideshowActions = ['start', 'stop'] as const

export type Command =
  | {name: 'open_app', app: App}
  | {name: 'minimize_app', app: App}
  | {name: 'maximize_app', app: App}
  | {name: 'restore_app', app: App}
  | {name: 'close_app', app: App}
  | {name: 'move_app', app: App, position: (typeof positions)[number]}
  | {name: 'resize_app', app: App, size: (typeof sizes)[number]}
  | {name: 'side_by_side', left: App, right: App}
  | {name: 'show_desktop'}
  | {name: 'reset_layout'}
  | {name: 'open_photo', photo: number}
  | {name: 'next_photo'}
  | {name: 'previous_photo'}
  | {name: 'close_photo'}
  | {name: 'slideshow', action: (typeof slideshowActions)[number]}
  | {name: 'scope_show', view: (typeof scopeViews)[number]}
  | {name: 'scope_list', action: (typeof scopeListActions)[number]}
  | {name: 'write_note', text: string, mode: (typeof noteModes)[number]}
  | {name: 'clear_note'}
  | {name: 'read_note'}
  | {name: 'set_theme', theme: (typeof themes)[number]}
  | {name: 'set_accent', color: (typeof accents)[number]}
  | {name: 'set_wallpaper', motion: (typeof wallpaperModes)[number]}
  | {name: 'set_transparency', level: (typeof transparencyLevels)[number]}
  | {name: 'set_arcs', visibility: (typeof arcVisibilities)[number]}
  | {name: 'open_link', link: (typeof links)[number]}
  | {name: 'get_stats'}
  | {name: 'explain', topic: (typeof topics)[number]}

export type CommandName = Command['name']

type Parameter = {type: 'STRING', description: string, enum?: readonly string[]}
export type ToolDeclaration = {
  type: 'function'
  function: {
    name: CommandName
    description: string
    parameters: {type: 'OBJECT', properties: Record<string, Parameter>, required: string[]}
  }
}

const appParameter: Parameter = {type: 'STRING', description: 'The app: scope, inkwell or chroma', enum: apps}

function tool(name: CommandName, description: string, properties: Record<string, Parameter> = {}): ToolDeclaration {
  return {type: 'function', function: {name, description, parameters: {type: 'OBJECT', properties, required: Object.keys(properties)}}}
}

// Short descriptions on purpose: every request carries all of them, and each token of the
// prompt is work for a 270M model in the browser.
export const toolDeclarations: readonly ToolDeclaration[] = [
  tool('open_app', 'Open, show or bring an app window to the front', {app: appParameter}),
  tool('minimize_app', 'Minimize an app window into the dock', {app: appParameter}),
  tool('maximize_app', 'Maximize an app window to fill the screen', {app: appParameter}),
  tool('restore_app', 'Restore a maximized or minimized app window to its normal size', {app: appParameter}),
  tool('close_app', 'Close an app window', {app: appParameter}),
  tool('move_app', 'Move an app window to a part of the screen', {
    app: appParameter,
    position: {type: 'STRING', description: 'Where to move it', enum: positions},
  }),
  tool('resize_app', 'Resize an app window', {
    app: appParameter,
    size: {type: 'STRING', description: 'The new size, or bigger or smaller than now', enum: sizes},
  }),
  tool('side_by_side', 'Put two app windows next to each other, each on half the screen', {
    left: {type: 'STRING', description: 'The app on the left', enum: apps},
    right: {type: 'STRING', description: 'The app on the right', enum: apps},
  }),
  tool('show_desktop', 'Minimize every window to show the desktop'),
  tool('reset_layout', 'Put every window back where it opened'),
  tool('open_photo', 'Open a photo in Chroma', {
    photo: {type: 'STRING', description: 'The photo name, or its number from 1 to 12'},
  }),
  tool('next_photo', 'Show the next photo in Chroma'),
  tool('previous_photo', 'Show the previous photo in Chroma'),
  tool('close_photo', 'Close the open photo and go back to the grid'),
  tool('slideshow', 'Start or stop a slideshow of the photos', {
    action: {type: 'STRING', description: 'start or stop', enum: slideshowActions},
  }),
  tool('scope_show', 'Show a list in Scope, the inspector of the program', {
    view: {type: 'STRING', description: 'Which list', enum: scopeViews},
  }),
  tool('scope_list', 'Move through the list in Scope', {
    action: {type: 'STRING', description: 'How to move', enum: scopeListActions},
  }),
  tool('write_note', 'Write text into the note in Inkwell', {
    text: {type: 'STRING', description: 'The text to write'},
    mode: {type: 'STRING', description: 'append adds to the note, replace replaces it', enum: noteModes},
  }),
  tool('clear_note', 'Erase the note in Inkwell'),
  tool('read_note', 'Read the note in Inkwell'),
  tool('set_theme', 'Set light or dark mode', {
    theme: {type: 'STRING', description: 'light, dark, or system to follow the device', enum: themes},
  }),
  tool('set_accent', 'Set the accent color', {
    color: {type: 'STRING', description: 'The color', enum: accents},
  }),
  tool('set_wallpaper', 'Animate the wallpaper or hold it still', {
    motion: {type: 'STRING', description: 'animated or still', enum: wallpaperModes},
  }),
  tool('set_transparency', 'Set how see-through the glass is', {
    level: {type: 'STRING', description: 'normal glass, or reduced for solid surfaces', enum: transparencyLevels},
  }),
  tool('set_arcs', 'Show or hide the arcs of the program weights behind the windows', {
    visibility: {type: 'STRING', description: 'shown or hidden', enum: arcVisibilities},
  }),
  tool('open_link', 'Leave Prism OS for another page', {
    link: {type: 'STRING', description: 'demos for all demos, source for the source code', enum: links},
  }),
  tool('get_stats', 'Report the live numbers of the program that runs Prism OS'),
  tool('explain', 'Explain a part of Prism OS', {
    topic: {type: 'STRING', description: 'What to explain', enum: topics},
  }),
]

// The words people use for each app, besides its name. Lowercase.
export const appAliases: Record<App, readonly string[]> = {
  scope: ['scope', 'monitor', 'inspector', 'the inspector', 'circuit inspector'],
  inkwell: ['inkwell', 'notes', 'note', 'the note', 'notepad', 'ink well'],
  chroma: ['chroma', 'photos', 'photo', 'gallery', 'pictures', 'the gallery', 'images'],
}

export function parseApp(value: unknown): App | null {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase()
  for (const app of apps) {
    if (app === key || appAliases[app].includes(key)) return app
  }
  return null
}

const numberWords = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
const ordinalWords = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth']

// A photo by name ("Blue Lagoon"), number ("3", "photo 3", "three", "third"), as an index
// from 0 to 11, or null.
export function parsePhoto(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 1 && value <= photoNames.length ? value - 1 : null
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase().replace(/^(the\s+)?(photo|picture|image|pic)\s*/u, '').replace(/^(number|#|no\.?)\s*/u, '').trim()
  const nameIndex = photoNames.findIndex(name => name.toLowerCase() === key)
  if (nameIndex !== -1) return nameIndex
  const partial = photoNames.findIndex(name => key.length >= 4 && name.toLowerCase().includes(key))
  if (partial !== -1) return partial
  const digits = /^(\d{1,2})(st|nd|rd|th)?$/u.exec(key)
  if (digits !== null) return parsePhoto(Number(digits[1]))
  const word = numberWords.indexOf(key)
  if (word !== -1) return word
  const ordinal = ordinalWords.indexOf(key)
  if (ordinal !== -1) return ordinal
  return null
}

function oneOf<const Values extends readonly string[]>(values: Values, value: unknown): Values[number] | null {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase().replace(/[\s-]+/gu, '_')
  return values.includes(key) ? key : null
}

// The longest note text a command may write, so a runaway generation can't fill the note.
export const maximumNoteText = 2000

export type Validation = {ok: true, command: Command} | {ok: false, reason: string}

// Turns a call, e.g. {name: 'move_app', arguments: {app: 'Notes', position: 'left'}}, into a
// command, accepting the aliases and spellings above. Everything the operator runs passes
// through here, whether it came from the model or the quick parser.
export function validateCall(name: string, args: Readonly<Record<string, unknown>>): Validation {
  const fail = (reason: string): Validation => ({ok: false, reason})
  const done = (command: Command): Validation => ({ok: true, command})
  const app = (key = 'app') => parseApp(args[key])
  switch (name) {
    case 'open_app':
    case 'minimize_app':
    case 'maximize_app':
    case 'restore_app':
    case 'close_app': {
      const value = app()
      return value === null ? fail(`I don't know an app called "${String(args['app'])}".`) : done({name, app: value})
    }
    case 'move_app': {
      const value = app()
      const position = oneOf(positions, args['position'])
      if (value === null) return fail(`I don't know an app called "${String(args['app'])}".`)
      return position === null ? fail('I can move a window left, right, center, or into a corner.') : done({name, app: value, position})
    }
    case 'resize_app': {
      const value = app()
      const size = oneOf(sizes, args['size'])
      if (value === null) return fail(`I don't know an app called "${String(args['app'])}".`)
      return size === null ? fail('I can make a window small, medium, large, bigger or smaller.') : done({name, app: value, size})
    }
    case 'side_by_side': {
      const left = app('left')
      const right = app('right')
      if (left === null || right === null) return fail('Side by side needs two apps.')
      return left === right ? fail('Side by side needs two different apps.') : done({name, left, right})
    }
    case 'show_desktop':
    case 'reset_layout':
    case 'next_photo':
    case 'previous_photo':
    case 'close_photo':
    case 'clear_note':
    case 'read_note':
    case 'get_stats':
      return done({name})
    case 'open_photo': {
      const photo = parsePhoto(args['photo'])
      return photo === null ? fail(`Chroma has 12 photos: ${photoNames.join(', ')}.`) : done({name, photo})
    }
    case 'slideshow': {
      const action = oneOf(slideshowActions, args['action'])
      return action === null ? fail('A slideshow can start or stop.') : done({name, action})
    }
    case 'scope_show': {
      const view = oneOf(scopeViews, args['view'])
      return view === null ? fail('Scope shows state, operations or outputs.') : done({name, view})
    }
    case 'scope_list': {
      const action = oneOf(scopeListActions, args['action'])
      return action === null ? fail('Scope\'s list moves up, down, a page at a time, to the top or to the bottom.') : done({name, action})
    }
    case 'write_note': {
      const text = args['text']
      const mode = args['mode'] === undefined ? 'append' : oneOf(noteModes, args['mode'])
      if (typeof text !== 'string' || text.trim() === '') return fail('What should I write?')
      if (mode === null) return fail('I can add to the note or replace it.')
      return done({name, text: text.slice(0, maximumNoteText), mode})
    }
    case 'set_theme': {
      const theme = oneOf(themes, args['theme'])
      return theme === null ? fail('The theme can be light, dark or system.') : done({name, theme})
    }
    case 'set_accent': {
      const color = oneOf(accents, args['color'])
      return color === null ? fail(`The accent can be ${accents.join(', ')}.`) : done({name, color})
    }
    case 'set_wallpaper': {
      const motion = oneOf(wallpaperModes, args['motion'])
      return motion === null ? fail('The wallpaper can be animated or still.') : done({name, motion})
    }
    case 'set_transparency': {
      const level = oneOf(transparencyLevels, args['level'])
      return level === null ? fail('Transparency can be normal or reduced.') : done({name, level})
    }
    case 'set_arcs': {
      const visibility = oneOf(arcVisibilities, args['visibility'])
      return visibility === null ? fail('The arcs can be shown or hidden.') : done({name, visibility})
    }
    case 'open_link': {
      const link = oneOf(links, args['link'])
      return link === null ? fail('I can open all demos or the source code.') : done({name, link})
    }
    case 'explain': {
      const topic = oneOf(topics, args['topic'])
      return topic === null ? fail(`I can explain ${topics.join(', ').replaceAll('_', ' ')}.`) : done({name, topic})
    }
    default:
      return fail(`I don't have a command called "${name}".`)
  }
}

// Commands that change what's on screen in ways that are hard to take back ask first.
export function needsConfirmation(command: Command): string | null {
  switch (command.name) {
    case 'clear_note':
      return 'Erase everything in the note?'
    case 'write_note':
      return command.mode === 'replace' ? 'Replace the whole note?' : null
    case 'open_link':
      return command.link === 'demos' ? 'Leave Prism OS for the demos page?' : 'Leave Prism OS for the source code?'
    default:
      return null
  }
}
