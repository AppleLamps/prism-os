// Execute the selected source with the JS engine, not the numeric interpreter. Only reachable
// declarations are included, so checking a gallery helper does not start its browser app.
import ts from 'typescript'
import {compileFunction} from 'node:vm'
import {invariant} from '../../numeric-ui-core.ts'
import {Scope, type RuntimeValue} from './twin.ts'

type NativeValue = number | boolean | string | null | undefined | NativeValue[] | {[name: string]: NativeValue}
type NativeFunction = (...args: NativeValue[]) => NativeValue

class ValueBridge {
  nativeByRuntime = new Map<object, NativeValue[] | {[name: string]: NativeValue}>()
  runtimeByNative = new Map<object, RuntimeValue>()
  synchronized = new Set<object>()

  toNative(value: RuntimeValue): NativeValue {
    if (value === null || typeof value !== 'object') return value
    invariant(value.kind !== 'function', 'native validation does not accept function-valued inputs')
    const existing = this.nativeByRuntime.get(value)
    if (existing !== undefined) return existing
    const native: NativeValue[] | {[name: string]: NativeValue} = value.kind === 'array' ? [] : {}
    this.nativeByRuntime.set(value, native)
    this.runtimeByNative.set(native, value)
    if (value.kind === 'array') {
      invariant(Array.isArray(native), 'array bridge')
      for (const element of value.elements) native.push(this.toNative(element))
    } else {
      invariant(!Array.isArray(native), 'object bridge')
      for (const [name, field] of value.fields) native[name] = this.toNative(field)
    }
    return native
  }

  fromNative(value: NativeValue): RuntimeValue {
    if (value === undefined) return null
    if (value === null || typeof value !== 'object') return value
    let runtime = this.runtimeByNative.get(value)
    if (runtime === undefined) {
      runtime = Array.isArray(value) ? {kind: 'array', elements: []} : {kind: 'object', fields: new Map()}
      this.runtimeByNative.set(value, runtime)
    }
    if (this.synchronized.has(value)) return runtime
    this.synchronized.add(value)
    invariant(runtime !== null && typeof runtime === 'object', 'object bridge result')
    if (Array.isArray(value)) {
      invariant(runtime.kind === 'array', 'array bridge result')
      runtime.elements = value.map(element => this.fromNative(element))
    } else {
      invariant(runtime.kind === 'object', 'object bridge result')
      runtime.fields = new Map(Object.entries(value).map(([name, field]) => [name, this.fromNative(field)]))
    }
    return runtime
  }

  synchronize() {
    for (const native of this.nativeByRuntime.values()) this.fromNative(native)
  }
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  const names: string[] = []
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) names.push(...bindingNames(element.name))
  }
  return names
}

export class NativeExecutor {
  readonly mode = 'fp64'
  sourceFile: ts.SourceFile
  checker: ts.TypeChecker
  compiled = new Map<string, NativeFunction>()

  constructor(sourceFile: ts.SourceFile) {
    this.sourceFile = sourceFile
    const options: ts.CompilerOptions = {noLib: true, noResolve: true, target: ts.ScriptTarget.ESNext}
    const host = ts.createCompilerHost(options)
    host.getSourceFile = fileName => fileName === sourceFile.fileName ? sourceFile : undefined
    const program = ts.createProgram([sourceFile.fileName], options, host)
    this.checker = program.getTypeChecker()
  }

  dependencies(nodes: readonly ts.Node[], bindings: readonly string[]): string {
    const declarations = new Set<ts.FunctionDeclaration | ts.VariableDeclaration>()
    const visit = (node: ts.Node, overriddenNames: readonly string[]) => {
      if (ts.isIdentifier(node)) {
        const declaration = this.checker.getSymbolAtLocation(node)?.valueDeclaration
        const isFunction = declaration !== undefined && ts.isFunctionDeclaration(declaration)
          && declaration.parent === this.sourceFile
        const isVariable = declaration !== undefined && ts.isVariableDeclaration(declaration)
          && declaration.parent.parent.parent === this.sourceFile
        if ((isFunction || isVariable) && !overriddenNames.includes(node.text) && !declarations.has(declaration)) {
          declarations.add(declaration)
          ts.forEachChild(declaration, child => visit(child, []))
        }
      }
      ts.forEachChild(node, child => visit(child, overriddenNames))
    }
    for (const node of nodes) visit(node, bindings)
    return [...declarations].sort((a, b) => a.pos - b.pos).map(declaration => (
      ts.isVariableDeclaration(declaration) ? `const ${declaration.getText()};` : declaration.getText()
    )).join('\n')
  }

  compile(key: string, nodes: readonly ts.Node[], names: string[], body: string): NativeFunction {
    const cached = this.compiled.get(key)
    if (cached !== undefined) return cached
    const source = `${this.dependencies(nodes, names)}\nfunction __nativeTrial(${names.join(',')}) {\n${body}\n}`
    const javascript = ts.transpileModule(source, {
      compilerOptions: {target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None},
    }).outputText
    // This is intentionally native execution of local test source. It is not a sandbox for
    // untrusted programs, and the harness must never evaluate downloaded source this way.
    const factory = compileFunction(`${javascript}\nreturn __nativeTrial;`) as () => NativeFunction
    const run: NativeFunction = (...args) => factory()(...args)
    this.compiled.set(key, run)
    return run
  }

  callFunction(name: string, args: RuntimeValue[]): RuntimeValue {
    const declaration = this.sourceFile.statements.find(statement => (
      ts.isFunctionDeclaration(statement) && statement.name?.text === name
    ))
    invariant(declaration !== undefined && ts.isFunctionDeclaration(declaration), `native function ${name} not found`)
    const names = args.map((_, index) => `__argument${index}`)
    const run = this.compile(`function:${name}:${args.length}`, [declaration], names, `return ${name}(${names.join(',')});`)
    const bridge = new ValueBridge()
    const result = run(...args.map(argument => bridge.toNative(argument)))
    bridge.synchronize()
    return bridge.fromNative(result)
  }

  runStatements(statements: readonly ts.Statement[], bindings: Map<string, RuntimeValue>): Scope {
    const names = [...bindings.keys()]
    const outputNames = new Set(names)
    for (const statement of statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) outputNames.add(name)
      }
    }
    const key = `statements:${statements.map(statement => statement.pos).join(',')}:${names.join(',')}`
    const body = `${statements.map(statement => statement.getText()).join('\n')}\nreturn {${[...outputNames].join(',')}};`
    const run = this.compile(key, statements, names, body)
    const bridge = new ValueBridge()
    const result = run(...[...bindings.values()].map(value => bridge.toNative(value)))
    bridge.synchronize()
    invariant(result !== null && typeof result === 'object' && !Array.isArray(result), 'native statement outputs')
    const scope = new Scope(null)
    for (const [name, value] of Object.entries(result)) scope.declare(name, bridge.fromNative(value))
    return scope
  }

  evaluateExpression(expression: ts.Expression, bindings: Map<string, RuntimeValue>): RuntimeValue {
    const names = [...bindings.keys()]
    const run = this.compile(`expression:${expression.pos}:${names.join(',')}`, [expression], names, `return (${expression.getText()});`)
    const bridge = new ValueBridge()
    const result = run(...[...bindings.values()].map(value => bridge.toNative(value)))
    bridge.synchronize()
    return bridge.fromNative(result)
  }
}
