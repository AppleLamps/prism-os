import {fileCommandNames, validateFileCommand, type FileCommand} from './file-commands.ts'
// The command center's vocabulary: every action Spotlight can take in Prism OS when a
// sentence is typed into it, as function declarations for FunctionGemma, and the
// validator that turns a call the model (or the quick parser) produced into a typed
// command, or rejects it.
//
// This file is the single source of truth for both sides of the model. The page sends
// `toolDeclarations` with every request, and scripts/prismos-dataset.ts writes the
// fine-tuning data from the same declarations, so a command added here and nowhere else
// is a command the next training run learns. After changing anything below, run the
// dataset script and the training job again (see src/prismos/README.md).
import {photoNames} from '../handwiredos/photo-gallery.ts'
import {parseDuration} from './durations.ts'
import {evaluateExpression} from './expression.ts'
import {type AccentName, type Appearance, type SceneName, accents, scenes} from './settings.ts'
import {maximumSearchText, webAddress} from './web-address.ts'

// The handwired program's three windows, and Prism's own apps in glass panels.
export const programApps = ['scope', 'inkwell', 'chroma'] as const
export const panelApps = ['cabinet', 'browser', 'calculator', 'clock', 'terminal', 'settings', 'about'] as const
export const apps = [...programApps, ...panelApps] as const
export type ProgramApp = (typeof programApps)[number]
export type PanelAppName = (typeof panelApps)[number]
export type App = (typeof apps)[number]
export const isProgramApp = (app: App): app is ProgramApp => (programApps as readonly string[]).includes(app)

// The window manager's order: window 0 is Scope (Monitor), 1 Inkwell (Notes), 2 Chroma
// (Photos).
export const appWindowIndex: Record<ProgramApp, number> = {scope: 0, inkwell: 1, chroma: 2}
export const appTitle: Record<App, string> = {
  cabinet: 'Cabinet',
  browser: 'Browser',
  scope: 'Scope',
  inkwell: 'Inkwell',
  chroma: 'Chroma',
  calculator: 'Calculator',
  clock: 'Clock',
  terminal: 'Terminal',
  settings: 'Settings',
  about: 'About Prism OS',
}

export const positions = ['left', 'right', 'center', 'top_left', 'top_right', 'bottom_left', 'bottom_right'] as const
export const sizes = ['small', 'medium', 'large', 'bigger', 'smaller'] as const
export const scopeViews = ['state', 'operations', 'outputs'] as const
export const scopeListActions = ['up', 'down', 'page_up', 'page_down', 'top', 'bottom'] as const
export const themes = ['light', 'dark', 'auto'] as const satisfies readonly Appearance[]
export const accentNames = Object.keys(accents) as AccentName[]
export const sceneNames = Object.keys(scenes) as SceneName[]
export const onOff = ['on', 'off'] as const
export const arcVisibilities = ['shown', 'hidden'] as const
export const topics = ['prism_os', 'scope', 'inkwell', 'chroma', 'browser', 'calculator', 'clock', 'terminal', 'handwired', 'command_center'] as const
export const noteModes = ['append', 'replace'] as const
export const slideshowActions = ['start', 'stop'] as const
export const stopwatchActions = ['start', 'stop', 'lap', 'reset'] as const
export const timerActions = ['pause', 'resume', 'cancel'] as const
export const browserActions = ['back', 'forward', 'reload', 'home'] as const

// The cities `world_time` knows, by the names people use, with their time zones. "here"
// is the visitor's own zone.
export const cities: Readonly<Record<string, string>> = {
  'here': '',
  'cupertino': 'America/Los_Angeles',
  'san francisco': 'America/Los_Angeles',
  'los angeles': 'America/Los_Angeles',
  'seattle': 'America/Los_Angeles',
  'denver': 'America/Denver',
  'chicago': 'America/Chicago',
  'new york': 'America/New_York',
  'boston': 'America/New_York',
  'toronto': 'America/Toronto',
  'mexico city': 'America/Mexico_City',
  'sao paulo': 'America/Sao_Paulo',
  'honolulu': 'Pacific/Honolulu',
  'london': 'Europe/London',
  'paris': 'Europe/Paris',
  'berlin': 'Europe/Berlin',
  'madrid': 'Europe/Madrid',
  'rome': 'Europe/Rome',
  'amsterdam': 'Europe/Amsterdam',
  'moscow': 'Europe/Moscow',
  'dubai': 'Asia/Dubai',
  'mumbai': 'Asia/Kolkata',
  'delhi': 'Asia/Kolkata',
  'singapore': 'Asia/Singapore',
  'hong kong': 'Asia/Hong_Kong',
  'beijing': 'Asia/Shanghai',
  'shanghai': 'Asia/Shanghai',
  'seoul': 'Asia/Seoul',
  'tokyo': 'Asia/Tokyo',
  'sydney': 'Australia/Sydney',
  'auckland': 'Pacific/Auckland',
}

