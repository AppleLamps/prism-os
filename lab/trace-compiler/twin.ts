// The fround twin: an interpreter that runs the same TypeScript subset with FP32 semantics.
// Every arithmetic step rounds through Math.fround, and division rewrites to multiplication by
// the FP32 reciprocal — the one algebraic rewrite the substrate forces, since the circuit has no
// division. Control flow (ternaries, ifs, loops, Math.min/max/floor) stays native. The compiled
// circuit must agree with this twin bit-for-bit; the same interpreter in fp64 mode is the
// original float64 function, used to measure drift between the twin and the author's intent.
//
// The twin also replays the circuit's comparison decisions: for every continuous comparison the
// compiler lowered to a boolean atom, the twin checks whether the operand difference fell inside
// the unresolved margin where the circuit's decision bit could disagree with the native branch.

import ts from 'typescript'
import {invariant} from '../../numeric-ui-core.ts'
import type {FunctionLike} from './compile.ts'

const f32 = Math.fround

export type RuntimeValue =
  | number
  | boolean
  | null
  | string
  | {kind: 'array', elements: RuntimeValue[]}
  | {kind: 'object', fields: Map<string, RuntimeValue>}
  | {kind: 'function', declaration: FunctionLike}

export type RuntimeObjectValue = {kind: 'object', fields: Map<string, RuntimeValue>}
export type RuntimeArrayValue = {kind: 'array', elements: RuntimeValue[]}

export function runtimeObject(fields: Record<string, RuntimeValue>): RuntimeObjectValue {
  return {kind: 'object', fields: new Map(Object.entries(fields))}
}

export function runtimeArray(elements: RuntimeValue[]): RuntimeArrayValue {
  return {kind: 'array', elements}
}

export type MarginInfo = {epsilon: number, tieIsTrue: boolean}

export type MarginViolation = {positionKey: string, difference: number}

export type InterpreterMode = 'fp32' | 'fp64'

type Binding = {value: RuntimeValue}

export class Scope {
  parent: Scope | null
  bindings: Map<string, Binding>

  constructor(parent: Scope | null) {
    this.parent = parent
    this.bindings = new Map()
  }

  declare(name: string, value: RuntimeValue) {
    this.bindings.set(name, {value})
  }

  lookup(name: string): Binding | null {
    const binding = this.bindings.get(name)
    if (binding !== undefined) return binding
    return this.parent === null ? null : this.parent.lookup(name)
  }
}

function positionKey(node: ts.Node): string {
  const file = node.getSourceFile()
  const {line, character} = file.getLineAndCharacterOfPosition(node.getStart())
  return `${line + 1}:${character + 1}`
}

export class Interpreter {
  mode: InterpreterMode
  functions: Map<string, FunctionLike>
  constantInitializers: Map<string, ts.Expression>
  moduleScope: Scope
  // Margins of the compiled circuit's continuous comparisons, keyed by source position. Filled
  // by the harness from the compiled program's comparison sites.
  margins: Map<string, MarginInfo>
  marginViolations: MarginViolation[]
  loopGuard: number

