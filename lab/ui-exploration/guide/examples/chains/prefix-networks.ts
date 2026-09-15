// Prefix networks compute every prefix combination items[0] ∘ items[1] ∘ ... ∘ items[i]
// of an associative combine, with a much shorter chain of combines, each reading the
// result of the one before, than a loop has. `combine(earlier, later)` must be associative:
// combine(combine(a, b), c) must equal combine(a, combine(b, c)). Nothing else is
// required, e.g. the combine doesn't need to be commutative.

// Sklansky (1960): for blocks of size 2, 4, 8, ..., combine the last prefix of the
// block's left half into every prefix of its right half. For k items (k a power of
// two) that's (k / 2) × log2(k) combines, and the longest chain of combines, each
// reading the result of the one before, is log2(k).
export function sklanskyPrefix<T>(items: readonly T[], combine: (earlier: T, later: T) => T): T[] {
  const prefixes = [...items]
  for (let halfSize = 1; halfSize < prefixes.length; halfSize *= 2) {
    for (let blockStart = 0; blockStart < prefixes.length; blockStart += 2 * halfSize) {
      const leftHalfLast = blockStart + halfSize - 1
      const blockEnd = Math.min(blockStart + 2 * halfSize, prefixes.length)
      for (let index = leftHalfLast + 1; index < blockEnd; index++) {
        prefixes[index] = combine(prefixes[leftHalfLast]!, prefixes[index]!)
      }
    }
  }
  return prefixes
}

// Brent-Kung (1982), the same up-sweep and down-sweep shape as Blelloch's (1990)
// scan: the up-sweep builds a balanced tree of combines, and the down-sweep fills in
// the prefixes the tree skipped. For k items (k a power of two, at least 4) that's
// 2k - 2 - log2(k) combines, and a longest chain of 2 × log2(k) - 2 combines.
export function brentKungPrefix<T>(items: readonly T[], combine: (earlier: T, later: T) => T): T[] {
  const prefixes = [...items]
  let span = 1
  for (; span < prefixes.length; span *= 2) {
    for (let index = 2 * span - 1; index < prefixes.length; index += 2 * span) {
      prefixes[index] = combine(prefixes[index - span]!, prefixes[index]!)
    }
  }
  for (span /= 2; span >= 1; span /= 2) {
    for (let index = 3 * span - 1; index < prefixes.length; index += 2 * span) {
      prefixes[index] = combine(prefixes[index - span]!, prefixes[index]!)
    }
  }
  return prefixes
}
