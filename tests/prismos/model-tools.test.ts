import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {validateCall} from '../../src/prismos/commands.ts'
import {parseModelAnswer} from '../../src/prismos/function-calls.ts'
import {expandCall, groupCall} from '../../src/prismos/model-tools.ts'

const expand = (name: string, args: Record<string, unknown>) => {
  const expansion = expandCall(name, args)
  assert.ok(expansion.ok, expansion.ok ? '' : expansion.reason)
  return expansion.calls
}

test('a grouped call stands for the command its action names', () => {
  assert.deepEqual(expand('app', {action: 'minimize', app: 'inkwell'}), [{name: 'minimize_app', arguments: {app: 'inkwell'}}])
  assert.deepEqual(expand('app', {action: 'move', app: 'chroma', position: 'left'}), [{name: 'move_app', arguments: {app: 'chroma', position: 'left'}}])
  assert.deepEqual(expand('files', {action: 'rename', path: '/a.txt', to: 'b.txt'}), [{name: 'rename_file', arguments: {path: '/a.txt', new_name: 'b.txt'}}])
  assert.deepEqual(expand('files', {action: 'move', path: '/a.txt', to: '/Work'}), [{name: 'move_file', arguments: {path: '/a.txt', destination: '/Work'}}])
  assert.deepEqual(expand('files', {action: 'list'}), [{name: 'list_files', arguments: {}}])
  assert.deepEqual(expand('scope', {action: 'operations'}), [{name: 'scope_show', arguments: {view: 'operations'}}])
  assert.deepEqual(expand('scope', {action: 'page down'}), [{name: 'scope_list', arguments: {action: 'page_down'}}])
  assert.deepEqual(expand('photos', {action: 'start_slideshow'}), [{name: 'slideshow', arguments: {action: 'start'}}])
  assert.deepEqual(expand('browser', {action: 'back'}), [{name: 'browser_navigate', arguments: {action: 'back'}}])
})

test('the model\'s shortcuts: text alone is a note to add, a length alone starts a timer, one call can change two settings', () => {
  assert.deepEqual(expand('note', {text: 'buy milk'}), [{name: 'write_note', arguments: {text: 'buy milk', mode: 'append'}}])
  assert.deepEqual(expand('timer', {duration: '5 minutes'}), [{name: 'start_timer', arguments: {duration: '5 minutes'}}])
  assert.deepEqual(expand('settings', {theme: 'dark', accent: 'teal'}), [{name: 'set_theme', arguments: {theme: 'dark'}}, {name: 'set_accent', arguments: {color: 'teal'}}])
})

test('a call with no action Prism OS has, or no setting, is turned down', () => {
  assert.equal(expandCall('app', {action: 'delete', app: 'clock'}).ok, false)
  assert.equal(expandCall('settings', {}).ok, false)
  assert.equal(expandCall('format_disk', {}).ok, false)
  assert.equal(expandCall('open_app', {app: 'clock'}).ok, false)
})

test('grouping a command and expanding it again gives the command back', () => {
  const commands = [
    {name: 'open_app', arguments: {app: 'browser'}},
    {name: 'resize_app', arguments: {app: 'chroma', size: 'large'}},
    {name: 'side_by_side', arguments: {left: 'scope', right: 'inkwell'}},
    {name: 'reset_layout', arguments: {}},
    {name: 'search_files', arguments: {query: 'report'}},
    {name: 'empty_trash', arguments: {}},
    {name: 'write_note', arguments: {text: 'hi', mode: 'replace'}},
    {name: 'read_note', arguments: {}},
    {name: 'set_arcs', arguments: {visibility: 'hidden'}},
    {name: 'start_timer', arguments: {duration: '90 seconds'}},
    {name: 'timer', arguments: {action: 'pause'}},
    {name: 'slideshow', arguments: {action: 'stop'}},
    {name: 'search_web', arguments: {query: 'weather in Rome'}},
  ]
  for (const command of commands) {
    const grouped = groupCall(command)
    assert.deepEqual(expand(grouped.name, grouped.arguments), [command], JSON.stringify(grouped))
  }
})

test('a model answer becomes commands: parsed, expanded, validated', () => {
  const raw = '<start_function_call>call:app{action:<escape>minimize<escape>,app:<escape>notes<escape>}<end_function_call>'
    + '<start_function_call>call:settings{accent:<escape>teal<escape>,theme:<escape>dark<escape>}<end_function_call><start_function_response>'
  const commands = parseModelAnswer(raw).calls.flatMap(call => expand(call.name, call.arguments)).map(call => {
    const result = validateCall(call.name, call.arguments)
    assert.ok(result.ok, result.ok ? '' : result.reason)
    return result.command
  })
  assert.deepEqual(commands, [{name: 'minimize_app', app: 'inkwell'}, {name: 'set_theme', theme: 'dark'}, {name: 'set_accent', color: 'teal'}])
})
