// Measurements for the text rows list (text-rows.ts). Run from the repo root:
//   bun lab/ui-exploration/lists/text-rows-report.ts
// It runs each variant in its own Bun process, prints one JSON line per variant, and writes the rows into results.json
// under "text-rows", keeping the other sections. One variant, in this process:
//   bun lab/ui-exploration/lists/text-rows-report.ts --variant 10000:7:resize
// A variant is capacity:breakpointCapacity:frames, where frames is scroll (random scrollTop at a fixed width) or resize
// (a new container width on every frame at a fixed scrollTop). Timings are rough: other agents share this machine.
import {installFakeCanvas} from '../hn-thread/fake-canvas.ts'
import {createRandom, measure} from './common.ts'
import {createTextRowsReference} from './text-rows-reference.ts'
import {generateMessage, prepareTextRows, textRowLayout} from './text-rows-prepare.ts'
import {buildTextRows, createTextRowsMachine, quantizeTextRowsInput, textRowsRoots} from './text-rows.ts'

function milliseconds(run: () => void) {
  const start = performance.now()
  run()
  return Math.round((performance.now() - start) * 10) / 10
}

// The median of 11 batches, each at least 10 ms long, in µs per call.
function medianMicroseconds(run: () => void) {
  let calls = 1
  for (;;) {
    const start = performance.now()
    for (let call = 0; call < calls; call++) run()
    if (performance.now() - start >= 10 || calls >= 1 << 20) break
    calls *= 2
  }
  const samples: number[] = []
  for (let batch = 0; batch < 11; batch++) {
    const start = performance.now()
    for (let call = 0; call < calls; call++) run()
    samples.push((performance.now() - start) * 1000 / calls)
  }
  samples.sort((left, right) => left - right)
  return Math.round(samples[5]! * 10) / 10
}

function runVariant(variant: string) {
  const [capacityText, breakpointText, frames] = variant.split(':')
  const capacity = Number(capacityText)
  const breakpointCapacity = Number(breakpointText)
  if (frames !== 'scroll' && frames !== 'resize') throw new Error(`frames must be scroll or resize, got ${frames}`)
  installFakeCanvas()
  const options = {capacity, slotCount: 64, breakpointCapacity}
  const texts = Array.from({length: capacity}, (_, row) => generateMessage(row))
  const prepared = prepareTextRows(texts, breakpointCapacity)
  let program: ReturnType<typeof buildTextRows> | undefined
  const buildMs = milliseconds(() => { program = buildTextRows(options) })
  let machine: ReturnType<typeof createTextRowsMachine> | undefined
  const compileMs = milliseconds(() => { machine = createTextRowsMachine(program!) })
  const roots = textRowsRoots(program!)
  const size = measure(program!.circuit, roots)
  const indexReads = program!.circuit.compileTensorProgram(roots).layers.reduce((total, layer) => total + layer.indexReads.length, 0)
  prepared.tables.forEach((rowTable, row) => machine!.writeRow(row, rowTable))

  const random = createRandom(5)
  const widths = Array.from({length: 64}, () => textRowLayout.minimumContainerWidth + Math.floor(random() * 826))
  const viewportHeight = 900
  let frame = 0
  // One frame at 800 px lays the rows out, so the scroll range is known.
  const first = machine!.step({containerWidth: 800, viewportHeight, scrollTop: 0, rowCount: capacity})
  const scrollRange = first.totalHeight - viewportHeight
  const nextInput = () => {
    frame++
    return frames === 'scroll'
      ? quantizeTextRowsInput({containerWidth: 800, viewportHeight, scrollTop: random() * scrollRange, rowCount: capacity}, capacity)
      : quantizeTextRowsInput({containerWidth: widths[frame % widths.length]!, viewportHeight, scrollTop: scrollRange / 2, rowCount: capacity}, capacity)
  }
  // createEvaluator's work per frame, as the machine calls it: check the table, evaluate, check the next values.
  const microsecondsPerFrame = medianMicroseconds(() => { machine!.step(nextInput()) })
  // Of that, checking the source table against every declaration once.
  const microsecondsTableCheck = medianMicroseconds(() => { program!.validate(machine!.source) })
  // The compiled program alone, still with its range check on every source cell.
  const evaluateRoots = program!.circuit.createTensorEvaluator(roots)
  const microsecondsTensorEvaluator = medianMicroseconds(() => {
    const frameInput = nextInput()
    machine!.source[program!.cells.containerWidth] = frameInput.containerWidth
    machine!.source[program!.cells.scrollTop] = frameInput.scrollTop
    evaluateRoots(machine!.source)
  })
  // The plain JavaScript reference: pretext's layout for every row, then loops.
  const reference = createTextRowsReference(options)
  texts.forEach((text, row) => reference.setRow(row, text))
  reference.frame({containerWidth: 800, viewportHeight, scrollTop: 0, rowCount: capacity})
  const microsecondsReference = medianMicroseconds(() => { reference.frame(nextInput()) })
  return {
    variant, capacity, breakpointCapacity, slotCount: options.slotCount, frames,
    sourceCells: program!.circuit.sourceSize,
    tableCells: capacity * (breakpointCapacity + 2),
    ...size, indexReads, buildMs, compileMs,
    prepareMs: Math.round(prepared.prepareMilliseconds),
    tabulateMs: Math.round(prepared.tabulateMilliseconds),
    clampedRows: prepared.tables.filter(rowTable => rowTable.minimumWidth > textRowLayout.minimumContainerWidth).length,
    microsecondsPerFrame, microsecondsTableCheck, microsecondsTensorEvaluator, microsecondsReference,
  }
}

const variantFlag = process.argv.indexOf('--variant')
if (variantFlag !== -1) {
  console.log(JSON.stringify(runVariant(process.argv[variantFlag + 1]!)))
} else {
  const variants = ['1000:7:scroll', '1000:7:resize', '10000:7:scroll', '10000:7:resize', '10000:3:resize', '10000:15:resize']
  const rows: unknown[] = []
  for (const variant of variants) {
    const child = Bun.spawnSync(['bun', import.meta.path, '--variant', variant], {stdout: 'pipe', stderr: 'inherit'})
    if (child.exitCode !== 0) throw new Error(`variant ${variant} exited with ${child.exitCode}`)
    const row = JSON.parse(child.stdout.toString().trim().split('\n').at(-1)!) as unknown
    console.log(JSON.stringify(row))
    rows.push(row)
  }
  const resultsFile = Bun.file(new URL('./results.json', import.meta.url))
  const previous = await resultsFile.exists() ? await resultsFile.json() as Record<string, unknown[]> : {}
  await Bun.write(resultsFile, JSON.stringify({...previous, 'text-rows': rows}, null, 2) + '\n')
}