  constructor(sourceFile: ts.SourceFile, mode: InterpreterMode, margins?: Map<string, MarginInfo>) {
    this.mode = mode
    this.functions = new Map()
    this.constantInitializers = new Map()
    this.moduleScope = new Scope(null)
    this.margins = margins ?? new Map<string, MarginInfo>()
    this.marginViolations = []
    this.loopGuard = 0
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
        this.functions.set(statement.name.text, statement)
        continue
      }
      if (ts.isVariableStatement(statement)) {
        if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
            this.constantInitializers.set(declaration.name.text, declaration.initializer)
          }
        }
      }
    }
  }

  round(value: number): number {
    return this.mode === 'fp32' ? f32(value) : value
  }

  callFunction(name: string, args: RuntimeValue[]): RuntimeValue {
    const declaration = this.functions.get(name)
    invariant(declaration !== undefined, `function ${name} not found`)
    return this.invoke(declaration, args)
  }

  runStatements(statements: readonly ts.Statement[], bindings: Map<string, RuntimeValue>): Scope {
    const scope = new Scope(this.moduleScope)
    for (const [name, value] of bindings) scope.declare(name, value)
    const ctx = {scope, returned: null as {value: RuntimeValue} | null}
    this.executeAll(statements, ctx)
    return scope
  }

  evaluateExpression(expression: ts.Expression, bindings: Map<string, RuntimeValue>): RuntimeValue {
    const scope = new Scope(this.moduleScope)
    for (const [name, value] of bindings) scope.declare(name, value)
    return this.evaluate(expression, {scope, returned: null})
  }

  invoke(declaration: FunctionLike, args: RuntimeValue[]): RuntimeValue {
    const scope = new Scope(this.moduleScope)
    const ctx = {scope, returned: null as {value: RuntimeValue} | null}
    declaration.parameters.forEach((parameter, index) => {
      invariant(ts.isIdentifier(parameter.name), 'destructured parameters are outside the subset')
      let argument = args[index]
      if (argument === undefined) {
        invariant(parameter.initializer !== undefined, `missing argument ${parameter.name.text}`)
        argument = this.evaluate(parameter.initializer, ctx)
      }
      scope.declare(parameter.name.text, argument)
    })
    const body = declaration.body
    invariant(body !== undefined, 'function without a body')
    if (ts.isBlock(body)) {
      this.executeAll(body.statements, ctx)
      return ctx.returned === null ? null : ctx.returned.value
    }
    return this.evaluate(body, ctx)
  }

  executeAll(statements: readonly ts.Statement[], ctx: {scope: Scope, returned: {value: RuntimeValue} | null}) {
    for (const statement of statements) {
      if (ctx.returned !== null) return
      this.execute(statement, ctx)
    }
  }

  execute(statement: ts.Statement, ctx: {scope: Scope, returned: {value: RuntimeValue} | null}) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        invariant(declaration.initializer !== undefined, 'declaration without an initializer')
        const value = this.evaluate(declaration.initializer, ctx)
        this.bindName(declaration.name, value, ctx)
      }
      return
    }
    if (ts.isExpressionStatement(statement)) {
      this.evaluate(statement.expression, ctx)
      return
    }
    if (ts.isIfStatement(statement)) {
      if (truthy(this.evaluate(statement.expression, ctx))) {
        this.execute(statement.thenStatement, {...ctx, scope: new Scope(ctx.scope)})
      } else if (statement.elseStatement !== undefined) {
        this.execute(statement.elseStatement, {...ctx, scope: new Scope(ctx.scope)})
      }
      return
    }
    if (ts.isForStatement(statement)) {
      const loopScope = new Scope(ctx.scope)
      const loopCtx = {...ctx, scope: loopScope}
      if (statement.initializer !== undefined) {
        if (ts.isVariableDeclarationList(statement.initializer)) {
          for (const declaration of statement.initializer.declarations) {
            invariant(declaration.initializer !== undefined, 'loop declaration without an initializer')
            this.bindName(declaration.name, this.evaluate(declaration.initializer, loopCtx), loopCtx)
          }
        } else {
          this.evaluate(statement.initializer, loopCtx)
        }
      }
      while (statement.condition === undefined || truthy(this.evaluate(statement.condition, loopCtx))) {
        invariant(this.loopGuard++ < 10_000_000, 'twin loop guard exceeded')
        this.execute(statement.statement, {...loopCtx, scope: new Scope(loopScope)})
        if (loopCtx.returned !== null) return
        if (statement.incrementor !== undefined) this.evaluate(statement.incrementor, loopCtx)
      }
      ctx.returned = loopCtx.returned
      return
    }
    if (ts.isForOfStatement(statement)) {
      const iterated = this.evaluate(statement.expression, ctx)
      invariant(typeof iterated === 'object' && iterated !== null && iterated.kind === 'array', 'for-of over a non-array')
      invariant(ts.isVariableDeclarationList(statement.initializer), 'for-of initializer shape')
      const declaration = statement.initializer.declarations[0]!
      for (const element of iterated.elements) {
        const iterationScope = new Scope(ctx.scope)
        const iterationCtx = {...ctx, scope: iterationScope}
        this.bindName(declaration.name, element, iterationCtx)
        this.execute(statement.statement, iterationCtx)
        if (ctx.returned !== null) return
      }
      return
    }
    if (ts.isReturnStatement(statement)) {
      ctx.returned = {value: statement.expression === undefined ? null : this.evaluate(statement.expression, ctx)}
      return
    }
    if (ts.isBlock(statement)) {
      this.executeAll(statement.statements, {...ctx, scope: new Scope(ctx.scope)})
      return
    }
    if (statement.kind === ts.SyntaxKind.EmptyStatement) return
    invariant(false, `twin does not support statement ${ts.SyntaxKind[statement.kind]}`)
  }

  bindName(name: ts.BindingName, value: RuntimeValue, ctx: {scope: Scope}) {
    if (ts.isIdentifier(name)) {
      ctx.scope.declare(name.text, value)
      return
    }
    if (ts.isObjectBindingPattern(name)) {
      invariant(typeof value === 'object' && value !== null && value.kind === 'object', 'destructuring a non-object')
      for (const element of name.elements) {
        const property = element.propertyName ?? element.name
        invariant(ts.isIdentifier(property) && ts.isIdentifier(element.name), 'computed destructuring')
        const field = value.fields.get(property.text)
        invariant(field !== undefined, `missing field ${property.text}`)
        ctx.scope.declare(element.name.text, field)
      }
      return
    }
    invariant(false, 'array destructuring is outside the subset')
  }

  evaluate(node: ts.Expression, ctx: {scope: Scope, returned: {value: RuntimeValue} | null}): RuntimeValue {
    if (ts.isNumericLiteral(node)) return this.round(Number(node.text))
    if (ts.isStringLiteralLike(node)) return node.text
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false
    if (node.kind === ts.SyntaxKind.NullKeyword) return null
    if (ts.isIdentifier(node)) {
      const name = node.text
      if (name === 'Infinity') return Number.POSITIVE_INFINITY
      if (name === 'undefined') return null
      const binding = ctx.scope.lookup(name)
      if (binding !== null) return binding.value
      const declaration = this.functions.get(name)
      if (declaration !== undefined) return {kind: 'function', declaration}
      const initializer = this.constantInitializers.get(name)
      if (initializer !== undefined) {
        const value = this.evaluate(initializer, {scope: this.moduleScope, returned: null})
        this.moduleScope.declare(name, value)
        return value
      }
      invariant(false, `twin cannot resolve identifier ${name}`)
    }
    if (ts.isParenthesizedExpression(node)) return this.evaluate(node.expression, ctx)
    if (ts.isNonNullExpression(node)) return this.evaluate(node.expression, ctx)
    if (ts.isAsExpression(node)) return this.evaluate(node.expression, ctx)
    if (ts.isPrefixUnaryExpression(node)) {
      if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
        return this.applyIncrement(node.operand, node.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1, ctx)
      }
      const operand = this.evaluate(node.operand, ctx)
      switch (node.operator) {
        case ts.SyntaxKind.MinusToken: return -asNumber(operand)
        case ts.SyntaxKind.PlusToken: return asNumber(operand)
        case ts.SyntaxKind.ExclamationToken: return !truthy(operand)
        default: invariant(false, `twin unary operator ${ts.SyntaxKind[node.operator]}`)
      }
    }
    if (ts.isPostfixUnaryExpression(node)) {
      return this.applyIncrement(node.operand, node.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1, ctx)
    }
    if (ts.isPropertyAccessExpression(node)) {
      const container = this.evaluate(node.expression, ctx)
      const field = node.name.text
      invariant(typeof container === 'object' && container !== null, `property ${field} on a primitive`)
      if (container.kind === 'object') {
        const value = container.fields.get(field)
        invariant(value !== undefined, `missing field ${field}`)
        return value
      }
      if (container.kind === 'array' && field === 'length') return container.elements.length
      invariant(false, `property ${field} on ${container.kind}`)
    }
    if (ts.isElementAccessExpression(node)) {
      const container = this.evaluate(node.expression, ctx)
      invariant(typeof container === 'object' && container !== null && container.kind === 'array', 'indexing a non-array')
      const index = asNumber(this.evaluate(node.argumentExpression, ctx))
      const element = container.elements[index]
      invariant(element !== undefined, `index ${index} out of bounds`)
      return element
    }
    if (ts.isCallExpression(node)) return this.evaluateCall(node, ctx)
    if (ts.isBinaryExpression(node)) return this.evaluateBinary(node, ctx)
    if (ts.isConditionalExpression(node)) {
      return truthy(this.evaluate(node.condition, ctx))
        ? this.evaluate(node.whenTrue, ctx)
        : this.evaluate(node.whenFalse, ctx)
    }
    if (ts.isObjectLiteralExpression(node)) {
      const fields = new Map<string, RuntimeValue>()
      for (const property of node.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          fields.set(property.name.text, this.evaluate(property.name, ctx))
        } else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
          fields.set(property.name.text, this.evaluate(property.initializer, ctx))
        } else {
          invariant(false, 'object literal property shape')
        }
      }
      return {kind: 'object', fields}
    }
    if (ts.isArrayLiteralExpression(node)) {
      return {kind: 'array', elements: node.elements.map(element => this.evaluate(element, ctx))}
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return {kind: 'function', declaration: node}
    invariant(false, `twin does not support expression ${ts.SyntaxKind[node.kind]}`)
  }

  applyIncrement(operand: ts.Expression, delta: number, ctx: {scope: Scope, returned: {value: RuntimeValue} | null}): number {
    const target = this.resolveTarget(operand, ctx)
    const current = asNumber(target.read())
    target.write(this.round(current + delta))
    return current
  }

  resolveTarget(node: ts.Expression, ctx: {scope: Scope, returned: {value: RuntimeValue} | null}): {read: () => RuntimeValue, write: (value: RuntimeValue) => void} {
    if (ts.isIdentifier(node)) {
      const binding = ctx.scope.lookup(node.text)
      invariant(binding !== null, `assignment to unknown ${node.text}`)
      return {read: () => binding.value, write: value => { binding.value = value }}
    }
    if (ts.isPropertyAccessExpression(node)) {
      const container = this.evaluate(node.expression, ctx)
      invariant(typeof container === 'object' && container !== null && container.kind === 'object', 'property assignment on a non-object')
      const field = node.name.text
      return {
        read: () => {
          const value = container.fields.get(field)
          invariant(value !== undefined, `missing field ${field}`)
          return value
        },
        write: value => container.fields.set(field, value),
      }
    }
    if (ts.isElementAccessExpression(node)) {
      const container = this.evaluate(node.expression, ctx)
      invariant(typeof container === 'object' && container !== null && container.kind === 'array', 'element assignment on a non-array')
      const index = asNumber(this.evaluate(node.argumentExpression, ctx))
      return {
        read: () => {
          const element = container.elements[index]
          invariant(element !== undefined, `index ${index} out of bounds`)
          return element
        },
        write: value => { container.elements[index] = value },
      }
    }
    invariant(false, `twin assignment target ${ts.SyntaxKind[node.kind]}`)
  }

  evaluateCall(node: ts.CallExpression, ctx: {scope: Scope, returned: {value: RuntimeValue} | null}): RuntimeValue {
    if (ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      if (ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Math') {
        const args = node.arguments.map(argument => asNumber(this.evaluate(argument, ctx)))
        switch (method) {
          case 'min': {
            this.recordFoldComparisons(node, args, 'min')
            return this.round(Math.min(...args))
          }
          case 'max': {
            this.recordFoldComparisons(node, args, 'max')
            return this.round(Math.max(...args))
          }
          case 'abs': return this.round(Math.abs(args[0]!))
          case 'floor': {
            const value = args[0]!
            if (!Number.isInteger(value)) this.recordComparison(node, f32(value - Math.ceil(value)))
            return this.round(Math.floor(value))
          }
          default: invariant(false, `twin Math.${method}`)
        }
      }
      const container = this.evaluate(node.expression.expression, ctx)
      invariant(typeof container === 'object' && container !== null && container.kind === 'array', `twin method call ${method}`)
      if (method === 'push') {
        for (const argument of node.arguments) container.elements.push(this.evaluate(argument, ctx))
        return container.elements.length
      }
      if (method === 'at') {
        const index = asNumber(this.evaluate(node.arguments[0]!, ctx))
        const at = index < 0 ? container.elements.length + index : index
        const element = container.elements[at]
        invariant(element !== undefined, 'array .at out of bounds')
        return element
      }
      invariant(false, `twin array method ${method}`)
    }
    invariant(ts.isIdentifier(node.expression), 'twin call shape')
    const callee = this.evaluate(node.expression, ctx)
    invariant(typeof callee === 'object' && callee !== null && callee.kind === 'function', `${node.expression.text} is not a function`)
    return this.invoke(callee.declaration, node.arguments.map(argument => this.evaluate(argument, ctx)))
  }

  evaluateBinary(node: ts.BinaryExpression, ctx: {scope: Scope, returned: {value: RuntimeValue} | null}): RuntimeValue {
    const kind = node.operatorToken.kind
    switch (kind) {
      case ts.SyntaxKind.EqualsToken: {
        const target = this.resolveTarget(node.left, ctx)
        const value = this.evaluate(node.right, ctx)
        target.write(value)
        return value
      }
      case ts.SyntaxKind.PlusEqualsToken:
      case ts.SyntaxKind.MinusEqualsToken:
      case ts.SyntaxKind.AsteriskEqualsToken:
      case ts.SyntaxKind.SlashEqualsToken: {
        const target = this.resolveTarget(node.left, ctx)
        const current = asNumber(target.read())
        const right = asNumber(this.evaluate(node.right, ctx))
        const value = kind === ts.SyntaxKind.PlusEqualsToken ? this.round(current + right)
          : kind === ts.SyntaxKind.MinusEqualsToken ? this.round(current - right)
          : kind === ts.SyntaxKind.AsteriskEqualsToken ? this.round(current * right)
          : this.divide(current, right)
        target.write(value)
        return value
      }
      case ts.SyntaxKind.AmpersandAmpersandToken: {
        const left = this.evaluate(node.left, ctx)
        return truthy(left) ? this.evaluate(node.right, ctx) : left
      }
      case ts.SyntaxKind.BarBarToken: {
        const left = this.evaluate(node.left, ctx)
        return truthy(left) ? left : this.evaluate(node.right, ctx)
      }
      case ts.SyntaxKind.QuestionQuestionToken: {
        const left = this.evaluate(node.left, ctx)
        return left ?? this.evaluate(node.right, ctx)
      }
      default: break
    }
    const left = this.evaluate(node.left, ctx)
    const right = this.evaluate(node.right, ctx)
    switch (kind) {
      case ts.SyntaxKind.PlusToken: return this.round(asNumber(left) + asNumber(right))
      case ts.SyntaxKind.MinusToken: return this.round(asNumber(left) - asNumber(right))
      case ts.SyntaxKind.AsteriskToken: return this.round(asNumber(left) * asNumber(right))
      case ts.SyntaxKind.SlashToken: return this.divide(asNumber(left), asNumber(right))
      case ts.SyntaxKind.PercentToken: return this.round(asNumber(left) % asNumber(right))
      case ts.SyntaxKind.LessThanToken:
        this.recordComparison(node, f32(asNumber(right) - asNumber(left)))
        return asNumber(left) < asNumber(right)
      case ts.SyntaxKind.GreaterThanToken:
        this.recordComparison(node, f32(asNumber(left) - asNumber(right)))
        return asNumber(left) > asNumber(right)
      case ts.SyntaxKind.LessThanEqualsToken:
        this.recordComparison(node, f32(asNumber(right) - asNumber(left)))
        return asNumber(left) <= asNumber(right)
      case ts.SyntaxKind.GreaterThanEqualsToken:
        this.recordComparison(node, f32(asNumber(left) - asNumber(right)))
        return asNumber(left) >= asNumber(right)
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
        if (typeof left === 'number' && typeof right === 'number') {
          this.recordComparison(node, f32(left - right))
          this.recordComparison(node, f32(right - left))
        }
        return strictEquals(left, right)
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        if (typeof left === 'number' && typeof right === 'number') {
          this.recordComparison(node, f32(left - right))
          this.recordComparison(node, f32(right - left))
        }
        return !strictEquals(left, right)
      case ts.SyntaxKind.EqualsEqualsToken: return looseNullEquals(left, right)
      case ts.SyntaxKind.ExclamationEqualsToken: return !looseNullEquals(left, right)
      default: invariant(false, `twin binary operator ${ts.SyntaxKind[kind]}`)
    }
  }

  // Division in fp32 mode mirrors the compiler's lowering: multiply by the FP32 reciprocal.
  divide(numerator: number, denominator: number): number {
    if (this.mode === 'fp64') return numerator / denominator
    return f32(numerator * f32(1 / denominator))
  }

  recordFoldComparisons(node: ts.Node, args: number[], which: 'min' | 'max') {
    // Mirrors the compiler's left fold over Math.min/max arguments: one comparison per step.
    let accumulated = args[0]!
    for (let index = 1; index < args.length; index++) {
      const next = args[index]!
      // min(a, b) tests [a - b > 0]; max(a, b) tests [b - a > 0].
      const difference = which === 'min' ? f32(accumulated - next) : f32(next - accumulated)
      this.recordComparison(node, difference)
      accumulated = which === 'min' ? Math.min(accumulated, next) : Math.max(accumulated, next)
    }
  }

  recordComparison(node: ts.Node, difference: number) {
    if (this.margins.size === 0) return
    const info = this.margins.get(positionKey(node))
    if (info === undefined) return
    const inUnresolvedZone = info.tieIsTrue
      ? difference > -info.epsilon && difference < 0
      : difference > 0 && difference < info.epsilon
    if (inUnresolvedZone) {
      this.marginViolations.push({positionKey: positionKey(node), difference})
    }
  }
}

function truthy(value: RuntimeValue): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value)
  if (value === null) return false
  if (typeof value === 'string') return value.length > 0
  return true
}

function asNumber(value: RuntimeValue): number {
  invariant(typeof value === 'number', `expected a number, got ${typeof value}`)
  return value
}

function strictEquals(left: RuntimeValue, right: RuntimeValue): boolean {
  return left === right
}

function looseNullEquals(left: RuntimeValue, right: RuntimeValue): boolean {
  // The subset only uses loose equality for null tests (x == null); null and undefined both
  // arrive here as null.
  invariant(left === null || right === null || typeof left === typeof right, 'loose equality outside null tests')
  return left === right
}
