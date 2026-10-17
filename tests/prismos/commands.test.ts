import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {needsConfirmation, parsePhoto, validateCall} from '../../src/prismos/commands.ts'
import {formatCall, parseModelAnswer} from '../../src/prismos/function-calls.ts'
import {quickCommands} from '../../src/prismos/quick-commands.ts'
import {describeCall, previewSentence, welcomeSuggestions} from '../../src/prismos/command-center.ts'
import {evaluateExpression, formatResult} from '../../src/prismos/expression.ts'

test('photos parse by name, part of a name, digit, word and ordinal', () => {
  assert.equal(parsePhoto('Blue Lagoon'), 10)
  assert.equal(parsePhoto('lagoon'), 10)
  assert.equal(parsePhoto('photo 3'), 2)
  assert.equal(parsePhoto('#12'), 11)
  assert.equal(parsePhoto('seven'), 6)
  assert.equal(parsePhoto('third'), 2)
  assert.equal(parsePhoto('3rd'), 2)
  assert.equal(parsePhoto(1), 0)
  assert.equal(parsePhoto('13'), null)
  assert.equal(parsePhoto('the sea'), null)
})

test('the validator accepts aliases and rejects what Prism OS lacks', () => {
  assert.deepEqual(validateCall('minimize_app', {app: 'Notes'}), {ok: true, command: {name: 'minimize_app', app: 'inkwell'}})
  assert.deepEqual(validateCall('move_app', {app: 'gallery', position: 'top left'}), {ok: true, command: {name: 'move_app', app: 'chroma', position: 'top_left'}})
  assert.deepEqual(validateCall('set_accent', {color: 'Teal'}), {ok: true, command: {name: 'set_accent', color: 'teal'}})
  assert.deepEqual(validateCall('set_accent', {color: 'grey'}), {ok: true, command: {name: 'set_accent', color: 'graphite'}})
  assert.deepEqual(validateCall('set_theme', {theme: 'system'}), {ok: true, command: {name: 'set_theme', theme: 'auto'}})
  assert.equal(validateCall('set_accent', {color: 'purple'}).ok, false)
  assert.equal(validateCall('set_wallpaper', {scene: 'volcano'}).ok, false)
  assert.deepEqual(validateCall('open_app', {app: 'Calc'}), {ok: true, command: {name: 'open_app', app: 'calculator'}})
  assert.equal(validateCall('resize_app', {app: 'clock', size: 'bigger'}).ok, false)
  assert.equal(validateCall('side_by_side', {left: 'scope', right: 'terminal'}).ok, false)
  assert.equal(validateCall('calculate', {expression: 'the meaning of life'}).ok, false)
  assert.deepEqual(validateCall('world_time', {city: 'NYC'}), {ok: true, command: {name: 'world_time', city: 'new york'}})
  assert.equal(validateCall('world_time', {city: 'Atlantis'}).ok, false)
  assert.equal(validateCall('open_app', {app: 'photoshop'}).ok, false)
  assert.deepEqual(validateCall('open_app', {app: 'Safari'}), {ok: true, command: {name: 'open_app', app: 'browser'}})
  assert.equal(validateCall('format_disk', {}).ok, false)
  assert.equal(validateCall('side_by_side', {left: 'scope', right: 'monitor'}).ok, false)
  assert.equal(validateCall('write_note', {text: '  '}).ok, false)
  const long = validateCall('write_note', {text: 'x'.repeat(5000)})
  assert.ok(long.ok && long.command.name === 'write_note' && long.command.text.length === 2000)
})

test('erasing and replacing the note, and leaving the page, ask first', () => {
  assert.notEqual(needsConfirmation({name: 'clear_note'}), null)
  assert.notEqual(needsConfirmation({name: 'write_note', text: 'a', mode: 'replace'}), null)
  assert.equal(needsConfirmation({name: 'write_note', text: 'a', mode: 'append'}), null)
  assert.equal(needsConfirmation({name: 'minimize_app', app: 'scope'}), null)
})

