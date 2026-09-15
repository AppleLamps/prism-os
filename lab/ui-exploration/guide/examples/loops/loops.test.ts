import {describe, expect, test} from 'bun:test'
import {validateOneHotGroups} from '../../../../../numeric-ui-core.ts'
import {boxesGapX, boxMinSizeX, buildColumnLayout, columnLayoutReference, maximumColumns} from './column-count.ts'
import {buildFirstHit, firstHitReference, type FirstHitForm} from './first-hit.ts'
import {buildFirstVisibleRow, firstVisibleRowReference} from './first-visible-row.ts'
import {createRandom, measureProgram} from './kit.ts'
import {buildMoveRanks, buildRankSort, moveRanksReference, rankSortReference} from './rank-sort.ts'
import {buildRowTops, describeAdditions, rowTopsReference, type RowTopsForm} from './row-tops.ts'
import {buildWaterFill, waterFillReference} from './water-fill.ts'

describe('count instead of search', () => {
  test('the first visible row and the slot tops match the while loop at every quarter-pixel scrollTop', () => {
    const random = createRandom(1)
    const rowCount = 48
    const slotCount = 6
    const built = buildFirstVisibleRow(rowCount, slotCount)
    const heights = Array.from({length: rowCount}, () => Math.round(random() * 480) / 4)
    // Zero-height rows, e.g. collapsed rows, repeat a bottom but keep the bottoms sorted.
    heights[5] = 0
    heights[6] = 0
    const source = new Float32Array(built.circuit.sourceSize)
    heights.forEach((height, row) => {
      source[built.heights[row]!] = height
    })
    const evaluate = built.circuit.createTensorEvaluator([built.firstVisibleRow, ...built.slotTops])
    const contentHeight = heights.reduce((sum, height) => sum + height, 0)
    let mismatches = 0
    let positions = 0
    for (let quarters = 0; quarters <= (contentHeight + 40) * 4; quarters++) {
      source[built.scrollTop] = quarters / 4
      const outputs = evaluate(source)
      const expected = firstVisibleRowReference(heights, quarters / 4, slotCount)
      if (outputs[0] !== expected.firstVisibleRow) mismatches++
      for (let slot = 0; slot < slotCount; slot++) {
        if (outputs[1 + slot] !== expected.slotTops[slot]) mismatches++
      }
      if (quarters % 997 === 0) validateOneHotGroups(built.circuit, built.circuit.evaluateReference(source))
      positions++
    }
    expect(positions).toBeGreaterThan(4 * contentHeight)
    expect(mismatches).toBe(0)
    // Every slot's top is one indexed read over the shared one-hot.
    expect(measureProgram(built.circuit, built.slotTops).gatherReads).toBe(slotCount)
  })
})

describe('prefix sums three ways', () => {
  const forms: RowTopsForm[] = ['chain', 'wide', 'brent-kung']

  test('on quarter-pixel heights every form equals the sequential FP32 loop', () => {
    const random = createRandom(2)
    for (const rowCount of [1, 2, 3, 5, 8, 17, 64, 200]) {
      const heights = Float32Array.from({length: rowCount}, () => Math.round(random() * 600) / 4)
      const expected = rowTopsReference(heights)
      for (const form of forms) {
        const built = buildRowTops(rowCount, form)
        const outputs = built.circuit.createTensorEvaluator(built.rowTops)(heights)
        expect(Array.from(outputs)).toEqual(Array.from(expected))
      }
    }
  })

  test('on fractional heights the chain and the wide sums equal the loop bit for bit, and Brent-Kung rounds differently', () => {
    const random = createRandom(3)
    for (const rowCount of [5, 17, 64, 200]) {
      const heights = Float32Array.from({length: rowCount}, () => Math.fround(10 + 150 * random()))
      const expected = rowTopsReference(heights)
      for (const form of forms) {
        const built = buildRowTops(rowCount, form)
        const compiled = built.circuit.createTensorEvaluator(built.rowTops)(heights)
        const reference = built.circuit.evaluateReference(heights)
        let differing = 0
        let largestDifference = 0
        built.rowTops.forEach((wire, row) => {
          expect(compiled[row]).toBe(reference[wire]!)
          if (compiled[row] !== expected[row]) differing++
          largestDifference = Math.max(largestDifference, Math.abs(compiled[row]! - expected[row]!))
        })
        if (form === 'brent-kung') {
          if (rowCount >= 64) expect(differing).toBeGreaterThan(0)
          expect(largestDifference).toBeLessThan(0.02)
        } else {
          expect(differing).toBe(0)
        }
      }
    }
  })
})

