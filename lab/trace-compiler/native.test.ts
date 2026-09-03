import assert from 'node:assert/strict'
import {test} from 'bun:test'
import ts from 'typescript'
import {compileFunctionFromSource, parseSource} from './compile.ts'
import {functionTrialRunner, runEquivalence} from './harness.ts'
import {NativeExecutor} from './native.ts'
import {Interpreter, runtimeObject} from './twin.ts'

test('native checks ignore unrelated initializers and respect parameter shadowing', () => {
  const source = parseSource(`
    const data = document.body
    const offset = 3
    function helper(value: number) { return value + offset }
    function example(data: number) { return helper(data) }
  `)
  assert.equal(new NativeExecutor(source).callFunction('example', [2]), 5)
})

test('interpreter returns leave runtime branches and loops, matching native JS', () => {
  const bodies = [
    'if (x > 0) { return x + 1 } return x + 2',
    'for (let index = 0; index < 3; index++) { if (index === x) { return index + 10 } } return 20',
    'for (const index of [0, 1, 2]) { if (index === x) { return index + 10 } } return 20',
  ]
  for (const body of bodies) {
    const source = parseSource(`function example(x: number) { ${body} }`)
    const interpreter = new Interpreter(source, 'fp64')
    const native = new NativeExecutor(source)
    for (const value of [-1, 0, 1, 2, 3]) {
      assert.equal(interpreter.callFunction('example', [value]), native.callFunction('example', [value]))
    }
  }
})

test('native execution retains object aliases and mutations through helper calls', () => {
  const source = parseSource(`
    function bump(first: {value: number}, second: {value: number}) {
      first.value += 1
      second.value += 2
      return first.value
    }
  `)
  const object = runtimeObject({value: 4})
  assert.equal(new NativeExecutor(source).callFunction('bump', [object, object]), 7)
  assert.equal(object.fields.get('value'), 7)
})

test('slice inputs override direct global reads, not globals inside helper functions', () => {
  const source = parseSource(`
    const value = 3
    function helper() { return value }
    function example() { const result = value + helper() }
  `)
  const declaration = source.statements[2]!
  assert.ok(ts.isFunctionDeclaration(declaration) && declaration.body !== undefined)
  const scope = new NativeExecutor(source).runStatements(declaration.body.statements, new Map([['value', 10]]))
  assert.equal(scope.lookup('result')!.value, 13)
})

test('custom inputs round on entry to the FP32 twin, not the native precision check', () => {
  const result = compileFunctionFromSource('function example(x: number) { return x - 1 }', 'example', {
    inputs: {x: {minimum: 0, maximum: 2}},
  })
  assert.ok(result.ok)
  const report = runEquivalence(result.program, result.sourceFile, functionTrialRunner(result.declaration, 'example'), {
    trials: 1, seed: 1, generateInputs: () => new Map([['x', 1 + 2 ** -24]]),
  })
  assert.deepEqual(report.mismatches, [])
  assert.deepEqual(report.sourceSemantics.mismatches, [])
  assert.equal(report.drift.maxAbsoluteDrift, 2 ** -24)
})
