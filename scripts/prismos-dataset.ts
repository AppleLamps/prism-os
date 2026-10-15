// Writes the fine-tuning data for the command center's model, from the command list in
// src/prismos/commands.ts. Each row is one exchange: what a person types, and either the
// calls the model should make or the reply it should write. The tools aren't repeated in
// every row: training/train.py reads them from tools.json and puts them in each prompt,
// as the page does.
//
// Generalization is measured, not assumed: a fifth of every phrasing list never appears
// in training, and eval.jsonl holds only those phrasings. So the eval score is the
// model's accuracy on sentences shaped unlike anything it trained on.
//
//   bun scripts/prismos-dataset.ts
//
// writes src/prismos/training/{train.jsonl,eval.jsonl,tools.json}.
import {mkdirSync, writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {photoNames} from '../src/handwiredos/photo-gallery.ts'
import {type App, accents, apps, toolDeclarations, validateCall} from '../src/prismos/commands.ts'

type Call = {name: string, arguments: Record<string, string>}
type Row = {user: string, calls?: Call[], reply?: string}
type Split = 'train' | 'eval'

// A seeded generator, so the same command list always writes the same data.
function createRandom(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!
  return {next, pick}
}
const random = createRandom(20261015)
const {pick} = random

// A fifth of each phrasing list is held out for eval: index 4, 9, 14 and so on.
function phrasings<T>(list: readonly T[], split: Split): readonly T[] {
  if (list.length < 5) return list
  return list.filter((_, index) => (index % 5 === 4) === (split === 'eval'))
}

const appForms: Record<App, readonly string[]> = {
  scope: ['Scope', 'scope', 'the monitor', 'Monitor', 'the inspector', 'the scope window', 'scope app'],
  inkwell: ['Inkwell', 'inkwell', 'notes', 'the notes app', 'my notes', 'the note', 'Notes', 'the notepad'],
  chroma: ['Chroma', 'chroma', 'photos', 'the gallery', 'Photos', 'the photo app', 'pictures', 'the photos window'],
}
const appPhrase = (app: App) => pick(appForms[app])

const single = (name: string, args: Record<string, string> = {}): Call[] => [{name, arguments: args}]

const templates = {
  open_app: ['open {app}', 'show {app}', 'bring up {app}', 'switch to {app}', 'I want to see {app}', 'can you open {app}', 'focus {app}', 'bring {app} to the front', 'launch {app}', 'pull up {app}', 'go to {app}', 'where is {app}', 'show me {app}', 'get {app} back', 'reopen {app}', 'start {app}', 'take me to {app}', 'give me {app}', 'put {app} on top', 'unminimize {app}', 'restore {app} from the dock', 'I need {app}', 'let me use {app}', 'jump to {app}', 'activate {app}'],
  minimize_app: ['minimize {app}', 'hide {app}', 'send {app} to the dock', 'put {app} away', 'tuck {app} into the dock', 'get {app} out of the way', 'minimise {app}', 'collapse {app}', 'stash {app} in the dock', 'hide the {app} window', 'shrink {app} into the dock', 'dock {app}', 'make {app} go away for now', 'move {app} down to the dock', 'I do not need {app} right now', 'park {app} in the dock', 'hide {app} for a bit', 'tuck away {app}', 'send {app} down', 'clear {app} off the screen'],
  maximize_app: ['maximize {app}', 'make {app} full screen', 'fullscreen {app}', 'make {app} fill the screen', 'blow up {app}', 'expand {app} to the whole screen', 'maximise {app}', 'zoom {app} to full size', 'give {app} the whole screen', 'make {app} as big as possible', 'go full screen with {app}', 'put {app} in full screen', 'make {app} take up the whole screen', 'enlarge {app} to fill everything', '{app} full screen', 'max out {app}', 'stretch {app} across the screen', 'open {app} full screen', 'full screen the {app} window', 'make {app} huge, full screen'],
  restore_app: ['restore {app}', 'unmaximize {app}', 'make {app} normal size again', 'shrink {app} back to normal', 'exit full screen on {app}', 'bring {app} back to normal', 'un-fullscreen {app}', 'put {app} back to its normal size', 'restore the {app} window', 'take {app} out of full screen', 'leave full screen on {app}', 'stop {app} being full screen', '{app} out of full screen', 'return {app} to its usual size', 'make {app} windowed again', 'undo the full screen on {app}', 'get {app} out of full screen mode', 'back to normal size for {app}', 'no more full screen for {app}', 'un-maximize the {app} window'],
  close_app: ['close {app}', 'quit {app}', 'shut {app}', 'exit {app}', 'close the {app} window', 'kill {app}', 'get rid of {app}', 'I am done with {app}, close it', 'close out {app}', 'shut down {app}', 'x out of {app}', 'end {app}', 'close down {app}', 'turn off {app}', 'dismiss {app}'],
  move_app: ['move {app} to {pos}', 'put {app} on {pos}', 'drag {app} to {pos}', 'slide {app} over to {pos}', '{app} to {pos}', 'shove {app} to {pos}', 'can you move {app} to {pos}', 'place {app} at {pos}', 'push {app} over to {pos}', 'I want {app} on {pos}', 'snap {app} to {pos}', 'send {app} to {pos}', 'relocate {app} to {pos}', 'move the {app} window to {pos}', 'position {app} on {pos}'],
  resize_app: ['make {app} {size}', 'resize {app} to {size}', '{app} {size} please', 'can you make {app} a bit {size}', 'set {app} to {size}', 'I want {app} {size}', 'change the size of {app} to {size}', 'make the {app} window {size}', 'size {app} {size}', 'could {app} be {size}', 'make {app} a {size} window', '{app} should be {size}', 'scale {app} to {size}', 'adjust {app} to be {size}', 'turn {app} {size}'],
  side_by_side: ['put {a} and {b} side by side', '{a} on the left and {b} on the right', 'split the screen between {a} and {b}', 'show {a} next to {b}', 'tile {a} and {b}', '{a} left, {b} right', 'snap {a} to the left half and {b} to the right half', 'I want {a} and {b} next to each other', 'arrange {a} and {b} side by side', 'half and half with {a} and {b}', 'split screen {a} and {b}', 'tile {a} with {b}', '{a} beside {b}', 'share the screen between {a} and {b}', 'put {a} left and {b} right', 'tile {a} on the left and {b} on the right', 'divide the screen: {a} and {b}', 'show {a} and {b} at the same time, side by side', 'two columns, {a} then {b}', 'place {a} next to {b}'],
  show_desktop: ['show desktop', 'show the desktop', 'minimize everything', 'hide all windows', 'clear the screen', 'minimize all windows', 'I want to see the wallpaper', 'get all the windows out of the way', 'hide everything', 'send every window to the dock', 'clear the desktop', 'minimize all', 'peek at the desktop', 'put everything away', 'hide every window', 'clean up the screen', 'everything to the dock', 'show me the wallpaper', 'clear all windows off', 'make the desktop empty'],
  reset_layout: ['reset the layout', 'put the windows back', 'reset windows', 'restore the original layout', 'arrange the windows like at the start', 'undo my window mess', 'back to the default layout', 'tidy up the windows', 'reset everything to where it was', 'put every window back where it opened', 'default layout', 'rearrange the windows like before', 'reset window positions', 'put things back how they were', 'start the layout over'],
  open_photo: ['open {photo}', 'show me {photo}', 'view {photo}', 'let me see {photo}', 'open {photo} in chroma', 'pull up {photo}', 'display {photo}', 'I want to look at {photo}', 'zoom into {photo}', 'show {photo} full size', 'go to {photo}', 'bring up {photo}', 'look at {photo}', 'can I see {photo}', 'show {photo}', 'open up {photo}', 'take me to {photo}', 'enlarge {photo}', 'click on {photo}', 'show me {photo} in the gallery'],
  next_photo: ['next photo', 'next', 'show the next picture', 'go to the next photo', 'next one', 'forward', 'skip to the next image', 'the one after this', 'next pic', 'advance the photo', 'go forward one photo', 'following photo', 'show me another one', 'move to the next image', 'next image please'],
  previous_photo: ['previous photo', 'go back one photo', 'previous', 'the one before', 'show the last picture again', 'back one', 'previous picture please', 'go to the previous image', 'prev photo', 'one photo back', 'go back a photo', 'the photo before this', 'back to the previous one', 'show the prior image', 'step back one photo'],
  close_photo: ['close the photo', 'back to the grid', 'close this picture', 'exit the photo', 'go back to all photos', 'stop viewing this photo', 'close the image', 'return to the gallery grid', 'done with this photo', 'leave the photo', 'show all the photos again', 'back to the gallery', 'close the open picture', 'exit the lightbox', 'go back to the thumbnails'],
  slideshow_start: ['start a slideshow', 'slideshow', 'play the photos as a slideshow', 'cycle through the pictures', 'start the slideshow', 'show the photos one by one automatically', 'run a slideshow of the gallery', 'play a slideshow', 'auto play the photos', 'begin a photo slideshow', 'slideshow please', 'flip through the photos for me', 'play all the pictures', 'rotate through the photos', 'start cycling the photos'],
  slideshow_stop: ['stop the slideshow', 'end slideshow', 'pause the slideshow', 'stop cycling the photos', 'that is enough slideshow', 'turn off the slideshow', 'quit the slideshow', 'halt the slideshow', 'stop playing the photos', 'no more slideshow', 'stop flipping through the photos', 'end the photo show', 'stop the photos', 'cancel the slideshow', 'slideshow off'],
  scope_show: ['show {view} in scope', 'switch scope to {view}', 'list the {view}', 'scope, show {view}', 'open the {view} list', 'let me see the {view}', 'show me the {view} of the program', 'go to {view} in the inspector', 'display {view}', 'change scope to {view}', 'scope should list {view}', 'view {view} in scope', 'pick {view} in the scope sidebar', 'inspect the {view}', 'switch the inspector to {view}'],
  scope_list: {
    up: ['scroll up in scope', 'go up one row', 'move up in the list', 'up one', 'select the row above', 'one row up', 'previous row', 'up a row', 'move the selection up', 'the row before'],
    down: ['scroll down in scope', 'go down one row', 'move down in the list', 'down one', 'select the next row', 'one row down', 'next row', 'down a row', 'move the selection down', 'the row after'],
    page_up: ['page up', 'scroll up a page in scope', 'go up a page', 'previous page of the list', 'one page up', 'up a whole page', 'page up in the inspector', 'back a page', 'scroll a screen up', 'jump up a page'],
    page_down: ['page down', 'scroll down a page in scope', 'go down a page', 'next page of the list', 'one page down', 'down a whole page', 'page down in the inspector', 'forward a page', 'scroll a screen down', 'jump down a page'],
    top: ['scroll scope to the top', 'go to the top of the list', 'jump to the first row', 'back to the top', 'top of the list', 'first row', 'scroll all the way up', 'the very first row', 'start of the list', 'go to the very top'],
    bottom: ['scroll scope to the bottom', 'go to the end of the list', 'jump to the last row', 'all the way down', 'bottom of the list', 'last row', 'scroll all the way down', 'the very last row', 'end of the list', 'go to the very bottom'],
  },
  write_note_append: ['write {text} in my notes', 'add {text} to inkwell', 'note: {text}', 'jot down {text}', 'take a note: {text}', 'add a line to my note: {text}', 'put {text} in the note', 'write down {text}', 'append {text} to the note', 'save a note that says {text}', 'note to self: {text}', 'add this to my note: {text}', 'jot {text} down', 'put this in inkwell: {text}', 'make a note: {text}', 'write "{text}" in the note', 'add "{text}" to my notes', 'can you note {text}', 'inkwell: {text}', 'remember this in my note: {text}'],
  write_note_replace: ['replace my note with {text}', 'change the note to say {text}', 'overwrite the note with {text}', 'make the note just say {text}', 'set the note to {text}', 'rewrite the note as {text}', 'swap the note for {text}', 'the note should only say {text}', 'erase the note and write {text}', 'replace everything in inkwell with {text}', 'start a fresh note: {text}', 'new note that only says {text}', 'replace the text in my note with {text}', 'wipe the note and put {text}', 'overwrite inkwell with {text}'],
  clear_note: ['clear the note', 'erase my note', 'wipe the note', 'delete everything in inkwell', 'empty the note', 'clear my notes', 'blank the note', 'remove all text from the note', 'start the note over', 'clean out the note', 'delete my note', 'erase everything I wrote', 'clear inkwell', 'make the note empty', 'throw away the note text'],
  read_note: ['read my note', 'what does the note say', 'read the note to me', 'what is in inkwell', 'what did I write', 'show me what my note says', 'read back my notes', 'what is written in the note', 'tell me what is in my notes', 'read inkwell', 'what is on my note', 'what are my notes', 'remind me what I wrote', 'check my note', 'what does inkwell say'],
  set_theme: {
    dark: ['dark mode', 'turn on dark mode', 'switch to dark', 'make it dark', 'night mode', 'it is too bright', 'dark theme please', 'go dark', 'enable dark mode', 'my eyes hurt, make it darker', 'dark', 'dim everything', 'use the dark theme', 'switch the theme to dark', 'the screen is too bright', 'dark appearance', 'make everything darker', 'night theme', 'turn the lights down', 'darken the desktop'],
    light: ['light mode', 'make it light', 'switch to light mode', 'it is too dark', 'day mode', 'turn off dark mode', 'light theme', 'brighter please', 'enable light mode', 'go back to light', 'light', 'brighten everything', 'use the light theme', 'switch the theme to light', 'the screen is too dark', 'light appearance', 'make everything brighter', 'day theme', 'turn the lights up', 'lighten the desktop'],
    system: ['match my system theme', 'follow the device theme', 'automatic theme', 'auto dark mode', 'use the system appearance', 'theme should follow my computer', 'set the theme to system', 'match the os theme', 'let my device decide light or dark', 'theme auto', 'same theme as my computer', 'follow my system appearance', 'automatic light and dark', 'system theme', 'match my settings for dark mode'],
  },
  set_accent: ['make the accent {color}', 'change the accent color to {color}', '{color} accent', 'use {color} as the highlight color', 'switch the color to {color}', 'set the accent to {color}', 'I want a {color} accent', 'make the highlights {color}', 'accent color {color} please', 'can the buttons be {color}', 'change the theme color to {color}', 'highlight color {color}', 'make the accents {color}', 'go {color} for the accent', 'tint everything {color}'],
  set_wallpaper: {
    still: ['stop the wallpaper', 'freeze the dunes', 'stop the background moving', 'the wallpaper is distracting, hold it still', 'pause the wallpaper animation', 'make the background still', 'no more moving dunes', 'stop animating the desktop', 'hold the dunes still', 'static wallpaper', 'stop the moving background', 'freeze the wallpaper', 'turn off the wallpaper motion', 'still background please', 'the dunes should not move'],
    animated: ['animate the wallpaper', 'let the dunes move again', 'start the wallpaper animation', 'make the background move', 'resume the dunes', 'moving wallpaper please', 'turn the wallpaper animation back on', 'animate the desktop', 'let the background drift', 'unfreeze the dunes', 'start the moving background', 'unfreeze the wallpaper', 'turn on the wallpaper motion', 'animated background please', 'let the dunes drift'],
  },
  set_transparency: {
    reduced: ['reduce transparency', 'make the windows solid', 'turn off the glass effect', 'less see-through please', 'solid windows', 'no glass', 'make the glass opaque', 'I cannot read the text over the wallpaper', 'disable the blur', 'reduce the glass effect', 'make it less transparent', 'opaque windows', 'turn off transparency', 'no more see-through windows', 'solid backgrounds on the windows'],
    normal: ['bring back the glass', 'normal transparency', 'make the windows see-through again', 'turn the glass effect on', 'restore transparency', 'glass windows please', 'enable the blur', 'transparent windows', 'undo reduce transparency', 'see-through glass again', 'make it transparent again', 'turn on transparency', 'glassy windows', 'bring the blur back', 'normal glass please'],
  },
  set_arcs: {
    hidden: ['hide the arcs', 'hide the weight lines', 'turn off the wiring', 'remove the lines behind the windows', 'hide the weights', 'no arcs please', 'get rid of the curves on the desktop', 'turn off the weight arcs', 'clear the lines from the background', 'hide the network drawing', 'hide the wires', 'no wiring', 'remove the arcs', 'turn the arcs off', 'hide the lines on the desk'],
    shown: ['show the arcs', 'show the weight lines', 'turn on the wiring', 'bring back the lines behind the windows', 'show the weights', 'arcs on', 'draw the network again', 'turn the weight arcs back on', 'I want the curves back', 'display the weight arcs', 'show the wires', 'wiring on', 'bring the arcs back', 'turn the arcs on', 'show the lines on the desk'],
  },
  open_link: {
    demos: ['go back to all demos', 'show the other demos', 'take me to the demos page', 'leave prism os', 'all demos', 'what other demos are there', 'exit to the demo list', 'back to the main page', 'open the demos', 'go home', 'other demos', 'back to the demo list', 'show me more demos', 'demos page', 'leave this page for the demos'],
    source: ['show me the source code', 'open the github', 'where is the code', 'view source', 'open the repository', 'I want to read the code', 'take me to github', 'source code please', 'show the repo', 'how is this built, show me the code', 'github', 'open the source', 'the code behind this', 'let me see the source', 'repo link'],
  },
  get_stats: ['how many weights does this have', 'stats', 'how big is the program', 'how many operations are there', 'how many layers are there', 'give me the numbers', 'program stats', 'how many source cells', 'what are the program numbers', 'show me the stats', 'how large is the network', 'size of the program', 'how many layers does it have', 'how many weights are there', 'count the operations', 'how many parameters', 'what is the weight count', 'numbers on the program', 'how many cells', 'how big is the network'],
  explain: {
    prism_os: ['what is prism os', 'what is this', 'what am I looking at', 'explain prism os', 'what is this desktop', 'tell me about prism os', 'what is this thing', 'describe prism os', 'what does prism os do', 'what is this site'],
    scope: ['what does scope do', 'what is the scope app', 'explain scope', 'what is the inspector for', 'what is monitor', 'tell me about scope', 'what is scope', 'what is the inspector', 'describe scope', 'what does the inspector show'],
    inkwell: ['what is inkwell', 'explain inkwell', 'what does the notes app do', 'is my note saved', 'what is the note app', 'tell me about inkwell', 'what are notes for', 'describe inkwell', 'does my note get saved', 'what is the notepad'],
    chroma: ['what is chroma', 'explain chroma', 'what does the gallery do', 'how many photos are there', 'what is the photo app', 'tell me about chroma', 'what is the gallery', 'describe chroma', 'what is in the gallery', 'what does chroma do'],
    handwired: ['what is handwired', 'how does this work under the hood', 'is this really a neural network', 'explain handwired', 'how does the program work', 'tell me about handwired', 'how does the window manager work', 'what runs this desktop', 'is the window manager a neural net', 'how was this built'],
    command_center: ['how do you work', 'explain the command center', 'what model are you', 'how does this chat work', 'do you run in my browser', 'are you running locally', 'what is the command center', 'tell me about the command center', 'where do you run', 'is this ai running on my computer'],
  },
} as const

const positionForms = {
  left: ['the left', 'the left side', 'the left edge', 'left'],
  right: ['the right', 'the right side', 'the right edge', 'right'],
  center: ['the center', 'the middle', 'center', 'the middle of the screen'],
  top_left: ['the top left', 'the top left corner', 'the upper left', 'top left'],
  top_right: ['the top right', 'the top right corner', 'the upper right', 'top right'],
  bottom_left: ['the bottom left', 'the bottom left corner', 'the lower left', 'bottom left'],
  bottom_right: ['the bottom right', 'the bottom right corner', 'the lower right', 'bottom right'],
} as const
const sizeForms = {
  small: ['small', 'tiny', 'small sized'],
  medium: ['medium', 'medium sized', 'normal sized'],
  large: ['large', 'big', 'huge'],
  bigger: ['bigger', 'larger', 'a little bigger'],
  smaller: ['smaller', 'a bit smaller', 'littler'],
} as const
const viewForms = {
  state: ['state', 'the state', 'source cells', 'the cells'],
  operations: ['operations', 'the operations', 'ops'],
  outputs: ['outputs', 'the outputs'],
} as const
const accentForms: Record<(typeof accents)[number], readonly string[]> = {
  blue: ['blue', 'Blue'],
  teal: ['teal', 'Teal', 'turquoise'],
  green: ['green', 'Green'],
  sand: ['sand', 'sandy', 'tan', 'beige'],
  graphite: ['graphite', 'gray', 'grey'],
}
const ordinals = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth']
const numberWords = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
const noteTexts = ['buy milk', 'call the dentist at 3', 'pick up the dry cleaning', 'water the plants', 'finish the report by Friday', 'book flights for June', 'ideas for the logo', 'renew the car registration', 'meeting moved to 2pm', 'send the invoice', 'try the new ramen place', 'back up the laptop', 'pay rent on the 1st', 'read chapter 4', 'return the library books', 'order more coffee', 'fix the squeaky door', 'gym at 6', 'birthday gift for Sam', 'check the oil', 'reply to the landlord', 'groceries: eggs, bread, apples', 'test the new build', 'plan the weekend hike', 'schedule a haircut', 'look into solar panels', 'update the resume', 'clean the gutters', 'pack for the trip', 'feed the cat at 7']

// Every way to name a photo appears in both splits: these are skills the model needs,
// and the phrasing templates around them are what's held out.
function photoReference(): {phrase: string, argument: string} {
  const item = Math.floor(random.next() * photoNames.length)
  const name = photoNames[item]!
  const [first, second] = name.split(' ') as [string, string]
  const forms: {phrase: string, argument: string}[] = [
    {phrase: name, argument: name},
    {phrase: name.toLowerCase(), argument: name},
    {phrase: `the ${name} photo`, argument: name},
    {phrase: `the ${name.toLowerCase()} picture`, argument: name},
    {phrase: `photo ${item + 1}`, argument: String(item + 1)},
    {phrase: `the ${ordinals[item]} photo`, argument: String(item + 1)},
    {phrase: `picture number ${numberWords[item]}`, argument: String(item + 1)},
    {phrase: `photo #${item + 1}`, argument: String(item + 1)},
    {phrase: `the ${ordinals[item]} picture`, argument: String(item + 1)},
    {phrase: `image ${item + 1}`, argument: String(item + 1)},
    {phrase: `photo number ${item + 1}`, argument: String(item + 1)},
    {phrase: `the ${ordinals[item]} one`, argument: String(item + 1)},
    {phrase: second.toLowerCase(), argument: name},
    {phrase: `the ${second.toLowerCase()} photo`, argument: name},
    {phrase: first.toLowerCase(), argument: name},
    {phrase: `the ${first.toLowerCase()} one`, argument: name},
  ]
  return pick(forms)
}

function fill(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/gu, (_, key: string) => values[key] ?? `{${key}}`)
}

