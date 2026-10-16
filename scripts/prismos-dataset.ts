// Writes the fine-tuning data for the command center's model, from the command list in
// src/prismos/commands.ts. Each row is one exchange: what a person types, and either the
// calls the model should make or the reply it should write. Rows are made with the
// commands of commands.ts and written as the model's grouped calls, see model-tools.ts. The tools aren't repeated in
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
import {existsSync, readFileSync, mkdirSync, writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {photoNames} from '../src/handwiredos/photo-gallery.ts'
import {type App, type ProgramApp, accentNames, apps, cities, programApps, sceneNames, validateCall} from '../src/prismos/commands.ts'
import {expandCall, groupCall, modelTools} from '../src/prismos/model-tools.ts'

type Call = {name: string, arguments: Record<string, string>}
// keepCase: the answer copies words of the sentence (a path, a note, a search), so the
// sentence is never written in capitals, which the answer couldn't follow. free: the
// sentence ends in free text, e.g. a search, so a command after it in a longer sentence
// needs a comma or "and" to say where the text stops.
// asked: the sentence is a question searched as asked, so the search is the sentence as
// dressed, without its "please" and its end mark.
type Row = {user: string, calls?: Call[], reply?: string, keepCase?: boolean, free?: boolean, asked?: boolean}
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
  cabinet: ['cabinet', 'Cabinet', 'files', 'file manager'],
  browser: ['Browser', 'browser', 'the browser', 'the web browser', 'web browser', 'Safari', 'safari', 'Chrome', 'chrome', 'Firefox', 'the internet'],
  scope: ['Scope', 'scope', 'the monitor', 'Monitor', 'the inspector', 'the scope window', 'scope app'],
  inkwell: ['Inkwell', 'inkwell', 'notes', 'the notes app', 'my notes', 'the note', 'Notes', 'the notepad'],
  chroma: ['Chroma', 'chroma', 'photos', 'the gallery', 'Photos', 'the photo app', 'pictures', 'the photos window'],
  calculator: ['Calculator', 'calculator', 'the calculator', 'calc', 'the calc app'],
  clock: ['Clock', 'clock', 'the clock', 'the world clock', 'the clock app'],
  terminal: ['Terminal', 'terminal', 'the terminal', 'the shell', 'the console'],
  settings: ['Settings', 'settings', 'the settings', 'preferences', 'system settings'],
  about: ['About', 'about', 'the about window', 'About Prism OS', 'about prism'],
}
// The panels that can fill the screen: Calculator and About keep their size.
const zoomable: readonly App[] = [...programApps, 'browser', 'clock', 'terminal', 'settings']
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
    page_up: ['page up', 'page up in the list', 'scroll up a page in scope', 'go up a page', 'previous page of the list', 'one page up', 'up a whole page', 'page up in the inspector', 'scroll a screen up', 'jump up a page'],
    page_down: ['page down', 'page down in the list', 'scroll down a page in scope', 'go down a page', 'next page of the list', 'one page down', 'down a whole page', 'page down in the inspector', 'scroll a screen down', 'jump down a page'],
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
  set_motion: {
    off: ['stop the wallpaper', 'freeze the dunes', 'stop the background moving', 'the wallpaper is distracting, hold it still', 'pause the wallpaper animation', 'make the background still', 'no more moving dunes', 'stop animating the desktop', 'hold the dunes still', 'static wallpaper', 'stop the moving background', 'freeze the wallpaper', 'turn off the wallpaper motion', 'still background please', 'the dunes should not move'],
    on: ['animate the wallpaper', 'let the dunes move again', 'start the wallpaper animation', 'make the background move', 'resume the dunes', 'moving wallpaper please', 'turn the wallpaper animation back on', 'animate the desktop', 'let the background drift', 'unfreeze the dunes', 'start the moving background', 'unfreeze the wallpaper', 'turn on the wallpaper motion', 'animated background please', 'let the dunes drift'],
  },
  set_wallpaper: ['{scene} wallpaper', 'change the wallpaper to {scene}', 'set the wallpaper to {scene}', 'use the {scene} wallpaper', 'switch to the {scene} scene', 'wallpaper {scene}', 'I want the {scene} wallpaper', 'make the background {scene}', 'show the {scene} scene', 'can I have the {scene} wallpaper', 'pick {scene} for the wallpaper', 'change the desktop to {scene}', 'try the {scene} wallpaper', 'go with {scene} for the background', 'new wallpaper: {scene}'],
  calculate: ['what is {expr}', 'calculate {expr}', '{expr}', 'how much is {expr}', 'compute {expr}', 'what does {expr} equal', 'work out {expr}', '{expr} equals what', 'can you calculate {expr}', 'quick math: {expr}', 'solve {expr}', 'what\'s {expr}', 'figure out {expr}', 'do the math on {expr}', '{expr}?'],
  stopwatch: {
    start: ['start the stopwatch', 'start a timer', 'begin timing', 'stopwatch start', 'time this', 'start counting', 'start the clock timer', 'kick off the stopwatch', 'go, start timing', 'run the stopwatch'],
    stop: ['stop the stopwatch', 'stop timing', 'stopwatch stop', 'pause the stopwatch', 'stop the timer', 'halt the stopwatch', 'freeze the stopwatch', 'end the timing', 'stop counting', 'that is it, stop the clock'],
    lap: ['lap', 'mark a lap', 'record a lap', 'lap time', 'new lap', 'split', 'take a lap', 'log a lap', 'stopwatch lap', 'add a lap'],
    reset: ['reset the stopwatch', 'clear the stopwatch', 'stopwatch reset', 'zero the stopwatch', 'reset the timer', 'start the stopwatch over', 'clear the laps', 'set the stopwatch back to zero', 'wipe the stopwatch', 'reset timing'],
  },
  world_time: ['what time is it in {city}', 'time in {city}', 'what is the time in {city}', 'current time in {city}', 'what\'s the time in {city} right now', 'tell me the time in {city}', 'is it night in {city}', 'clock for {city}', 'what time is it over in {city}', 'how late is it in {city}', '{city} time', 'local time in {city}', 'show me the time in {city}', 'what hour is it in {city}', 'time check for {city}'],
  open_website: ['go to {site}', 'open {site}', 'visit {site}', 'take me to {site}', 'browse to {site}', 'load {site}', 'open the website {site}', 'show me {site}', 'navigate to {site}', 'pull up {site}', 'open {site} in the browser', 'I want to go to {site}', 'can you load {site}', 'bring up the site {site}', 'head over to {site}', 'go to the page {site}', 'open up {site}', 'let me see {site}', 'browse {site}', 'show {site} in browser'],
  search_web: ['search the web for {query}', 'google {query}', 'look up {query}', 'search for {query}', 'search online for {query}', 'find {query} on the web', 'web search {query}', 'search the internet for {query}', 'bing {query}', 'look up {query} online', 'search {query} on the web', 'what does the web say about {query}', 'find me pages about {query}', 'run a web search for {query}', 'look for {query} online', 'search bing for {query}', 'do a search for {query}', 'search the browser for {query}', 'can you search for {query}', 'find information about {query} online'],
  browser_navigate: {
    back: ['go back a page', 'previous page', 'back in the browser', 'go back in the browser', 'take me back a page', 'the page before', 'back to the last page', 'browser back', 'go to the previous page', 'return to the last website'],
    forward: ['go forward a page', 'forward in the browser', 'next page in the browser', 'browser forward', 'go to the next page', 'forward one page', 'go forward in the browser', 'take me forward a page', 'go ahead a page', 'the page after'],
    reload: ['refresh the page', 'reload', 'reload the page', 'refresh', 'reload the website', 'refresh the browser', 'the page is stuck, reload it', 'refresh this site', 'hit refresh', 'load the page again'],
    home: ['browser home', 'show favorites', 'go to the browser favorites', 'open favorites', 'back to favorites', 'browser start page', 'show my favorites in the browser', 'go to the start page', 'favorites please', 'take the browser home'],
  },
  start_timer: ['set a timer for {d}', 'start a timer for {d}', 'timer for {d}', 'set the timer to {d}', 'countdown {d}', 'count down {d}', 'remind me in {d}', 'time {d} for me', 'I need a timer for {d}', 'can you time {d}', 'put a timer on for {d}', 'alert me in {d}', 'start counting down {d}', 'let me know when {d} is up', 'timer {d}', 'set timer {d}', 'a timer for {d} please', 'begin a {d} countdown', 'set up a timer for {d}', 'ring me in {d}'],
  timer: {
    pause: ['pause the timer', 'pause timer', 'hold the timer', 'freeze the timer', 'stop the countdown for a moment', 'pause my timer', 'put the timer on hold', 'timer pause', 'wait, pause the timer', 'hold on, pause the countdown'],
    resume: ['resume the timer', 'continue the timer', 'unpause the timer', 'keep the timer going', 'start the timer again', 'timer resume', 'resume my countdown', 'carry on with the timer', 'continue the countdown', 'let the timer run again'],
    cancel: ['cancel the timer', 'stop the timer', 'turn off the timer', 'clear the timer', 'end the timer', 'kill the timer', 'never mind the timer', 'delete my timer', 'timer off', 'I do not need the timer anymore'],
  },
  // Questions about the world: the answer is a web search, of the question as asked.
  weather_question: ['what is the weather in {city}', 'what\'s the weather like today', 'weather in {city}', 'is it going to rain today', 'will it rain in {city} tomorrow', 'how hot is it in {city}', 'weather forecast for {city}', 'do I need an umbrella today', 'how cold is it in {city} right now', 'what is the temperature in {city}', 'weather this weekend', 'what\'s the forecast for tomorrow', 'is it snowing in {city}', 'weather today', 'how is the weather in {city}'],
  web_question: ['who won the game last night', 'what is the capital of france', 'give me a recipe for pancakes', 'how tall is mount everest', 'who is the president', 'what is bitcoin worth', 'translate hello to spanish', 'explain quantum physics', 'recommend a movie', 'latest news', 'what is the population of japan', 'when was the eiffel tower built', 'how far is the moon', 'what movies are playing tonight', 'how do I boil an egg', 'who wrote pride and prejudice', 'what time does the sun set today', 'how many ounces in a cup', 'what is the score of the lakers game', 'best pizza near me', 'how old is taylor swift', 'what does photosynthesis mean', 'how do you say thank you in japanese', 'when is the next full moon', 'what is the tallest building in the world'],
  world_time_here: ['what time is it', 'what is the time', 'time', 'current time', 'what\'s the time', 'tell me the time', 'what time is it now', 'clock check', 'what day is it', 'the time please'],
  set_arcs: {
    hidden: ['hide the arcs', 'hide the weight lines', 'turn off the wiring', 'remove the lines behind the windows', 'hide the weights', 'no arcs please', 'get rid of the curves on the desktop', 'turn off the weight arcs', 'clear the lines from the background', 'hide the network drawing', 'hide the wires', 'no wiring', 'remove the arcs', 'turn the arcs off', 'hide the lines on the desk'],
    shown: ['show the arcs', 'show the weight lines', 'turn on the wiring', 'bring back the lines behind the windows', 'show the weights', 'arcs on', 'draw the network again', 'turn the weight arcs back on', 'I want the curves back', 'display the weight arcs', 'show the wires', 'wiring on', 'bring the arcs back', 'turn the arcs on', 'show the lines on the desk'],
  },
  get_stats: ['how many weights does this have', 'stats', 'how big is the program', 'how many operations are there', 'how many layers are there', 'give me the numbers', 'program stats', 'how many source cells', 'what are the program numbers', 'show me the stats', 'how large is the network', 'size of the program', 'how many layers does it have', 'how many weights are there', 'count the operations', 'how many parameters', 'what is the weight count', 'numbers on the program', 'how many cells', 'how big is the network'],
  explain: {
    prism_os: ['what is prism os', 'what is this', 'what am I looking at', 'explain prism os', 'what is this desktop', 'tell me about prism os', 'what is this thing', 'describe prism os', 'what does prism os do', 'what is this site'],
    scope: ['what does scope do', 'what is the scope app', 'explain scope', 'what is the inspector for', 'what is monitor', 'tell me about scope', 'what is scope', 'what is the inspector', 'describe scope', 'what does the inspector show'],
    inkwell: ['what is inkwell', 'explain inkwell', 'what does the notes app do', 'is my note saved', 'what is the note app', 'tell me about inkwell', 'what are notes for', 'describe inkwell', 'does my note get saved', 'what is the notepad'],
    chroma: ['what is chroma', 'explain chroma', 'what does the gallery do', 'how many photos are there', 'what is the photo app', 'tell me about chroma', 'what is the gallery', 'describe chroma', 'what is in the gallery', 'what does chroma do'],
    handwired: ['what is handwired', 'how does this work under the hood', 'is this really a neural network', 'explain handwired', 'how does the program work', 'tell me about handwired', 'how does the window manager work', 'what runs this desktop', 'is the window manager a neural net', 'how was this built'],
    command_center: ['how do you work', 'explain spotlight', 'what model are you', 'how does this chat work', 'do you run in my browser', 'are you running locally', 'what is spotlight', 'tell me about spotlight', 'where do you run', 'is this ai running on my computer'],
    calculator: ['what is the calculator', 'explain the calculator', 'what does calculator do', 'tell me about calculator', 'how does the calculator work'],
    clock: ['what is the clock app', 'explain clock', 'what does the clock do', 'tell me about the clock', 'what can the clock do'],
    terminal: ['what is terminal', 'explain the terminal', 'what does the terminal do', 'what commands does terminal have', 'tell me about the terminal'],
    browser: ['what is the browser', 'explain the browser', 'what does browser do', 'tell me about the browser', 'why won\'t some sites open in the browser'],
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
const accentForms: Record<(typeof accentNames)[number], readonly string[]> = {
  blue: ['blue', 'Blue'],
  teal: ['teal', 'Teal', 'turquoise'],
  green: ['green', 'Green'],
  yellow: ['yellow', 'Yellow', 'gold'],
  orange: ['orange', 'Orange', 'amber'],
  red: ['red', 'Red'],
  graphite: ['graphite', 'gray', 'grey'],
}
const sceneForms: Record<(typeof sceneNames)[number], readonly string[]> = {
  dunes: ['dunes', 'Dunes', 'the dunes'],
  lagoon: ['lagoon', 'Lagoon', 'the lagoon'],
  ember: ['ember', 'Ember'],
  graphite: ['graphite', 'Graphite'],
}
// Sites people name, as typed, which the model copies into the call. Every one passes
// webAddress, also the ones Browser can't show: the reply says so.
const siteForms = ['wikipedia.org', 'en.wikipedia.org/wiki/Prism', 'archive.org', 'xkcd.com', 'example.com', 'www.gutenberg.org', 'https://en.wiktionary.org/wiki/glass', 'bing.com', 'github.com', 'news.ycombinator.com', 'https://www.bbc.com/news', 'nytimes.com', 'developer.mozilla.org', 'youtube.com/watch?v=dQw4w9WgXcQ', 'en.wikipedia.org/wiki/Optics', 'marginalia-search.com', 'wikipedia dot org', 'xkcd dot com', 'archive dot org', 'en dot wikipedia dot org slash wiki slash Light']
const searchQueries = ['youtube', 'glass prisms', 'how rainbows form', 'best pancake recipe', 'the speed of light', 'weather in Tokyo', 'who invented the telescope', 'liquid glass design', 'neural networks explained', 'cheap flights to Lisbon', 'how to tie a bowline knot', 'Isaac Newton optics', 'sand dune formation', 'FunctionGemma', 'news today', 'chocolate chip cookies', 'the tallest mountain in Europe']
const timerLengths = ['5 minutes', '10 minutes', '3 minutes', '1 minute', '30 seconds', '90 seconds', '45 seconds', '1 hour', '2 hours', 'half an hour', 'an hour and a half', '15 minutes', '25 minutes', '20 mins', '1 minute 30 seconds', '2.5 minutes', '1:30', 'ten minutes', 'twenty minutes', '8 min']
// Cabinet's files and folders as people name them: a path from the top, or a name in
// the folder Cabinet shows. The answer copies the path as typed.
const folders = ['Documents', 'Pictures', 'Projects', 'Music', 'Downloads', 'Work', 'Recipes', 'Travel']
const fileNames = ['Notes.txt', 'Plan.txt', 'Beach.png', 'Ideas.md', 'Budget.csv', 'Resume.txt', 'todo.txt', 'report.md', 'cat.jpg', 'Groceries.txt', 'Trip.png', 'Draft 2.txt']
const newFiles = ['Idea.txt', 'Letter.txt', 'Packing List.txt', 'Meeting Notes.md', 'Poem.txt', 'Recipe.txt']
const newFolders = ['Garden', 'Taxes 2026', 'Photos', 'Archive', 'School', 'Old Stuff']
const newNames = ['Final.txt', 'Plan v2.txt', 'Old Notes.txt', 'Summer.png', 'Budget 2026.csv', 'Draft.md']
const fileQueries = ['Plan', 'budget', 'beach', 'notes', 'resume', 'trip', 'report', 'ideas']
const inFolder = (name: string) => random.next() < 0.55 ? `/${pick(folders)}/${name}` : name
const filePath = () => inFolder(pick(fileNames))
const folderPath = () => random.next() < 0.55 ? `/${pick(folders)}` : pick(folders)
const newFilePath = () => inFolder(pick(newFiles))
const newFolderPath = () => inFolder(pick(newFolders))
const cabinetTemplates = {
  list_files: ['list files in {folder}', 'list the files in {folder}', 'show the files in {folder}', 'what files are in {folder}', 'what is in {folder}', 'list everything in {folder}', 'show me the contents of {folder}', 'list the contents of {folder}', 'which files are in {folder}', 'list {folder}'],
  open_file: ['open file {file}', 'open {file}', 'open the file {file}', 'bring up {file}', 'open the folder {folder}', 'go to the folder {folder}', 'open {file} in cabinet', 'pull up the file {file}', 'view the file {file}', 'open folder {folder}'],
  create_folder: ['create folder {newfolder}', 'make a folder called {newfolder}', 'new folder {newfolder}', 'create a new folder named {newfolder}', 'add a folder {newfolder}', 'make a new folder {newfolder}', 'create a directory {newfolder}', 'make folder {newfolder}', 'set up a folder called {newfolder}', 'I need a new folder {newfolder}'],
  create_document: ['create document {newfile}', 'make a new text file {newfile}', 'create an empty file called {newfile}', 'new document {newfile}', 'make a document named {newfile}', 'start a new file {newfile}', 'create a text document {newfile}', 'add a blank file {newfile}', 'make an empty document at {newfile}', 'create file {newfile}'],
  save_note_as: ['save my note as {newfile}', 'save the note as {newfile}', 'save inkwell as {newfile}', 'save this note to {newfile}', 'store my note in {newfile}', 'save the draft as {newfile}', 'keep a copy of my note in {newfile}', 'save the notes to {newfile}', 'save what I wrote as {newfile}', 'save my inkwell draft as {newfile}'],
  duplicate_file: ['duplicate file {file}', 'duplicate {file}', 'make a copy of {file}', 'copy {file}', 'clone {file}', 'create a duplicate of {file}', 'make another copy of {file}', 'copy the file {file}', 'duplicate the file {file}', 'make a second copy of {file}'],
  trash_file: ['trash file {file}', 'move {file} to the trash', 'put {file} in the trash', 'throw away {file}', 'trash {file}', 'send {file} to the trash', 'get rid of {file}', 'remove {file}', 'bin {file}', 'toss {file} in the trash'],
  restore_file: ['restore file {file}', 'restore {file}', 'recover {file}', 'bring {file} back from the trash', 'undelete {file}', 'get {file} out of the trash', 'restore {file} from the trash', 'take {file} out of the trash', 'put {file} back where it was', 'recover {file} from the trash'],
  download_file: ['download file {file}', 'download {file}', 'save {file} to my computer', 'export {file}', 'download a copy of {file}', 'save {file} to my device', 'get {file} onto my computer', 'download the file {file}', 'export {file} to my device', 'save a copy of {file} to my downloads'],
  delete_file: ['delete file {file}', 'permanently delete {file}', 'delete {file} forever', 'erase {file} from the trash', 'remove {file} from the trash for good', 'permanently remove {file}', 'delete {file} permanently', 'wipe {file} from the trash', 'destroy {file} in the trash', 'purge {file} from the trash'],
  search_files: ['search files for {q}', 'find files named {q}', 'search cabinet for {q}', 'find {q} in my files', 'look for files called {q}', 'which files have {q} in the name', 'search my files for {q}', 'find the file called {q}', 'locate {q} in cabinet', 'find files with {q} in the name'],
  rename_file: ['rename file {file} to {newname}', 'rename {file} to {newname}', 'change the name of {file} to {newname}', 'call {file} {newname} instead', 'rename {file} as {newname}', 'give {file} the name {newname}', 'retitle {file} to {newname}', 'change {file} to be named {newname}', 'rename the file {file} to {newname}', 'name {file} {newname} from now on'],
  move_file: ['move file {file} to {folder}', 'move {file} to {folder}', 'put {file} in {folder}', 'move {file} into the folder {folder}', 'file {file} under {folder}', 'relocate {file} to {folder}', 'drag {file} into {folder}', 'send {file} over to {folder}', 'move the file {file} into {folder}', 'shift {file} over to {folder}'],
  empty_trash: ['empty the trash', 'empty trash', 'clear the trash', 'delete everything in the trash', 'take out the trash', 'wipe the trash', 'empty the bin', 'purge the trash', 'permanently delete everything in trash', 'clean out the trash'],
  import_files: ['import files', 'import some files', 'add files from my computer', 'upload files to cabinet', 'bring files into cabinet', 'import photos from my device', 'add a file from my computer', 'upload a document', 'import from my computer', 'let me add files to cabinet'],
} as const

const cityNames = Object.keys(cities).filter(city => city !== 'here')
const titleCase = (text: string) => text.replace(/\b\w/gu, letter => letter.toUpperCase())

// Arithmetic as people type it: symbols or words, with or without spaces.
function arithmeticQuestion(): string {
  const number = () => String(pick([2, 3, 4, 5, 7, 8, 9, 12, 15, 17, 23, 25, 42, 50, 64, 99, 100, 128, 250, 365, 1024, 2.5, 0.75]))
  const operators = [['+', 'plus'], ['-', 'minus'], ['*', 'times'], ['/', 'divided by'], ['x', 'multiplied by'], ['×', 'times'], ['÷', 'over']] as const
  const [symbol, word] = pick(operators)
  const a = number()
  const b = number()
  const style = random.next()
  if (style < 0.12) return `${a}% of ${b}`
  if (style < 0.2) return `(${a} + ${b}) * ${number()}`
  return style < 0.55 ? `${a} ${word} ${b}` : style < 0.8 ? `${a} ${symbol} ${b}` : `${a}${symbol}${b}`
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
function dress(sentence: string, keepCase = false) {
  let text = sentence
  const extra = random.next()
  if (extra < 0.08) text = `please ${text}`
  else if (extra < 0.14) text = `${text} please`
  else if (extra < 0.18) text = `hey, ${text}`
  else if (extra < 0.22) text = `can you ${text}`
  const r = random.next()
  if (r < 0.45) text = text.charAt(0).toUpperCase() + text.slice(1)
  else if (r < 0.47 && !keepCase) text = text.toUpperCase()
  const mark = random.next()
  if (mark < 0.15) text += '.'
  else if (mark < 0.22) text += '!'
  return text
}

// A dressed sentence without the words and marks dress() adds around it.
function withoutCourtesy(sentence: string) {
  return sentence.replace(/^(?:please|hey,|can you)\s+/iu, '').replace(/\s+please(?=[.!]?$)/iu, '').replace(/[.!]+$/u, '')
}

// One command row of each kind, phrased from the split's templates.
const commandMakers: Record<string, (split: Split) => Row> = {
  cabinet(split) {
    const name = pick(Object.keys(cabinetTemplates) as (keyof typeof cabinetTemplates)[])
    const values = {file: filePath(), folder: folderPath(), newfile: newFilePath(), newfolder: newFolderPath(), newname: pick(newNames), q: pick(fileQueries)}
    const user = fill(pick(phrasings(cabinetTemplates[name], split)), values)
    const args: Record<string, Record<string, string>> = {
      list_files: {path: values.folder},
      open_file: {path: user.includes(values.file) ? values.file : values.folder},
      create_folder: {path: values.newfolder},
      create_document: {path: values.newfile},
      save_note_as: {path: values.newfile},
      duplicate_file: {path: values.file},
      trash_file: {path: values.file},
      restore_file: {path: values.file},
      download_file: {path: values.file},
      delete_file: {path: values.file},
      search_files: {query: values.q},
      rename_file: {path: values.file, new_name: values.newname},
      move_file: {path: values.file, destination: values.folder},
      empty_trash: {},
      import_files: {},
    }
    return {user, calls: single(name, args[name]), keepCase: true, free: name === 'search_files'}
  },
  app_command(split) {
    const name = pick(['open_app', 'minimize_app', 'maximize_app', 'restore_app', 'close_app'] as const)
    const app = pick(name === 'maximize_app' || name === 'restore_app' ? zoomable : apps)
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
    const app: ProgramApp = pick(programApps)
    const size = pick(Object.keys(sizeForms) as (keyof typeof sizeForms)[])
    const user = size === 'bigger' && random.next() < 0.25
      ? `grow ${appPhrase(app)}`
      : size === 'smaller' && random.next() < 0.25
        ? `shrink ${appPhrase(app)}`
        : fill(pick(phrasings(templates.resize_app, split)), {app: appPhrase(app), size: pick(sizeForms[size])})
    return {user, calls: single('resize_app', {app, size})}
  },
  side_by_side(split) {
    const left: ProgramApp = pick(programApps)
    const right = pick(programApps.filter(app => app !== left))
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
    return {user: fill(pick(phrasings(replace ? templates.write_note_replace : templates.write_note_append, split)), {text}), calls: single('write_note', {mode: replace ? 'replace' : 'append', text}), keepCase: true}
  },
  note_other(split) {
    const name = pick(['clear_note', 'read_note'] as const)
    return {user: pick(phrasings(templates[name], split)), calls: single(name)}
  },
  set_theme(split) {
    const theme = pick(['dark', 'light', 'system'] as const)
    return {user: pick(phrasings(templates.set_theme[theme], split)), calls: single('set_theme', {theme: theme === 'system' ? 'auto' : theme})}
  },
  set_accent(split) {
    const color = pick(accentNames)
    return {user: fill(pick(phrasings(templates.set_accent, split)), {color: pick(accentForms[color])}), calls: single('set_accent', {color})}
  },
  set_wallpaper(split) {
    const scene = pick(sceneNames)
    return {user: fill(pick(phrasings(templates.set_wallpaper, split)), {scene: pick(sceneForms[scene])}), calls: single('set_wallpaper', {scene})}
  },
  calculate(split) {
    // The answer copies the arithmetic as typed, words and all: the validator reads it.
    const phrase = arithmeticQuestion()
    return {user: fill(pick(phrasings(templates.calculate, split)), {expr: phrase}), calls: single('calculate', {expression: phrase}), keepCase: true}
  },
  stopwatch(split) {
    const action = pick(['start', 'stop', 'lap', 'reset'] as const)
    return {user: pick(phrasings(templates.stopwatch[action], split)), calls: single('stopwatch', {action})}
  },
  world_time(split) {
    if (random.next() < 0.3) return {user: pick(phrasings(templates.world_time_here, split)), calls: single('world_time', {city: 'here'})}
    const city = pick(cityNames)
    return {user: fill(pick(phrasings(templates.world_time, split)), {city: random.next() < 0.6 ? titleCase(city) : city}), calls: single('world_time', {city})}
  },
  appearance(split) {
    const kind = pick(['set_motion', 'set_arcs'] as const)
    if (kind === 'set_motion') {
      const motion = pick(['off', 'on'] as const)
      return {user: pick(phrasings(templates.set_motion[motion], split)), calls: single(kind, {motion})}
    }
    const visibility = pick(['hidden', 'shown'] as const)
    return {user: pick(phrasings(templates.set_arcs[visibility], split)), calls: single(kind, {visibility})}
  },
  web(split) {
    if (random.next() < 0.45) {
      const query = pick(searchQueries)
      return {user: fill(pick(phrasings(templates.search_web, split)), {query}), calls: single('search_web', {query}), keepCase: true}
    }
    const address = pick(siteForms)
    return {user: fill(pick(phrasings(templates.open_website, split)), {site: address}), calls: single('open_website', {address}), keepCase: true}
  },
  browser_navigate(split) {
    const action = pick(Object.keys(templates.browser_navigate) as (keyof typeof templates.browser_navigate)[])
    return {user: pick(phrasings(templates.browser_navigate[action], split)), calls: single('browser_navigate', {action})}
  },
  timer(split) {
    if (random.next() < 0.6) {
      const duration = pick(timerLengths)
      // "a 5 minute timer", as people say a length before "timer".
      const user = random.next() < 0.2 ? `${pick(['start a', 'set a', 'give me a'])} ${duration.replace(/s$/u, '')} timer` : fill(pick(phrasings(templates.start_timer, split)), {d: duration})
      return {user, calls: single('start_timer', {duration: user.endsWith(' timer') ? duration.replace(/s$/u, '') : duration}), keepCase: true}
    }
    const action = pick(Object.keys(templates.timer) as (keyof typeof templates.timer)[])
    return {user: pick(phrasings(templates.timer[action], split)), calls: single('timer', {action})}
  },
  web_question(split) {
    const query = random.next() < 0.4
      ? fill(pick(phrasings(templates.weather_question, split)), {city: titleCase(pick(cityNames))})
      : pick(phrasings(templates.web_question, split))
    return {user: query, calls: single('search_web', {query}), keepCase: true, asked: true}
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
    () => { const theme = pick(['dark', 'light'] as const); return {user: `${pick(['switch to', 'turn on', 'use'])} ${theme} mode`, calls: single('set_theme', {theme})} },
    () => { const color = pick(accentNames); return {user: `make the accent ${color}`, calls: single('set_accent', {color})} },
    () => { const scene = pick(sceneNames); return {user: `${scene} wallpaper`, calls: single('set_wallpaper', {scene})} },
    () => { const photo = photoReference(); return {user: `open ${photo.phrase}`, calls: single('open_photo', {photo: photo.argument})} },
    () => { const app = pick(apps); const position = pick(['left', 'right', 'center'] as const); return {user: `move ${appPhrase(app)} to the ${position}`, calls: single('move_app', {app, position})} },
    () => { const app = pick(programApps); return {user: `maximize ${appPhrase(app)}`, calls: single('maximize_app', {app})} },
    () => ({user: 'hide the arcs', calls: single('set_arcs', {visibility: 'hidden'})}),
    () => ({user: 'freeze the wallpaper', calls: single('set_motion', {motion: 'off'})}),
    () => ({user: 'start the stopwatch', calls: single('stopwatch', {action: 'start'})}),
    () => { const city = pick(cityNames); return {user: `what time is it in ${titleCase(city)}`, calls: single('world_time', {city})} },
    () => { const text = pick(noteTexts); return {user: `write ${text} in my notes`, calls: single('write_note', {mode: 'append', text}), keepCase: true} },
    () => { const address = pick(siteForms); return {user: `go to ${address}`, calls: single('open_website', {address}), keepCase: true, free: address.includes(' ')} },
    () => { const query = pick(searchQueries); return {user: `${pick(['search for', 'search the web for', 'look up', 'google'])} ${query}`, calls: single('search_web', {query}), keepCase: true, free: true} },
    () => { const duration = pick(timerLengths); return {user: `set a timer for ${duration}`, calls: single('start_timer', {duration}), keepCase: true, free: true} },
    () => { const path = filePath(); return {user: `open file ${path}`, calls: single('open_file', {path}), keepCase: true, free: true} },
    () => ({user: pick(['refresh the page', 'reload the page']), calls: single('browser_navigate', {action: 'reload'})}),
  ]
  const joiners = phrasings([' and ', ', then ', ' and then ', ', and ', ' and also ', ' then ', ', also '], split)
  const first = pick(short)()
  let second = pick(short)()
  for (let tries = 0; tries < 5 && second.user === first.user; tries++) second = pick(short)()
  // A quarter of them are three commands, as people say them in one breath: "close
  // inkwell, open safari and search for youtube".
  if (random.next() < 0.25) {
    let third = pick(short)()
    for (let tries = 0; tries < 5 && (third.user === first.user || third.user === second.user); tries++) third = pick(short)()
    const last = pick(phrasings([' and ', ', and ', ' and then ', ', then '], split))
    // Speech recognition writes no commas: "close inkwell open safari and search for youtube".
    // Free text never runs straight into the next command, or its end would be a guess.
    const spoken = random.next() < 0.4
    const firstJoin = spoken && first.free !== true ? ' ' : ', '
    const secondJoin = spoken && second.free !== true ? last.replace(',', '') : last
    return {user: `${first.user}${firstJoin}${second.user}${secondJoin}${third.user}`, calls: [...first.calls!, ...second.calls!, ...third.calls!], keepCase: [first, second, third].some(part => part.keepCase === true)}
  }
  const joiner = random.next() < 0.15 && first.free !== true ? ' ' : pick(joiners)
  return {user: `${first.user}${joiner}${second.user}`, calls: [...first.calls!, ...second.calls!], keepCase: first.keepCase === true || second.keepCase === true}
}

const capabilityReply = 'I can open, move, resize and arrange the windows and apps, open photos in Chroma, open web pages, search the web and look things up in Browser, write in your note, do arithmetic, run the stopwatch and timers, tell the time around the world, and change the appearance, accent color and wallpaper. Just tell me what to do.'
const declineReply = 'That\'s not something I can do. I run Prism OS: I can open apps, look things up on the web in Browser, write notes, set timers, do arithmetic or change the appearance.'

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
    replies: ['I\'m Spotlight\'s model: a small language model running entirely in your browser. I turn what you type into Prism OS commands.'],
  },
  off_topic: {
    users: ['tell me a joke', 'write me a poem', 'write an email to my boss', 'help me with my homework', 'tell me a story', 'what stocks should I buy', 'what is the meaning of life', 'sing me a song', 'draw me a picture', 'tell me something funny', 'be my friend', 'write a cover letter for me', 'make up a riddle', 'pretend to be a pirate', 'give me a pep talk'],
    replies: [declineReply],
  },
  unsupported: {
    users: ['open microsoft word', 'delete all my files', 'install an app', 'change the wallpaper to cats', 'play some music', 'print this page', 'set an alarm for 7', 'shut down the computer', 'open photo 20', 'make the accent purple', 'add a new app', 'open a new window', 'print a document', 'take a screenshot', 'connect to wifi', 'send an email', 'call my mom', 'make the font bigger', 'turn up the volume', 'restart prism os'],
    replies: ['Prism OS can\'t do that yet. I can arrange its windows and apps, open its 12 photos, open web pages, set timers, write in the note, do arithmetic, run the stopwatch, tell the time, and change the appearance, accent and wallpaper.'],
  },
  ambiguous: {
    users: ['minimize it', 'close it', 'move it left', 'make it bigger', 'maximize that', 'hide that window', 'move this to the right', 'shrink it', 'close that', 'open it'],
    replies: ['Which app: Scope, Inkwell, Chroma, Cabinet, Browser, Calculator, Clock, Terminal or Settings?'],
  },
}

