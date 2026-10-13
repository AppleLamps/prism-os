// A strict interpreter for the WGSL subset that emit.ts writes, so that the emitted text is tested on the CPU: the exact
// literals, the order of each sum, and an index read's floor, clamp and selects. Every f32 operation rounds on its own,
// which is what WGSL means when no compiler fuses or regroups anything. It says nothing about what a real GPU compiler
// does; gpu/run.ts checks that. It's a changed copy of lab/ui-exploration/codegen/wgsl-interpreter.ts: this one has
// floor, u32(), the comparisons > and <, and several output buffers, and has no switch statements.
import {invariant} from '../../src/runtime/numeric-ui-core.ts'

type ValueType = 'f32' | 'i32' | 'u32' | 'bool'
type State = {slots: Float64Array, shared: Float32Array, sources: Float32Array, outputs: Float32Array[]}
type Compiled = {type: ValueType, evaluate: (state: State) => number}
type Variable = {slot: number, type: ValueType}

const tokenPattern = /(0[xX][0-9a-fA-F]*\.[0-9a-fA-F]+[pP][+-]?[0-9]+f|[0-9]+\.[0-9]+f|[0-9]+[iu]|[A-Za-z_][A-Za-z0-9_]*|>=|[-+*()[\],&<>])/y

function tokenize(text: string) {
  const tokens: string[] = []
  let index = 0
  while (index < text.length) {
    if (text[index] === ' ') {
      index++
      continue
    }
    tokenPattern.lastIndex = index
    const match = tokenPattern.exec(text)
    invariant(match !== null, `unexpected WGSL text: ${text.slice(index, index + 30)}`)
    tokens.push(match[1]!)
    index = tokenPattern.lastIndex
  }
  return tokens
}

function parseWgslFloat(token: string) {
  const hex = /^0[xX]([0-9a-fA-F]*)\.([0-9a-fA-F]+)[pP]([+-]?[0-9]+)f$/.exec(token)
  const value = hex === null
    ? Number(token.slice(0, -1))
    : (parseInt(hex[1] === '' ? '0' : hex[1]!, 16) + parseInt(hex[2]!, 16) / 16 ** hex[2]!.length) * 2 ** Number(hex[3])
  invariant(Math.fround(value) === value, `the literal ${token} isn't exactly a float32 value`)
  return value
}

// WGSL's f32 to i32 conversion: toward zero, and clamped to the i32 range.
function toI32(value: number) {
  if (Number.isNaN(value)) return 0
  if (value >= 2_147_483_647) return 2_147_483_647
  if (value <= -2_147_483_648) return -2_147_483_648
  return Math.trunc(value) | 0
}