// Makes a sentence look typed: capitals, a please, a trailing mark.
function dress(sentence: string) {
  let text = sentence
  const extra = random.next()
  if (extra < 0.08) text = `please ${text}`
  else if (extra < 0.14) text = `${text} please`
  else if (extra < 0.18) text = `hey, ${text}`
  else if (extra < 0.22) text = `can you ${text}`
  const r = random.next()
  if (r < 0.45) text = text.charAt(0).toUpperCase() + text.slice(1)
  else if (r < 0.47) text = text.toUpperCase()
  const mark = random.next()
  if (mark < 0.15) text += '.'
  else if (mark < 0.22) text += '!'
  return text
}

// One command row of each kind, phrased from the split's templates.
const commandMakers: Record<string, (split: Split) => Row> = {
  app_command(split) {
    const name = pick(['open_app', 'minimize_app', 'maximize_app', 'restore_app', 'close_app'] as const)
    const app = pick(apps)
    return {user: fill(pick(phrasings(templates[name], split)), {app: appPhrase(app)}), calls: single(name, {app})}
  },
  move_app(split) {
    const app = pick(apps)
    const position = pick(Object.keys(positionForms) as (keyof typeof positionForms)[])
    const user = position === 'center' && random.next() < 0.3
      ? `center ${appPhrase(app)}`
      : fill(pick(phrasings(templates.move_app, split)), {app: appPhrase(app), pos: pick(positionForms[position])})
    return {user, calls: single('move_app', {app, position})}
  },
  resize_app(split) {
    const app = pick(apps)
    const size = pick(Object.keys(sizeForms) as (keyof typeof sizeForms)[])
    const user = size === 'bigger' && random.next() < 0.25
      ? `grow ${appPhrase(app)}`
      : size === 'smaller' && random.next() < 0.25
        ? `shrink ${appPhrase(app)}`
        : fill(pick(phrasings(templates.resize_app, split)), {app: appPhrase(app), size: pick(sizeForms[size])})
    return {user, calls: single('resize_app', {app, size})}
  },
  side_by_side(split) {
    const left = pick(apps)
    const right = pick(apps.filter(app => app !== left))
    return {user: fill(pick(phrasings(templates.side_by_side, split)), {a: appPhrase(left), b: appPhrase(right)}), calls: single('side_by_side', {left, right})}
  },
  layout(split) {
    const name = pick(['show_desktop', 'reset_layout'] as const)
    return {user: pick(phrasings(templates[name], split)), calls: single(name)}
  },
  open_photo(split) {
    const photo = photoReference()
    return {user: fill(pick(phrasings(templates.open_photo, split)), {photo: photo.phrase}), calls: single('open_photo', {photo: photo.argument})}
  },
  photo_step(split) {
    const name = pick(['next_photo', 'previous_photo', 'close_photo'] as const)
    return {user: pick(phrasings(templates[name], split)), calls: single(name)}
  },
  slideshow(split) {
    const action = pick(['start', 'stop'] as const)
    return {user: pick(phrasings(action === 'start' ? templates.slideshow_start : templates.slideshow_stop, split)), calls: single('slideshow', {action})}
  },
  scope_show(split) {
    const view = pick(Object.keys(viewForms) as (keyof typeof viewForms)[])
    return {user: fill(pick(phrasings(templates.scope_show, split)), {view: pick(viewForms[view])}), calls: single('scope_show', {view})}
  },
  scope_list(split) {
    const action = pick(Object.keys(templates.scope_list) as (keyof typeof templates.scope_list)[])
    return {user: pick(phrasings(templates.scope_list[action], split)), calls: single('scope_list', {action})}
  },
  write_note(split) {
    const text = pick(noteTexts)
    const replace = random.next() < 0.3
    return {user: fill(pick(phrasings(replace ? templates.write_note_replace : templates.write_note_append, split)), {text}), calls: single('write_note', {mode: replace ? 'replace' : 'append', text})}
  },
  note_other(split) {
    const name = pick(['clear_note', 'read_note'] as const)
    return {user: pick(phrasings(templates[name], split)), calls: single(name)}
  },
  set_theme(split) {
    const theme = pick(['dark', 'light', 'system'] as const)
    return {user: pick(phrasings(templates.set_theme[theme], split)), calls: single('set_theme', {theme})}
  },
  set_accent(split) {
    const color = pick(accents)
    return {user: fill(pick(phrasings(templates.set_accent, split)), {color: pick(accentForms[color])}), calls: single('set_accent', {color})}
  },
  appearance(split) {
    const kind = pick(['set_wallpaper', 'set_transparency', 'set_arcs'] as const)
    if (kind === 'set_wallpaper') {
      const motion = pick(['still', 'animated'] as const)
      return {user: pick(phrasings(templates.set_wallpaper[motion], split)), calls: single(kind, {motion})}
    }
    if (kind === 'set_transparency') {
      const level = pick(['reduced', 'normal'] as const)
      return {user: pick(phrasings(templates.set_transparency[level], split)), calls: single(kind, {level})}
    }
    const visibility = pick(['hidden', 'shown'] as const)
    return {user: pick(phrasings(templates.set_arcs[visibility], split)), calls: single(kind, {visibility})}
  },
  open_link(split) {
    const link = pick(['demos', 'source'] as const)
    return {user: pick(phrasings(templates.open_link[link], split)), calls: single('open_link', {link})}
  },
  info(split) {
    if (random.next() < 0.4) return {user: pick(phrasings(templates.get_stats, split)), calls: single('get_stats')}
    const topic = pick(Object.keys(templates.explain) as (keyof typeof templates.explain)[])
    return {user: pick(phrasings(templates.explain[topic], split)), calls: single('explain', {topic})}
  },
}

