// Arithmetic for the `calculate` command: + - × ÷, parentheses, percent and decimals, with
// the usual precedence, read by a small parser (never eval). Words people type become
// symbols first, e.g. "17 times 23" or "half of 90".

export type Evaluation = {ok: true, value: number, expression: string} | {ok: false, reason: string}

// Turns words and look-alike symbols into + - * / ( ) and digits.
export function normalizeExpression(text: string): string {
  return ` ${text.toLowerCase()} `
    .replace(/,(?=\d{3}\b)/gu, '')
    .replace(/\b(what is|what's|whats|calculate|compute|how much is|equals?|the answer to)\b/gu, ' ')
    .replace(/\bhalf of\b/gu, ' 0.5 * ')
    .replace(/\bsquared\b/gu, ' ^ 2 ')
    // "3x4" as typed, with no space around the x.
    .replace(/(\d)x(?=[\d.(])/gu, '$1 * ')
    .replace(/\b(multiplied by|times|x)\b/gu, ' * ')
    .replace(/\b(divided by|over)\b/gu, ' / ')
    .replace(/\bplus\b/gu, ' + ')
    .replace(/\bminus\b/gu, ' - ')
    .replace(/\bpercent of\b/gu, ' % * ')
    .replace(/%\s*of\b/gu, '% * ')
    .replace(/\bpercent\b/gu, ' % ')
    .replace(/[×✕]/gu, '*')
    .replace(/[÷]/gu, '/')
    .replace(/[−–]/gu, '-')
    .replace(/[?=]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

type Token = {kind: 'number', value: number} | {kind: 'op', value: string}

function tokenize(text: string): Token[] | null {
  const tokens: Token[] = []
  let index = 0
  while (index < text.length) {
    const character = text[index]!
    if (character === ' ') {
      index++
      continue
    }
    const number = /^\d+(\.\d+)?|^\.\d+/u.exec(text.slice(index))
    if (number !== null) {
      tokens.push({kind: 'number', value: Number(number[0])})
      index += number[0].length
      continue
    }
    if ('+-*/()%^'.includes(character)) {
      tokens.push({kind: 'op', value: character})
      index++
      continue
    }
    return null
  }
  return tokens
}

// expression := term (('+' | '-') term)*
// term       := factor (('*' | '/') factor)*
// factor     := ('-' | '+') factor | power
// power      := postfix ('^' factor)?
// postfix    := primary '%'*
// primary    := number | '(' expression ')'
export function evaluateExpression(text: string): Evaluation {
  const expression = normalizeExpression(text)
  const tokens = tokenize(expression)
  if (tokens === null || tokens.length === 0) return {ok: false, reason: 'That isn\'t arithmetic I can do.'}
  let position = 0
  const peek = () => tokens[position]
  const isOp = (value: string) => {
    const token = peek()
    return token?.kind === 'op' && token.value === value
  }
  const primary = (): number => {
    const token = peek()
    if (token === undefined) throw new Error('incomplete')
    if (token.kind === 'number') {
      position++
      return token.value
    }
    if (token.value === '(') {
      position++
      const value = sum()
      if (!isOp(')')) throw new Error('unclosed')
      position++
      return value
    }
    throw new Error('unexpected')
  }
  const postfix = (): number => {
    let value = primary()
    while (isOp('%')) {
      position++
      value /= 100
    }
    return value
  }
  const power = (): number => {
    const base = postfix()
    if (!isOp('^')) return base
    position++
    return base ** factor()
  }
  const factor = (): number => {
    if (isOp('-')) {
      position++
      return -factor()
    }
    if (isOp('+')) {
      position++
      return factor()
    }
    return power()
  }
  const product = (): number => {
    let value = factor()
    while (isOp('*') || isOp('/')) {
      const operator = peek()!.value
      position++
      const right = factor()
      value = operator === '*' ? value * right : value / right
    }
    return value
  }
  const sum = (): number => {
    let value = product()
    while (isOp('+') || isOp('-')) {
      const operator = peek()!.value
      position++
      const right = product()
      value = operator === '+' ? value + right : value - right
    }
    return value
  }
  try {
    const value = sum()
    if (position !== tokens.length) return {ok: false, reason: 'That isn\'t arithmetic I can do.'}
    if (!Number.isFinite(value)) return {ok: false, reason: 'That has no number for an answer, e.g. a division by zero.'}
    return {ok: true, value, expression}
  } catch {
    return {ok: false, reason: 'That isn\'t arithmetic I can do.'}
  }
}

// A result as a person writes it: up to 10 significant digits, no trailing zeros, and
// thousands separators, e.g. 391, 0.3333333333, 1,234,567.
export function formatResult(value: number): string {
  const rounded = Number(value.toPrecision(10))
  if (Math.abs(rounded) >= 1e15 || (Math.abs(rounded) < 1e-6 && rounded !== 0)) return rounded.toExponential(6).replace(/\.?0+e/u, 'e')
  return rounded.toLocaleString('en-US', {maximumFractionDigits: 10})
}

// The expression back in the calculator's symbols, for the reply, e.g. "17 × 23".
export function prettyExpression(expression: string): string {
  return expression.replaceAll('*', '×').replaceAll('/', '÷').replace(/\s*([+\-×÷^])\s*/gu, ' $1 ').replace(/\s+/gu, ' ').trim()
}
