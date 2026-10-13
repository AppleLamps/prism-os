// What the measurement pages share: summaries of samples, the CPU and GPU sampling loops, and posting the report to the
// driver. combined-page.ts uses it; page.ts and search-page.ts were written before it and have their own copies.
export const round = (value: number) => Math.round(value * 1000) / 1000
export const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

export type Summary = {count: number, median: number, p10: number, p90: number, min: number, max: number}

export function summary(values: readonly (number | undefined)[]): Summary | undefined {
  const sorted = values.filter(value => value !== undefined).sort((left, right) => left - right)
  if (sorted.length === 0) return undefined
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!
  // The median of an even count is the mean of the two middle values.
  const middle = sorted.length >> 1
  const median = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
  return {count: sorted.length, median: round(median), p10: round(at(0.1)), p90: round(at(0.9)), min: round(sorted[0]!), max: round(sorted.at(-1)!)}
}

export type SamplingConfig = {warmupMs: number, sampleMs: number, minimumSamples: number, maximumSamples: number, cpuWarmupMs: number, cpuSampleMs: number, cpuSamples: number}

// µs per document of a JavaScript loop over `count` documents: cpuWarmupMs and at least 2 runs of warmup, then
// cpuSamples samples of whole runs, each at least cpuSampleMs, and their median.
export function timeCpu(config: SamplingConfig, run: () => void, count: number) {
  const warmUntil = performance.now() + config.cpuWarmupMs
  for (let runs = 0; runs < 2 || performance.now() < warmUntil; runs++) run()
  const samples: number[] = []
  for (let index = 0; index < config.cpuSamples; index++) {
    let runs = 0
    const started = performance.now()
    do {
      run()
      runs++
    } while (performance.now() - started < config.cpuSampleMs)
    samples.push((performance.now() - started) * 1000 / (runs * count))
  }
  return {microsecondsPerDocument: summary(samples)!.median, samples: samples.map(round)}
}

// Evaluates until at least warmupMs and 3 evaluations have passed, then samples until sampleMs and minimumSamples have
// passed, or maximumSamples. A slow evaluation, e.g. 1 s, stops at 5 samples once 4 times sampleMs have passed.
export async function sample<Sample>(config: SamplingConfig, evaluateOnce: () => Promise<Sample>) {
  const warmStarted = performance.now()
  for (let warm = 0; warm < 3 && (warm < 1 || performance.now() - warmStarted < 4 * config.sampleMs) || performance.now() - warmStarted < config.warmupMs; warm++) await evaluateOnce()
  const samples: Sample[] = []
  const started = performance.now()
  while (samples.length < config.maximumSamples) {
    const elapsed = performance.now() - started
    if (samples.length >= config.minimumSamples && elapsed >= config.sampleMs) break
    if (samples.length >= 5 && elapsed >= 4 * config.sampleMs) break
    samples.push(await evaluateOnce())
  }
  return samples
}

// The report that a page posts to the driver's /result, and a log that goes into it and onto the page.
export function createReporter() {
  // crossOriginIsolated is true when the driver's headers took effect, and performance.now() reads in steps of 5 µs.
  const report: Record<string, unknown> = {startedAt: new Date().toISOString(), userAgent: navigator.userAgent, crossOriginIsolated: globalThis.crossOriginIsolated}
  const logLines: string[] = []
  return {
    report,
    post: async (done: boolean) => {
      await fetch('/result', {method: 'POST', body: JSON.stringify({...report, logLines, done})})
    },
    log: (line: string) => {
      console.log(line)
      logLines.push(`${round(performance.now())} ms: ${line}`)
      const element = document.querySelector('#log')
      if (element !== null) element.textContent = logLines.join('\n')
    },
  }
}

// The first pipeline of a Chrome process pays for one-time setup, so a shader of one empty function compiles first.
export async function compileEmptyPipeline(device: GPUDevice, salt: number) {
  const started = performance.now()
  const module = device.createShaderModule({code: `@compute @workgroup_size(1)\nfn main() {\nlet salt: u32 = ${salt}u;\n_ = salt;\n}\n`})
  await device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint: 'main'}})
  return performance.now() - started
}
