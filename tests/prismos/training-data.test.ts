// The training data in src/prismos/training, as scripts/prismos-dataset.ts writes it, checked
// against the page: it matches today's commands, covers every one, keeps eval phrasings out
// of training, and agrees with the quick parser wherever the parser answers. A failure here
// means the data needs `bun scripts/prismos-dataset.ts`, or the generator or the parser has
// a bug, before any training run.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {test} from 'bun:test'
import {toolDeclarations, validateCall} from '../../src/prismos/commands.ts'
import {describeCall} from '../../src/prismos/command-center.ts'
import {quickCommands} from '../../src/prismos/quick-commands.ts'

type Call = {name: string, arguments: Record<string, string>}
type Row = {messages: [{role: string, content: string}, {role: string, content: string}, {role: string, content?: string, tool_calls?: {function: Call}[]}]}

const folder = resolve(import.meta.dir, '../../src/prismos/training')
const read = (name: string) => readFileSync(resolve(folder, name), 'utf8')
const rows = (name: string) => read(name).trim().split('\n').map(line => JSON.parse(line) as Row)
const train = rows('train.jsonl')
const evaluation = rows('eval.jsonl')
const calls = (row: Row) => row.messages[2].tool_calls?.map(call => call.function) ?? []
const user = (row: Row) => row.messages[1].content

test('the data was written from today\'s commands', () => {
  assert.deepEqual(JSON.parse(read('tools.json')), JSON.parse(JSON.stringify(toolDeclarations)), 'run bun scripts/prismos-dataset.ts')
})

test('every call is valid, and every command is taught and tested', () => {
  const names = toolDeclarations.map(tool => tool.function.name)
  for (const [label, data, minimum] of [['train', train, 40], ['eval', evaluation, 3]] as const) {
    const counts = new Map<string, number>()
    for (const row of data) {
      for (const call of calls(row)) {
        const result = validateCall(call.name, call.arguments)
        assert.ok(result.ok, `${label}: ${user(row)} -> ${call.name}: ${result.ok ? '' : result.reason}`)
        counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
      }
    }
    for (const name of names) assert.ok((counts.get(name) ?? 0) >= minimum, `${label} has ${counts.get(name) ?? 0} ${name} calls, fewer than ${minimum}`)
  }
})

test('eval sentences never appear in training, and no sentence has two answers', () => {
  const trained = new Set(train.map(row => user(row).toLowerCase()))
  assert.deepEqual(evaluation.filter(row => trained.has(user(row).toLowerCase())).map(user), [])
  const answers = new Map<string, string>()
  for (const row of train) {
    if (calls(row).length === 0) continue
    const key = user(row).replace(/[.!?]+$/u, '')
    const answer = JSON.stringify(calls(row))
    const before = answers.get(key)
    assert.ok(before === undefined || before === answer, `"${key}" has two answers: ${before} and ${answer}`)
    answers.set(key, answer)
  }
})

// Paths, notes, searches and addresses are copied with their capitals. Values from a fixed
// list, e.g. an app or a color, are read in any case.
const copied = new Set(['path', 'new_name', 'destination', 'text', 'query', 'address'])

test('a copied argument can be copied: no sentence in capitals hides the words it copies', () => {
  for (const row of [...train, ...evaluation]) {
    const text = user(row)
    if (text !== text.toUpperCase() || !/[A-Z]/u.test(text)) continue
    for (const call of calls(row)) {
      for (const [key, value] of Object.entries(call.arguments)) {
        assert.ok(!copied.has(key) || !/[a-z]/u.test(value), `"${text}" is in capitals but copies "${value}"`)
      }
    }
  }
})

test('the quick parser and the data agree wherever the parser answers', () => {
  const disagreements: string[] = []
  let answered = 0
  for (const row of [...train, ...evaluation]) {
    const quick = quickCommands(user(row))
    if (quick === null) continue
    answered++
    const want = calls(row).map(call => {
      const result = validateCall(call.name, call.arguments)
      return result.ok ? describeCall(result.command) : `invalid ${call.name}`
    }).join('  ')
    const got = quick.map(command => describeCall(command)).join('  ').replace('back()', 'previous_photo()').replace('next()', 'next_photo()')
    if (got !== want) disagreements.push(`${user(row)}\n  data:  ${want}\n  quick: ${got}`)
  }
  assert.ok(answered > 3000, `the quick parser answers only ${answered} rows`)
  assert.deepEqual(disagreements.slice(0, 10), [])
})