describe('first hit when the predicate is not sorted', () => {
  test('the tournament and both prefix-count forms match the loop', () => {
    const random = createRandom(4)
    const forms: FirstHitForm[] = ['tournament', 'wide-counts', 'brent-kung-counts']
    for (const itemCount of [1, 2, 7, 64]) {
      const patterns: number[][] = [Array(itemCount).fill(0), Array(itemCount).fill(1)]
      for (let pattern = 0; pattern < 200; pattern++) {
        const density = [0.02, 0.2, 0.6][pattern % 3]!
        patterns.push(Array.from({length: itemCount}, () => random() < density ? 1 : 0))
      }
      for (const form of forms) {
        const built = buildFirstHit(itemCount, form)
        const evaluate = built.circuit.createTensorEvaluator(built.isFirstHit)
        const source = new Float32Array(built.circuit.sourceSize)
        source[built.unit] = 1
        for (const hits of patterns) {
          hits.forEach((hit, item) => {
            source[built.hits[item]!] = hit
          })
          expect(Array.from(evaluate(source))).toEqual(firstHitReference(hits))
        }
      }
    }
  })
})

describe('threshold counts instead of floor and division', () => {
  test('the column count, rows and columns match index.ts at every whole-pixel width', () => {
    const itemCount = 221
    const built = buildColumnLayout(itemCount)
    const evaluate = built.circuit.createTensorEvaluator([built.columnCount, ...built.rows, ...built.columns])
    const source = new Float32Array(1)
    let mismatches = 0
    for (let width = 0; width <= 8192; width++) {
      source[0] = width
      const outputs = evaluate(source)
      const expected = columnLayoutReference(width, itemCount)
      if (outputs[0] !== expected.columnCount) mismatches++
      for (let item = 0; item < itemCount; item++) {
        if (outputs[1 + item] !== expected.rows[item]) mismatches++
        if (outputs[1 + itemCount + item] !== expected.columns[item]) mismatches++
      }
    }
    expect(mismatches).toBe(0)
  })

  test('floor of an FP32 reciprocal gives one column too few at the widths where a new column starts', () => {
    const reciprocal = Math.fround(1 / (boxMinSizeX + boxesGapX))
    const wrongWidths: number[] = []
    for (let width = 0; width <= 8192; width++) {
      const quotient = Math.fround(Math.fround(width - boxesGapX) * reciprocal)
      const columnCount = Math.min(Math.max(1, Math.floor(quotient)), maximumColumns)
      if (columnCount !== columnLayoutReference(width, 0).columnCount) wrongWidths.push(width)
    }
    expect(wrongWidths).toEqual([512, 756, 1000, 1244, 1488, 1732])
  })
})

