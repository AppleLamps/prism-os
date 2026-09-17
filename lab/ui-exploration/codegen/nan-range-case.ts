// A runtime finding: the builder's ranges don't track NaN, so gather lowering
// can skip a NaN that the reference evaluator keeps. Prints the first random
// circuit whose one-hot groups all hold, whose open-range source is Infinity,
// and whose executor result differs from the reference, then walks the NaN
// back to where it started and shows the declared ranges along the way.
// Run: bun lab/ui-exploration/codegen/nan-range-case.ts
import {validateOneHotGroups} from '../../../src/runtime/numeric-ui-core.ts'
import {sameFloat} from './codegen.ts'
import {buildRandomCircuit} from './random-circuit.ts'

let cases = 0
let printed = false
for (let seed = 1; seed <= 200; seed++) {
  const {circuit, sources} = buildRandomCircuit(seed, {keepContracts: true, allowInfiniteSource: true})
  const program = circuit.compileTensorProgram()
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const source = sources[sourceIndex]!
    const reference = circuit.evaluateReference(source)
    try {
      validateOneHotGroups(circuit, reference)
    } catch {
      continue
    }
    const executor = circuit.evaluateTensor(source)
    const differing = Array.from(program.wireOrder).find(wire => !sameFloat(executor[wire]!, reference[wire]!))
    if (differing === undefined) continue
    cases++
    if (printed) continue
    printed = true
    console.log(`seed ${seed}, source ${sourceIndex}: open source cell ${source[11]}, wire ${differing} is ${executor[differing]} in the executor and ${reference[differing]} in the reference`)
    // Walk from the differing sum to a NaN input, then down to the first NaN.
    const operationOf = (wire: number) => circuit.operations[wire - circuit.sourceSize]!
    const nanInput = (wire: number) => [...operationOf(wire).leftTerms, ...operationOf(wire).gateTerms]
      .map(([input]) => input)
      .find(input => input >= circuit.sourceSize && Number.isNaN(reference[input]!))
    let wire = differing
    for (let next = nanInput(wire); next !== undefined; next = nanInput(wire)) {
      wire = next
      const operation = operationOf(wire)
      const kind = operation.macro?.kind ?? (operation.kind === 'reglu' && operation.leftTerms.length === 0 && operation.leftBias === 1 ? 'relu' : operation.kind)
      console.log(`  wire ${wire} (${kind}) holds NaN, declared range ${circuit.ranges[wire]!.minimum}..${circuit.ranges[wire]!.maximum}`)
    }
  }
}
console.log(`${cases} source tables with valid one-hot groups where the executor and the reference differ`)