test('FunctionGemma calls parse, including strings with commas and braces, and several calls', () => {
  const raw = '<start_function_call>call:write_note{mode:<escape>append<escape>,text:<escape>milk, eggs {2}<escape>}<end_function_call>'
    + '<start_function_call>call:open_photo{photo:3}<end_function_call><start_function_response>'
  const answer = parseModelAnswer(raw)
  assert.deepEqual(answer.calls, [
    {name: 'write_note', arguments: {mode: 'append', text: 'milk, eggs {2}'}},
    {name: 'open_photo', arguments: {photo: 3}},
  ])
  assert.equal(answer.text, '')
  const call = {name: 'move_app', arguments: {position: 'left', app: 'scope'}}
  assert.deepEqual(parseModelAnswer(formatCall(call)).calls, [call])
  assert.deepEqual(parseModelAnswer('Hi! I can move windows, open photos and change settings.<end_of_turn>'), {
    calls: [],
    text: 'Hi! I can move windows, open photos and change settings.',
  })
})

test('the quick parser takes whole common sentences and leaves the rest to the model', () => {
  assert.deepEqual(quickCommands('Dark mode'), [{name: 'set_theme', theme: 'dark'}])
  assert.deepEqual(quickCommands('please minimize the notes window'), [{name: 'minimize_app', app: 'inkwell'}])
  assert.deepEqual(quickCommands('Open photo Blue Lagoon!'), [{name: 'open_photo', photo: 10, bundled: true}])
  assert.deepEqual(quickCommands('next'), [{name: 'next_photo', bare: true}])
  assert.deepEqual(quickCommands('make it teal'), [{name: 'set_accent', color: 'teal'}])
  assert.deepEqual(quickCommands('note this: buy milk'), [{name: 'write_note', text: 'buy milk', mode: 'append'}])
  assert.deepEqual(quickCommands('go to the browser favorites'), [{name: 'browser_navigate', action: 'home'}])
  assert.deepEqual(quickCommands('night mode'), [{name: 'set_theme', theme: 'dark'}])
  assert.deepEqual(quickCommands('show desktop'), [{name: 'show_desktop'}])
  assert.equal(quickCommands('don\'t close scope'), null)
  assert.equal(quickCommands('put scope on the left and the weather on the right'), null)
  assert.equal(quickCommands('make it purple'), null)
  assert.equal(quickCommands('open photo of my cat'), null)
  assert.equal(quickCommands(''), null)
})

test('arithmetic follows precedence, reads words, and never runs code', () => {
  const value = (text: string) => {
    const result = evaluateExpression(text)
    return result.ok ? result.value : result.reason
  }
  assert.equal(value('2 + 3 * 4'), 14)
  assert.equal(value('(2 + 3) * 4'), 20)
  assert.equal(value('what is 17 times 23'), 391)
  assert.equal(value('10% of 250'), 25)
  assert.equal(value('2 squared'), 4)
  assert.equal(value('3x4'), 12)
  assert.equal(value('250x0.75'), 187.5)
  assert.equal(value('-3 - -3'), 0)
  assert.equal(value('1 / 0'), 'That has no number for an answer, e.g. a division by zero.')
  assert.equal(typeof value('alert(1)'), 'string')
  assert.equal(typeof value('2 +'), 'string')
  assert.equal(formatResult(1 / 3), '0.3333333333')
  assert.equal(formatResult(1234567), '1,234,567')
})

