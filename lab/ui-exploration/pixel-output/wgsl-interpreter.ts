// A strict IEEE-754 interpreter for the WGSL subset that wgsl.ts emits, so the
// emitted text (literal encoding, switch-based gather reads, index math) can be
// tested on the CPU. Every f32 operation rounds on its own, which is what WGSL
// means when no optimizer contracts or regroups. It says nothing about what a
// real GPU compiler does; gpu-headless.ts checks that.
import {invariant} from './numeric-ui-core.ts'

type ValueType = 'f32' | 'i32' | 'u32' | 'bool'
type Frame = {slots: Float64Array, shared: Float32Array, sources: Float32Array, outputs: Float32Array}
type Compiled = {type: ValueType, evaluate: (frame: Frame) => number}
type Variable = {slot: number, type: ValueType}

// pixel-output: `<` and `>` added for i32 comparisons, plus floor and u32 below.
const tokenPattern = /(0[xX][0-9a-fA-F]*\.[0-9a-fA-F]+[pP][+-]?[0-9]+f|[0-9]+\.[0-9]+f|[0-9]+[iu]|[A-Za-z_][A-Za-z0-9_]*|>=|<|>|[-+*()[\],&])/y

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

export function parseWgslFloat(token: string) {
  const hex = /^0[xX]([0-9a-fA-F]*)\.([0-9a-fA-F]+)[pP]([+-]?[0-9]+)f$/.exec(token)
  const value = hex === null
    ? Number(token.slice(0, -1))
    : (parseInt(hex[1] === '' ? '0' : hex[1]!, 16) + parseInt(hex[2]!, 16) / 16 ** hex[2]!.length) * 2 ** Number(hex[3])
  invariant(Object.is(Math.fround(value), value), `literal ${token} isn't exactly a float32 value`)
  return value
}

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
    invariant(left.type === right.type, `mixed types in ${text}`)
    const type = left.type
    if (type === 'f32') {
      if (operator === '+') return {type, evaluate: frame => Math.fround(left.evaluate(frame) + right.evaluate(frame))}
      if (operator === '-') return {type, evaluate: frame => Math.fround(left.evaluate(frame) - right.evaluate(frame))}
      return {type, evaluate: frame => Math.fround(left.evaluate(frame) * right.evaluate(frame))}
    }
    const wrap = type === 'u32' ? (value: number) => value >>> 0 : (value: number) => value | 0
    if (operator === '+') return {type, evaluate: frame => wrap(left.evaluate(frame) + right.evaluate(frame))}
    if (operator === '-') return {type, evaluate: frame => wrap(left.evaluate(frame) - right.evaluate(frame))}
    return {type, evaluate: frame => wrap(Math.imul(left.evaluate(frame), right.evaluate(frame)))}
  }
  function parseComparison(): Compiled {
    const left = parseAdditive()
    const operator = peek()
    if (operator !== '>=' && operator !== '<' && operator !== '>') return left
    position++
    const right = parseAdditive()
    if (operator === '<') return {type: 'bool', evaluate: frame => left.evaluate(frame) < right.evaluate(frame) ? 1 : 0}
    if (operator === '>') return {type: 'bool', evaluate: frame => left.evaluate(frame) > right.evaluate(frame) ? 1 : 0}
    return {type: 'bool', evaluate: frame => left.evaluate(frame) >= right.evaluate(frame) ? 1 : 0}
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
    return {type: operand.type, evaluate: frame => -operand.evaluate(frame)}
  }
  function parseArguments(): Compiled[] {
    expect('(')
    const values: Compiled[] = []
    while (peek() !== ')') {
      values.push(parseComparison())
      if (peek() === ',') position++
    }
    expect(')')
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
      const values = parseArguments()
      switch (token) {
        case 'max': {
          const [left, right] = values as [Compiled, Compiled]
          return {type: left.type, evaluate: frame => Math.max(left.evaluate(frame), right.evaluate(frame))}
        }
        case 'select': {
          const [off, on, condition] = values as [Compiled, Compiled, Compiled]
          return {type: off.type, evaluate: frame => condition.evaluate(frame) === 1 ? on.evaluate(frame) : off.evaluate(frame)}
        }
        case 'clamp': {
          const [value, low, high] = values as [Compiled, Compiled, Compiled]
          return {type: value.type, evaluate: frame => Math.min(Math.max(value.evaluate(frame), low.evaluate(frame)), high.evaluate(frame))}
        }
        case 'i32': {
          const [value] = values as [Compiled]
          return {type: 'i32', evaluate: frame => toI32(value.evaluate(frame))}
        }
        case 'u32': {
          const [value] = values as [Compiled]
          return {type: 'u32', evaluate: frame => value.evaluate(frame) >>> 0}
        }
        case 'floor': {
          const [value] = values as [Compiled]
          return {type: value.type, evaluate: frame => Math.floor(value.evaluate(frame))}
        }
      }
      invariant(false, `unsupported function ${token}`)
    }
    if (peek() === '[') {
      position++
      const index = parseAdditive()
      expect(']')
      if (token === 'shared_values') return {type: 'f32', evaluate: frame => frame.shared[index.evaluate(frame)]!}
      if (token === 'instance_sources') return {type: 'f32', evaluate: frame => frame.sources[index.evaluate(frame)]!}
      invariant(false, `unsupported array ${token}`)
    }
    const variable = variables.get(token)
    invariant(variable !== undefined, `unknown variable ${token}`)
    const {slot} = variable
    return {type: variable.type, evaluate: frame => frame.slots[slot]!}
  }
  const compiled = parseComparison()
  invariant(position === tokens.length, `trailing tokens in ${text}`)
  return compiled
}