describe('ranks instead of sorting', () => {
  test('ranks, item tops and sorted reads match a stable sort, including equal keys', () => {
    const random = createRandom(5)
    for (const itemCount of [1, 2, 5, 16, 33]) {
      const built = buildRankSort(itemCount)
      const evaluate = built.circuit.createTensorEvaluator([...built.ranks, ...built.itemTops, ...built.sortedHeights])
      const source = new Float32Array(built.circuit.sourceSize)
      for (let trial = 0; trial < 60; trial++) {
        // Few distinct keys, so many items tie.
        const keys = Array.from({length: itemCount}, () => Math.floor(random() * 8))
        const heights = Array.from({length: itemCount}, () => Math.round(random() * 800) / 4)
        keys.forEach((key, item) => {
          source[built.keys[item]!] = key
        })
        heights.forEach((height, item) => {
          source[built.heights[item]!] = height
        })
        const outputs = Array.from(evaluate(source))
        const expected = rankSortReference(keys, heights)
        expect(outputs).toEqual([...expected.ranks, ...expected.itemTops, ...expected.sortedHeights])
        if (trial % 20 === 0) validateOneHotGroups(built.circuit, built.circuit.evaluateReference(source))
      }
    }
  })

  test('moving one item updates every rank like splice', () => {
    const random = createRandom(6)
    for (const itemCount of [1, 2, 9, 40]) {
      const built = buildMoveRanks(itemCount)
      const evaluate = built.circuit.createTensorEvaluator(built.nextRanks)
      const source = new Float32Array(built.circuit.sourceSize)
      for (let trial = 0; trial < 20; trial++) {
        const order = Array.from({length: itemCount}, (_, item) => item)
        for (let index = itemCount - 1; index > 0; index--) {
          const swap = Math.floor(random() * (index + 1))
          ;[order[index], order[swap]] = [order[swap]!, order[index]!]
        }
        const ranks = Array<number>(itemCount)
        order.forEach((item, rank) => {
          ranks[item] = rank
        })
        ranks.forEach((rank, item) => {
          source[built.ranks[item]!] = rank
        })
        for (let fromRank = 0; fromRank < itemCount; fromRank++) {
          for (let toRank = 0; toRank < itemCount; toRank++) {
            if (itemCount > 9 && random() > 0.1) continue
            source[built.fromRank] = fromRank
            source[built.toRank] = toRank
            expect(Array.from(evaluate(source))).toEqual(moveRanksReference(ranks, fromRank, toRank))
          }
        }
      }
    }
  })
})

describe('grow and shrink with min and max', () => {
  test('water filling matches a loop over the sorted breakpoints on random children, including equal breakpoints', () => {
    const random = createRandom(8)
    for (const childCount of [1, 2, 3, 5, 8]) {
      const built = buildWaterFill(childCount)
      const evaluate = built.circuit.createTensorEvaluator(built.sizes)
      const source = new Float32Array(built.circuit.sourceSize)
      let largestError = 0
      for (let trial = 0; trial < 400; trial++) {
        // Half the trials draw lows and spans from a few values, so breakpoints often coincide.
        const coarse = trial % 2 === 0
        const lows = Array.from({length: childCount}, () => coarse ? 50 * Math.floor(random() * 4) : Math.floor(random() * 300))
        const highs = lows.map(low => low + (coarse ? 50 * Math.floor(random() * 3) : Math.floor(random() * 300)))
        const highTotal = highs.reduce((sum, high) => sum + high, 0)
        const containerWidth = Math.floor(random() * (highTotal + 200))
        source[built.containerWidth] = containerWidth
        lows.forEach((low, child) => {
          source[built.lows[child]!] = low
        })
        highs.forEach((high, child) => {
          source[built.highs[child]!] = high
        })
        const sizes = evaluate(source)
        waterFillReference(lows, highs, containerWidth).forEach((size, child) => {
          largestError = Math.max(largestError, Math.abs(sizes[child]! - size))
        })
      }
      expect(largestError).toBeLessThan(1e-3)
    }
  })
})

