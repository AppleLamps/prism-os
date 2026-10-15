// The quick parser: a few exact patterns for the commands people type most, e.g. "dark
// mode" or "minimize inkwell". A sentence that matches runs at once, before the model has
// downloaded and without its latency. Anything else returns null and goes to the model.
// The patterns match the whole sentence, so "don't close scope" never closes Scope.
import {type Command, accents, parseApp, parsePhoto, validateCall} from './commands.ts'

function normalize(input: string) {
  return input
    .toLowerCase()
    .replace(/[’']/gu, '')
    .replace(/[.!?,]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^(please|pls|hey|ok|okay|can you|could you|would you)\s+/u, '')
    .replace(/\s+(please|pls|thanks|thank you|now)$/u, '')
    .trim()
}

const appWords = '(scope|monitor|inspector|inkwell|ink well|notes|note|notepad|chroma|photos|gallery|pictures)'
const the = '(?:the\\s+)?'
const windowWord = '(?:\\s+(?:app|window))?'

type Rule = [RegExp, (match: RegExpExecArray) => Record<string, unknown> & {name: string}]

const rules: Rule[] = [
  [new RegExp(`^(?:open|show|launch|start|bring up|focus|switch to|go to) ${the}${appWords}${windowWord}$`, 'u'), m => ({name: 'open_app', app: m[1]})],
  [new RegExp(`^(?:minimize|minimise|hide) ${the}${appWords}${windowWord}$`, 'u'), m => ({name: 'minimize_app', app: m[1]})],
  [new RegExp(`^(?:maximize|maximise|fullscreen|full screen) ${the}${appWords}${windowWord}$`, 'u'), m => ({name: 'maximize_app', app: m[1]})],
  [new RegExp(`^(?:restore|unmaximize|unmaximise) ${the}${appWords}${windowWord}$`, 'u'), m => ({name: 'restore_app', app: m[1]})],
  [new RegExp(`^(?:close|quit|exit) ${the}${appWords}${windowWord}$`, 'u'), m => ({name: 'close_app', app: m[1]})],
  [/^(?:turn on |switch to |use |enable |go )?(dark|light)(?: mode| theme)?(?: on)?$/u, m => ({name: 'set_theme', theme: m[1]})],
  [/^(?:follow|use|match) (?:the )?(?:system|device|os)(?: theme| appearance)?$/u, () => ({name: 'set_theme', theme: 'system'})],
  [new RegExp(`^(?:make it |set (?:the )?accent(?: color)?(?: to)? |accent(?: color)? )(${accents.join('|')})$`, 'u'), m => ({name: 'set_accent', color: m[1]})],
  [/^(?:next|next photo|next picture)$/u, () => ({name: 'next_photo'})],
  [/^(?:previous|prev|back|previous photo|previous picture|last photo)$/u, () => ({name: 'previous_photo'})],
  [/^(?:close (?:the )?photo|back to (?:the )?grid)$/u, () => ({name: 'close_photo'})],
  [/^(?:open|show) (?:the )?(?:photo|picture|image) (.+)$/u, m => ({name: 'open_photo', photo: m[1]})],
  [/^(?:start (?:a |the )?slideshow|slideshow|play (?:a )?slideshow)$/u, () => ({name: 'slideshow', action: 'start'})],
  [/^(?:stop (?:the )?slideshow|end (?:the )?slideshow)$/u, () => ({name: 'slideshow', action: 'stop'})],
  [/^(?:show (?:the )?desktop|minimize (?:all|everything)(?: windows)?|hide (?:all|everything)(?: windows)?)$/u, () => ({name: 'show_desktop'})],
  [/^(?:reset (?:the )?(?:layout|windows)|put (?:the )?windows back)$/u, () => ({name: 'reset_layout'})],
  [/^(?:stats|statistics|show (?:me )?(?:the )?stats|how big is (?:the )?program)$/u, () => ({name: 'get_stats'})],
  [/^(?:read (?:the |my )?note|what does (?:the |my )?note say)$/u, () => ({name: 'read_note'})],
  [/^(?:clear|erase|wipe) (?:the |my )?note$/u, () => ({name: 'clear_note'})],
  [/^(?:hide|turn off) (?:the )?(?:weight )?arcs$/u, () => ({name: 'set_arcs', visibility: 'hidden'})],
  [/^(?:show|turn on) (?:the )?(?:weight )?arcs$/u, () => ({name: 'set_arcs', visibility: 'shown'})],
  [/^(?:stop|pause|freeze) (?:the )?(?:wallpaper|dunes|background)(?: animation)?$/u, () => ({name: 'set_wallpaper', motion: 'still'})],
  [/^(?:animate|start|resume|play) (?:the )?(?:wallpaper|dunes|background)(?: animation)?$/u, () => ({name: 'set_wallpaper', motion: 'animated'})],
  [/^(?:reduce transparency|solid glass|make (?:the )?glass solid)$/u, () => ({name: 'set_transparency', level: 'reduced'})],
]

// Returns the commands for a sentence the patterns cover, or null.
export function quickCommands(input: string): Command[] | null {
  const sentence = normalize(input)
  if (sentence === '') return null
  for (const [pattern, toCall] of rules) {
    const match = pattern.exec(sentence)
    if (match === null) continue
    const {name, ...args} = toCall(match)
    if ('app' in args && parseApp(args['app']) === null) return null
    if (name === 'open_photo' && parsePhoto(args['photo']) === null) return null
    const result = validateCall(name, args)
    return result.ok ? [result.command] : null
  }
  return null
}
