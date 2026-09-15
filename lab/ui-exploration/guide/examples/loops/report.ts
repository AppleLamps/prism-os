// Prints the compiled sizes and precision numbers that the loops section quotes.
// From the repo root:
//   bun lab/ui-exploration/guide/examples/loops/report.ts [first-visible-row] [row-tops] [network] [precision] [first-hit] [columns] [ranks] [water-fill]
// Row tops are measured without rowTops[0], the constant 0, so a chain over n heights is n - 1 additions.
import {buildColumnLayout} from './column-count.ts'
import {buildFirstHit, type FirstHitForm} from './first-hit.ts'
import {buildFirstVisibleRow} from './first-visible-row.ts'
import {createRandom, measureProgram, type ProgramSize} from './kit.ts'
import {buildMoveRanks, buildRankSort} from './rank-sort.ts'
import {buildRowTops, describeAdditions, rowTopsReference, type RowTopsForm} from './row-tops.ts'
import {buildWaterFill} from './water-fill.ts'

const requested = new Set(process.argv.slice(2))
const wants = (name: string) => requested.size === 0 || requested.has(name)

function print(label: string, size: ProgramSize) {
  console.log(`${label}: ${size.liveOperations} operations, ${size.layers} layers, ${size.storedWeights} stored weights, ${size.gatherReads} gather reads`)
}

if (wants('first-visible-row')) {
  for (const rowCount of [1_000, 10_000]) {
    const built = buildFirstVisibleRow(rowCount, 24)
    print(`first visible row, ${rowCount} rows: row tops (Brent-Kung)`, measureProgram(built.circuit, built.rowTops.slice(1)))
    print(`first visible row, ${rowCount} rows: row tops and the count`, measureProgram(built.circuit, [built.firstVisibleRow]))
    print(`first visible row, ${rowCount} rows: row tops, count, one-hot and 24 slot tops`, measureProgram(built.circuit, [built.firstVisibleRow, ...built.slotTops]))
  }
}

if (wants('row-tops')) {
  const forms: RowTopsForm[] = ['chain', 'wide', 'brent-kung']
  for (const rowCount of [8, 64, 256, 1024]) {
    for (const form of forms) {
      const built = buildRowTops(rowCount, form)
      print(`row tops, ${rowCount} rows, ${form}`, measureProgram(built.circuit, built.rowTops.slice(1)))
    }
  }
}

if (wants('network')) {
  const additions = describeAdditions(buildRowTops(8, 'brent-kung').circuit)
  const range = ([first, last]: [number, number]) => first === last ? `h${first}` : `h${first}..h${last}`
  for (let layer = 1; layer <= Math.max(...additions.map(addition => addition.layer)); layer++) {
    const sums = additions
      .filter(addition => addition.layer === layer)
      .map(addition => `${addition.operands.map(range).join(' + ')} = h${addition.firstRow}..h${addition.lastRow}`)
    console.log(`Brent-Kung network, 8 rows, layer ${layer}: ${sums.join(', ')}`)
  }
}

if (wants('precision')) {
  const random = createRandom(7)
  for (const rowCount of [1_000, 10_000]) {
    const heights = Float32Array.from({length: rowCount}, () => Math.fround(20 + 280 * random()))
    // float64 holds these sums exactly: every height is a multiple of 2^-19 and totals stay below 2^22.
    const exactTops = [0]
    for (let row = 0; row < rowCount; row++) exactTops.push(exactTops[row]! + heights[row]!)
    const sequentialTops = rowTopsReference(heights)
    const brentKung = buildRowTops(rowCount, 'brent-kung')
    const brentKungValues = brentKung.circuit.evaluateReference(heights)
    let sequentialError = 0
    let brentKungError = 0
    let differing = 0
    for (let row = 0; row <= rowCount; row++) {
      const brentKungTop = brentKungValues[brentKung.rowTops[row]!]!
      sequentialError = Math.max(sequentialError, Math.abs(sequentialTops[row]! - exactTops[row]!))
      brentKungError = Math.max(brentKungError, Math.abs(brentKungTop - exactTops[row]!))
      if (brentKungTop !== sequentialTops[row]) differing++
    }
    console.log(`precision, ${rowCount} fractional heights in 20..300 px, content height ${Math.round(exactTops[rowCount]!)} px: sequential loop off by at most ${sequentialError.toFixed(4)} px, Brent-Kung by at most ${brentKungError.toFixed(4)} px, ${differing} of ${rowCount + 1} tops differ between the two`)
  }
}

if (wants('first-hit')) {
  const forms: FirstHitForm[] = ['tournament', 'wide-counts', 'brent-kung-counts']
  for (const itemCount of [16, 64, 256, 1024]) {
    for (const form of forms) {
      const built = buildFirstHit(itemCount, form)
      print(`first hit, ${itemCount} items, ${form}`, measureProgram(built.circuit, built.isFirstHit))
    }
  }
}

if (wants('columns')) {
  for (const itemCount of [221, 10_000]) {
    const built = buildColumnLayout(itemCount)
    print(`column count only`, measureProgram(built.circuit, [built.columnCount]))
    print(`column count, rows and columns of ${itemCount} items`, measureProgram(built.circuit, [built.columnCount, ...built.rows, ...built.columns]))
  }
}

if (wants('ranks')) {
  for (const itemCount of [16, 64, 128]) {
    const built = buildRankSort(itemCount)
    print(`rank sort, ${itemCount} items: ranks`, measureProgram(built.circuit, built.ranks))
    print(`rank sort, ${itemCount} items: item tops`, measureProgram(built.circuit, built.itemTops))
    print(`rank sort, ${itemCount} items: heights at each sorted position`, measureProgram(built.circuit, built.sortedHeights))
  }
  for (const itemCount of [16, 64, 256, 1024]) {
    const built = buildMoveRanks(itemCount)
    print(`move one item, ${itemCount} items: next ranks`, measureProgram(built.circuit, built.nextRanks))
  }
}

if (wants('water-fill')) {
  for (const childCount of [2, 8, 16, 64]) {
    const built = buildWaterFill(childCount)
    print(`water filling, ${childCount} children, lows and highs in source cells`, measureProgram(built.circuit, built.sizes))
  }
}