function compileExpression(text: string, variables: Map<string, Variable>): Compiled {
  const tokens = tokenize(text)
  let position = 0
  const peek = () => tokens[position]
  const expect = (token: string) => {
    invariant(tokens[position] === token, `expected ${token} in ${text}`)
    position++
  }
  const arithmetic = (operator: string, left: Compiled, right: Compiled): Compiled => {
    invariant(left.type === right.type && left.type !== 'bool', `mixed types in ${text}`)
    const type = left.type
    if (type === 'f32') {
      if (operator === '+') return {type, evaluate: state => Math.fround(left.evaluate(state) + right.evaluate(state))}
      if (operator === '-') return {type, evaluate: state => Math.fround(left.evaluate(state) - right.evaluate(state))}
      return {type, evaluate: state => Math.fround(left.evaluate(state) * right.evaluate(state))}
    }
    const wrap = type === 'u32' ? (value: number) => value >>> 0 : (value: number) => value | 0
    if (operator === '+') return {type, evaluate: state => wrap(left.evaluate(state) + right.evaluate(state))}
    if (operator === '-') return {type, evaluate: state => wrap(left.evaluate(state) - right.evaluate(state))}
    return {type, evaluate: state => wrap(Math.imul(left.evaluate(state), right.evaluate(state)))}
  }
  function parseComparison(): Compiled {
    const left = parseAdditive()
    const operator = peek()
    if (operator !== '>=' && operator !== '>' && operator !== '<') return left
    position++
    const right = parseAdditive()
    invariant(left.type === right.type && left.type !== 'bool', `mixed types in ${text}`)
    if (operator === '>=') return {type: 'bool', evaluate: state => left.evaluate(state) >= right.evaluate(state) ? 1 : 0}
    if (operator === '>') return {type: 'bool', evaluate: state => left.evaluate(state) > right.evaluate(state) ? 1 : 0}
    return {type: 'bool', evaluate: state => left.evaluate(state) < right.evaluate(state) ? 1 : 0}
  }
  function parseAdditive(): Compiled {
    let left = parseMultiplicative()
    while (peek() === '+' || peek() === '-') {
      const operator = tokens[position++]!
      left = arithmetic(operator, left, parseMultiplicative())
    }
    return left
  }
  function parseMultiplicative(): Compiled {
    let left = parseUnary()
    while (peek() === '*') {
      position++
      left = arithmetic('*', left, parseUnary())
    }
    return left
  }
  function parseUnary(): Compiled {
    if (peek() !== '-') return parsePrimary()
    position++
    const operand = parseUnary()
    invariant(operand.type === 'f32' || operand.type === 'i32', `a negated ${operand.type} in ${text}`)
    return {type: operand.type, evaluate: state => -operand.evaluate(state)}
  }
  function parseArguments(count: number): Compiled[] {
    expect('(')
    const values: Compiled[] = []
    while (peek() !== ')') {
      values.push(parseComparison())
      if (peek() === ',') position++
    }
    expect(')')
    invariant(values.length === count, `wrong argument count in ${text}`)
    return values
  }
  function parsePrimary(): Compiled {
    const token = tokens[position++]
    invariant(token !== undefined, `unexpected end of ${text}`)
    if (token === '(') {
      const inner = parseComparison()
      expect(')')
      return inner
    }
    if (/^[0-9]/.test(token)) {
      if (token.endsWith('f')) {
        const value = parseWgslFloat(token)
        return {type: 'f32', evaluate: () => value}
      }
      const value = Number(token.slice(0, -1))
      return {type: token.endsWith('i') ? 'i32' : 'u32', evaluate: () => value}
    }
    if (peek() === '(') {
      switch (token) {
        case 'max': {
          const [left, right] = parseArguments(2) as [Compiled, Compiled]
          invariant(left.type === 'f32' && right.type === 'f32', `max of other types in ${text}`)
          return {type: 'f32', evaluate: state => Math.max(left.evaluate(state), right.evaluate(state))}
        }
        case 'select': {
          const [off, on, condition] = parseArguments(3) as [Compiled, Compiled, Compiled]
          invariant(off.type === on.type && condition.type === 'bool', `select of mixed types in ${text}`)
          // WGSL evaluates both values, so an index that is out of range in either one counts as an error here too.
          return {type: off.type, evaluate: state => {
            const offValue = off.evaluate(state)
            const onValue = on.evaluate(state)
            return condition.evaluate(state) === 1 ? onValue : offValue
          }}
        }
        case 'clamp': {
          const [value, low, high] = parseArguments(3) as [Compiled, Compiled, Compiled]
          invariant(value.type === 'i32' && low.type === 'i32' && high.type === 'i32', `clamp of other types in ${text}`)
          return {type: 'i32', evaluate: state => Math.min(Math.max(value.evaluate(state), low.evaluate(state)), high.evaluate(state))}
        }
        case 'floor': {
          const [value] = parseArguments(1) as [Compiled]
          invariant(value.type === 'f32', `floor of another type in ${text}`)
          return {type: 'f32', evaluate: state => Math.floor(value.evaluate(state))}
        }
        case 'i32': {
          const [value] = parseArguments(1) as [Compiled]
          invariant(value.type === 'f32', `i32() of another type in ${text}`)
          return {type: 'i32', evaluate: state => toI32(value.evaluate(state))}
        }
        case 'u32': {
          const [value] = parseArguments(1) as [Compiled]
          invariant(value.type === 'i32', `u32() of another type in ${text}`)
          return {type: 'u32', evaluate: state => {
            const converted = value.evaluate(state)
            invariant(converted >= 0, `a negative index in ${text}`)
            return converted
          }}
        }
        default:
          invariant(false, `unsupported function ${token}`)
      }
    }
    if (peek() === '[') {
      position++
      const index = parseAdditive()
      expect(']')
      invariant(index.type === 'u32', `an array index of another type in ${text}`)
      invariant(token === 'shared_values' || token === 'instance_sources', `unsupported array ${token}`)
      const pick = token === 'shared_values' ? (state: State) => state.shared : (state: State) => state.sources
      return {type: 'f32', evaluate: state => {
        const array = pick(state)
        const at = index.evaluate(state)
        invariant(at < array.length, `${token}[${at}] is past the buffer's end`)
        return array[at]!
      }}
    }
    const variable = variables.get(token)
    invariant(variable !== undefined, `unknown variable ${token}`)
    const {slot} = variable
    return {type: variable.type, evaluate: state => state.slots[slot]!}
  }
  const compiled = parseComparison()
  invariant(position === tokens.length, `trailing tokens in ${text}`)
  return compiled
}

