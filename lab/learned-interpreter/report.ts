import {createCertificationCases, type TrainingTask} from './oracle.ts'
import {
  buildProgramLossMatrix,
  coordinateDescentOnLossMatrix,
  defaultDiscreteTrainingConfig,
  enumerateLossMatrix,
  hardProgramLoss,
  trainJointProgramDistribution,
  trainWithExpectedProgramLoss,
  type DiscreteTrainingConfig,
} from './discrete-training.ts'
import {buildProgram, type DecodedInstruction} from './program.ts'
import {searchProgramSpace} from './search.ts'
import {
  addOnlyTrainingConfig,
  defaultTrainingConfig,
  trainProgram,
  verifyProgram,
  type TrainingConfig,
  type VerificationResult,
} from './training.ts'

type VerifiedProgram = {
  task: TrainingTask
  instructions: DecodedInstruction[]
  verification: VerificationResult
}

type SeedResult = {
  seed: number
  program: number
  trainingLoss: number
  lossLookups?: number
  sweeps?: number
}

const cases = createCertificationCases()
const programs: VerifiedProgram[] = []

function recordProgram(task: TrainingTask, instructions: DecodedInstruction[], program: Float32Array) {
  const key = JSON.stringify({task, instructions})
  const existing = programs.findIndex(item => JSON.stringify({task: item.task, instructions: item.instructions}) === key)
  if (existing !== -1) return existing
  programs.push({task, instructions, verification: verifyProgram(program, task, cases)})
  return programs.length - 1
}

function summarize(rows: SeedResult[]) {
  let exactTraining = 0
  let exactIntegerCertification = 0
  let exactFullCertification = 0
  let tensorMismatches = 0
  for (const row of rows) {
    const verification = programs[row.program]!.verification
    if (row.trainingLoss === 0) exactTraining++
    const families = verification.mismatchesByFamily
    if (families.unseen + families.extrapolation + families.translation === 0 && verification.tensorMismatches === 0) {
      exactIntegerCertification++
    }
    if (verification.referenceMismatches === 0 && verification.tensorMismatches === 0) exactFullCertification++
    tensorMismatches += verification.tensorMismatches
  }
  return {total: rows.length, exactTraining, exactIntegerCertification, exactFullCertification, tensorMismatches}
}

function metrics(mode: 'soft' | 'hard') {
  const build = buildProgram(2, mode)
  const tensor = build.circuit.tensorProgram!
  return {
    runtimeCells: 4,
    programCells: build.layout.programCellCount,
    operations: build.circuit.operations.length,
    affine: build.circuit.operations.filter(operation => operation.kind === 'affine').length,
    reglu: build.circuit.operations.filter(operation => operation.kind === 'reglu').length,
    layers: tensor.layers.length,
    storedWeights: tensor.layers.reduce((sum, layer) => sum + layer.weights.length, 0),
    gatherReads: tensor.layers.reduce((sum, layer) => sum + layer.gatherReads.length, 0),
  }
}

const configurations = {
  original: {...defaultDiscreteTrainingConfig, adamEpsilon: 1e-8},
  corrected: defaultDiscreteTrainingConfig,
  equivalentScaling: {...defaultDiscreteTrainingConfig, adamEpsilon: 1e-8, lossMultiplier: 1e6},
} satisfies Record<string, DiscreteTrainingConfig>

function runHardStudy(task: TrainingTask, firstSeed: number, name: string) {
  const matrix = buildProgramLossMatrix(task)
  const rows = {
    original: [] as SeedResult[],
    corrected: [] as SeedResult[],
    equivalentScaling: [] as SeedResult[],
    joint: [] as SeedResult[],
    coordinateDescent: [] as SeedResult[],
  }
  let maximumProbabilityDifference = 0
  let differentHardenedPrograms = 0
  for (let seed = firstSeed; seed < firstSeed + 20; seed++) {
    const original = trainWithExpectedProgramLoss(seed, task, configurations.original)
    const corrected = trainWithExpectedProgramLoss(seed, task, configurations.corrected)
    const equivalentScaling = trainWithExpectedProgramLoss(seed, task, configurations.equivalentScaling)
    const joint = trainJointProgramDistribution(seed, task, configurations.corrected)
    const coordinateDescent = coordinateDescentOnLossMatrix(matrix, original.hardenedProgram)
    for (const [mode, run] of [
      ['original', original],
      ['corrected', corrected],
      ['equivalentScaling', equivalentScaling],
      ['joint', joint],
      ['coordinateDescent', coordinateDescent],
    ] as const) {
      rows[mode].push({
        seed,
        program: recordProgram(task, run.decodedProgram, run.hardenedProgram),
        trainingLoss: hardProgramLoss(matrix, run.hardenedProgram),
        ...('lossLookups' in run ? {lossLookups: run.lossLookups, sweeps: run.sweeps} : {}),
      })
    }
    for (let parameter = 0; parameter < corrected.softProgram.length; parameter++) {
      maximumProbabilityDifference = Math.max(
        maximumProbabilityDifference,
        Math.abs(corrected.softProgram[parameter]! - equivalentScaling.softProgram[parameter]!),
      )
    }
    if (JSON.stringify(corrected.decodedProgram) !== JSON.stringify(equivalentScaling.decodedProgram)) {
      differentHardenedPrograms++
    }
  }
  const summary = {
    original: summarize(rows.original),
    corrected: summarize(rows.corrected),
    equivalentScaling: summarize(rows.equivalentScaling),
    joint: summarize(rows.joint),
    coordinateDescent: summarize(rows.coordinateDescent),
  }
  console.log(`\n${name}: ${JSON.stringify(task)}, seeds ${firstSeed}-${firstSeed + 19}`)
  console.table(summary)
  return {
    name,
    task,
    firstSeed,
    lastSeed: firstSeed + 19,
    summary,
    epsilonScalingAgreement: {maximumProbabilityDifference, differentHardenedPrograms},
    rows,
  }
}