export type Command = FileCommand
  | {name: 'open_app', app: App}
  | {name: 'minimize_app', app: App}
  | {name: 'maximize_app', app: App}
  | {name: 'restore_app', app: App}
  | {name: 'close_app', app: App}
  | {name: 'move_app', app: App, position: (typeof positions)[number]}
  | {name: 'resize_app', app: ProgramApp, size: (typeof sizes)[number]}
  | {name: 'side_by_side', left: ProgramApp, right: ProgramApp}
  | {name: 'show_desktop'}
  | {name: 'reset_layout'}
  | {name: 'open_photo', photo: number, bundled?: boolean}
  // `bare` marks "next", "back" and the like, said without naming photos: they act on
  // the front app, so they step Browser's pages while Browser is in front.
  | {name: 'next_photo', bare?: true}
  | {name: 'previous_photo', bare?: true}
  | {name: 'close_photo'}
  | {name: 'slideshow', action: (typeof slideshowActions)[number]}
  | {name: 'scope_show', view: (typeof scopeViews)[number]}
  | {name: 'scope_list', action: (typeof scopeListActions)[number]}
  | {name: 'write_note', text: string, mode: (typeof noteModes)[number]}
  | {name: 'clear_note'}
  | {name: 'read_note'}
  | {name: 'set_theme', theme: Appearance}
  | {name: 'set_accent', color: AccentName}
  | {name: 'set_wallpaper', scene: SceneName}
  | {name: 'set_motion', motion: (typeof onOff)[number]}
  | {name: 'set_arcs', visibility: (typeof arcVisibilities)[number]}
  | {name: 'calculate', expression: string}
  | {name: 'stopwatch', action: (typeof stopwatchActions)[number]}
  | {name: 'start_timer', seconds: number}
  | {name: 'timer', action: (typeof timerActions)[number]}
  | {name: 'world_time', city: string}
  | {name: 'open_website', url: string}
  | {name: 'search_web', query: string}
  | {name: 'browser_navigate', action: (typeof browserActions)[number]}
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

const appParameter: Parameter = {type: 'STRING', description: 'The app', enum: apps}
const programAppParameter: Parameter = {type: 'STRING', description: 'The program window: scope, inkwell or chroma', enum: programApps}

function tool(name: CommandName, description: string, properties: Record<string, Parameter> = {}): ToolDeclaration {
  return {type: 'function', function: {name, description, parameters: {type: 'OBJECT', properties, required: Object.keys(properties)}}}
}