// Two commands in one sentence, from short forms that read naturally when joined.
function compound(split: Split): Row {
  const short: (() => Row)[] = [
    () => { const app = pick(apps); return {user: `${pick(['minimize', 'hide'])} ${appPhrase(app)}`, calls: single('minimize_app', {app})} },
    () => { const app = pick(apps); return {user: `${pick(['open', 'show'])} ${appPhrase(app)}`, calls: single('open_app', {app})} },
    () => { const app = pick(apps); return {user: `close ${appPhrase(app)}`, calls: single('close_app', {app})} },
    () => { const app = pick(apps); return {user: `maximize ${appPhrase(app)}`, calls: single('maximize_app', {app})} },
    () => { const theme = pick(['dark', 'light'] as const); return {user: `${pick(['switch to', 'turn on', 'use'])} ${theme} mode`, calls: single('set_theme', {theme})} },
    () => { const color = pick(accents); return {user: `make the accent ${color}`, calls: single('set_accent', {color})} },
    () => { const photo = photoReference(); return {user: `open ${photo.phrase}`, calls: single('open_photo', {photo: photo.argument})} },
    () => { const app = pick(apps); const position = pick(['left', 'right', 'center'] as const); return {user: `move ${appPhrase(app)} to the ${position}`, calls: single('move_app', {app, position})} },
    () => ({user: 'hide the arcs', calls: single('set_arcs', {visibility: 'hidden'})}),
    () => ({user: 'freeze the wallpaper', calls: single('set_wallpaper', {motion: 'still'})}),
    () => { const text = pick(noteTexts); return {user: `write ${text} in my notes`, calls: single('write_note', {mode: 'append', text})} },
  ]
  const joiners = phrasings([' and ', ', then ', ' and then ', ', and ', ' and also ', ' then ', ', also '], split)
  const first = pick(short)()
  let second = pick(short)()
  for (let tries = 0; tries < 5 && second.user === first.user; tries++) second = pick(short)()
  return {user: `${first.user}${pick(joiners)}${second.user}`, calls: [...first.calls!, ...second.calls!]}
}

