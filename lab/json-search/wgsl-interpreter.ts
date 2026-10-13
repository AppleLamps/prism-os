// A strict interpreter for the WGSL subset that emit.ts and loop-emit.ts write, so that the emitted text is tested on
// the CPU: the exact literals, the order of each sum, an index read's floor, clamp and selects, and for a loop shader
// the `for` loops, the carried `var`s, the arrays between two loops, and the window of documents that gets per
// position outputs. Every f32 operation rounds on its own, which is what WGSL means when no compiler fuses or regroups
// anything. It says nothing about what a real GPU compiler does; gpu/run.ts and gpu/search-run.ts check that. It
// started as a copy of lab/ui-exploration/codegen/wgsl-interpreter.ts: this one has floor, min, u32(), f32(), the
// comparisons > and <, &&, the bit operators | & << >>, `var`, assignments, `for`, `if`, several input and output
// buffers, and has no switch statements.
import {invariant} from '../../src/runtime/numeric-ui-core.ts'

type ValueType = 'f32' | 'i32' | 'u32' | 'bool'
type State = {slots: Float64Array, arrays: (Float32Array | Uint32Array)[], shared: Float32Array, inputs: Float32Array[], outputs: Float32Array[]}
type Compiled = {type: ValueType, evaluate: (state: State) => number}
type Variable =
  | {kind: 'scalar', slot: number, type: ValueType, mutable: boolean}
  | {kind: 'array', index: number, elementType: 'f32' | 'u32', length: number}
type Statement = (state: State) => void
type Scope = {variables: Map<string, Variable>, slotCount: number, arrays: {elementType: 'f32' | 'u32', length: number}[]}

const tokenPattern = /(0[xX][0-9a-fA-F]*\.[0-9a-fA-F]+[pP][+-]?[0-9]+f|[0-9]+\.[0-9]+f|[0-9]+[iu]|[A-Za-z_][A-Za-z0-9_.]*|>=|&&|<<|>>|[-+*()[\],&<>|])/y

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

// The buffers a shader reads by name: the shared values, then the per-document input buffers.
function inputBufferOf(name: string): ((state: State) => Float32Array) | undefined {
  if (name === 'shared_values') return state => state.shared
  if (name === 'instance_sources') return state => state.inputs[0]!
  const match = /^instance_inputs_(\d+)$/.exec(name)
  if (match === null) return undefined
  const buffer = Number(match[1])
  return state => {
    const array = state.inputs[buffer]
    invariant(array !== undefined, `the shader reads input buffer ${buffer}, which the caller didn't pass`)
    return array
  }
}