test('the quick parser covers Prism\'s apps, settings, Clock and arithmetic', () => {
  const calls = (text: string) => quickCommands(text)?.map(describeCall) ?? null
  assert.deepEqual(calls('open calculator'), ['open_app(calculator)'])
  assert.deepEqual(calls('close the clock'), ['close_app(clock)'])
  assert.deepEqual(calls('put scope and chroma side by side'), ['side_by_side(scope, chroma)'])
  assert.deepEqual(calls('scope on the left and chroma on the right'), ['side_by_side(scope, chroma)'])
  assert.deepEqual(calls('move inkwell to the top right'), ['move_app(inkwell, top_right)'])
  assert.deepEqual(calls('make chroma bigger'), ['resize_app(chroma, bigger)'])
  assert.deepEqual(calls('dark mode and a teal accent'), ['set_theme(dark)', 'set_accent(teal)'])
  assert.deepEqual(calls('minimize inkwell then open chroma'), ['minimize_app(inkwell)', 'open_app(chroma)'])
  assert.deepEqual(calls('lagoon wallpaper'), ['set_wallpaper(lagoon)'])
  assert.deepEqual(calls('stop the wallpaper'), ['set_motion(off)'])
  assert.deepEqual(calls('start the stopwatch'), ['stopwatch(start)'])
  assert.deepEqual(calls('what time is it in tokyo'), ['world_time(tokyo)'])
  assert.deepEqual(calls('what is 17 times 23'), ['calculate(17 * 23)'])
  assert.deepEqual(calls('open blue lagoon'), ['open_photo(Blue Lagoon)'])
  assert.deepEqual(calls('note: buy milk'), ['write_note(buy milk, append)'])
  assert.deepEqual(calls('what is chroma'), ['explain(chroma)'])
  assert.equal(calls('what is the meaning of life'), null)
  assert.equal(calls('open the pod bay doors'), null)
})

test('Spotlight previews a sentence before running it', () => {
  assert.deepEqual(previewSentence('help'), {kind: 'help'})
  const preview = previewSentence('minimize scope')
  assert.ok(preview?.kind === 'commands' && preview.calls === 'minimize_app(scope)')
  assert.equal(previewSentence('calculator'), null)
  assert.equal(previewSentence('write me a poem'), null)
})

test('Browser takes web addresses and searches, and leaves file names alone', () => {
  const calls = (text: string) => quickCommands(text)?.map(describeCall) ?? null
  assert.deepEqual(calls('go to wikipedia.org'), ['open_website(https://wikipedia.org/)'])
  assert.deepEqual(calls('Open en.wikipedia.org/wiki/Prism?action=history'), ['open_website(https://en.wikipedia.org/wiki/Prism?action=history)'])
  assert.deepEqual(calls('visit the site xkcd.com.'), ['open_website(https://xkcd.com/)'])
  assert.deepEqual(calls('https://example.com'), ['open_website(https://example.com/)'])
  assert.deepEqual(calls('search the web for Glass Prisms?'), ['search_web(Glass Prisms)'])
  assert.deepEqual(calls('look up how rainbows form'), ['search_web(how rainbows form)'])
  assert.deepEqual(calls('open the browser'), ['open_app(browser)'])
  assert.deepEqual(calls('maximize browser'), ['maximize_app(browser)'])
  assert.deepEqual(calls('what is the browser'), ['explain(browser)'])
  assert.deepEqual(calls('search files for Plan'), ['search_files(Plan)'])
  assert.equal(calls('search for files named plan'), null)
  assert.equal(calls('open notes.txt'), null)
  assert.equal(calls('go to javascript:alert(1)'), null)
  assert.deepEqual(calls('open calculator'), ['open_app(calculator)'])
  assert.deepEqual(validateCall('open_website', {address: 'http://archive.org'}), {ok: true, command: {name: 'open_website', url: 'https://archive.org/'}})
  assert.equal(validateCall('open_website', {address: 'glass prisms'}).ok, false)
  assert.equal(validateCall('search_web', {query: ' '}).ok, false)
  const long = validateCall('search_web', {query: 'x'.repeat(500)})
  assert.ok(long.ok && long.command.name === 'search_web' && long.command.query.length === 200)
})