function runSoftStudy(task: TrainingTask, firstSeed: number, config: TrainingConfig, name: string) {
  const matrix = buildProgramLossMatrix(task)
  const rows: SeedResult[] = []
  for (let seed = firstSeed; seed < firstSeed + 20; seed++) {
    const run = trainProgram(seed, task, 'connected', config)
    rows.push({
      seed,
      program: recordProgram(task, run.decodedProgram, run.hardenedProgram),
      trainingLoss: hardProgramLoss(matrix, run.hardenedProgram),
    })
  }
  const summary = summarize(rows)
  console.log(`\n${name}: ${JSON.stringify(task)}, seeds ${firstSeed}-${firstSeed + 19}`)
  console.table(summary)
  return {name, task, firstSeed, lastSeed: firstSeed + 19, config, summary, rows}
}

const started = performance.now()
const twoAddTask = {kind: 'two-add', thirdAddend: 'distractor'} as const
const coordinateTask = {kind: 'coordinate'} as const
const hardStudies = []
const exhaustiveBaselines = []
for (const task of [twoAddTask, coordinateTask]) {
  const matrix = buildProgramLossMatrix(task)
  const enumeration = enumerateLossMatrix(matrix)
  const fullSearch = searchProgramSpace(cases, task)
  exhaustiveBaselines.push({
    task,
    matrixExamples: matrix.exampleCount,
    matrixFirstInstructionEvaluations: matrix.exampleCount * matrix.firstInstructionCount,
    matrixFinalInstructionEvaluations: matrix.exampleCount * matrix.losses.length,
    matrixStoredBytes: matrix.losses.byteLength,
    exactTrainingPrograms: matrix.exactProgramCount,
    exactFullCertificationPrograms: fullSearch.exactPrograms.length,
    lossLookups: enumeration.lossLookups,
    program: recordProgram(task, enumeration.decodedProgram, enumeration.hardenedProgram),
    trainingLoss: enumeration.loss,
  })
  hardStudies.push(runHardStudy(task, task.kind === 'two-add' ? 501 : 541, 'Original study seeds'))
  hardStudies.push(runHardStudy(task, 1001, 'Reassessment seeds'))
  hardStudies.push(runHardStudy(task, 4001, 'Fresh seeds'))
}

const softStudies = []
if (process.argv.includes('--soft')) {
  softStudies.push(runSoftStudy(coordinateTask, 101, defaultTrainingConfig, 'Original soft coordinate seeds'))
  softStudies.push(runSoftStudy(coordinateTask, 6101, defaultTrainingConfig, 'Fresh soft coordinate seeds'))
  softStudies.push(runSoftStudy(twoAddTask, 421, defaultTrainingConfig, 'Original soft two-add seeds'))
  softStudies.push(runSoftStudy(twoAddTask, 6201, defaultTrainingConfig, 'Fresh soft two-add seeds'))
  softStudies.push(runSoftStudy(twoAddTask, 441, addOnlyTrainingConfig, 'Original add-only seeds'))
  softStudies.push(runSoftStudy(twoAddTask, 6301, addOnlyTrainingConfig, 'Fresh add-only seeds'))
}

const report = {
  runtime: {bun: Bun.version, platform: process.platform, architecture: process.arch},
  trainingDomain: '14,739 small integer examples; inputs and each instruction rounded to FP32',
  certificationCases: cases.length,
  configurations,
  metrics: {soft: metrics('soft'), hard: metrics('hard')},
  exhaustiveBaselines,
  hardStudies,
  softStudies,
  programs,
  elapsedSeconds: (performance.now() - started) / 1_000,
}
console.log('\nMeasured circuit and study cost')
console.table(report.metrics)
console.table(exhaustiveBaselines)
console.log(`Elapsed: ${report.elapsedSeconds.toFixed(2)} seconds`)
if (process.argv.includes('--write')) {
  const path = new URL(process.argv.includes('--soft') ? './study-results-with-soft.json' : './study-results.json', import.meta.url)
  await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Wrote ${path.pathname}`)
}
