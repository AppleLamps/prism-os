import assert from 'node:assert/strict'
import {test} from 'bun:test'
import {parseFitText} from './annotations.ts'
import {compileFunctionFromSource, type CompileResult} from './compile.ts'
import {functionTrialRunner, runEquivalence} from './harness.ts'
import {Interpreter} from './twin.ts'

function compileOrThrow(source: string, name: string, options?: Parameters<typeof compileFunctionFromSource>[2]) {
  const result = compileFunctionFromSource(source, name, options)
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.diagnostic)}`)
  return result
}

function verify(result: CompileResult & {ok: true}, functionName: string, trials = 2000, seed = 1) {
  const report = runEquivalence(
    result.program,
    result.sourceFile,
    functionTrialRunner(result.declaration, functionName),
    {trials, seed},
  )
  assert.deepEqual(report.mismatches, [])
  assert.deepEqual(report.sourceSemantics.mismatches, [])
  return report
}

test('@fit parsing covers the forms in the real file', () => {
  const doc = parseFitText(`
    given containerSizeX: int 0..<Infinity
    given max >= min
    return.cols: int 1..7
    return.boxMaxSizeX > 0
  `, null)
  assert.deepEqual(doc.problems, [])
  assert.deepEqual(doc.ranges, [
    {subject: 'containerSizeX', integer: true, minimum: 0, maximum: Number.POSITIVE_INFINITY},
    {subject: 'return.cols', integer: true, minimum: 1, maximum: 7},
    {subject: 'return.boxMaxSizeX', integer: false, minimum: 0, maximum: Number.POSITIVE_INFINITY},
  ])
  assert.deepEqual(doc.relations, [{subject: 'max', comparison: '>=', other: 'min'}])

  const trailing = parseFitText('int 0..Infinity', 'steps')
  assert.deepEqual(trailing.ranges, [
    {subject: 'steps', integer: true, minimum: 0, maximum: Number.POSITIVE_INFINITY},
  ])
  const positive = parseFitText('> 0', 'k')
  assert.deepEqual(positive.ranges, [
    {subject: 'k', integer: false, minimum: 0, maximum: Number.POSITIVE_INFINITY},
  ])
})

test('straight-line arithmetic matches the fround twin bit-for-bit', () => {
  const source = `
    function layoutGap(
      containerSizeX: number, // @fit 0..4096
      itemSizeX: number, // @fit 1..512
    ): number {
      const leftover = containerSizeX - itemSizeX * 3
      return leftover / 7 + 0.125 * itemSizeX
    }
  `
  const result = compileOrThrow(source, 'layoutGap')
  const report = verify(result, 'layoutGap')
  // Straight-line arithmetic has no comparisons at all.
  assert.equal(result.program.comparisonSites.length, 0)
  // Division lowered to reciprocal multiplication drifts from float64 division by around one
  // FP32 ulp; the leftover subtraction can cancel, so bound the absolute drift, not the relative.
  assert.ok(report.drift.maxAbsoluteDrift < 1e-2, `drift ${report.drift.maxAbsoluteDrift}`)
  assert.ok(report.drift.outputsCompared > 0 && report.drift.bitEqualCount > 0)
})

test('ternary on a continuous comparison lowers to a select and matches the twin', () => {
  const source = `
    function pick(a: number, b: number): number { // @fit
      return a < b ? a * 2 + 1 : b - 3
    }
  `
  const result = compileOrThrow(source, 'pick', {
    inputs: {a: {minimum: -1000, maximum: 1000}, b: {minimum: -1000, maximum: 1000}},
  })
  verify(result, 'pick', 3000)
  assert.equal(result.program.comparisonSites.length, 1)
  assert.equal(result.program.comparisonSites[0]!.kind, 'continuous')
})

test('integer comparisons use exact decision bits with no boolean atom', () => {
  const source = `
    function stripe(
      row: number, // @fit int 0..100
      cols: number, // @fit int 1..7
    ): number {
      return row > cols ? 10 : row === cols ? 20 : 30
    }
  `
  const result = compileOrThrow(source, 'stripe')
  assert.equal(result.program.opCounts.boolean, 0)
  verify(result, 'stripe', 3000)
})

test('Math.min, Math.max, Math.abs match native FP32 results', () => {
  const source = `
    function extremes(a: number, b: number, c: number): number { // @fit
      return Math.min(a, b, c) + Math.max(a, b) * 2 + Math.abs(c - a)
    }
  `
  const bounds = {minimum: -5000, maximum: 5000}
  const result = compileOrThrow(source, 'extremes', {inputs: {a: bounds, b: bounds, c: bounds}})
  verify(result, 'extremes', 3000)
  // min/max lower through exact sign bits; no site carries an unresolved margin.
  assert.ok(result.program.comparisonSites.every(site => site.epsilon === null))
})

test('Math.floor over a bounded range uses step bits and matches', () => {
  const source = `
    function shelf(x: number): number { // @fit 0..20
      return Math.floor(x) * 3
    }
  `
  const result = compileOrThrow(source, 'shelf', {inputs: {x: {minimum: 0, maximum: 20}}})
  verify(result, 'shelf', 3000)
})

test('modulo and division by a bounded runtime integer lower to one-hot selection', () => {
  const source = `
    function wrap(
      index: number, // @fit int 0..40
      count: number, // @fit int 1..8
    ): number {
      return index % count + index / count
    }
  `
  const result = compileOrThrow(source, 'wrap')
  verify(result, 'wrap', 3000)
})

test('runtime loop bounds unroll with per-iteration masks', () => {
  const source = `
    function prefixWidth(
      focused: number, // @fit int 0..11
      itemSizeX: number, // @fit 10..200
    ): number {
      let total = 0
      for (let i = focused - 1; i >= 0; i--) {
        total = total - (itemSizeX + 8)
      }
      return total
    }
  `
  const result = compileOrThrow(source, 'prefixWidth')
  verify(result, 'prefixWidth', 2000)
})

test('if statements under runtime conditions mask their assignments', () => {
  const source = `
    function stack(
      itemCount: number, // @fit int 1..16
      rowSizeY: number, // @fit 1..400
    ): number {
      let top = 0
      for (let i = 0; i < itemCount; i++) {
        if (i > 4) {
          top = top + rowSizeY
        } else {
          top = top + rowSizeY / 2
        }
      }
      return top
    }
  `
  const result = compileOrThrow(source, 'stack')
  verify(result, 'stack', 2000)
})

test('a nullable return compiles to a presence bit plus a value', () => {
  const source = `
    function hitSide(
      pointerX: number, // @fit -100..2200
      windowSizeX: number, // @fit 200..2100
    ): number | null {
      return pointerX < 100 ? 1 : pointerX > windowSizeX - 100 ? 2 : null
    }
  `
  const result = compileOrThrow(source, 'hitSide')
  const names = result.program.outputs.map(output => output.name)
  assert.deepEqual(names, ['return.present', 'return.value'])
  verify(result, 'hitSide', 3000)
})

test('object parameters declared through options compile with field mutations as outputs', () => {
  const source = `
    function springStep(config: {pos: number, dest: number, v: number, k: number, b: number}): void {
      const t = 4 / 1000
      const Fspring = -config.k * (config.pos - config.dest)
      const Fdamper = -config.b * config.v
      const a = Fspring + Fdamper
      const newV = config.v + a * t
      const newPos = config.pos + newV * t
      config.pos = newPos; config.v = newV
    }
  `
  const result = compileOrThrow(source, 'springStep', {
    inputs: {
      'config.pos': {minimum: -4000, maximum: 4000},
      'config.dest': {minimum: -4000, maximum: 4000},
      'config.v': {minimum: -10_000, maximum: 10_000},
      'config.k': {minimum: 0, maximum: 600},
      'config.b': {minimum: 0, maximum: 80},
    },
  })
  const names = result.program.outputs.map(output => output.name).sort()
  assert.deepEqual(names, ['config.pos', 'config.v'])
  verify(result, 'springStep', 3000)
})

test('rejections carry a category, the construct, and the line', () => {
  const cases: [string, string, string][] = [
    ['function f(a: number): number { return a + "px" as unknown as number }', 'f', 'string work'],
    ['function f(a: number, b: number): number { return a / b }', 'f', 'dynamic division'],
    ['function f(x: number): number { return Math.floor(x) }', 'f', 'unbounded range'],
    ['function f(n: number): number { let s = 0; for (let i = 0; i < n; i++) s = s + i; return s }', 'f', 'dynamic loop bound'],
    ['function f(a: number): number { return document.body.clientWidth + a }', 'f', 'browser API'],
    ['function f(a: number): number { return Math.sqrt(a) }', 'f', 'unsupported call'],
  ]
  for (const [source, name, category] of cases) {
    const result = compileFunctionFromSource(source, name, {
      inputs: {a: {minimum: 0, maximum: 10}, b: {minimum: -5, maximum: 5}},
    })
    assert.ok(!result.ok, `expected rejection for: ${source}`)
    assert.equal(result.diagnostic.category, category, `for: ${source}, got ${JSON.stringify(result.diagnostic)}`)
    assert.ok(result.diagnostic.line >= 1)
  }
})

test('string comparison in the real style is rejected as string work', () => {
  const source = `
    function f(code: string, x: number): number {
      return code === 'ArrowLeft' ? x - 1 : x
    }
  `
  const result = compileFunctionFromSource(source, 'f', {inputs: {x: {minimum: 0, maximum: 10}}})
  assert.ok(!result.ok)
  assert.equal(result.diagnostic.category, 'string work')
})

test('branch-narrowed ranges stay local: dedup-shared wires keep context-free ranges', () => {
  // Adversarial regression: inside the ternary branch, a is narrowed to (5, 10]; the product
  // a * b emitted there dedups with the same expression outside the branch. The hull stamped on
  // the shared wire must come from the un-narrowed ranges, or Math.max(outer, -5) folds away
  // and the circuit returns -100 where the twin returns -5.
  const trapSource = `
    function trap(a: number, b: number): number {
      const inner = a > 5 ? a * b : 0
      const outer = a * b
      const clamped = Math.max(outer, -5)
      return clamped + inner
    }
  `
  // Control: the narrowing lands on the other operand.
  const trapOtherSide = `
    function trap(a: number, b: number): number {
      const inner = b > 5 ? a * b : 0
      const outer = a * b
      const clamped = Math.max(outer, -5)
      return clamped + inner
    }
  `
  // Control: no branch, so no narrowing is involved at all.
  const straight = `
    function trap(a: number, b: number): number {
      const inner = a * b
      const outer = a * b
      const clamped = Math.max(outer, -5)
      return clamped + inner
    }
  `
  const bounds = {a: {minimum: -10, maximum: 10}, b: {minimum: 0, maximum: 10}}
  for (const source of [trapSource, trapOtherSide, straight]) {
    const result = compileOrThrow(source, 'trap', {inputs: bounds})
    verify(result, 'trap', 3000)
    // The corner the attack used: a at its minimum, b at its maximum.
    const cornerReport = runEquivalence(
      result.program,
      result.sourceFile,
      functionTrialRunner(result.declaration, 'trap'),
      {trials: 1, seed: 1, generateInputs: () => new Map([['a', -10], ['b', 10]])},
    )
    assert.deepEqual(cornerReport.mismatches, [])
  }
})

test('a branch whose float64 range is finite but overflows FP32 is rejected, not NaN-poisoned', () => {
  // fround(1e30 * 1e30) is Infinity; the masked-off side would compute fround(Infinity * 0),
  // which is NaN and would poison the select. The guard must check FP32 representability, not
  // float64 finiteness.
  const constantBranch = 'function f(a: number, b: number, c: number): number { return c > 0.5 ? a * b : 1 }'
  const wireBranch = 'function f(a: number, b: number, c: number): number { return c > 0.5 ? a * b : c }'
  for (const source of [constantBranch, wireBranch]) {
    const result = compileFunctionFromSource(source, 'f', {
      inputs: {a: {minimum: 0, maximum: 1e30}, b: {minimum: 0, maximum: 1e30}, c: {minimum: 0, maximum: 1}},
    })
    assert.ok(!result.ok, `expected rejection for: ${source}`)
    assert.equal(result.diagnostic.category, 'non-finite branch')
  }
})

test('returns propagate through blocks, constant branches, and fixed loops', () => {
  const bodies = [
    '{ return x + 1 } return x + 2',
    'if (true) { return x + 1 } return x + 2',
    'if (false) { return x + 2 } else { { return x + 1 } } return x + 3',
    'for (let index = 0; index < 3; index++) { return x + 1 } return x + 2',
    'for (const offset of [1, 2, 3]) { return x + offset } return x + 2',
  ]
  for (const body of bodies) {
    const result = compileOrThrow(`function example(x: number) { ${body} }`, 'example', {
      inputs: {x: {minimum: -10, maximum: 10}},
    })
    const report = verify(result, 'example', 20)
    assert.equal(report.sourceSemantics.outputsChecked, 20)
  }
})

test('runtime conditional expressions explicitly reject mutations in evaluated branches', () => {
  for (const expression of [
    'flag > 0 ? bump(object) : 0',
    'flag > 0 ? 0 : bump(object)',
    'flag > 0 && bump(object) > 0',
    'flag > 0 || bump(object) > 0',
    '(flag > 0 ? 5 : null) ?? bump(object)',
  ]) {
    const source = `
      function bump(object: {value: number}) { object.value += 1; return object.value }
      function example(flag: number, object: {value: number}) { return ${expression} }
    `
    const result = compileFunctionFromSource(source, 'example', {
      inputs: {flag: {minimum: 0, maximum: 1}, 'object.value': {minimum: 0, maximum: 10}},
    })
    assert.ok(!result.ok, expression)
    assert.equal(result.diagnostic.category, 'unsupported syntax')
    assert.match(result.diagnostic.construct, /mutation inside a runtime conditional expression/)
  }
  const pure = compileOrThrow(`
    function offset(value: number) { return value + 1 }
    function example(flag: number) { return flag > 0 ? offset(flag) : 0 }
  `, 'example', {inputs: {flag: {minimum: 0, maximum: 1}}})
  verify(pure, 'example', 20)
})

test('nullable equality compares presence and values, in either operand order', () => {
  for (const expression of [
    'value === 5', '5 === value', 'value !== 5', '5 !== value',
    'value === null', 'null === value', 'value !== null', 'null !== value',
    'value === other', 'value !== other', 'null === null', '5 === null',
  ]) {
    const result = compileOrThrow(`
      function example(flag: number, otherFlag: number) {
        const value = flag > 0 ? 5 : null
        const other = otherFlag > 0 ? 6 : null
        return ${expression}
      }
    `, 'example', {inputs: {
      flag: {minimum: 0, maximum: 1, integer: true},
      otherFlag: {minimum: 0, maximum: 1, integer: true},
    }})
    const report = runEquivalence(result.program, result.sourceFile, functionTrialRunner(result.declaration, 'example'), {
      trials: 4, seed: 1,
      generateInputs: trial => new Map([['flag', trial % 2], ['otherFlag', Math.floor(trial / 2)]]),
    })
    assert.deepEqual(report.mismatches, [], expression)
    assert.deepEqual(report.sourceSemantics.mismatches, [], expression)
  }
})

test('floor bounds include rounding up to the next FP32 integer', () => {
  const maximumX = 1 - 2 ** -24
  const maximumY = 2 ** -25
  const result = compileOrThrow('function example(x: number, y: number) { return Math.floor(x + y) }', 'example', {
    inputs: {x: {minimum: 0, maximum: maximumX}, y: {minimum: 0, maximum: maximumY}},
  })
  const report = runEquivalence(result.program, result.sourceFile, functionTrialRunner(result.declaration, 'example'), {
    trials: 1, seed: 1, generateInputs: () => new Map([['x', maximumX], ['y', maximumY]]),
  })
  assert.deepEqual(report.mismatches, [])
  assert.deepEqual(report.sourceSemantics.mismatches, [])
  assert.equal(report.drift.maxAbsoluteDrift, 1)
})

test('native validation detects an interpreter error even when circuit and twin agree', () => {
  const result = compileOrThrow('function example(x: number) { return x + 1 }', 'example', {
    inputs: {x: {minimum: 0, maximum: 10, integer: true}},
  })
  const runner = functionTrialRunner(result.declaration, 'example')
  const report = runEquivalence(result.program, result.sourceFile, {
    run(executor, values) {
      const outputs = runner.run(executor, values)
      if (executor instanceof Interpreter && executor.mode === 'fp64') {
        outputs.set('return', outputs.get('return')! + 1)
      }
      return outputs
    },
  }, {trials: 3, seed: 1})
  assert.deepEqual(report.mismatches, [])
  assert.equal(report.sourceSemantics.mismatchCount, 3)
  assert.equal(report.drift.maxAbsoluteDrift, 0)
})

test('native validation allows intentional FP32 drift and preserves source rounding points', () => {
  const result = compileOrThrow('function example(x: number) { return (100000000 + x) - 100000000 }', 'example', {
    inputs: {x: {minimum: 0, maximum: 2}},
  })
  const report = runEquivalence(result.program, result.sourceFile, functionTrialRunner(result.declaration, 'example'), {
    trials: 1, seed: 1, generateInputs: () => new Map([['x', 1]]),
  })
  assert.deepEqual(report.mismatches, [])
  assert.deepEqual(report.sourceSemantics.mismatches, [])
  assert.equal(report.drift.maxAbsoluteDrift, 1)
  assert.equal(result.program.opCounts.reglu, 0)
  assert.equal(result.program.opCounts.affine, 2)
})