export type WgslInterpreter = (shared: Float32Array, sources: Float32Array, count: number, outputs: Float32Array) => void

export function createWgslInterpreter(code: string): WgslInterpreter {
  const mainStart = code.indexOf('fn main(')
  invariant(mainStart >= 0, 'shader has no main')
  const lines = code.slice(code.indexOf('{', mainStart) + 1, code.lastIndexOf('}')).split('\n').map(line => line.trim()).filter(line => line !== '')
  const variables = new Map<string, Variable>()
  const define = (name: string, type: ValueType) => {
    invariant(!variables.has(name), `variable ${name} defined twice`)
    const variable = {slot: variables.size, type}
    variables.set(name, variable)
    return variable
  }
  const instanceIndex = define('i', 'u32')
  const statements: ((frame: Frame) => void)[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (line === 'let i: u32 = id.x;' || line.startsWith('_ = arrayLength(')) continue
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
      statements.push(frame => {
        frame.slots[slot] = expression.evaluate(frame)
      })
      continue
    }
    match = /^var (\w+): f32;$/.exec(line)
    if (match !== null) {
      define(match[1]!, 'f32')
      continue
    }
    match = /^switch \((.*)\) \{$/.exec(line)
    if (match !== null) {
      const selector = compileExpression(match[1]!, variables)
      const cases = new Map<number, (frame: Frame) => void>()
      let fallback: ((frame: Frame) => void) | null = null
      const assignment = (name: string, text: string) => {
        const target = variables.get(name)
        invariant(target !== undefined, `unknown switch target ${name}`)
        const expression = compileExpression(text, variables)
        return (frame: Frame) => {
          frame.slots[target.slot] = expression.evaluate(frame)
        }
      }
      for (index++; lines[index] !== '}'; index++) {
        const caseMatch = /^case (\d+)i: \{ (\w+) = (.*); \}$/.exec(lines[index]!)
        if (caseMatch !== null) {
          cases.set(Number(caseMatch[1]), assignment(caseMatch[2]!, caseMatch[3]!))
          continue
        }
        const defaultMatch = /^default: \{ (\w+) = (.*); \}$/.exec(lines[index]!)
        invariant(defaultMatch !== null, `unsupported switch line ${lines[index]}`)
        fallback = assignment(defaultMatch[1]!, defaultMatch[2]!)
      }
      invariant(fallback !== null, 'switch without default')
      const defaultCase = fallback
      statements.push(frame => (cases.get(selector.evaluate(frame)) ?? defaultCase)(frame))
      continue
    }
    match = /^instance_outputs\[output_base \+ (\d+)u\] = (.*);$/.exec(line)
    if (match !== null) {
      const offset = Number(match[1])
      const base = variables.get('output_base')
      invariant(base !== undefined, 'output_base must be defined before outputs')
      const expression = compileExpression(match[2]!, variables)
      statements.push(frame => {
        frame.outputs[frame.slots[base.slot]! + offset] = expression.evaluate(frame)
      })
      continue
    }
    invariant(false, `unsupported WGSL statement: ${line}`)
  }
  const slots = new Float64Array(variables.size)
  return (shared, sources, count, outputs) => {
    const frame: Frame = {slots, shared, sources, outputs}
    for (let instance = 0; instance < count; instance++) {
      slots[instanceIndex.slot] = instance
      for (const statement of statements) statement(frame)
    }
  }
}
