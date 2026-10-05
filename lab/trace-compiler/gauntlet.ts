// The synthetic gauntlet: representative layout functions in the chenguini style, each compiled
// to a circuit and verified bit-exactly against the fround twin over seeded random inputs.
// The functions are deliberately close to the patterns in the real target file: responsive
// column count (floor + clamp), gap distribution (division by a runtime column count), clamped
// positions (min/max chains), wrap arithmetic (modulo by a runtime count), a spring step with
// settle detection, aspect-ratio sizing (ternary chain + three-way min), and a pointer hit test.

import {type CompileOptions, type CompileResult, compileFunctionFromSource} from './compile.ts'
import {
  type EquivalenceReport,
  type HarnessOptions,
  functionTrialRunner,
  relationsAccept,
  runEquivalence,
} from './harness.ts'

export type GauntletEntry = {
  name: string
  description: string
  source: string
  options?: CompileOptions
  trials: number
}

export const gauntletEntries: GauntletEntry[] = [
  {
    name: 'responsiveColumnCount',
    description: 'column count from viewport width: floor plus clamp',
    trials: 4097, // exhaustive over every integer viewport width in range, see the test
    source: `
      /** @fit
       * given max >= min
       */
      function clamp(min: number, v: number, max: number): number {
        return v > max ? max : v < min ? min : v
      }
      function responsiveColumnCount(
        containerSizeX: number, // @fit int 0..4096
      ): number {
        return clamp(1, Math.floor((containerSizeX - 24) / 244), 7)
      }
    `,
  },
  {
    name: 'gapDistribution',
    description: 'leftover width split across a runtime column count',
    trials: 5000,
    source: `
      function gapDistribution(
        containerSizeX: number, // @fit int 0..4096
        cols: number, // @fit int 1..7
      ): number {
        return Math.max(1, (containerSizeX - 24 - cols * 24) / cols)
      }
    `,
  },
  {
    name: 'clampedPanelPosition',
    description: 'panel kept inside the viewport: nested min/max chains',
    trials: 5000,
    source: `
      function clampedPanelPosition(
        panelX: number, // @fit -3000..3000
        panelY: number, // @fit -3000..3000
        panelSizeX: number, // @fit 50..1200
        panelSizeY: number, // @fit 50..1200
        viewportSizeX: number, // @fit 320..3840
        viewportSizeY: number, // @fit 320..2400
      ): {x: number, y: number} {
        const x = Math.max(8, Math.min(panelX, viewportSizeX - panelSizeX - 8))
        const y = Math.max(8, Math.min(panelY, viewportSizeY - panelSizeY - 8))
        return {x, y}
      }
    `,
  },
  {
    name: 'wrapIndex',
    description: 'cyclic photo navigation: modulo by a runtime count',
    trials: 5000,
    source: `
      /** @fit
       * given focused < count
       */
      function wrapIndex(
        focused: number, // @fit int 0..11
        direction: number, // @fit int -1..1
        count: number, // @fit int 1..12
      ): number {
        return (focused + direction + count) % count
      }
    `,
  },
  {
    name: 'springSettle',
    description: 'one spring physics step plus settle detection and snap',
    trials: 5000,
    source: `
      function springSettle(
        pos: number, // @fit -4000..4000
        dest: number, // @fit -4000..4000
        v: number, // @fit -20000..20000
      ): {pos: number, v: number, done: number} {
        const t = 4 / 1000
        const stiffness = 290
        const damping = 30
        const Fspring = -stiffness * (pos - dest)
        const Fdamper = -damping * v
        const a = Fspring + Fdamper
        const newV = v + a * t
        const newPos = pos + newV * t
        const done = Math.abs(newV) < 0.01 && Math.abs(dest - newPos) < 0.01 ? 1 : 0
        return {pos: done === 1 ? dest : newPos, v: done === 1 ? 0 : newV, done}
      }
    `,
  },
  {
    name: 'heroRowSizing',
    description: 'aspect-ratio dependent sizing: ternary chain plus three-way min',
    trials: 5000,
    source: `
      function heroRowSizing(
        naturalSizeX: number, // @fit int 1..4096
        ar: number, // @fit 0.2..5
        boxMaxSizeX: number, // @fit 1..2000
      ): number {
        const imgMaxSizeY = ar === 1 ? boxMaxSizeX * 0.85 : ar < 1 ? boxMaxSizeX * 1.05 : boxMaxSizeX
        return Math.min(naturalSizeX, boxMaxSizeX, imgMaxSizeY * ar)
      }
    `,
  },
  {
    name: 'hitTestBox',
    description: 'pointer containment bit for one box',
    trials: 5000,
    source: `
      function hitTestBox(
        pointerX: number, // @fit -4000..4000
        pointerY: number, // @fit -4000..4000
        boxX: number, // @fit -2000..2000
        boxY: number, // @fit -2000..2000
        boxSizeX: number, // @fit 0..2000
        boxSizeY: number, // @fit 0..2000
      ): number {
        return boxX <= pointerX && pointerX < boxX + boxSizeX && boxY <= pointerY && pointerY < boxY + boxSizeY ? 1 : 0
      }
    `,
  },
  {
    name: 'hoverMagnet',
    description: 'hover attraction toward the pointer, gated on a hit bit',
    trials: 5000,
    source: `
      function hoverMagnet(
        destX: number, // @fit -2000..4000
        sizeX: number, // @fit 1..2000
        pointerX: number, // @fit -4000..4000
        hit: number, // @fit int 0..1
      ): number {
        const pull = (pointerX - (destX + sizeX / 2)) / 40
        return hit === 1 ? destX + pull : destX
      }
    `,
  },
]

export type GauntletRun = {
  entry: GauntletEntry
  compiled: CompileResult & {ok: true}
  report: EquivalenceReport
}

export function runGauntlet(seed = 20260706): GauntletRun[] {
  const runs: GauntletRun[] = []
  for (const entry of gauntletEntries) {
    const compiled = compileFunctionFromSource(entry.source, entry.name, entry.options)
    if (!compiled.ok) {
      throw new Error(`gauntlet ${entry.name} failed to compile: ${JSON.stringify(compiled.diagnostic)}`)
    }
    const exhaustive = entry.name === 'responsiveColumnCount'
    const options: HarnessOptions = {trials: entry.trials, seed}
    const accept = relationsAccept(compiled.program.annotations.relations)
    if (accept !== undefined) options.acceptInputs = accept
    // responsiveColumnCount has one integer input; sweep it completely instead of sampling.
    if (exhaustive) options.generateInputs = trial => new Map([['containerSizeX', trial]])
    const report = runEquivalence(
      compiled.program,
      compiled.sourceFile,
      functionTrialRunner(compiled.declaration, entry.name),
      options,
    )
    runs.push({entry, compiled, report})
  }
  return runs
}
