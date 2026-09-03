// Slices of Cheng's photo gallery, loaded from a frozen source fixture by default. An optional
// live-source run reads ~/github/chenglou.github.io. Both check the circuit against the FP32
// interpreter and independently validate the float64 interpreter against native JS.
// The slices are:
//
// - clamp, colsBoxMaxSizeXF, springStep, springGoToEnd, hitTest1DMode: whole functions.
// - the 2D grid layout (first sizing pass + spring destination loop): the row structure (which
//   boxes share a row, how many rows exist) depends on the runtime column count, so the block is
//   compiled once per possible column count (1..7, from the @fit annotation on
//   colsBoxMaxSizeXF's return) and the seven variants are combined through an exact one-hot on
//   the cols wire. Photo dimensions are static content, so each photo's naturalSizeX and aspect
//   ratio enter as compile-time constants — the tracing stance: run the tick against the
//   recorded data.
// - the 1D lightbox layout: compiles directly, with no specialization. The backward loop that
//   accumulates positions left of the focused photo has a runtime bound (newFocused - 1); the
//   compiler unrolls the whole static range and masks each iteration, and a masked-off
//   iteration's writes keep the old value exactly, so the unrolled circuit matches the twin's
//   native loop bit-for-bit. The keyboard rubber-band velocity is a string-decoding statement
//   (inputCode === 'ArrowLeft'), so it stays outside the slice and enters as a numeric input.
// - the occlusion culling condition: one visibility bit per photo.
// - the scroll compensation line (y.pos += adjustedScrollTop - currentScrollY).
//
// hitTest2DMode (early return from a search loop) and stepSpring (data-dependent loop bound) are
// compiled as rejection probes; their diagnostics feed the residue taxonomy.

import {readFileSync} from 'node:fs'
import {homedir} from 'node:os'
import ts from 'typescript'
import {invariant} from '../../numeric-ui-core.ts'
import {emptyFitAnnotations} from './annotations.ts'
import {
  Compilation,
  CompileReject,
  type CompiledOutput,
  type CompiledProgram,
  type Diagnostic,
  type InputSpec,
  type Num,
  type Value,
  circuitOpCounts,
  compileFunctionFromSource,
  constantNum,
  parseSource,
} from './compile.ts'
import {
  type EquivalenceReport,
  type HarnessOptions,
  type TrialRunner,
  functionTrialRunner,
  relationsAccept,
  runEquivalence,
} from './harness.ts'
import {type RuntimeArrayValue, type RuntimeValue, runtimeArray, runtimeObject} from './twin.ts'

export const realIndexPath = `${homedir()}/github/chenglou.github.io/index.ts`
export const realDataPath = `${homedir()}/github/chenglou.github.io/data.ts`

export type RealTarget = {
  sourceFile: ts.SourceFile
  photos: {naturalSizeX: number, aspectRatio: number}[]
}

export function loadRealTarget(source: 'fixture' | 'live' = 'fixture'): RealTarget {
  const indexPath = source === 'live' ? realIndexPath : new URL('./fixtures/index.ts.txt', import.meta.url)
  const dataPath = source === 'live' ? realDataPath : new URL('./fixtures/data.ts.txt', import.meta.url)
  const sourceFile = parseSource(readFileSync(indexPath, 'utf8'), 'index.ts')
  const dataFile = parseSource(readFileSync(dataPath, 'utf8'), 'data.ts')
  const photos: {naturalSizeX: number, aspectRatio: number}[] = []
  const dataArray = findSmallest(dataFile, node => ts.isArrayLiteralExpression(node), "id: '")
  invariant(dataArray !== null && ts.isArrayLiteralExpression(dataArray), 'photoGalleryData literal not found')
  for (const element of dataArray.elements) {
    invariant(ts.isObjectLiteralExpression(element), 'photo entry shape')
    let width = 0
    let height = 0
    for (const property of element.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue
      if (property.name.text === 'w') width = Number(property.initializer.getText())
      if (property.name.text === 'h') height = Number(property.initializer.getText())
    }
    invariant(width > 0 && height > 0, 'photo entry missing dimensions')
    // The real app computes ar = d.w / d.h in float64 at startup and stores it in BoxData.
    photos.push({naturalSizeX: width, aspectRatio: width / height})
  }
  return {sourceFile, photos}
}