function compileExpression(text: string, variables: ReadonlyMap<string, Variable>): Compiled {
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
  function parseLogical(): Compiled {
    let left = parseComparison()
    while (peek() === '&&') {
      position++
      const earlier = left
      const right = parseComparison()
      invariant(earlier.type === 'bool' && right.type === 'bool', `&& of other types in ${text}`)
      left = {type: 'bool', evaluate: state => earlier.evaluate(state) === 1 && right.evaluate(state) === 1 ? 1 : 0}
    }
    return left
  }
  function parseComparison(): Compiled {
    const left = parseBitwise()
    const operator = peek()
    if (operator !== '>=' && operator !== '>' && operator !== '<') return left
    position++
    const right = parseBitwise()
    invariant(left.type === right.type && left.type !== 'bool', `mixed types in ${text}`)
    if (operator === '>=') return {type: 'bool', evaluate: state => left.evaluate(state) >= right.evaluate(state) ? 1 : 0}
    if (operator === '>') return {type: 'bool', evaluate: state => left.evaluate(state) > right.evaluate(state) ? 1 : 0}
    return {type: 'bool', evaluate: state => left.evaluate(state) < right.evaluate(state) ? 1 : 0}
  }
  // WGSL wants parentheses where | or & meets another operator, and the emitters write them.
  function parseBitwise(): Compiled {
    let left = parseShift()
    while (peek() === '|' || peek() === '&') {
      const operator = tokens[position++]!
      const earlier = left
      const right = parseShift()
      invariant(earlier.type === 'u32' && right.type === 'u32', `${operator} of other types in ${text}`)
      left = operator === '|'
        ? {type: 'u32', evaluate: state => (earlier.evaluate(state) | right.evaluate(state)) >>> 0}
        : {type: 'u32', evaluate: state => (earlier.evaluate(state) & right.evaluate(state)) >>> 0}
    }
    return left
  }
  function parseShift(): Compiled {
    const left = parseAdditive()
    const operator = peek()
    if (operator !== '<<' && operator !== '>>') return left
    position++
    const right = parseAdditive()
    invariant(left.type === 'u32' && right.type === 'u32', `a shift of other types in ${text}`)
    const amount = (state: State) => {
      const bits = right.evaluate(state)
      invariant(bits < 32, `a shift by ${bits} in ${text}`)
      return bits
    }
    return operator === '<<'
      ? {type: 'u32', evaluate: state => (left.evaluate(state) << amount(state)) >>> 0}
      : {type: 'u32', evaluate: state => left.evaluate(state) >>> amount(state)}
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
      values.push(parseLogical())
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
      const inner = parseLogical()
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
        case 'min': {
          const [left, right] = parseArguments(2) as [Compiled, Compiled]
          invariant(left.type === 'u32' && right.type === 'u32', `min of other types in ${text}`)
          return {type: 'u32', evaluate: state => Math.min(left.evaluate(state), right.evaluate(state))}
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
          invariant(value.type === 'i32' || value.type === 'f32', `u32() of another type in ${text}`)
          return {type: 'u32', evaluate: state => {
            const converted = value.evaluate(state)
            // Stricter than WGSL, which clamps: the emitters only convert whole numbers that fit.
            invariant(Number.isInteger(converted) && converted >= 0 && converted <= 0xffffffff, `u32() of ${converted} in ${text}`)
            return converted
          }}
        }
        case 'f32': {
          const [value] = parseArguments(1) as [Compiled]
          invariant(value.type === 'u32', `f32() of another type in ${text}`)
          return {type: 'f32', evaluate: state => Math.fround(value.evaluate(state))}
        }
        default:
          invariant(false, `unsupported function ${token}`)
      }
    }
    if (peek() === '[') {
      position++
      const index = parseLogical()
      expect(']')
      invariant(index.type === 'u32', `an array index of another type in ${text}`)
      const buffer = inputBufferOf(token)
      if (buffer !== undefined) {
        return {type: 'f32', evaluate: state => {
          const array = buffer(state)
          const at = index.evaluate(state)
          invariant(at < array.length, `${token}[${at}] is past the buffer's end`)
          return array[at]!
        }}
      }
      const variable = variables.get(token)
      invariant(variable?.kind === 'array', `unsupported array ${token}`)
      return {type: variable.elementType, evaluate: state => {
        const at = index.evaluate(state)
        invariant(at < variable.length, `${token}[${at}] is past the array's end`)
        return state.arrays[variable.index]![at]!
      }}
    }
    const variable = variables.get(token)
    invariant(variable?.kind === 'scalar', `unknown variable ${token}`)
    const {slot} = variable
    return {type: variable.type, evaluate: state => state.slots[slot]!}
  }
  const compiled = parseLogical()
  invariant(position === tokens.length, `trailing tokens in ${text}`)
  return compiled
}

