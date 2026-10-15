// The quick parser: patterns for the sentences people type most, e.g. "dark mode",
// "minimize inkwell", "put scope and chroma side by side" or "what is 17 times 23". A
// sentence that matches runs at once, with no model, which is how Spotlight runs
// commands until the model ships. Anything else returns null: the model's turn, or a hint.
// The patterns match the whole sentence, so "don't close scope" never closes Scope.
import {type Command, accentNames, appAliases, apps, parseApp, parseCity, parsePhoto, positions, sceneNames, validateCall} from './commands.ts'
import {evaluateExpression} from './expression.ts'
import {photoNames} from '../handwiredos/photo-gallery.ts'

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
const the = '(?:the\\s+)?'
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
  // Clock, first: "start the stopwatch" is the stopwatch, not "start" an app named Clock.
  [/^(start|stop|reset|lap) (?:the )?stopwatch$|^stopwatch (start|stop|reset|lap)$|^(lap)$/u, m => ({name: 'stopwatch', action: m[1] ?? m[2] ?? m[3]})],
  [/^(?:what time is it|whats the time|what is the time|time|the time|current time)(?: (?:in|at) (.+))?$|^time in (.+)$/u, m => ({name: 'world_time', city: m[1] ?? m[2] ?? 'here'})],
  // Windows and apps.
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
  [new RegExp(`^(?:make it |set (?:the )?accent(?: color)?(?: to)? |(?:change|switch) (?:the )?accent(?: color)? to |accent(?: color)? )?(${alternatives([...accentNames, 'gray', 'grey', 'turquoise', 'gold', 'amber'])})(?: accent)?$`, 'u'), m => ({name: 'set_accent', color: m[1]})],
  [new RegExp(`^(?:(?:set|change|switch) (?:the )?wallpaper (?:to )?|wallpaper )(${alternatives(sceneNames)})$|^(${alternatives(sceneNames)}) (?:wallpaper|scene)$`, 'u'), m => ({name: 'set_wallpaper', scene: m[1] ?? m[2]})],
  [/^(?:stop|pause|freeze) (?:the )?(?:wallpaper|dunes|background)(?: animation| motion)?$|^(?:wallpaper )?motion off$/u, () => ({name: 'set_motion', motion: 'off'})],
  [/^(?:animate|start|resume|play) (?:the )?(?:wallpaper|dunes|background)(?: animation| motion)?$|^(?:wallpaper )?motion on$/u, () => ({name: 'set_motion', motion: 'on'})],
  [/^(?:hide|turn off) (?:the )?(?:weight )?(?:arcs|wiring)$|^arcs off$/u, () => ({name: 'set_arcs', visibility: 'hidden'})],
  [/^(?:show|turn on) (?:the )?(?:weight )?(?:arcs|wiring)$|^arcs on$/u, () => ({name: 'set_arcs', visibility: 'shown'})],
  // Chroma.
  [/^(?:next|next photo|next picture)$/u, () => ({name: 'next_photo'})],
  [/^(?:previous|prev|back|previous photo|previous picture|last photo)$/u, () => ({name: 'previous_photo'})],
  [/^(?:close (?:the )?photo|back to (?:the )?grid)$/u, () => ({name: 'close_photo'})],
  [/^(?:open|show|view) (?:the )?(?:photo|picture|image) (.+)$/u, m => ({name: 'open_photo', photo: m[1]})],
  [new RegExp(`^(?:open|show|view|show me) (?:the )?(${alternatives(photoNames.map(name => name.toLowerCase()))})(?: photo| picture)?$`, 'u'), m => ({name: 'open_photo', photo: m[1]})],
  [/^(?:open|show|view|show me) the (first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth) (?:photo|picture|image)$/u, m => ({name: 'open_photo', photo: m[1]})],
  [/^(?:start (?:a |the )?slideshow|slideshow|play (?:a )?slideshow)$/u, () => ({name: 'slideshow', action: 'start'})],
  [/^(?:stop (?:the )?slideshow|end (?:the )?slideshow)$/u, () => ({name: 'slideshow', action: 'stop'})],
  // Scope.
  [new RegExp(`^(?:show|list|view) (?:me )?(?:the )?(${alternatives(Object.keys(viewWords))})(?: in (?:scope|the inspector))?$`, 'u'), m => ({name: 'scope_show', view: viewWords[m[1]!]})],
  // Inkwell.
  [/^(?:read (?:the |my )?notes?|what does (?:the |my )?note say|whats in (?:my|the) note)$/u, () => ({name: 'read_note'})],
  [/^(?:clear|erase|wipe) (?:the |my )?notes?$/u, () => ({name: 'clear_note'})],
  [/^(?:note|jot down|write down|take a note|add to (?:my |the )?notes?|note to self)[:,]? (.+)$/u, m => ({name: 'write_note', text: m[1], mode: 'append'})],
  // Information.
  [/^(?:stats|statistics|show (?:me )?(?:the )?stats|how big is (?:the )?program|program stats)$/u, () => ({name: 'get_stats'})],
  [/^(?:what is|whats|explain|tell me about) (prism os|prism|this|scope|inkwell|chroma|calculator|clock|terminal|handwired|spotlight)$/u, m => {
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
// one command may be several joined by "and" or "then", e.g. "dark mode and a teal accent",
// when every part is one.
export function quickCommands(input: string): Command[] | null {
  const sentence = normalize(input)
  if (sentence === '') return null
  const whole = single(sentence)
  if (whole !== null) return [whole]
  const parts = sentence.split(/\s*,?\s+(?:and then|then|and also|and)\s+|\s*,\s+/u).map(part => part.replace(/^(?:a|an|the) (?=\w+ (?:accent|wallpaper))/u, '').trim())
  if (parts.length < 2) return null
  const commands: Command[] = []
  for (const part of parts) {
    const command = single(part)
    if (command === null) return null
    commands.push(command)
  }
  return commands
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
  return null
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