// Short descriptions on purpose: every request carries all of them, and each token of the
// prompt is work for a 270M model in the browser.
export const toolDeclarations: readonly ToolDeclaration[] = [
  tool('list_files', 'List files in a Cabinet folder', {path: {type: 'STRING', description: 'Cabinet path, absolute or relative to the current folder'}}),
  tool('open_file', 'Open a file or folder by Cabinet path', {path: {type: 'STRING', description: 'Cabinet path, absolute or relative to the current folder'}}),
  tool('create_folder', 'Create a Cabinet folder', {path: {type: 'STRING', description: 'Cabinet path, absolute or relative to the current folder'}}),
  tool('create_document', 'Create an empty text document', {path: {type: 'STRING', description: 'Cabinet path, absolute or relative to the current folder'}}),
  tool('save_note_as', 'Save the current Inkwell draft to a new file', {path: {type: 'STRING', description: 'Cabinet path, absolute or relative to the current folder'}}),
  tool('duplicate_file', 'Duplicate a file or folder', {path: {type: 'STRING', description: 'Cabinet path, absolute or relative to the current folder'}}),
  tool('trash_file', 'Move a file or folder to recoverable Trash', {path: {type: 'STRING', description: 'Cabinet path, absolute or relative to the current folder'}}),
  tool('restore_file', 'Restore an item from Trash', {path: {type: 'STRING', description: 'Cabinet path, absolute or relative to the current folder'}}),
  tool('download_file', 'Download a Cabinet file', {path: {type: 'STRING', description: 'Cabinet path, absolute or relative to the current folder'}}),
  tool('delete_file', 'Permanently delete an item from Trash', {path: {type: 'STRING', description: 'Cabinet path, absolute or relative to the current folder'}}),
  tool('search_files', 'Search all live files by name', {query: {type: 'STRING', description: 'Part of the file name'}}),
  tool('rename_file', 'Rename a file or folder', {path: {type: 'STRING', description: 'Cabinet path, absolute or relative to the current folder'}, new_name: {type: 'STRING', description: 'New item name'}}),
  tool('move_file', 'Move an item to a folder', {path: {type: 'STRING', description: 'Cabinet path, absolute or relative to the current folder'}, destination: {type: 'STRING', description: 'Destination folder path'}}),
  tool('empty_trash', 'Permanently delete everything in Trash', {}),
  tool('import_files', 'Open Cabinet so the user can press Import', {}),
  tool('open_app', 'Open, show or bring an app to the front', {app: appParameter}),
  tool('minimize_app', 'Minimize an app into the dock', {app: appParameter}),
  tool('maximize_app', 'Maximize an app to fill the screen', {app: appParameter}),
  tool('restore_app', 'Restore a maximized or minimized app to its normal size', {app: appParameter}),
  tool('close_app', 'Close an app', {app: appParameter}),
  tool('move_app', 'Move an app\'s window to a part of the screen', {
    app: appParameter,
    position: {type: 'STRING', description: 'Where to move it', enum: positions},
  }),
  tool('resize_app', 'Resize a program window', {
    app: programAppParameter,
    size: {type: 'STRING', description: 'The new size, or bigger or smaller than now', enum: sizes},
  }),
  tool('side_by_side', 'Put two program windows next to each other, each on half the screen', {
    left: {type: 'STRING', description: 'The window on the left', enum: programApps},
    right: {type: 'STRING', description: 'The window on the right', enum: programApps},
  }),
  tool('show_desktop', 'Minimize every window to show the desktop'),
  tool('reset_layout', 'Put the program windows back where they opened'),
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
  tool('set_theme', 'Set light or dark appearance', {
    theme: {type: 'STRING', description: 'light, dark, or auto to follow the device', enum: themes},
  }),
  tool('set_accent', 'Set the accent color', {
    color: {type: 'STRING', description: 'The color', enum: accentNames},
  }),
  tool('set_wallpaper', 'Change the wallpaper scene', {
    scene: {type: 'STRING', description: 'The scene', enum: sceneNames},
  }),
  tool('set_motion', 'Turn the wallpaper animation on or off', {
    motion: {type: 'STRING', description: 'on or off', enum: onOff},
  }),
  tool('set_arcs', 'Show or hide the arcs of the program weights behind the windows', {
    visibility: {type: 'STRING', description: 'shown or hidden', enum: arcVisibilities},
  }),
  tool('calculate', 'Do arithmetic', {
    expression: {type: 'STRING', description: 'The arithmetic, e.g. 17 * 23'},
  }),
  tool('stopwatch', 'Use the stopwatch in Clock', {
    action: {type: 'STRING', description: 'start, stop, lap or reset', enum: stopwatchActions},
  }),
  tool('start_timer', 'Start a countdown timer in Clock', {
    duration: {type: 'STRING', description: 'How long, e.g. 5 minutes'},
  }),
  tool('timer', 'Pause, resume or cancel the timer in Clock', {
    action: {type: 'STRING', description: 'pause, resume or cancel', enum: timerActions},
  }),
  tool('world_time', 'Tell the time in a city', {
    city: {type: 'STRING', description: 'The city, or here'},
  }),
  tool('open_website', 'Open a web page in Browser', {
    address: {type: 'STRING', description: 'The web address, e.g. wikipedia.org'},
  }),
  tool('search_web', 'Search the web in Browser, also to answer questions about the world', {
    query: {type: 'STRING', description: 'What to search for'},
  }),
  tool('browser_navigate', 'Go back, forward, reload, or to Favorites in Browser', {
    action: {type: 'STRING', description: 'back, forward, reload or home', enum: browserActions},
  }),
  tool('get_stats', 'Report the live numbers of the program that runs Prism OS'),
  tool('explain', 'Explain a part of Prism OS', {
    topic: {type: 'STRING', description: 'What to explain', enum: topics},
  }),
]