function textRow(split: Split): Row {
  const kind = pick(Object.keys(textRows))
  const {users, replies} = textRows[kind]!
  return {user: pick(phrasings(users, split)), reply: pick(replies)}
}

// How often each kind of row is made: about the number of commands it teaches, more for
// the commands whose arguments vary the most, so every command gets its share.
const makerWeights: Partial<Record<keyof typeof commandMakers, number>> = {
  cabinet: 12, app_command: 5, move_app: 2, layout: 2, open_photo: 2, photo_step: 3, write_note: 2, note_other: 2,
  calculate: 2, world_time: 1.5, appearance: 2, web: 3, timer: 2.5, web_question: 2, info: 2,
}
const weightedMakers = Object.entries(commandMakers).map(([name, make]) => ({make, weight: (makerWeights as Record<string, number>)[name] ?? 1}))
const totalWeight = weightedMakers.reduce((sum, maker) => sum + maker.weight, 0)
function pickMaker() {
  let r = random.next() * totalWeight
  for (const maker of weightedMakers) {
    r -= maker.weight
    if (r < 0) return maker.make
  }
  return weightedMakers.at(-1)!.make
}

function generate(split: Split, count: number) {
  const rows: Row[] = []
  const seen = new Set<string>()
  let attempts = 0
  while (rows.length < count && attempts < count * 20) {
    attempts++
    const r = random.next()
    const row = r < 0.76 ? pickMaker()(split) : r < 0.9 ? compound(split) : textRow(split)
    row.user = dress(row.user, row.keepCase === true)
    if (row.asked === true) row.calls = single('search_web', {query: withoutCourtesy(row.user)})
    // Text rows repeat by design, a few times each; other rows are kept unique.
    const key = row.user.toLowerCase()
    if (row.calls !== undefined && seen.has(key)) continue
    seen.add(key)
    for (const call of row.calls ?? []) {
      const result = validateCall(call.name, call.arguments)
      if (!result.ok) throw new Error(`generated an invalid call ${JSON.stringify(call)}: ${result.reason}`)
      const grouped = groupCall(call)
      const expansion = expandCall(grouped.name, grouped.arguments)
      if (!expansion.ok || expansion.calls.length !== 1 || !sameCall(expansion.calls[0]!, call)) {
        throw new Error(`${JSON.stringify(call)} doesn't come back from the model's ${JSON.stringify(grouped)}`)
      }
    }
    rows.push(row)
  }
  return rows
}