// Compiles the statements from lines[start] up to the `}` that closes the block, and returns the index after it.
function compileBlock(lines: readonly string[], start: number, scope: Scope, isMain: boolean): {statements: Statement[], next: number} {
  const {variables} = scope
  const defined: string[] = []
  const define = (name: string, variable: Variable) => {
    invariant(!variables.has(name), `variable ${name} is defined twice`)
    variables.set(name, variable)
    defined.push(name)
  }
  const scalar = (name: string, type: ValueType, mutable: boolean) => {
    const variable = {kind: 'scalar' as const, slot: scope.slotCount++, type, mutable}
    define(name, variable)
    return variable
  }
  const statements: Statement[] = []
  let index = start
  for (; index < lines.length; index++) {
    const line = lines[index]!
    if (line === '}') break
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
      const {slot} = scalar(match[1]!, expression.type, false)
      statements.push(state => {
        state.slots[slot] = expression.evaluate(state)
      })
      continue
    }
    match = /^var (\w+): array<(f32|u32), (\d+)>;$/.exec(line)
    if (match !== null) {
      const elementType = match[2] as 'f32' | 'u32'
      const length = Number(match[3])
      const arrayIndex = scope.arrays.length
      scope.arrays.push({elementType, length})
      define(match[1]!, {kind: 'array', index: arrayIndex, elementType, length})
      // A `var` without a value starts at zero.
      statements.push(state => {
        state.arrays[arrayIndex]!.fill(0)
      })
      continue
    }
    match = /^var (\w+): (f32|u32) = (.*);$/.exec(line)
    if (match !== null) {
      const expression = compileExpression(match[3]!, variables)
      invariant(expression.type === match[2], `type mismatch in ${line}`)
      const {slot} = scalar(match[1]!, expression.type, true)
      statements.push(state => {
        state.slots[slot] = expression.evaluate(state)
      })
      continue
    }
    match = /^for \(var (\w+): u32 = (.*); (\w+) < (.*); (\w+)\+\+\) \{$/.exec(line)
    if (match !== null) {
      invariant(match[1] === match[3] && match[1] === match[5], `unsupported loop header ${line}`)
      const from = compileExpression(match[2]!, variables)
      const to = compileExpression(match[4]!, variables)
      invariant(from.type === 'u32' && to.type === 'u32', `a loop over another type in ${line}`)
      const {slot} = scalar(match[1]!, 'u32', true)
      const body = compileBlock(lines, index + 1, scope, false)
      index = body.next - 1
      variables.delete(match[1]!)
      defined.pop()
      statements.push(state => {
        for (let value = from.evaluate(state); value < to.evaluate(state); value++) {
          state.slots[slot] = value
          for (const statement of body.statements) statement(state)
        }
      })
      continue
    }
    match = /^if \((.*)\) \{$/.exec(line)
    if (match !== null) {
      const condition = compileExpression(match[1]!, variables)
      invariant(condition.type === 'bool', `a condition of another type in ${line}`)
      const body = compileBlock(lines, index + 1, scope, false)
      index = body.next - 1
      statements.push(state => {
        if (condition.evaluate(state) === 1) for (const statement of body.statements) statement(state)
      })
      continue
    }
    match = /^(\w+)\[(.*)\] = (.*);$/.exec(line)
    if (match !== null) {
      const name = match[1]!
      const at = compileExpression(match[2]!, variables)
      const expression = compileExpression(match[3]!, variables)
      invariant(at.type === 'u32', `an array index of another type in ${line}`)
      const output = /^instance_outputs_(\d+)$/.exec(name)
      if (output !== null) {
        const group = Number(output[1])
        invariant(expression.type === 'f32', `an output of another type in ${line}`)
        statements.push(state => {
          const array = state.outputs[group]
          const position = at.evaluate(state)
          invariant(array !== undefined && position < array.length, `${name}[${position}] is past the buffer's end`)
          array[position] = expression.evaluate(state)
        })
        continue
      }
      const variable = variables.get(name)
      invariant(variable?.kind === 'array' && variable.elementType === expression.type, `unsupported array write ${line}`)
      statements.push(state => {
        const position = at.evaluate(state)
        invariant(position < variable.length, `${name}[${position}] is past the array's end`)
        state.arrays[variable.index]![position] = expression.evaluate(state)
      })
      continue
    }
    match = /^(\w+) = (.*);$/.exec(line)
    if (match !== null) {
      const variable = variables.get(match[1]!)
      const expression = compileExpression(match[2]!, variables)
      invariant(variable?.kind === 'scalar' && variable.mutable && variable.type === expression.type, `unsupported assignment ${line}`)
      const {slot} = variable
      statements.push(state => {
        state.slots[slot] = expression.evaluate(state)
      })
      continue
    }
    invariant(false, `unsupported WGSL statement: ${line}`)
  }
  invariant(isMain ? index === lines.length : lines[index] === '}', 'a block ends with }')
  // A name of this block is free again after it, e.g. the `let`s of the next loop's body.
  for (const name of defined) variables.delete(name)
  return {statements, next: index + 1}
}

// Runs the shader's statements for instances 0 to count - 1, writing each output group into its own array. `inputs`
// are the per-document buffers after the first one, e.g. the display kinds a masked search reads, and `window` the
// documents that get per position outputs.
export type WgslInterpreter = (shared: Float32Array, sources: Float32Array, count: number, outputs: Float32Array[], options?: {inputs?: readonly Float32Array[], window?: {first: number, count: number}}) => void

export function createWgslInterpreter(code: string): WgslInterpreter {
  const mainStart = code.indexOf('fn main(')
  invariant(mainStart >= 0, 'the shader has no main')
  const lines = code.slice(code.indexOf('{', mainStart) + 1, code.lastIndexOf('}')).split('\n').map(line => line.trim()).filter(line => line !== '')
  const scope: Scope = {variables: new Map(), slotCount: 0, arrays: []}
  const builtIn = (name: string) => {
    const slot = scope.slotCount++
    scope.variables.set(name, {kind: 'scalar', slot, type: 'u32', mutable: false})
    return slot
  }
  const instanceIndex = builtIn('i')
  const windowFirst = builtIn('params.window_first')
  const windowCount = builtIn('params.window_count')
  const {statements} = compileBlock(lines, 0, scope, true)
  const slots = new Float64Array(scope.slotCount)
  const arrays = scope.arrays.map(({elementType, length}) => elementType === 'f32' ? new Float32Array(length) : new Uint32Array(length))
  return (shared, sources, count, outputs, options = {}) => {
    const state: State = {slots, arrays, shared, inputs: [sources, ...(options.inputs ?? [])], outputs}
    slots[windowFirst] = options.window?.first ?? 0
    slots[windowCount] = options.window?.count ?? 0
    for (let instance = 0; instance < count; instance++) {
      slots[instanceIndex] = instance
      for (const statement of statements) statement(state)
    }
  }
}