// Runs the shader's statements for instances 0 to count - 1, writing each output group into its own array.
export type WgslInterpreter = (shared: Float32Array, sources: Float32Array, count: number, outputs: Float32Array[]) => void

export function createWgslInterpreter(code: string): WgslInterpreter {
  const mainStart = code.indexOf('fn main(')
  invariant(mainStart >= 0, 'the shader has no main')
  const lines = code.slice(code.indexOf('{', mainStart) + 1, code.lastIndexOf('}')).split('\n').map(line => line.trim()).filter(line => line !== '')
  const variables = new Map<string, Variable>()
  const define = (name: string, type: ValueType) => {
    invariant(!variables.has(name), `variable ${name} is defined twice`)
    const variable = {slot: variables.size, type}
    variables.set(name, variable)
    return variable
  }
  const instanceIndex = define('i', 'u32')
  const statements: ((state: State) => void)[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (line === 'let i: u32 = id.x;' || line.startsWith('_ = ')) continue
    if (line === 'if (i >= params.count) {') {
      invariant(lines[index + 1] === 'return;' && lines[index + 2] === '}', 'unexpected bounds check')
      index += 2
      continue
    }
    let match = /^let (\w+): (\w+) = (.*);$/.exec(line)
    if (match !== null) {
      const expression = compileExpression(match[3]!, variables)
      invariant(expression.type === match[2], `type mismatch in ${line}`)
      const {slot} = define(match[1]!, expression.type)
      statements.push(state => {
        state.slots[slot] = expression.evaluate(state)
      })
      continue
    }
    match = /^instance_outputs_(\d+)\[output_base_(\d+) \+ (\d+)u\] = (.*);$/.exec(line)
    if (match !== null) {
      invariant(match[1] === match[2], `an output written at another group's base in ${line}`)
      const group = Number(match[1])
      const offset = Number(match[3])
      const base = variables.get(`output_base_${group}`)
      invariant(base !== undefined, 'the output base is defined before the outputs')
      const expression = compileExpression(match[4]!, variables)
      invariant(expression.type === 'f32', `an output of another type in ${line}`)
      statements.push(state => {
        const array = state.outputs[group]
        const at = state.slots[base.slot]! + offset
        invariant(array !== undefined && at < array.length, `instance_outputs_${group}[${at}] is past the buffer's end`)
        array[at] = expression.evaluate(state)
      })
      continue
    }
    invariant(false, `unsupported WGSL statement: ${line}`)
  }
  const slots = new Float64Array(variables.size)
  return (shared, sources, count, outputs) => {
    const state: State = {slots, shared, sources, outputs}
    for (let instance = 0; instance < count; instance++) {
      slots[instanceIndex.slot] = instance
      for (const statement of statements) statement(state)
    }
  }
}