function sameCall(a: {name: string, arguments: Record<string, unknown>}, b: {name: string, arguments: Record<string, unknown>}) {
  const sorted = (args: Record<string, unknown>) => JSON.stringify(Object.entries(args).sort(([x], [y]) => x.localeCompare(y)))
  return a.name === b.name && sorted(a.arguments) === sorted(b.arguments)
}

// The chat that the page sends, without the tools: the same developer line, the user's
// sentence, and the answer to learn.
export const developerPrompt = 'You are a model that can do function calling with the following functions'

function toMessages(row: Row) {
  const assistant = row.calls !== undefined
    ? {role: 'assistant', tool_calls: row.calls.map(groupCall).map(call => ({type: 'function', function: call}))}
    : {role: 'assistant', content: row.reply}
  return {messages: [{role: 'developer', content: developerPrompt}, {role: 'user', content: row.user}, assistant]}
}

if (import.meta.main) {
  const directory = resolve(import.meta.dir, '../src/prismos/training')
  mkdirSync(directory, {recursive: true})
  const write = (name: string, text: string) => {
    const path = resolve(directory, name)
    const crlf = existsSync(path) && readFileSync(path, 'utf8').includes('\r\n')
    writeFileSync(path, crlf ? text.replaceAll('\n', '\r\n') : text)
  }
  const train = generate('train', 10000)
  const evaluation = generate('eval', 900)
  const trainUsers = new Set(train.map(row => row.user.toLowerCase()))
  const heldOut = evaluation.filter(row => !trainUsers.has(row.user.toLowerCase()))
  write('train.jsonl', train.map(row => JSON.stringify(toMessages(row))).join('\n') + '\n')
  write('eval.jsonl', heldOut.map(row => JSON.stringify(toMessages(row))).join('\n') + '\n')
  write('tools.json', JSON.stringify(modelTools, null, 2) + '\n')
  const count = (rows: Row[], test: (row: Row) => boolean) => rows.filter(test).length
  console.log(`train: ${train.length} rows, ${count(train, row => (row.calls?.length ?? 0) > 1)} with two calls or more (${count(train, row => (row.calls?.length ?? 0) > 2)} with three), ${count(train, row => row.reply !== undefined)} replies`)
  console.log(`eval: ${heldOut.length} rows (${evaluation.length - heldOut.length} dropped as seen in train), ${count(heldOut, row => (row.calls?.length ?? 0) > 1)} with two calls or more (${count(heldOut, row => (row.calls?.length ?? 0) > 2)} with three), ${count(heldOut, row => row.reply !== undefined)} replies`)
}