describe('numbers quoted in the section', () => {
  test('first visible row: heights 40, 40, 0, 60, 40 at scrollTop 90', () => {
    const built = buildFirstVisibleRow(5, 2)
    const values = built.circuit.evaluateReference(Float32Array.from([90, 40, 40, 0, 60, 40]))
    expect(built.aboveViewport.map(wire => values[wire])).toEqual([1, 1, 1, 0, 0])
    expect(values[built.firstVisibleRow]).toBe(3)
    expect(built.isFirstVisible.map(wire => values[wire])).toEqual([0, 0, 0, 1, 0, 0])
    expect(built.slotTops.map(wire => values[wire])).toEqual([80, 140])
  })

  test('first hit: hits 0, 1, 0, 1, 1', () => {
    const built = buildFirstHit(5, 'wide-counts')
    const values = built.circuit.evaluateReference(Float32Array.from([0, 1, 0, 1, 1, 1]))
    expect(built.isFirstHit.map(wire => values[wire])).toEqual([0, 1, 0, 0, 0])
  })

  test('accumulation order: heights 229, 167.4, 208.5, 194.4', () => {
    const heights = Float32Array.from([229, 167.4, 208.5, 194.4])
    expect(rowTopsReference(heights)[4]).toBe(799.300048828125)
    for (const form of ['chain', 'wide'] as const) {
      const built = buildRowTops(4, form)
      expect(built.circuit.evaluateReference(heights)[built.rowTops[4]!]).toBe(799.300048828125)
    }
    const brentKung = buildRowTops(4, 'brent-kung')
    expect(brentKung.circuit.evaluateReference(heights)[brentKung.rowTops[4]!]).toBe(799.2999877929688)
  })

  test('the Brent-Kung network for 8 rows: 11 additions in 4 layers', () => {
    const additions = describeAdditions(buildRowTops(8, 'brent-kung').circuit)
    expect(additions.map(({layer, firstRow, lastRow}) => `${layer}:${firstRow}..${lastRow}`)).toEqual([
      '1:0..1', '1:2..3', '1:4..5', '1:6..7', '2:0..3', '2:4..7', '3:0..7', '3:0..5', '2:0..2', '3:0..4', '4:0..6',
    ])
  })

  test('column count: the FP32 reciprocal lands one step below a whole number, the threshold count does not', () => {
    const reciprocal = Math.fround(1 / 244)
    expect(Math.fround(Math.fround(1000 - 24) * reciprocal)).toBe(3.999999761581421)
    expect(Math.fround(Math.fround(1732 - 24) * reciprocal)).toBe(6.999999523162842)
    const built = buildColumnLayout(11)
    const values = built.circuit.evaluateReference(Float32Array.from([1000]))
    expect(values[built.columnCount]).toBe(4)
    expect(values[built.rows[10]!]).toBe(2)
    expect(values[built.columns[10]!]).toBe(2)
  })

  test('ranks: keys 30, 10, 30, 20', () => {
    const built = buildRankSort(4)
    const values = built.circuit.evaluateReference(Float32Array.from([30, 10, 30, 20, 0, 0, 0, 0]))
    expect(built.ranks.map(wire => values[wire])).toEqual([2, 0, 3, 1])
  })

  test('moving the item at rank 1 to rank 3', () => {
    const built = buildMoveRanks(4)
    const values = built.circuit.evaluateReference(Float32Array.from([0, 1, 2, 3, 1, 3]))
    expect(built.nextRanks.map(wire => values[wire])).toEqual([0, 3, 1, 2])
  })

  test('water filling: lows 50, 100, 150, highs 80, 200, 300, container 360', () => {
    const built = buildWaterFill(3)
    const values = built.circuit.evaluateReference(Float32Array.from([360, 50, 100, 150, 80, 200, 300]))
    expect(built.atLow.map(wire => values[wire])).toEqual([0, 0, 1])
    expect(built.atHigh.map(wire => values[wire])).toEqual([1, 0, 0])
    expect(values[built.level]).toBe(130)
    expect(built.sizes.map(wire => values[wire])).toEqual([80, 130, 150])
    expect(waterFillReference([50, 100, 150], [80, 200, 300], 360)).toEqual([80, 130, 150])
  })
})
