// The Calculator app's arithmetic, apart from its buttons: a pocket calculator with
// immediate execution, as macOS's Calculator in its basic mode. "2 + 3 × 4 =" is 20, an
// operator pressed twice replaces the first, and "=" pressed again repeats the last
// operation, e.g. "2 + 3 = =" is 8.

export type Operator = '+' | '-' | '×' | '÷'
export type CalculatorKey = Operator | '=' | '.' | 'clear' | 'sign' | 'percent' | 'backspace' | `${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`

export type CalculatorState = {
  // The number being typed or the last result, as shown.
  display: string
  // The left operand and the operator waiting for the right one.
  accumulator: number | null
  operator: Operator | null
  // Whether the next digit starts a new number instead of extending the display.
  fresh: boolean
  // The last operator and right operand, for a repeated "=".
  repeat: {operator: Operator, operand: number} | null
  error: boolean
}

export const initialCalculator: CalculatorState = {
  display: '0',
  accumulator: null,
  operator: null,
  fresh: true,
  repeat: null,
  error: false,
}

const maximumDigits = 12

function apply(operator: Operator, left: number, right: number): number {
  switch (operator) {
    case '+': return left + right
    case '-': return left - right
    case '×': return left * right
    case '÷': return left / right
  }
}

// A result as the display shows it: at most 12 significant digits, without the binary
// noise of floating point, e.g. 0.1 + 0.2 shows 0.3, and in exponent form when it's very
// large or very small.
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return 'Error'
  if (value === 0) return '0'
  const magnitude = Math.abs(value)
  if (magnitude >= 1e12 || magnitude < 1e-9) {
    return value.toExponential(6).replace(/\.?0+e/, 'e').replace('e+', 'e')
  }
  const rounded = Number.parseFloat(value.toPrecision(maximumDigits))
  return `${rounded}`
}

function displayValue(state: CalculatorState) {
  return Number.parseFloat(state.display)
}

export function pressKey(state: CalculatorState, key: CalculatorKey): CalculatorState {
  if (state.error && key !== 'clear') return pressKey(initialCalculator, key)
  switch (key) {
    case 'clear':
      return initialCalculator
    case 'backspace': {
      if (state.fresh) return state
      const display = state.display.length > 1 && !(state.display.length === 2 && state.display.startsWith('-')) ? state.display.slice(0, -1) : '0'
      return {...state, display}
    }
    case '.':
      if (state.fresh) return {...state, display: '0.', fresh: false}
      if (state.display.includes('.')) return state
      return {...state, display: `${state.display}.`}
    case 'sign':
      if (state.display === '0') return state
      return {...state, display: state.display.startsWith('-') ? state.display.slice(1) : `-${state.display}`}
    case 'percent':
      return {...state, display: formatNumber(displayValue(state) / 100), fresh: true}
    case '+':
    case '-':
    case '×':
    case '÷': {
      // A second operator in a row only replaces the first.
      if (state.fresh && state.operator !== null) return {...state, operator: key}
      const value = displayValue(state)
      const result = state.accumulator === null || state.operator === null ? value : apply(state.operator, state.accumulator, value)
      if (!Number.isFinite(result)) return {...initialCalculator, display: 'Error', error: true}
      return {display: formatNumber(result), accumulator: result, operator: key, fresh: true, repeat: null, error: false}
    }
    case '=': {
      const value = displayValue(state)
      let operation = state.repeat
      let left = value
      if (state.operator !== null && state.accumulator !== null) {
        operation = {operator: state.operator, operand: value}
        left = state.accumulator
      }
      if (operation === null) return {...state, fresh: true}
      const result = apply(operation.operator, left, operation.operand)
      if (!Number.isFinite(result)) return {...initialCalculator, display: 'Error', error: true}
      return {display: formatNumber(result), accumulator: null, operator: null, fresh: true, repeat: operation, error: false}
    }
    default: {
      // A digit.
      if (state.fresh) return {...state, display: key, fresh: false}
      const digits = state.display.replace(/[-.]/g, '').length
      if (digits >= maximumDigits) return state
      return {...state, display: state.display === '0' ? key : state.display === '-0' ? `-${key}` : `${state.display}${key}`}
    }
  }
}

// The key that a keyboard key presses, if any.
export function keyFromKeyboard(key: string): CalculatorKey | null {
  if (/^[0-9]$/.test(key)) return key as CalculatorKey
  switch (key) {
    case '+': return '+'
    case '-': return '-'
    case '*': case 'x': case '×': return '×'
    case '/': case '÷': return '÷'
    case '=': case 'Enter': return '='
    case '.': case ',': return '.'
    case '%': return 'percent'
    case 'Escape': case 'c': case 'C': return 'clear'
    case 'Backspace': case 'Delete': return 'backspace'
    default: return null
  }
}
