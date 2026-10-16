// The quick parser: patterns for the sentences people type most, e.g. "dark mode",
// "minimize inkwell", "put scope and chroma side by side" or "what is 17 times 23". A
// sentence that matches runs at once, with no model, which is how Spotlight runs
// commands until the model ships. Anything else returns null: the model's turn, or a hint.
// The patterns match the whole sentence, so "don't close scope" never closes Scope.
import {parsePhoto, type Command, accentNames, appAliases, apps, parseApp, parseCity, positions, sceneNames, validateCall} from './commands.ts'
import {evaluateExpression} from './expression.ts'
import {photoNames} from '../handwiredos/photo-gallery.ts'
import {webAddress} from './web-address.ts'

function normalize(input: string) {
  return input
    .toLowerCase()
    .replace(/[’']/gu, '')
    .replace(/[!?]+/gu, ' ')
    .replace(/\.(?=\s|$)/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^(please|pls|hey|ok|okay|can you|could you|would you)\s+/u, '')
    .replace(/\s+(please|pls|thanks|thank you|now)$/u, '')
    .replace(/,$/u, '')
    .trim()
}

const alternatives = (words: readonly string[]) => [...words].sort((a, b) => b.length - a.length).map(word => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')
const appWords = `(${alternatives(apps.flatMap(app => [app, ...appAliases[app]]))})`
const the = '(?:(?:the|my)\\s+)?'
// "note to self" and "note this" before "note", so the note doesn't start with "to self"
// or "this:".
const runsOn = /,|\s(?:and|then|open|close|show|hide|go|search|set|start|move|make|write|minimize|maximize)\s/iu
const notePattern = /^(?:note to self|note this|note|jot down|write down|take a note|add to (?:my |the )?notes?)[:,]? (.+)$/iu
const windowWord = '(?:\\s+(?:app|window))?'
const app = `${the}${appWords}${windowWord}`
const positionWords: Record<string, (typeof positions)[number]> = {
  'left': 'left', 'right': 'right', 'center': 'center', 'centre': 'center', 'middle': 'center',
  'top left': 'top_left', 'upper left': 'top_left', 'top right': 'top_right', 'upper right': 'top_right',
  'bottom left': 'bottom_left', 'lower left': 'bottom_left', 'bottom right': 'bottom_right', 'lower right': 'bottom_right',
}
const sizeWords: Record<string, string> = {bigger: 'bigger', larger: 'bigger', smaller: 'smaller', small: 'small', tiny: 'small', medium: 'medium', large: 'large', big: 'large', huge: 'large'}
const viewWords: Record<string, string> = {'state': 'state', 'source cells': 'state', 'cells': 'state', 'operations': 'operations', 'ops': 'operations', 'outputs': 'outputs'}

type Call = Record<string, unknown> & {name: string}
type Rule = [RegExp, (match: RegExpExecArray) => Call | Call[] | null]

const rules: Rule[] = [
  // Cabinet's commands with a path are read from the words as written, see one().
  [/^empty (?:the )?trash$/u, () => ({name: 'empty_trash'})],
  [/^import files$/u, () => ({name: 'import_files'})],
  // Clock, first: "start the stopwatch" is the stopwatch, not "start" an app named Clock.
  [/^(start|stop|reset|lap) (?:the )?stopwatch$|^stopwatch (start|stop|reset|lap)$|^(lap)(?: time)?$/u, m => ({name: 'stopwatch', action: m[1] ?? m[2] ?? m[3]})],
  // The timer: pausing and canceling first, so "cancel the timer" is never a length.
  [/^(pause|stop|cancel|resume|continue|clear|end) (?:the |my )?timer$|^timer (pause|stop|cancel|resume)$/u, m => ({name: 'timer', action: m[1] ?? m[2]})],
  [/^(?:set|start|make)(?: a| an| the)? timer (?:for|to) (.+)$|^(?:set|start)(?: a| an)? (.+?) timer$|^timer (?:for )?(.+)$|^(?:a |an )?(\S+(?: \S+){0,3}) timer$/u, m => ({name: 'start_timer', duration: m[1] ?? m[2] ?? m[3] ?? m[4]})],
  // Questions about the weather are web searches.
  [/^(?:(?:whats|what is|hows|how is) )?(?:the )?(?:weather(?: forecast)?|forecast)(?: like)?(?: (?:today|tomorrow|tonight|now|right now|this week|this weekend))?(?: (?:in|for|at) [a-z .]+?)?(?: (?:today|tomorrow|tonight|this week|this weekend))?$|^(?:will it|is it going to) (?:rain|snow)(?: [a-z ]+)?$/u, m => ({name: 'search_web', query: m[0]})],
  [/^(?:what time is it|whats the time|what is the time|time|the time|current time)(?: (?:in|at) (.+))?$|^time in (.+)$/u, m => ({name: 'world_time', city: m[1] ?? m[2] ?? 'here'})],
  // Windows and apps. "close the photo" is Chroma's photo, not Chroma.
  [/^(?:(?:close|exit|leave) (?:the |this )?(?:photo|picture|image)|back to (?:the )?grid)$/u, () => ({name: 'close_photo'})],
  [new RegExp(`^(?:open|show|launch|start|bring up|focus|switch to|go to|pull up) ${app}$`, 'u'), m => ({name: 'open_app', app: m[1]})],
  [new RegExp(`^(?:minimize|minimise|hide) ${app}$`, 'u'), m => ({name: 'minimize_app', app: m[1]})],
  [new RegExp(`^(?:maximize|maximise|fullscreen|full screen|zoom) ${app}$|^(?:make ${app} (?:full screen|fill the screen))$`, 'u'), m => ({name: 'maximize_app', app: m[1] ?? m[2]})],
  [new RegExp(`^(?:restore|unmaximize|unmaximise|exit full screen on|unzoom) ${app}$`, 'u'), m => ({name: 'restore_app', app: m[1]})],
  [new RegExp(`^(?:close|quit|exit) ${app}$`, 'u'), m => ({name: 'close_app', app: m[1]})],
  [new RegExp(`^(?:move|put|drag|snap|send|slide) ${app} (?:to|on|into|over to) (?:the )?(${alternatives(Object.keys(positionWords))})(?: side| edge| corner| half| of the screen)?$`, 'u'),
    m => ({name: 'move_app', app: m[1], position: positionWords[m[2]!]})],
  [new RegExp(`^center ${app}$`, 'u'), m => ({name: 'move_app', app: m[1], position: 'center'})],
  [new RegExp(`^(?:make|resize|set) ${app} (?:to )?(?:a (?:bit|little) )?(${alternatives(Object.keys(sizeWords))})$`, 'u'), m => ({name: 'resize_app', app: m[1], size: sizeWords[m[2]!]})],
  [new RegExp(`^(grow|shrink) ${app}$`, 'u'), m => ({name: 'resize_app', app: m[2], size: m[1] === 'grow' ? 'bigger' : 'smaller'})],
  [new RegExp(`^(?:put |show |tile |place )?${app} (?:and|&|next to|beside|with) ${app}(?: side by side| next to each other)?$`, 'u'),
    m => ({name: 'side_by_side', left: m[1], right: m[2]})],
  [new RegExp(`^(?:put )?${app} (?:on the )?left(?: side)?,? (?:and )?${app} (?:on the )?right(?: side)?$`, 'u'), m => ({name: 'side_by_side', left: m[1], right: m[2]})],
  [/^(?:show (?:the )?desktop|minimize (?:all|everything)(?: windows)?|hide (?:all|everything)(?: windows)?|clear the screen)$/u, () => ({name: 'show_desktop'})],
  [/^(?:reset (?:the )?(?:layout|windows)|put (?:the )?windows back|default layout)$/u, () => ({name: 'reset_layout'})],
  // Appearance and the desk.
  [/^(?:turn on |switch to |use |enable |go |set (?:the )?(?:appearance|theme) to )?(dark|light|night|day)(?: mode| theme| appearance)?(?: on)?$/u, m => ({name: 'set_theme', theme: m[1]})],
  [/^(?:follow|use|match) (?:the |my )?(?:system|device|os)(?: theme| appearance)?$|^(?:auto|automatic) (?:mode|theme|appearance)$/u, () => ({name: 'set_theme', theme: 'auto'})],
  [new RegExp(`^(?:make it |make the accent(?: color)? |set (?:the )?accent(?: color)?(?: to)? |(?:change|switch) (?:the )?accent(?: color)? to |accent(?: color)? )?(${alternatives([...accentNames, 'gray', 'grey', 'turquoise', 'gold', 'amber'])})(?: accent)?$`, 'u'), m => ({name: 'set_accent', color: m[1]})],
  [new RegExp(`^(?:(?:set|change|switch) (?:the )?wallpaper (?:to )?|wallpaper )(${alternatives(sceneNames)})$|^(${alternatives(sceneNames)}) (?:wallpaper|scene)$`, 'u'), m => ({name: 'set_wallpaper', scene: m[1] ?? m[2]})],
  [/^(?:stop|pause|freeze) (?:the )?(?:wallpaper|dunes|background)(?: animation| motion)?$|^(?:wallpaper )?motion off$/u, () => ({name: 'set_motion', motion: 'off'})],
  [/^(?:animate|start|resume|play) (?:the )?(?:wallpaper|dunes|background)(?: animation| motion)?$|^(?:wallpaper )?motion on$/u, () => ({name: 'set_motion', motion: 'on'})],
  [/^(?:hide|turn off) (?:the )?(?:weight )?(?:arcs|wiring)$|^arcs off$/u, () => ({name: 'set_arcs', visibility: 'hidden'})],
  [/^(?:show|turn on) (?:the )?(?:weight )?(?:arcs|wiring)$|^arcs on$/u, () => ({name: 'set_arcs', visibility: 'shown'})],
  // Chroma.
  // Browser's buttons. "back" and "next" alone act on the front app, see the operator.
  [/^(?:refresh|reload)(?: the)?(?: page| website| site| browser| tab)?$/u, () => ({name: 'browser_navigate', action: 'reload'})],
  [/^(?:go )?back (?:a|one) page$|^previous page$|^(?:go )?back in (?:the )?browser$/u, () => ({name: 'browser_navigate', action: 'back'})],
  [/^(?:go )?forward (?:a|one) page$|^(?:go )?forward in (?:the )?browser$/u, () => ({name: 'browser_navigate', action: 'forward'})],
  [/^(?:browser home|(?:show |open |go to )?(?:the )?(?:browser )?favorites)$/u, () => ({name: 'browser_navigate', action: 'home'})],
  [/^(?:next|forward|go forward)$/u, () => ({name: 'next_photo', bare: true})],
  [/^(?:previous|prev|back|go back)$/u, () => ({name: 'previous_photo', bare: true})],
  [/^(?:next photo|next picture)$/u, () => ({name: 'next_photo'})],
  [/^(?:previous photo|previous picture|last photo)$/u, () => ({name: 'previous_photo'})],
  [/^(?:open|show|view) (?:the )?(?:photo|picture|image) (.+)$/u, m => parsePhoto(m[1]) === null && /\.[a-z0-9]+$/iu.test(m[1]!) ? (runsOn.test(m[1]!) ? null : {name: 'open_file', path: m[1]}) : ({name: 'open_photo', photo: m[1]})],
  [new RegExp(`^(?:open|show|view|show me) (?:the )?(${alternatives(photoNames.map(name => name.toLowerCase()))})(?: photo| picture)?$`, 'u'), m => ({name: 'open_photo', photo: m[1]})],
  [/^(?:open|show|view|show me) the (first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth) (?:photo|picture|image)$/u, m => ({name: 'open_photo', photo: m[1]})],
  [/^(?:start (?:a |the )?slideshow|slideshow|play (?:a )?slideshow)$/u, () => ({name: 'slideshow', action: 'start'})],
  [/^(?:stop (?:the )?slideshow|end (?:the )?slideshow)$/u, () => ({name: 'slideshow', action: 'stop'})],
  // Scope.
  [new RegExp(`^(?:show|list|view) (?:me )?(?:the )?(${alternatives(Object.keys(viewWords))})(?: in (?:scope|the inspector))?$`, 'u'), m => ({name: 'scope_show', view: viewWords[m[1]!]})],
  // Inkwell.
  [/^(?:read (?:the |my )?notes?|what does (?:the |my )?note say|whats in (?:my|the) note)$/u, () => ({name: 'read_note'})],
  [/^(?:clear|erase|wipe) (?:the |my )?notes?$/u, () => ({name: 'clear_note'})],
  [new RegExp(notePattern.source, 'u'), m => ({name: 'write_note', text: m[1], mode: 'append'})],
  [/^(?:write|add|put) (.+?) (?:in|to|into) (?:my |the )?(?:notes?|inkwell)$/u, m => ({name: 'write_note', text: m[1], mode: 'append'})],
  // Information.
  [/^(?:stats|statistics|show (?:me )?(?:the )?stats|how big is (?:the )?program|program stats)$/u, () => ({name: 'get_stats'})],
  [/^(?:what is|whats|explain|tell me about) (?:the )?(prism os|prism|this|scope|inkwell|chroma|browser|calculator|clock|terminal|handwired|spotlight)$/u, m => {
    const topic = {'prism os': 'prism_os', 'prism': 'prism_os', 'this': 'prism_os', 'spotlight': 'command_center'}[m[1]!] ?? m[1]
    return {name: 'explain', topic}
  }],
]

// A sentence that is only arithmetic, e.g. "17 * 23", "what is 17 times 23" or
// "calculate (2 + 3) * 4": at least one operator between numbers, nothing else.
function arithmetic(sentence: string): Call | null {
  if (!/\d/u.test(sentence)) return null
  const result = evaluateExpression(sentence)
  if (!result.ok || !/\d\s*[-+*/^%]|[%]/u.test(result.expression)) return null
  return {name: 'calculate', expression: sentence}
}

// Returns the commands for a sentence the patterns cover, or null. A sentence that isn't
// one command may be several joined by commas, "and" or "then", e.g. "dark mode and a
// teal accent", when every part is one, or run together without them, as speech writes
// them.
export function quickCommands(input: string): Command[] | null {
  const text = clean(input)
  return text === '' ? null : sentence(text, 0)
}

// The words around a command that ask politely, and the marks at its end.
function clean(text: string) {
  return text.trim()
    .replace(/^(?:please|pls|hey|ok|okay|can you|could you|would you)\b[,\s]*/iu, '')
    .replace(/[\s,]*(?:\b(?:please|pls|thanks|thank you))?[.!?]*$/iu, '')
    .trim()
}

const separators = /\s*,\s*(?:and then\s+|then\s+|and also\s+|also\s+|and\s+)?|\s+(?:and then|then|and also|and)\s+/giu
const maximumParts = 5

// The first split at a comma, "and" or "then" whose two sides both read, from the left:
// "search for salt and pepper" stays one search, since "pepper" isn't a command, and
// "search for glass prisms and open clock" is two commands. Free text, a search or a
// path, ends where a command can start.
function sentence(text: string, depth: number): Command[] | null {
  if (depth < maximumParts) {
    for (const match of text.matchAll(separators)) {
      const left = text.slice(0, match.index).trim()
      const right = text.slice(match.index + match[0].length).trim()
      if (left === '' || right === '') continue
      const first = part(left)
      if (first === null) continue
      const rest = sentence(right, depth + 1)
      if (rest !== null) return [...first, ...rest]
    }
  }
  return part(text)
}

// One command, or several said without commas.
function part(text: string): Command[] | null {
  const command = one(text)
  return command === null ? runTogether(text) : [command]
}

const filePatterns: [RegExp, (m: RegExpExecArray) => Record<string, unknown> & {name: string}][] = [
  [/^open (?:file|folder) (?!manager\b)(.+)$/iu, m => ({name: 'open_file', path: m[1]})],
  [/^list files(?: in (.+))?$/iu, m => ({name: 'list_files', path: m[1] ?? '.'})],
  [/^(?:search|find) files (?:for |named |called |with )?(.+?)(?: in (?:the|their) names?)?$/iu, m => ({name: 'search_files', query: m[1]})],
  [/^create folder (.+)$/iu, m => ({name: 'create_folder', path: m[1]})],
  [/^create (?:text )?document (.+)$/iu, m => ({name: 'create_document', path: m[1]})],
  [/^save (?:my |the )?note as (.+)$/iu, m => ({name: 'save_note_as', path: m[1]})],
  [/^rename file (?!manager\b)(.+) to (.+)$/iu, m => ({name: 'rename_file', path: m[1], new_name: m[2]})],
  [/^move file (?!manager\b)(.+) to (.+)$/iu, m => ({name: 'move_file', path: m[1], destination: m[2]})],
  [/^(duplicate|trash|restore|download|delete) file (?!manager\b)(.+)$/iu, m => ({name: `${m[1]!.toLowerCase()}_file`, path: m[2]})],
]

// One command, read from the words as written, so a path, an address or a search keeps
// its capitals, then from the normalized sentence.
function one(raw: string): Command | null {
  const text = clean(raw)
  if (text === '') return null
  const image = /^(?:open|show|view) (?:photo|picture|image) (.+)$/iu.exec(text)
  if (image !== null && parsePhoto(image[1]) === null && /\.[a-z0-9]+$/iu.test(image[1]!) && !runsOn.test(image[1]!)) return valid({name: 'open_file', path: image[1]})
  for (const [pattern, make] of filePatterns) {
    const match = pattern.exec(text)
    if (match === null) continue
    // A path that runs into "and", "then", a comma or another command's verb may hold
    // the next command: the model's turn, since where the name ends is a guess.
    if ((match.slice(1) as (string | undefined)[]).some(value => runsOn.test(value ?? ''))) return null
    return valid(make(match))
  }
  const web = webCommand(text)
  if (web !== null) return web
  const command = single(normalize(text).replace(/^(?:a|an|the) (?=\w+ (?:accent|wallpaper))/u, ''))
  // A question searched as asked, e.g. "What's the weather in Tokyo", and a note as written.
  if (command?.name === 'search_web') return valid({name: 'search_web', query: text})
  const note = command?.name === 'write_note' ? notePattern.exec(text) ?? /^(?:write|add|put) (.+?) (?:in|to|into) (?:my |the )?(?:notes?|inkwell)$/iu.exec(text) : null
  // A note said in quotes is the words inside them.
  return note !== null ? valid({name: 'write_note', text: note[1]!.replace(/^["“'](.+)["”']$/u, '$1'), mode: 'append'}) : command
}


function valid(call: Record<string, unknown> & {name: string}): Command | null {
  const result = validateCall(call.name, call)
  return result.ok ? result.command : null
}

// Speech has no commas: "close inkwell open safari" is two commands run together. Reads
// a part as a few whole commands, each the longest that parses, e.g. "search for glass
// prisms" and never "search for glass". Each start in the part is read once.
const maximumRunWords = 24
const maximumRunCommands = 5
function runTogether(part: string): Command[] | null {
  const words = part.split(/\s+/u)
  if (words.length > maximumRunWords) return null
  const readings = new Map<number, Command[] | null>()
  const from = (start: number): Command[] | null => {
    if (start === words.length) return []
    const known = readings.get(start)
    if (known !== undefined) return known
    let reading: Command[] | null = null
    for (let end = words.length; end > start && reading === null; end--) {
      const command = one(words.slice(start, end).join(' '))
      if (command === null) continue
      // A search's words run to the end, so "weather forecast for rome" is one search.
      if (command.name === 'search_web' && end < words.length) continue
      const rest = from(end)
      if (rest !== null && rest.length < maximumRunCommands) reading = [command, ...rest]
    }
    readings.set(start, reading)
    return reading
  }
  const reading = from(0)
  return reading !== null && reading.length > 1 ? reading : null
}

// Web addresses and searches, read before normalize(), which would drop an address's "?"
// and lowercase a search: "go to wikipedia.org", "en.wikipedia.org/wiki/Prism", "search
// the web for glass prisms". A word with a dot that is a file's name, e.g. "notes.txt",
// isn't an address, see webAddress, and neither are words without a spoken "dot com".
function webCommand(input: string): Command | null {
  const text = input.replace(/[.!]+$/u, '').trim()
  const site = /^(?:(?:go|browse|navigate|take me) to|open|visit|browse|load|pull up)\s+(?:the (?:site|website|page)\s+)?(.+)$/iu.exec(text)
  const address = site?.[1] ?? text
  if (webAddress(address) !== null) return check({name: 'open_website', address})
  const search = /^(?:search (?:the web|the internet|online|google|bing) for|search for|web search(?: for)?|google|bing|look up)\s+(.+)$/iu.exec(text)
  // A search that runs into "then" or a comma may hold the next command, which the split
  // in sentence() didn't recognize: the model's turn. "salt and pepper" stays a search.
  if (search !== null && !/^files?\b/iu.test(search[1]!) && !/,|\s(?:and then|then)\s/iu.test(search[1]!)) return check({name: 'search_web', query: search[1]!.replace(/\s+(?:online|on the (?:web|internet))$/iu, '')})
  return null
}

function single(sentence: string): Command | null {
  const calculation = arithmetic(sentence)
  if (calculation !== null) return check(calculation)
  for (const [pattern, toCall] of rules) {
    const match = pattern.exec(sentence)
    if (match === null) continue
    const call = toCall(match)
    if (call === null || Array.isArray(call)) return null
    return check(call)
  }
  // A part of a longer sentence, e.g. "search for youtube" in "close inkwell, open safari
  // and search for youtube".
  return webCommand(sentence)
}

function check(call: Call): Command | null {
  const {name, ...args} = call
  for (const key of ['app', 'left', 'right']) {
    if (key in args && parseApp(args[key]) === null) return null
  }
  if (name === 'open_photo' && parsePhoto(args['photo']) === null) return null
  if (name === 'world_time' && parseCity(args['city']) === null) return null
  const result = validateCall(name, args)
  return result.ok ? result.command : null
}

// Sentences that ask what Spotlight can do. The command center answers them itself.
export function isHelpQuestion(input: string): boolean {
  return /^(?:help|what can you do|what can i (?:say|type|ask)|commands|what do you do|how do i use this)$/u.test(normalize(input))
}