const capabilityReply = 'I can open, move, resize and arrange the windows, open photos in Chroma, write in your note, switch Scope\'s lists, and change the theme, accent color, wallpaper and glass. Just tell me what to do.'
const declineReply = 'I only run Prism OS, so I can\'t help with that. I can arrange windows, open photos, write notes or change the theme.'

const textRows: Record<string, {users: readonly string[], replies: readonly string[]}> = {
  greeting: {
    users: ['hi', 'hello', 'hey there', 'good morning', 'yo', 'hey', 'good evening', 'howdy', 'hi there', 'sup', 'hello prism', 'greetings', 'good afternoon', 'hiya', 'morning'],
    replies: ['Hi! What should I do in Prism OS?', 'Hello! I can arrange windows, open photos or change settings. What would you like?'],
  },
  thanks: {
    users: ['thanks', 'thank you', 'great job', 'perfect', 'nice', 'awesome, thanks', 'cool', 'that worked', 'thanks a lot', 'appreciate it', 'good job', 'excellent', 'nice work', 'ty', 'love it'],
    replies: ['You\'re welcome.', 'Glad that worked.'],
  },
  capabilities: {
    users: ['what can you do', 'help', 'what commands are there', 'how do I use this', 'what can I ask you', 'list your commands', 'what are my options', 'what do you do', 'how does this work', 'I need help', 'what else can you do', 'show me what you can do', 'commands', 'what kind of things can you do', 'can you help me'],
    replies: [capabilityReply],
  },
  identity: {
    users: ['who are you', 'what is your name', 'are you a person', 'are you ChatGPT', 'who made you', 'are you human', 'what should I call you', 'introduce yourself', 'are you an assistant', 'tell me about yourself'],
    replies: ['I\'m the Prism OS command center: a small model running entirely in your browser. I turn what you type into window, photo, note and setting commands.'],
  },
  off_topic: {
    users: ['what is the weather today', 'tell me a joke', 'write me a poem', 'what is 17 times 23', 'who won the game last night', 'translate hello to spanish', 'what is the capital of france', 'give me a recipe for pancakes', 'what is the meaning of life', 'summarize the news', 'write an email to my boss', 'what time is it', 'how tall is mount everest', 'recommend a movie', 'explain quantum physics', 'what stocks should I buy', 'help me with my homework', 'who is the president', 'tell me a story', 'what is bitcoin worth'],
    replies: [declineReply],
  },
  unsupported: {
    users: ['open a terminal', 'delete all my files', 'install an app', 'change the wallpaper to cats', 'play some music', 'open safari', 'set an alarm for 7', 'shut down the computer', 'open photo 20', 'make the accent purple', 'add a new app', 'open a new window', 'upload a photo', 'take a screenshot', 'connect to wifi', 'send an email', 'open the settings app', 'make the font bigger', 'turn up the volume', 'restart prism os'],
    replies: ['Prism OS can\'t do that yet. I can arrange its three apps, open its 12 photos, write in the note, and change the theme, accent, wallpaper motion and glass.'],
  },
  ambiguous: {
    users: ['minimize it', 'close it', 'move it left', 'make it bigger', 'maximize that', 'hide that window', 'move this to the right', 'shrink it', 'close that', 'open it'],
    replies: ['Which app: Scope, Inkwell or Chroma?'],
  },
}

