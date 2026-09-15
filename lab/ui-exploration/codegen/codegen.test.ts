import {expect, test} from 'bun:test'
import {createCandidateGalleryMachine} from './candidate-gallery-copy.ts'
import {createWindowManagerMachine} from './window-manager-copy.ts'
import {compareWithReference, compileScalarProgram, flattenProgram, sameFloat} from './codegen.ts'
import {buildRandomCircuit} from './random-circuit.ts'

test('generated JS matches the reference evaluator on every live wire of random circuits whose contracts hold, including huge finite sources', () => {
  let checked = 0
  let skippedNonFinite = 0
  let hugeChecked = 0
  let hugeSkipped = 0
  let gatherReads = 0
  for (let seed = 1; seed <= 60; seed++) {
    const {circuit, sources} = buildRandomCircuit(seed)
    const program = circuit.compileTensorProgram()
    gatherReads += program.layers.reduce((total, layer) => total + layer.gatherReads.length, 0)
    const generated = compileScalarProgram(program, {rowsPerFunction: 1 + (seed % 9)})
    // Huge finite values in the open source cell 11, with cells 4..7 moved to
    // the ends of their declared -1000..1000 range (zeros stay zeros).
    const hugeSources = sources.slice(0, 4).flatMap(source => [3e38, -3e38, 1e30, -1e30].map(huge => {
      const extreme = new Float32Array(source)
      extreme[11] = huge
      for (let cell = 4; cell < 8; cell++) extreme[cell] = source[cell]! > 0 ? 1000 : source[cell]! < 0 ? -1000 : source[cell]!
      return extreme
    }))
    for (const [index, source] of [...sources, ...hugeSources].entries()) {
      const huge = index >= sources.length
      // Products of products can still overflow to Infinity and then produce
      // NaN, which the builder's ranges don't track (see random-circuit.ts).
      // Huge sources overflow often, so they're counted separately.
      const reference = circuit.evaluateReference(source)
      if (Array.from(program.wireOrder, wire => reference[wire]!).some(value => !Number.isFinite(value))) {
        if (huge) hugeSkipped++
        else skippedNonFinite++
        continue
      }
      generated.run(source)
      const comparison = compareWithReference(circuit, program, generated.values, source)
      expect(comparison.firstMismatch).toBeNull()
      checked += comparison.checked
      if (huge) hugeChecked++
    }
  }
  expect(skippedNonFinite).toBeLessThan(60 * 16 * 0.1)
  expect(hugeChecked + hugeSkipped).toBe(60 * 16)
  expect(hugeChecked).toBeGreaterThan(300)
  expect(gatherReads).toBeGreaterThan(50)
  expect(checked).toBeGreaterThan(50_000)
})

test('generated JS stays bit-identical to the executor even when a circuit breaks its own one-hot contracts', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const {circuit, sources} = buildRandomCircuit(seed, {keepContracts: false})
    const program = circuit.compileTensorProgram()
    const generated = compileScalarProgram(program, {rowsPerFunction: 1 + (seed % 5), froundAccess: seed % 2 === 0 ? 'Math.fround' : 'closure'})
    for (const source of sources) {
      generated.run(source)
      const executor = circuit.evaluateTensor(source)
      for (let position = 0; position < program.valueCount; position++) {
        if (!sameFloat(generated.values[position]!, executor[program.wireOrder[position]!]!)) {
          throw new Error(`seed ${seed}: packed ${position} generated ${generated.values[position]} executor ${executor[program.wireOrder[position]!]}`)
        }
      }
    }
  }
})

test('generated JS matches the reference on candidate-gallery and on IndirectOS after an interaction', () => {
  const candidate = createCandidateGalleryMachine()
  candidate.step(1280, 800)
  candidate.click(400, 300)
  const candidateProgram = candidate.tensorProgram
  const candidateGenerated = compileScalarProgram(candidateProgram, {rowsPerFunction: 64})
  candidateGenerated.run(candidate.source)
  expect(compareWithReference(candidate.circuit, candidateProgram, candidateGenerated.values, candidate.source).mismatches).toBe(0)

  const machine = createWindowManagerMachine()
  machine.step(1280, 800, 16)
  machine.pointerDown(300, 70)
  machine.step(1280, 800, 32)
  machine.pointerMove(360, 110)
  machine.step(1280, 800, 48)
  machine.pointerUp(360, 110)
  machine.source[13] = 1
  machine.source[14] = 640
  machine.source[15] = 760
  const program = machine.tensorProgram
  const flat = flattenProgram(program)
  expect(flat.rowCount).toBe(5253)
  expect(flat.storedWeights).toBe(11_598)
  const generated = compileScalarProgram(program, {rowsPerFunction: 128})
  generated.run(machine.source)
  const comparison = compareWithReference(machine.circuit, program, generated.values, machine.source)
  expect(comparison.checked).toBe(program.valueCount)
  expect(comparison.mismatches).toBe(0)
})