// Finds the smallest node of a matching kind whose source text contains the marker. The real
// file has no stable statement labels, so slices locate their statements by distinctive text;
// a changed fixture or live file fails loudly rather than silently compiling something else.
function findSmallest(root: ts.Node, matches: (node: ts.Node) => boolean, marker: string): ts.Node | null {
  let best: ts.Node | null = null
  const visit = (node: ts.Node) => {
    if (matches(node) && node.getText().includes(marker)) {
      if (best === null || node.getText().length < best.getText().length) best = node
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return best
}

function findStatement(root: ts.Node, kind: (node: ts.Node) => boolean, marker: string): ts.Statement {
  const found = findSmallest(root, kind, marker)
  invariant(found !== null, `statement with marker "${marker}" not found in the real file`)
  return found as ts.Statement
}

function lineRange(sourceFile: ts.SourceFile, node: ts.Node): [number, number] {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1
  return [start, end]
}

export type SliceResult = {
  name: string
  program: CompiledProgram
  report: EquivalenceReport
  coveredLines: [number, number][]
}

export type RejectionProbe = {
  name: string
  diagnostic: Diagnostic
}

const spec = (minimum: number, maximum: number, integer = false): InputSpec => ({minimum, maximum, integer})

function objectValue(fields: Record<string, Value>): Value & {kind: 'object'} {
  return {kind: 'object', fields: new Map(Object.entries(fields))}
}

// ============================== function slices ==============================

export function compileClampSlice(target: RealTarget, trials: number, seed: number): SliceResult {
  const bounds = {minimum: -100_000, maximum: 100_000}
  const compiled = compileFunctionFromSource(target.sourceFile, 'clamp', {
    inputs: {min: bounds, v: bounds, max: bounds},
  })
  invariant(compiled.ok, 'clamp should compile')
  const options: HarnessOptions = {trials, seed}
  const accept = relationsAccept(compiled.program.annotations.relations)
  if (accept !== undefined) options.acceptInputs = accept
  const report = runEquivalence(
    compiled.program,
    target.sourceFile,
    functionTrialRunner(compiled.declaration, 'clamp'),
    options,
  )
  return {
    name: 'clamp',
    program: compiled.program,
    report,
    coveredLines: [lineRange(target.sourceFile, compiled.declaration)],
  }
}

export function compileColsBoxSlice(target: RealTarget, seed: number): SliceResult {
  // The @fit annotation says int 0..<Infinity; Math.floor needs a finite range, so compilation
  // narrows the viewport width to 0..4096 (a stand-in for the tighter annotation the file
  // would need). Verification is exhaustive over every integer width in that range.
  const compiled = compileFunctionFromSource(target.sourceFile, 'colsBoxMaxSizeXF', {
    inputs: {containerSizeX: {maximum: 4096}},
  })
  invariant(compiled.ok, `colsBoxMaxSizeXF should compile: ${JSON.stringify(compiled.ok ? null : compiled)}`)
  const report = runEquivalence(
    compiled.program,
    target.sourceFile,
    functionTrialRunner(compiled.declaration, 'colsBoxMaxSizeXF'),
    {
      trials: 4097,
      seed,
      generateInputs: trial => new Map([['containerSizeX', trial]]),
    },
  )
  return {
    name: 'colsBoxMaxSizeXF',
    program: compiled.program,
    report,
    coveredLines: [lineRange(target.sourceFile, compiled.declaration)],
  }
}

export function compileSpringStepSlice(target: RealTarget, trials: number, seed: number): SliceResult {
  // The Spring type annotates k > 0 and b > 0; position, destination, and velocity ranges are
  // stand-ins wide enough for the gallery's coordinate space.
  const compiled = compileFunctionFromSource(target.sourceFile, 'springStep', {
    inputs: {
      'config.pos': spec(-300_000, 300_000),
      'config.dest': spec(-300_000, 300_000),
      'config.v': spec(-100_000, 100_000),
      'config.k': spec(0, 600),
      'config.b': spec(0, 80),
    },
  })
  invariant(compiled.ok, 'springStep should compile')
  const report = runEquivalence(
    compiled.program,
    target.sourceFile,
    functionTrialRunner(compiled.declaration, 'springStep'),
    {trials, seed},
  )
  return {
    name: 'springStep',
    program: compiled.program,
    report,
    coveredLines: [lineRange(target.sourceFile, compiled.declaration)],
  }
}

export function compileSpringGoToEndSlice(target: RealTarget, trials: number, seed: number): SliceResult {
  const compiled = compileFunctionFromSource(target.sourceFile, 'springGoToEnd', {
    inputs: {
      'config.pos': spec(-300_000, 300_000),
      'config.dest': spec(-300_000, 300_000),
      'config.v': spec(-100_000, 100_000),
    },
  })
  invariant(compiled.ok, 'springGoToEnd should compile')
  const report = runEquivalence(
    compiled.program,
    target.sourceFile,
    functionTrialRunner(compiled.declaration, 'springGoToEnd'),
    {trials, seed},
  )
  return {
    name: 'springGoToEnd',
    program: compiled.program,
    report,
    coveredLines: [lineRange(target.sourceFile, compiled.declaration)],
  }
}

// hitTest1DMode takes the data array (only its length is used), so it compiles through the
// lower-level session with the array bound to the real photo count. The real pointer state
// initializes to -Infinity before the first mouse move; the compiled comparison needs a finite
// range, so the slice declares a finite pointer range — the residue taxonomy lists the
// non-finite sentinel separately.
export function compileHitTest1DSlice(target: RealTarget, trials: number, seed: number): SliceResult {
  const declaration = target.sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'hitTest1DMode',
  )
  invariant(declaration !== undefined, 'hitTest1DMode not found')
  const photoCount = target.photos.length
  const inputSpecs = [
    {name: 'focused', spec: spec(0, photoCount - 1, true)},
    {name: 'windowSizeX', spec: spec(320, 4096, true)},
    {name: 'pointerX', spec: spec(-4096, 4096)},
  ]
  const compilation = new Compilation(target.sourceFile, inputSpecs)
  const dataValue: Value = {
    kind: 'array',
    elements: Array.from({length: photoCount}, () => objectValue({})),
  }
  const returned = compilation.callFunction('hitTest1DMode', [
    dataValue,
    compilation.inputNum('focused'),
    compilation.inputNum('windowSizeX'),
    compilation.inputNum('pointerX'),
  ])
  invariant(returned.kind === 'nullable', 'hitTest1DMode should return a nullable number')
  const outputs: CompiledOutput[] = [
    {name: 'return.present', num: returned.present},
    {name: 'return.value', num: returned.value},
  ]
  const program: CompiledProgram = {
    circuit: compilation.circuit,
    oneWire: 0,
    inputs: compilation.inputs,
    outputs,
    comparisonSites: compilation.emitter.comparisonSites,
    annotations: emptyFitAnnotations(),
    opCounts: circuitOpCounts(compilation.circuit),
  }
  const runner: TrialRunner = {
    run: (interpreter, values) => {
      const result = interpreter.callFunction('hitTest1DMode', [
        runtimeArray(Array.from({length: photoCount}, () => runtimeObject({}))),
        values.get('focused')!,
        values.get('windowSizeX')!,
        values.get('pointerX')!,
      ])
      const outputMap = new Map<string, number | null>()
      outputMap.set('return', typeof result === 'number' ? result : null)
      return outputMap
    },
  }
  const report = runEquivalence(program, target.sourceFile, runner, {trials, seed})
  return {
    name: 'hitTest1DMode',
    program,
    report,
    coveredLines: [lineRange(target.sourceFile, declaration)],
  }
}

// ============================== block slices from render ==============================

type RenderStatements = {
  colsDestructuring: ts.Statement
  arraysDeclaration: ts.Statement
  firstPassBlock: ts.Statement
  destLoop2D: ts.Statement
  img1DSizeY: ts.Statement
  box1DMaxSizeX: ts.Statement
  currentLeftDeclaration: ts.Statement
  backwardLoop1D: ts.Statement
  mainLoop1D: ts.Statement
  occlusionCondition: ts.Expression
  scrollCompensation: ts.Statement
}

export function locateRenderStatements(target: RealTarget): RenderStatements {
  const root = target.sourceFile
  const occlusionIf = findSmallest(root, node => ts.isIfStatement(node), 'browserUIMaxSizeBottom &&')
  invariant(occlusionIf !== null && ts.isIfStatement(occlusionIf), 'occlusion if not found')
  return {
    colsDestructuring: findStatement(root, node => ts.isVariableStatement(node), 'const {cols, boxMaxSizeX} = colsBoxMaxSizeXF(newWindowSizeX)'),
    arraysDeclaration: findStatement(root, node => ts.isVariableStatement(node), 'boxes2DSizeX: number[] = []'),
    firstPassBlock: findStatement(root, node => ts.isBlock(node), 'let rowMaxSizeY = 0'),
    destLoop2D: findStatement(root, node => ts.isForStatement(node), 'd.sizeX.dest = sizeX'),
    img1DSizeY: findStatement(root, node => ts.isVariableStatement(node), 'img1DSizeY = Math.max'),
    box1DMaxSizeX: findStatement(root, node => ts.isVariableStatement(node), 'box1DMaxSizeX = Math.max'),
    currentLeftDeclaration: findStatement(root, node => ts.isVariableStatement(node), 'currentLeft = hitArea1DSizeX'),
    backwardLoop1D: findStatement(root, node => ts.isForStatement(node), 'currentLeft -='),
    mainLoop1D: findStatement(root, node => ts.isForStatement(node), 'd.x.dest = i === newFocused'),
    occlusionCondition: occlusionIf.expression,
    scrollCompensation: findStatement(root, node => ts.isForOfStatement(node), 'y.pos +='),
  }
}

// Fresh symbolic photo data for one compilation variant: dimensions as constants (static
// content), springs as empty objects the block fills with .dest writes.
function symbolicPhotoData(target: RealTarget, springFields: (index: number) => Record<string, Value>): Value & {kind: 'array'} {
  return {
    kind: 'array',
    elements: target.photos.map((photo, index) => objectValue({
      naturalSizeX: constantNum(photo.naturalSizeX),
      ar: constantNum(photo.aspectRatio),
      sizeX: objectValue({}),
      sizeY: objectValue({}),
      x: objectValue(springFields(index)),
      y: objectValue({}),
      scale: objectValue({}),
      fxFactor: objectValue({}),
    })),
  }
}

// Runtime photo data for the twin. fp32 mode rounds the aspect ratio the way the compiled
// constants are rounded; fp64 keeps the startup float64 value.
function runtimePhotoData(target: RealTarget, fp32: boolean, extraSpringFields: (index: number) => Record<string, RuntimeValue>): RuntimeArrayValue {
  return runtimeArray(target.photos.map((photo, index) => runtimeObject({
    naturalSizeX: photo.naturalSizeX,
    ar: fp32 ? Math.fround(photo.aspectRatio) : photo.aspectRatio,
    sizeX: runtimeObject({}),
    sizeY: runtimeObject({}),
    x: runtimeObject(extraSpringFields(index)),
    y: runtimeObject({}),
    scale: runtimeObject({}),
    fxFactor: runtimeObject({}),
  })))
}

function readSpringOutputs(prefix: string, element: Value, outputs: CompiledOutput[], fields: [string, string][]) {
  invariant(element.kind === 'object', 'photo element shape')
  for (const [springName, fieldName] of fields) {
    const spring = element.fields.get(springName)
    invariant(spring !== undefined && spring.kind === 'object', `missing spring ${springName}`)
    const value = spring.fields.get(fieldName)
    if (value === undefined) continue
    invariant(value.kind === 'constant' || value.kind === 'wire', 'spring field must be numeric')
    outputs.push({name: `${prefix}.${springName}.${fieldName}`, num: value})
  }
}

function readRuntimeSpringOutputs(prefix: string, element: RuntimeValue, outputMap: Map<string, number | null>, fields: [string, string][]) {
  invariant(typeof element === 'object' && element !== null && element.kind === 'object', 'photo element shape')
  for (const [springName, fieldName] of fields) {
    const spring = element.fields.get(springName)
    invariant(spring !== undefined && typeof spring === 'object' && spring !== null && spring.kind === 'object', `missing spring ${springName}`)
    const value = spring.fields.get(fieldName)
    if (value === undefined) continue
    invariant(typeof value === 'number', 'spring field must be numeric')
    outputMap.set(`${prefix}.${springName}.${fieldName}`, value)
  }
}

const destFields2D: [string, string][] = [
  ['sizeX', 'dest'], ['sizeY', 'dest'], ['x', 'dest'], ['y', 'dest'], ['scale', 'dest'], ['fxFactor', 'dest'],
]

export function compile2DLayoutSlice(target: RealTarget, trials: number, seed: number): SliceResult {
  const statements = locateRenderStatements(target)
  const variantStatements = [statements.arraysDeclaration, statements.firstPassBlock, statements.destLoop2D]
  const compilation = new Compilation(target.sourceFile, [
    {name: 'newWindowSizeX', spec: spec(320, 4096, true)},
  ])
  const emitter = compilation.emitter
  const anchorNode = statements.destLoop2D

  // The column count and box width derive from the viewport width through the compiled
  // colsBoxMaxSizeXF, so the whole slice has a single input.
  const headScope = compilation.runStatements([statements.colsDestructuring], new Map<string, Value>([
    ['newWindowSizeX', compilation.inputNum('newWindowSizeX')],
  ]))
  const colsBinding = headScope.lookup('cols')
  const boxMaxBinding = headScope.lookup('boxMaxSizeX')
  invariant(colsBinding !== null && isNumValue(colsBinding.value), 'cols should be numeric')
  invariant(boxMaxBinding !== null && isNumValue(boxMaxBinding.value), 'boxMaxSizeX should be numeric')
  const colsNum = colsBinding.value
  const boxMaxSizeXNum = boxMaxBinding.value

  // One variant per possible column count (the @fit annotation on colsBoxMaxSizeXF's return
  // declares cols in 1..7): with cols constant, the row structure (rowsTop pushes, i % cols,
  // floor(i / cols)) folds at compile time. The variants share the per-photo sizing wires
  // through the builder's expression dedup, since sizing does not depend on cols.
  type VariantOutputs = {perPhoto: CompiledOutput[][], totalHeight: Num}
  const variants: VariantOutputs[] = []
  for (let columnCount = 1; columnCount <= 7; columnCount++) {
    const dataValue = symbolicPhotoData(target, () => ({}))
    const scope = compilation.runStatements(variantStatements, new Map<string, Value>([
      ['cols', constantNum(columnCount)],
      ['boxMaxSizeX', boxMaxSizeXNum],
      ['data', dataValue],
    ]))
    const perPhoto: CompiledOutput[][] = dataValue.elements.map((element, index) => {
      const outputs: CompiledOutput[] = []
      readSpringOutputs(`box${index}`, element, outputs, destFields2D)
      return outputs
    })
    const rowsTopBinding = scope.lookup('rowsTop')
    invariant(rowsTopBinding !== null && rowsTopBinding.value.kind === 'array', 'rowsTop should be an array')
    const totalHeight = rowsTopBinding.value.elements.at(-1)!
    invariant(totalHeight.kind === 'constant' || totalHeight.kind === 'wire', 'total height must be numeric')
    variants.push({perPhoto, totalHeight})
  }

  // Exact combination: each output is the sum of the variants' values, each masked by the exact
  // one-hot bit [cols == k] on the derived cols wire. Exactly one mask is 1; multiplying by an
  // exact 1 or 0 and adding exact zeros never re-rounds.
  const colsBits = emitter.oneHot(anchorNode, colsNum, 1, 7)
  const combine = (pick: (variant: VariantOutputs) => Num): Num => {
    let sum: Num = constantNum(0)
    for (let variantIndex = 0; variantIndex < variants.length; variantIndex++) {
      const masked = emitter.multiply(anchorNode, pick(variants[variantIndex]!), colsBits[variantIndex]!)
      sum = emitter.add(anchorNode, sum, masked)
    }
    return sum
  }
  const outputs: CompiledOutput[] = []
  for (let photoIndex = 0; photoIndex < target.photos.length; photoIndex++) {
    for (let field = 0; field < destFields2D.length; field++) {
      const name = variants[0]!.perPhoto[photoIndex]![field]!.name
      outputs.push({name, num: combine(variant => variant.perPhoto[photoIndex]![field]!.num)})
    }
  }
  outputs.push({name: 'totalHeight', num: combine(variant => variant.totalHeight)})

  const program: CompiledProgram = {
    circuit: compilation.circuit,
    oneWire: 0,
    inputs: compilation.inputs,
    outputs,
    comparisonSites: emitter.comparisonSites,
    annotations: emptyFitAnnotations(),
    opCounts: circuitOpCounts(compilation.circuit),
  }
  const sliceStatements = [statements.colsDestructuring, ...variantStatements]
  const runner: TrialRunner = {
    run: (interpreter, values) => {
      const dataValue = runtimePhotoData(target, interpreter.mode === 'fp32', () => ({}))
      const scope = interpreter.runStatements(sliceStatements, new Map<string, RuntimeValue>([
        ['newWindowSizeX', values.get('newWindowSizeX')!],
        ['data', dataValue],
      ]))
      const outputMap = new Map<string, number | null>()
      dataValue.elements.forEach((element, index) => {
        readRuntimeSpringOutputs(`box${index}`, element, outputMap, destFields2D)
      })
      const rowsTop = scope.lookup('rowsTop')
      invariant(rowsTop !== null && typeof rowsTop.value === 'object' && rowsTop.value !== null && rowsTop.value.kind === 'array', 'rowsTop shape')
      const totalHeight = rowsTop.value.elements.at(-1)!
      invariant(typeof totalHeight === 'number', 'total height shape')
      outputMap.set('totalHeight', totalHeight)
      return outputMap
    },
  }
  const report = runEquivalence(program, target.sourceFile, runner, {trials, seed})
  return {
    name: '2D grid layout (per-cols specialization x7)',
    program,
    report,
    coveredLines: sliceStatements.map(statement => lineRange(target.sourceFile, statement)),
  }
}

function isNumValue(value: Value): value is Num {
  return value.kind === 'constant' || value.kind === 'wire'
}

const destFields1D: [string, string][] = [
  ['sizeX', 'dest'], ['sizeY', 'dest'], ['x', 'dest'], ['x', 'v'], ['y', 'dest'], ['scale', 'dest'], ['fxFactor', 'dest'],
]

export function compile1DLayoutSlice(target: RealTarget, trials: number, seed: number): SliceResult {
  const statements = locateRenderStatements(target)
  const sliceStatements = [
    statements.img1DSizeY,
    statements.box1DMaxSizeX,
    statements.currentLeftDeclaration,
    statements.backwardLoop1D,
    statements.mainLoop1D,
  ]
  const photoCount = target.photos.length
  const inputSpecs = [
    {name: 'newFocused', spec: spec(0, photoCount - 1, true)},
    {name: 'windowSizeY', spec: spec(240, 2400, true)},
    {name: 'newWindowSizeX', spec: spec(320, 4096, true)},
    {name: 'adjustedScrollTop', spec: spec(0, 250_000)},
    // Decoded from the keyboard event outside the slice: -2000, 0, or 2000 pixels per second.
    {name: 'edgeRubberBandVelocityX', spec: spec(-2000, 2000)},
  ]
  for (let index = 0; index < photoCount; index++) {
    inputSpecs.push({name: `box${index}.x.v`, spec: spec(-50_000, 50_000)})
  }
  const compilation = new Compilation(target.sourceFile, inputSpecs)
  const dataValue = symbolicPhotoData(target, index => ({v: compilation.inputNum(`box${index}.x.v`)}))
  compilation.runStatements(sliceStatements, new Map<string, Value>([
    ['newFocused', compilation.inputNum('newFocused')],
    ['windowSizeY', compilation.inputNum('windowSizeY')],
    ['newWindowSizeX', compilation.inputNum('newWindowSizeX')],
    ['adjustedScrollTop', compilation.inputNum('adjustedScrollTop')],
    ['edgeRubberBandVelocityX', compilation.inputNum('edgeRubberBandVelocityX')],
    ['data', dataValue],
  ]))
  const outputs: CompiledOutput[] = []
  dataValue.elements.forEach((element, index) => {
    readSpringOutputs(`box${index}`, element, outputs, destFields1D)
  })
  const program: CompiledProgram = {
    circuit: compilation.circuit,
    oneWire: 0,
    inputs: compilation.inputs,
    outputs,
    comparisonSites: compilation.emitter.comparisonSites,
    annotations: emptyFitAnnotations(),
    opCounts: circuitOpCounts(compilation.circuit),
  }
  const runner: TrialRunner = {
    run: (interpreter, values) => {
      const dataRuntime = runtimePhotoData(target, interpreter.mode === 'fp32', index => ({
        v: values.get(`box${index}.x.v`)!,
      }))
      interpreter.runStatements(sliceStatements, new Map<string, RuntimeValue>([
        ['newFocused', values.get('newFocused')!],
        ['windowSizeY', values.get('windowSizeY')!],
        ['newWindowSizeX', values.get('newWindowSizeX')!],
        ['adjustedScrollTop', values.get('adjustedScrollTop')!],
        ['edgeRubberBandVelocityX', values.get('edgeRubberBandVelocityX')!],
        ['data', dataRuntime],
      ]))
      const outputMap = new Map<string, number | null>()
      dataRuntime.elements.forEach((element, index) => {
        readRuntimeSpringOutputs(`box${index}`, element, outputMap, destFields1D)
      })
      return outputMap
    },
  }
  const report = runEquivalence(program, target.sourceFile, runner, {trials, seed})
  return {
    name: '1D lightbox layout (masked loops, no specialization)',
    program,
    report,
    coveredLines: sliceStatements.map(statement => lineRange(target.sourceFile, statement)),
  }
}

export function compileOcclusionSlice(target: RealTarget, trials: number, seed: number): SliceResult {
  const statements = locateRenderStatements(target)
  const condition = statements.occlusionCondition
  const photoCount = target.photos.length
  const inputSpecs = [
    {name: 'adjustedScrollTop', spec: spec(0, 250_000)},
    {name: 'windowSizeY', spec: spec(240, 2400, true)},
    {name: 'newWindowSizeX', spec: spec(320, 4096, true)},
  ]
  for (let index = 0; index < photoCount; index++) {
    inputSpecs.push({name: `box${index}.x.pos`, spec: spec(-100_000, 100_000)})
    inputSpecs.push({name: `box${index}.y.pos`, spec: spec(-100_000, 350_000)})
    inputSpecs.push({name: `box${index}.sizeX.pos`, spec: spec(0, 4096)})
    inputSpecs.push({name: `box${index}.sizeY.pos`, spec: spec(0, 4096)})
  }
  const compilation = new Compilation(target.sourceFile, inputSpecs)
  const outputs: CompiledOutput[] = []
  for (let index = 0; index < photoCount; index++) {
    // browserUIMaxSizeTop and browserUIMaxSizeBottom are local constants declared just above
    // the loop in render; the slice binds their literal values.
    const bit = compilation.evaluateExpression(condition, new Map<string, Value>([
      ['d', objectValue({
        x: objectValue({pos: compilation.inputNum(`box${index}.x.pos`)}),
        y: objectValue({pos: compilation.inputNum(`box${index}.y.pos`)}),
        sizeX: objectValue({pos: compilation.inputNum(`box${index}.sizeX.pos`)}),
        sizeY: objectValue({pos: compilation.inputNum(`box${index}.sizeY.pos`)}),
      })],
      ['adjustedScrollTop', compilation.inputNum('adjustedScrollTop')],
      ['windowSizeY', compilation.inputNum('windowSizeY')],
      ['newWindowSizeX', compilation.inputNum('newWindowSizeX')],
      ['browserUIMaxSizeTop', constantNum(100)],
      ['browserUIMaxSizeBottom', constantNum(150)],
    ]))
    invariant(bit.kind === 'constant' || bit.kind === 'wire', 'visibility bit must be numeric')
    outputs.push({name: `box${index}.visible`, num: bit})
  }
  const program: CompiledProgram = {
    circuit: compilation.circuit,
    oneWire: 0,
    inputs: compilation.inputs,
    outputs,
    comparisonSites: compilation.emitter.comparisonSites,
    annotations: emptyFitAnnotations(),
    opCounts: circuitOpCounts(compilation.circuit),
  }
  const runner: TrialRunner = {
    run: (interpreter, values) => {
      const outputMap = new Map<string, number | null>()
      for (let index = 0; index < photoCount; index++) {
        const visible = interpreter.evaluateExpression(condition, new Map<string, RuntimeValue>([
          ['d', runtimeObject({
            x: runtimeObject({pos: values.get(`box${index}.x.pos`)!}),
            y: runtimeObject({pos: values.get(`box${index}.y.pos`)!}),
            sizeX: runtimeObject({pos: values.get(`box${index}.sizeX.pos`)!}),
            sizeY: runtimeObject({pos: values.get(`box${index}.sizeY.pos`)!}),
          })],
          ['adjustedScrollTop', values.get('adjustedScrollTop')!],
          ['windowSizeY', values.get('windowSizeY')!],
          ['newWindowSizeX', values.get('newWindowSizeX')!],
          ['browserUIMaxSizeTop', 100],
          ['browserUIMaxSizeBottom', 150],
        ]))
        outputMap.set(`box${index}.visible`, visible === true ? 1 : visible === false ? 0 : null)
      }
      return outputMap
    },
  }
  const report = runEquivalence(program, target.sourceFile, runner, {trials, seed})
  return {
    name: 'occlusion culling bits (one per photo)',
    program,
    report,
    coveredLines: [lineRange(target.sourceFile, condition)],
  }
}

export function compileScrollCompensationSlice(target: RealTarget, trials: number, seed: number): SliceResult {
  const statements = locateRenderStatements(target)
  const photoCount = target.photos.length
  const inputSpecs = [
    {name: 'adjustedScrollTop', spec: spec(0, 250_000)},
    {name: 'currentScrollY', spec: spec(0, 250_000)},
  ]
  for (let index = 0; index < photoCount; index++) {
    inputSpecs.push({name: `box${index}.y.pos`, spec: spec(-100_000, 350_000)})
  }
  const compilation = new Compilation(target.sourceFile, inputSpecs)
  const dataValue: Value & {kind: 'array'} = {
    kind: 'array',
    elements: Array.from({length: photoCount}, (_, index) => objectValue({
      y: objectValue({pos: compilation.inputNum(`box${index}.y.pos`)}),
    })),
  }
  compilation.runStatements([statements.scrollCompensation], new Map<string, Value>([
    ['data', dataValue],
    ['adjustedScrollTop', compilation.inputNum('adjustedScrollTop')],
    ['currentScrollY', compilation.inputNum('currentScrollY')],
  ]))
  const outputs: CompiledOutput[] = []
  dataValue.elements.forEach((element, index) => {
    readSpringOutputs(`box${index}`, element, outputs, [['y', 'pos']])
  })
  const program: CompiledProgram = {
    circuit: compilation.circuit,
    oneWire: 0,
    inputs: compilation.inputs,
    outputs,
    comparisonSites: compilation.emitter.comparisonSites,
    annotations: emptyFitAnnotations(),
    opCounts: circuitOpCounts(compilation.circuit),
  }
  const runner: TrialRunner = {
    run: (interpreter, values) => {
      const dataRuntime = runtimeArray(Array.from({length: photoCount}, (_, index) => runtimeObject({
        y: runtimeObject({pos: values.get(`box${index}.y.pos`)!}),
      })))
      interpreter.runStatements([statements.scrollCompensation], new Map<string, RuntimeValue>([
        ['data', dataRuntime],
        ['adjustedScrollTop', values.get('adjustedScrollTop')!],
        ['currentScrollY', values.get('currentScrollY')!],
      ]))
      const outputMap = new Map<string, number | null>()
      dataRuntime.elements.forEach((element, index) => {
        readRuntimeSpringOutputs(`box${index}`, element, outputMap, [['y', 'pos']])
      })
      return outputMap
    },
  }
  const report = runEquivalence(program, target.sourceFile, runner, {trials, seed})
  return {
    name: 'scroll compensation (y.pos writes)',
    program,
    report,
    coveredLines: [lineRange(target.sourceFile, statements.scrollCompensation)],
  }
}

// ============================== rejection probes ==============================

export function probeRejections(target: RealTarget): RejectionProbe[] {
  const probes: RejectionProbe[] = []
  const photoCount = target.photos.length

  // hitTest2DMode: a search loop with an early return (first match wins).
  {
    const compilation = new Compilation(target.sourceFile, [
      {name: 'pointerX', spec: spec(-4096, 4096)},
      {name: 'pointerY', spec: spec(-4096, 350_000)},
    ])
    const dataValue: Value = {
      kind: 'array',
      elements: Array.from({length: photoCount}, () => objectValue({
        x: objectValue({dest: constantNum(0)}),
        y: objectValue({dest: constantNum(0)}),
        sizeX: objectValue({dest: constantNum(100)}),
        sizeY: objectValue({dest: constantNum(100)}),
      })),
    }
    try {
      compilation.callFunction('hitTest2DMode', [
        dataValue,
        compilation.inputNum('pointerX'),
        compilation.inputNum('pointerY'),
      ])
      invariant(false, 'hitTest2DMode unexpectedly compiled')
    } catch (error) {
      invariant(error instanceof CompileReject, 'expected a compile rejection')
      probes.push({name: 'hitTest2DMode', diagnostic: error.diagnostic})
    }
  }

  // stepSpring: loop bound is the runtime step count (annotated int 0..Infinity — unbounded).
  {
    const compilation = new Compilation(target.sourceFile, [
      {name: 's.pos', spec: spec(-300_000, 300_000)},
      {name: 's.dest', spec: spec(-300_000, 300_000)},
      {name: 's.v', spec: spec(-100_000, 100_000)},
      {name: 's.k', spec: spec(0, 600)},
      {name: 's.b', spec: spec(0, 80)},
      {name: 'steps', spec: {minimum: 0, maximum: Number.POSITIVE_INFINITY, integer: true}},
    ])
    const springValue = objectValue({
      pos: compilation.inputNum('s.pos'),
      dest: compilation.inputNum('s.dest'),
      v: compilation.inputNum('s.v'),
      k: compilation.inputNum('s.k'),
      b: compilation.inputNum('s.b'),
    })
    try {
      compilation.callFunction('stepSpring', [springValue, compilation.inputNum('steps')])
      invariant(false, 'stepSpring unexpectedly compiled')
    } catch (error) {
      invariant(error instanceof CompileReject, 'expected a compile rejection')
      probes.push({name: 'stepSpring', diagnostic: error.diagnostic})
    }
  }

  return probes
}

// ============================== orchestration ==============================

export type RealSliceRun = {
  slices: SliceResult[]
  probes: RejectionProbe[]
}

export function runRealSlices(seed = 20260706, source: 'fixture' | 'live' = 'fixture'): RealSliceRun {
  const target = loadRealTarget(source)
  const slices = [
    compileClampSlice(target, 5000, seed),
    compileColsBoxSlice(target, seed),
    compileSpringStepSlice(target, 5000, seed),
    compileSpringGoToEndSlice(target, 2000, seed),
    compileHitTest1DSlice(target, 5000, seed),
    compile2DLayoutSlice(target, 300, seed),
    compile1DLayoutSlice(target, 300, seed),
    compileOcclusionSlice(target, 500, seed),
    compileScrollCompensationSlice(target, 500, seed),
  ]
  return {slices, probes: probeRejections(target)}
}