function textRow(split: Split): Row {
  const kind = pick(Object.keys(textRows))
  const {users, replies} = textRows[kind]!
  return {user: pick(phrasings(users, split)), reply: pick(replies)}
}

function generate(split: Split, count: number) {
  const rows: Row[] = []
  const makers = Object.values(commandMakers)
  const seen = new Set<string>()
  let attempts = 0
  while (rows.length < count && attempts < count * 20) {
    attempts++
    const r = random.next()
    const row = r < 0.76 ? pick(makers)(split) : r < 0.9 ? compound(split) : textRow(split)
    row.user = dress(row.user)
    // Text rows repeat by design, a few times each; other rows are kept unique.
    const key = row.user.toLowerCase()
    if (row.calls !== undefined && seen.has(key)) continue
    seen.add(key)
    for (const call of row.calls ?? []) {
      const result = validateCall(call.name, call.arguments)
      if (!result.ok) throw new Error(`generated an invalid call ${JSON.stringify(call)}: ${result.reason}`)
    }
    rows.push(row)
  }
  return rows
}

// The chat that the page sends, without the tools: the same developer line, the user's
// sentence, and the answer to learn.
export const developerPrompt = 'You are a model that can do function calling with the following functions'

function toMessages(row: Row) {
  const assistant = row.calls !== undefined
    ? {role: 'assistant', tool_calls: row.calls.map(call => ({type: 'function', function: {name: call.name, arguments: call.arguments}}))}
    : {role: 'assistant', content: row.reply}
  return {messages: [{role: 'developer', content: developerPrompt}, {role: 'user', content: row.user}, assistant]}
}

