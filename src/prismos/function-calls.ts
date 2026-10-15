// Reads FunctionGemma's answer. The model either writes text, which is its reply, or one
// or more calls in its own format:
//
//   <start_function_call>call:move_app{app:<escape>inkwell<escape>,position:<escape>left<escape>}<end_function_call>
//
// A string argument sits between two <escape> markers, so it may hold commas and braces.
// A number or a boolean is written bare. The answer ends at <start_function_response>,
// where the model would wait for the calls' results, or at <end_of_turn>.

export type FunctionCall = {name: string, arguments: Record<string, unknown>}
export type ModelAnswer = {calls: FunctionCall[], text: string}

const callStart = '<start_function_call>'
const callEnd = '<end_function_call>'
const escape = '<escape>'
const stopMarkers = ['<start_function_response>', '<end_of_turn>', '<eos>']

export function parseModelAnswer(raw: string): ModelAnswer {
  let answer = raw
  for (const marker of stopMarkers) {
    const at = answer.indexOf(marker)
    if (at !== -1) answer = answer.slice(0, at)
  }
  const calls: FunctionCall[] = []
  let text = ''
  let index = 0
  while (index < answer.length) {
    const start = answer.indexOf(callStart, index)
    if (start === -1) {
      text += answer.slice(index)
      break
    }
    text += answer.slice(index, start)
    const end = answer.indexOf(callEnd, start)
    const body = answer.slice(start + callStart.length, end === -1 ? answer.length : end)
    const call = parseCall(body)
    if (call !== null) calls.push(call)
    index = end === -1 ? answer.length : end + callEnd.length
  }
  return {calls, text: text.replaceAll(escape, '').trim()}
}

// Parses `call:name{key:value,...}`, or returns null when the body isn't one.
export function parseCall(body: string): FunctionCall | null {
  const match = /^\s*call:([A-Za-z_][\w]*)\s*\{/u.exec(body)
  if (match === null) return null
  const name = match[1]!
  const args: Record<string, unknown> = {}
  let index = match[0].length
  while (index < body.length) {
    while (body[index] === ',' || body[index] === ' ') index++
    if (body[index] === '}' || index >= body.length) break
    const colon = body.indexOf(':', index)
    if (colon === -1) break
    const key = body.slice(index, colon).trim()
    index = colon + 1
    let value: unknown
    if (body.startsWith(escape, index)) {
      const close = body.indexOf(escape, index + escape.length)
      const stop = close === -1 ? body.length : close
      value = body.slice(index + escape.length, stop)
      index = close === -1 ? body.length : close + escape.length
    } else {
      let stop = index
      while (stop < body.length && body[stop] !== ',' && body[stop] !== '}') stop++
      const bare = body.slice(index, stop).trim()
      value = bare === 'true' ? true : bare === 'false' ? false : bare !== '' && Number.isFinite(Number(bare)) ? Number(bare) : bare
      index = stop
    }
    if (key !== '') args[key] = value
  }
  return {name, arguments: args}
}

// The format back, as the chat template writes a call: keys in sorted order, strings
// escaped. The tests use it to check that parsing inverts it.
/** @public */
export function formatCall(call: FunctionCall): string {
  const fields = Object.keys(call.arguments).sort().map(key => {
    const value = call.arguments[key]
    return `${key}:${typeof value === 'string' ? `${escape}${value}${escape}` : String(value)}`
  })
  return `${callStart}call:${call.name}{${fields.join(',')}}${callEnd}`
}