test('spoken sentences: browsers by name, three commands, addresses said aloud', () => {
  const calls = (text: string) => quickCommands(text)?.map(describeCall) ?? null
  assert.deepEqual(calls('open safari'), ['open_app(browser)'])
  assert.deepEqual(calls('Close Inkwell, open Safari and search for YouTube'), ['close_app(inkwell)', 'open_app(browser)', 'search_web(YouTube)'])
  assert.deepEqual(calls('open chrome then go to wikipedia.org'), ['open_app(browser)', 'open_website(https://wikipedia.org/)'])
  assert.deepEqual(calls('go to wikipedia dot org'), ['open_website(https://wikipedia.org/)'])
  assert.deepEqual(calls('en dot wikipedia dot org slash wiki slash Prism'), ['open_website(https://en.wikipedia.org/wiki/Prism)'])
  assert.deepEqual(calls('search for polka dot dresses'), ['search_web(polka dot dresses)'])
  assert.deepEqual(calls('search for salt and pepper'), ['search_web(salt and pepper)'])
  assert.equal(calls('open the pod bay doors'), null)
  assert.deepEqual(calls('dark mode'), ['set_theme(dark)'])
})

test('commands said without commas run together, and nonsense still doesn\'t parse', () => {
  const calls = (text: string) => quickCommands(text)?.map(describeCall) ?? null
  assert.deepEqual(calls('close Inkwell open Safari and search for YouTube'), ['close_app(inkwell)', 'open_app(browser)', 'search_web(YouTube)'])
  assert.deepEqual(calls('minimize scope open the calculator'), ['minimize_app(scope)', 'open_app(calculator)'])
  assert.deepEqual(calls('dark mode teal accent'), ['set_theme(dark)', 'set_accent(teal)'])
  assert.deepEqual(calls('search for glass prisms'), ['search_web(glass prisms)'])
  assert.equal(calls('dont close scope'), null)
  assert.equal(calls('close scope the banana'), null)
})

test('the timer, Browser\'s buttons and the weather, in the words people use most', () => {
  const calls = (text: string) => quickCommands(text)?.map(describeCall) ?? null
  assert.deepEqual(calls('set a timer for 5 minutes'), ['start_timer(5 minutes)'])
  assert.deepEqual(calls('start a 10 minute timer'), ['start_timer(10 minutes)'])
  assert.deepEqual(calls('set the timer to 1:30'), ['start_timer(1 minute 30 seconds)'])
  assert.deepEqual(calls('cancel the timer'), ['timer(cancel)'])
  assert.deepEqual(calls('pause timer'), ['timer(pause)'])
  assert.equal(calls('start a timer'), null)
  assert.deepEqual(calls('refresh the page'), ['browser_navigate(reload)'])
  assert.deepEqual(calls('go back a page'), ['browser_navigate(back)'])
  assert.deepEqual(calls('show favorites'), ['browser_navigate(home)'])
  assert.deepEqual(quickCommands('back'), [{name: 'previous_photo', bare: true}])
  assert.deepEqual(quickCommands('next photo'), [{name: 'next_photo'}])
  assert.deepEqual(calls('what is the weather like in new york today?'), ['search_web(what is the weather like in new york today)'])
  assert.deepEqual(calls('will it rain tomorrow'), ['search_web(will it rain tomorrow)'])
  assert.deepEqual(calls('close inkwell and set a timer for 3 minutes'), ['close_app(inkwell)', 'start_timer(3 minutes)'])
  assert.deepEqual(validateCall('start_timer', {duration: 'half an hour'}), {ok: true, command: {name: 'start_timer', seconds: 1800}})
  assert.equal(validateCall('start_timer', {duration: '3 days'}).ok, false)
  assert.deepEqual(validateCall('timer', {action: 'stop'}), {ok: true, command: {name: 'timer', action: 'cancel'}})
  assert.deepEqual(validateCall('browser_navigate', {action: 'refresh'}), {ok: true, command: {name: 'browser_navigate', action: 'reload'}})
})

test('every suggestion on Spotlight\'s welcome runs without the model', () => {
  for (const sentence of welcomeSuggestions) {
    const commands = quickCommands(sentence)
    assert.ok(commands !== null && commands.length > 0, `${sentence} needs the model`)
  }
})