if (import.meta.main) {
  const directory = resolve(import.meta.dir, '../src/prismos/training')
  mkdirSync(directory, {recursive: true})
  const train = generate('train', 8000)
  const evaluation = generate('eval', 700)
  const trainUsers = new Set(train.map(row => row.user.toLowerCase()))
  const heldOut = evaluation.filter(row => !trainUsers.has(row.user.toLowerCase()))
  writeFileSync(resolve(directory, 'train.jsonl'), train.map(row => JSON.stringify(toMessages(row))).join('\n') + '\n')
  writeFileSync(resolve(directory, 'eval.jsonl'), heldOut.map(row => JSON.stringify(toMessages(row))).join('\n') + '\n')
  writeFileSync(resolve(directory, 'tools.json'), JSON.stringify(toolDeclarations, null, 2) + '\n')
  const count = (rows: Row[], test: (row: Row) => boolean) => rows.filter(test).length
  console.log(`train: ${train.length} rows, ${count(train, row => (row.calls?.length ?? 0) > 1)} with two calls, ${count(train, row => row.reply !== undefined)} replies`)
  console.log(`eval: ${heldOut.length} rows (${evaluation.length - heldOut.length} dropped as seen in train), ${count(heldOut, row => (row.calls?.length ?? 0) > 1)} with two calls, ${count(heldOut, row => row.reply !== undefined)} replies`)
}
