import {boundaryScenes, buildAdapter, CAPACITY, describe, heldOutScenes, repeatedLookup, synthesize, trainingScenes, verify} from './experiment.ts'

const training = trainingScenes()
const start = performance.now()
const result = synthesize(training)
const searchMilliseconds = performance.now() - start
const programs = result.fits.map(fit => {
  if (fit.programs.length === 0) throw new Error(`no solution for ${fit.task}`)
  return fit.programs[0]!
})
const tasks = result.fits.map(fit => fit.task)
const reusable = repeatedLookup(programs)
if (reusable === null || reusable.uses !== programs.length) throw new Error('expected a shared lookup across the solved tasks')
const heldOut = [...heldOutScenes(), ...boundaryScenes()]
let allFitComparisons = 0
for (const fit of result.fits) {
  for (const program of fit.programs) allFitComparisons += verify([program], [fit.task], heldOut).comparisons
}
const separateOperations = programs.reduce((sum, program) => sum + buildAdapter([program]).circuit.operations.length, 0)
const joint = verify(programs, tasks, heldOut)
const factored = verify(programs, tasks, heldOut, reusable)
const tensor = buildAdapter(programs, reusable)
const compiled = tensor.circuit.compileTensorProgram(tensor.roots)

console.log(JSON.stringify({
  capacity: CAPACITY,
  training: {scenes: training.length, activeCounts: [1, 2, 3], integerCoordinates: true},
  search: {candidates: result.candidateCount, circuitEvaluations: result.evaluations, milliseconds: searchMilliseconds},
  solutions: result.fits.map(fit => ({task: fit.task, fittingPrograms: fit.programs.length, chosen: describe(fit.programs[0]!)})),
  controls: {
    fitsWithoutActivePredicate: result.fits.reduce((count, fit) => count + fit.programs.filter(program => !program.predicates.includes('active')).length, 0),
    fitsWithoutIDPredicate: result.fits.reduce((count, fit) => count + fit.programs.filter(program => !program.predicates.includes('same-id')).length, 0),
  },
  heldOut: {scenes: heldOut.length, randomActiveCounts: [0, 4, 6, 9, 12], fractionalCoordinates: true, allFitComparisons},
  reuse: {
    predicates: reusable.predicates, calls: reusable.uses,
    definition: 'selectedField(field) = active & same-id -> read field',
    separateOperations, jointUnfactored: joint, factored,
    loweredLiveOperations: compiled.valueCount - compiled.sourceSize,
    gatherReads: compiled.layers.reduce((count, layer) => count + layer.gatherReads.length, 0),
    note: 'Joint compilation already deduplicates identical expressions; factoring makes the reusable lookup explicit, not newly discovered neural behavior.',
  },
  neuralGuide: 'Not implemented: eight small tasks and 868 candidates do not justify a neural search guide.',
}, null, 2))