// The words people use for each app, besides its name. Lowercase.
export const appAliases: Record<App, readonly string[]> = {
  cabinet: ['cabinet', 'files', 'file manager', 'the files', 'the file manager'],
  // The browsers people know by name all mean Browser: "open safari" opens it.
  browser: ['browser', 'web browser', 'the browser', 'the web browser', 'internet', 'the internet', 'the web', 'safari', 'chrome', 'google chrome', 'firefox', 'edge', 'microsoft edge'],
  scope: ['scope', 'monitor', 'inspector', 'the inspector', 'circuit inspector'],
  inkwell: ['inkwell', 'notes', 'note', 'the note', 'notepad', 'ink well'],
  chroma: ['chroma', 'photos', 'photo', 'gallery', 'pictures', 'the gallery', 'images'],
  calculator: ['calculator', 'calc', 'the calculator'],
  clock: ['clock', 'clocks', 'world clock', 'stopwatch', 'timer', 'the clock'],
  terminal: ['terminal', 'shell', 'console', 'command line', 'the terminal'],
  settings: ['settings', 'preferences', 'system settings', 'prefs', 'the settings'],
  about: ['about', 'about prism', 'about prism os', 'about this os'],
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

// A city of `cities`, or null.
export function parseCity(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase().replace(/^(in|at)\s+/u, '').replace(/[.?!]+$/u, '')
    .replace('são paulo', 'sao paulo').replace(/^nyc$/u, 'new york').replace(/^sf$/u, 'san francisco').replace(/^la$/u, 'los angeles')
  if (['here', 'local', 'my time', 'now', 'right now'].includes(key)) return 'here'
  return Object.hasOwn(cities, key) ? key : null
}

// The words people use for settings that the store names otherwise.
const themeAliases: Record<string, Appearance> = {system: 'auto', automatic: 'auto', device: 'auto', night: 'dark', day: 'light'}
const accentAliases: Record<string, AccentName> = {turquoise: 'teal', gray: 'graphite', grey: 'graphite', gold: 'yellow', amber: 'orange'}

function oneOf<const Values extends readonly string[]>(values: Values, value: unknown, aliases: Record<string, Values[number]> = {}): Values[number] | null {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase().replace(/[\s-]+/gu, '_')
  if (values.includes(key)) return key
  return Object.hasOwn(aliases, key) ? aliases[key]! : null
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
  const unknownApp = (key = 'app') => fail(`I don't know an app called "${String(args[key])}".`)
  if ((fileCommandNames as readonly string[]).includes(name)) {
    try { return done(validateFileCommand(name, args)) } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  }
  switch (name) {
    case 'open_app':
    case 'minimize_app':
    case 'maximize_app':
    case 'restore_app':
    case 'close_app': {
      const app = parseApp(args['app'])
      // One object for five names, which TypeScript can't check against the union.
      return app === null ? unknownApp() : done({name, app} as Command)
    }
    case 'move_app': {
      const app = parseApp(args['app'])
      const position = oneOf(positions, args['position'])
      if (app === null) return unknownApp()
      return position === null ? fail('I can move a window left, right, center, or into a corner.') : done({name, app, position})
    }
    case 'resize_app': {
      const app = parseApp(args['app'])
      const size = oneOf(sizes, args['size'])
      if (app === null) return unknownApp()
      if (!isProgramApp(app)) return fail(`${appTitle[app]} keeps its size. I can resize Scope, Inkwell and Chroma.`)
      return size === null ? fail('I can make a window small, medium, large, bigger or smaller.') : done({name, app, size})
    }
    case 'side_by_side': {
      const left = parseApp(args['left'])
      const right = parseApp(args['right'])
      if (left === null || right === null) return fail('Side by side needs two apps.')
      if (!isProgramApp(left) || !isProgramApp(right)) return fail('Side by side works with Scope, Inkwell and Chroma.')
      return left === right ? fail('Side by side needs two different apps.') : done({name, left, right})
    }
    case 'next_photo':
    case 'previous_photo':
      return done(args['bare'] === true ? {name, bare: true} : {name})
    case 'show_desktop':
    case 'reset_layout':
    case 'close_photo':
    case 'clear_note':
    case 'read_note':
    case 'get_stats':
      return done({name})
    case 'open_photo': {
      const value = args['photo']
      const key = typeof value === 'string' ? value.trim().toLowerCase().replace(/^(the\s+)?(photo|picture|image|pic)\s*/u, '') : ''
      const bundled = key.length >= 4 && photoNames.some(title => title.toLowerCase().includes(key))
      const parsed = parsePhoto(value)
      const number = typeof value === 'number' ? value : /^\d+$/u.test(key) ? Number(key) : 0
      const photo = parsed ?? (Number.isSafeInteger(number) && number >= 1 ? number - 1 : null)
      if (photo !== null) return done(bundled ? {name, photo, bundled: true} : {name, photo})
      if (typeof value === 'string' && /\.[a-z0-9]+$/iu.test(value)) {
        try { return done(validateFileCommand('open_file', {path: value})) } catch { return fail('Provide an image path in Cabinet.') }
      }
      return fail(`Choose an image in Cabinet or a bundled photo: ${photoNames.join(', ')}.`)
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
      const theme = oneOf(themes, args['theme'], themeAliases)
      return theme === null ? fail('The appearance can be light, dark or auto.') : done({name, theme})
    }
    case 'set_accent': {
      const color = oneOf(accentNames, args['color'], accentAliases)
      return color === null ? fail(`The accent can be ${accentNames.join(', ')}.`) : done({name, color})
    }
    case 'set_wallpaper': {
      const scene = oneOf(sceneNames, args['scene'])
      return scene === null ? fail(`The wallpaper can be ${sceneNames.join(', ')}.`) : done({name, scene})
    }
    case 'set_motion': {
      const motion = oneOf(onOff, args['motion'], {true: 'on', false: 'off', animated: 'on', still: 'off'})
      return motion === null ? fail('Wallpaper motion can be on or off.') : done({name, motion})
    }
    case 'set_arcs': {
      const visibility = oneOf(arcVisibilities, args['visibility'], {on: 'shown', off: 'hidden', show: 'shown', hide: 'hidden'})
      return visibility === null ? fail('The arcs can be shown or hidden.') : done({name, visibility})
    }
    case 'calculate': {
      const expression = args['expression']
      if (typeof expression !== 'string') return fail('What should I calculate?')
      const result = evaluateExpression(expression)
      return result.ok ? done({name, expression: result.expression}) : fail(result.reason)
    }
    case 'stopwatch': {
      const action = oneOf(stopwatchActions, args['action'])
      return action === null ? fail('The stopwatch can start, stop, lap or reset.') : done({name, action})
    }
    case 'start_timer': {
      const seconds = parseDuration(args['duration'])
      return seconds === null ? fail('A timer can run from a second to a day, e.g. 5 minutes, 90 seconds or 1:30.') : done({name, seconds})
    }
    case 'timer': {
      const action = oneOf(timerActions, args['action'], {stop: 'cancel', clear: 'cancel', continue: 'resume', unpause: 'resume'})
      return action === null ? fail('The timer can pause, resume or cancel.') : done({name, action})
    }
    case 'browser_navigate': {
      const action = oneOf(browserActions, args['action'], {refresh: 'reload', favorites: 'home', previous: 'back', next: 'forward'})
      return action === null ? fail('Browser can go back, forward, reload or home.') : done({name, action})
    }
    case 'world_time': {
      const city = parseCity(args['city'] ?? 'here')
      return city === null ? fail(`I know the time in ${Object.keys(cities).filter(key => key !== 'here').map(key => key.replace(/\b\w/gu, letter => letter.toUpperCase())).join(', ')}.`) : done({name, city})
    }
    case 'open_website': {
      const url = webAddress(args['address'])
      return url === null ? fail('That isn\'t a web address. Try one like wikipedia.org, or ask me to search the web.') : done({name, url})
    }
    case 'search_web': {
      const query = args['query']
      if (typeof query !== 'string' || query.trim() === '') return fail('What should I search for?')
      return done({name, query: query.trim().slice(0, maximumSearchText)})
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
    case 'delete_file': return `Permanently delete ${command.path}?`
    case 'empty_trash': return 'Permanently delete everything in Trash?'
    case 'clear_note':
      return 'Erase everything in the note?'
    case 'write_note':
      return command.mode === 'replace' ? 'Replace the whole note?' : null
    default:
      return null
  }
}
