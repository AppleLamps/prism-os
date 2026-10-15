import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {needsConfirmation, parsePhoto, validateCall} from '../../src/prismos/commands.ts'
import {formatCall, parseModelAnswer} from '../../src/prismos/function-calls.ts'
import {quickCommands} from '../../src/prismos/quick-commands.ts'

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
  assert.equal(validateCall('set_accent', {color: 'purple'}).ok, false)
  assert.equal(validateCall('open_app', {app: 'terminal'}).ok, false)
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
  assert.deepEqual(quickCommands('Open photo Blue Lagoon!'), [{name: 'open_photo', photo: 10}])
  assert.deepEqual(quickCommands('next'), [{name: 'next_photo'}])
  assert.deepEqual(quickCommands('make it teal'), [{name: 'set_accent', color: 'teal'}])
  assert.deepEqual(quickCommands('show desktop'), [{name: 'show_desktop'}])
  assert.equal(quickCommands('don\'t close scope'), null)
  assert.equal(quickCommands('put scope on the left and chroma on the right'), null)
  assert.equal(quickCommands('make it purple'), null)
  assert.equal(quickCommands('open photo of my cat'), null)
  assert.equal(quickCommands(''), null)
})
