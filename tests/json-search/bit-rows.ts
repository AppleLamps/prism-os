// The same automaton as regex search's form (a), with every row of a class's transition matrix as one 32-bit word:
// what a programmer would write by hand, in JavaScript and as a WGSL kernel. Neither is the repo's program. They are
// here as comparisons: the JavaScript loop is the plain JavaScript baseline for the automaton, and the kernel shows what
// the GPU does with this search when nothing has to be a sum, a ReLU gate or a table read of float32 values. Both read
// the pattern from one table of numbers, like form (a), so a new pattern compiles nothing.
//
// Where the program takes one table read per pair of states, `transitions[class][from][to] && bit`, i.e. S × S reads
// per pass and code point, a row here is one AND and one comparison per state:
//   reach[from] = (row[class][from] & finish) !== 0
import {type CompiledPattern, capacityErrors, codePointLimit} from '../../src/json-search/regex/pattern.ts'
import {boundaryCapacity, classCapacity} from '../../src/json-search/search-step.ts'

// The table of one pattern: the boundaries, the class of each region, then for each class and state a row word with
// bit t set when a step from that state reads the class and goes to state t, the same as a column word with bit s set
// for the steps into that state, and the accepting states as one word. Class 16 is the class of a code point that no
// step reads, with rows of 0.
export function bitRowTables(compiled: CompiledPattern, states: number) {
  const {automaton, partition} = compiled
  const errors = capacityErrors(compiled, {states, classes: classCapacity, boundaries: boundaryCapacity})
  if (errors.length > 0) throw new Error(errors.map(error => error.message).join('; '))
  if (states > 32) throw new Error('a row word holds 32 states')
  const regionsOffset = boundaryCapacity
  const rowsOffset = regionsOffset + boundaryCapacity + 1
  const columnsOffset = rowsOffset + (classCapacity + 1) * states
  const acceptingOffset = columnsOffset + (classCapacity + 1) * states
  const tables = new Uint32Array(acceptingOffset + 1)
  for (let index = 0; index < boundaryCapacity; index++) tables[index] = partition.boundaries[index] ?? codePointLimit
  for (let region = 0; region <= boundaryCapacity; region++) {
    const classIndex = partition.regionClasses[region] ?? -1
    tables[regionsOffset + region] = classIndex === -1 ? classCapacity : classIndex
  }
  partition.classReads.forEach((reads, classIndex) => {
    for (let from = 0; from < automaton.stateCount; from++) {
      for (const to of automaton.targets[from]!) {
        if (reads[to] !== true) continue
        tables[rowsOffset + classIndex * states + from]! |= 1 << to
        tables[columnsOffset + classIndex * states + to]! |= 1 << from
      }
    }
  })
  let acceptingMask = 0
  automaton.accepting.forEach((accepting, state) => {
    if (accepting) acceptingMask |= 1 << state
  })
  tables[acceptingOffset] = acceptingMask >>> 0
  return {tables, states, regionsOffset, rowsOffset, columnsOffset, acceptingOffset}
}

export type BitRowTables = ReturnType<typeof bitRowTables>

// The display kinds of one document, and which of them a search reads, for a search like search-step.ts's masked one.
export type KindMask = {kinds: ArrayLike<number>, offset: number, searchable: ArrayLike<number>}

// A plain JavaScript search over the tables: the class of every code point, the reverse pass, then the forward pass,
// over the text's first `positions` code points. It returns the number of matches, and writes each position's mark
// into `marks` when given: 0 outside a match, 1 inside one, 2 at a match's first code point. With a mask, a code point
// whose display kind isn't searchable gets the class that no step reads.
export function createBitRowSearch({tables, states, regionsOffset, rowsOffset, columnsOffset, acceptingOffset}: BitRowTables, positions: number) {
  const reach = new Uint32Array(positions)
  const classes = new Uint8Array(positions)
  const acceptingMask = tables[acceptingOffset]!
  const classOf = (codePoint: number) => {
    let region = 0
    while (region < boundaryCapacity && codePoint >= tables[region]!) region++
    return tables[regionsOffset + region]!
  }
  // Most text is ASCII, so those classes are looked up.
  const asciiClasses = Uint8Array.from({length: 128}, (_, codePoint) => classOf(codePoint))
  return (text: string, marks?: Uint8Array, marksOffset = 0, mask?: KindMask) => {
    const unitCount = text.length
    let length = 0
    for (let unit = 0; unit < unitCount && length < positions; unit++) {
      const codeUnit = text.charCodeAt(unit)
      if (mask !== undefined && mask.searchable[mask.kinds[mask.offset + length]!] !== 1) {
        // A surrogate pair is one code point, with one kind.
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && unit + 1 < unitCount && (text.charCodeAt(unit + 1) & 0xfc00) === 0xdc00) unit++
        classes[length++] = classCapacity
        continue
      }
      if (codeUnit < 128) {
        classes[length++] = asciiClasses[codeUnit]!
        continue
      }
      let codePoint = codeUnit
      // A surrogate pair is one code point.
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && unit + 1 < unitCount) {
        const low = text.charCodeAt(unit + 1)
        if (low >= 0xdc00 && low <= 0xdfff) {
          codePoint = (codeUnit - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000
          unit++
        }
      }
      classes[length++] = classOf(codePoint)
    }
    let finish = acceptingMask
    for (let position = length - 1; position >= 0; position--) {
      const rowBase = rowsOffset + classes[position]! * states
      let word = 0
      for (let from = 0; from < states; from++) if ((tables[rowBase + from]! & finish) !== 0) word |= 1 << from
      reach[position] = word
      finish = acceptingMask | word
    }
    let reached = 0
    let matches = 0
    for (let position = 0; position < length; position++) {
      const word = reach[position]!
      let live = reached & word
      let mark = live === 0 ? 0 : 1
      if (live === 0 && (word & 1) !== 0) {
        matches++
        live = 1
        mark = 2
      }
      if (marks !== undefined) marks[marksOffset + position] = mark
      const columnBase = columnsOffset + classes[position]! * states
      let next = 0
      for (let to = 0; to < states; to++) if ((tables[columnBase + to]! & live) !== 0) next |= 1 << to
      reached = next
    }
    if (marks !== undefined) marks.fill(0, marksOffset + length, marksOffset + positions)
    return matches
  }
}

// The hand-written kernel: one invocation per document, the same two loops over the document's first `positions`
// cells, with the tables above in a buffer of u32 values. It writes each document's match count as one f32 value.
export function bitRowKernel(states: number, positions: number, cellsPerDocument: number, workgroupSize = 64) {
  const rowsOffset = 2 * boundaryCapacity + 1
  const columnsOffset = rowsOffset + (classCapacity + 1) * states
  const acceptingOffset = columnsOffset + (classCapacity + 1) * states
  const code = `struct Params {
  count: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> tables: array<u32>;
@group(0) @binding(2) var<storage, read> documents: array<f32>;
@group(0) @binding(3) var<storage, read_write> counts: array<f32>;

@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i: u32 = id.x;
  if (i >= params.count) {
    return;
  }
  let accepting_mask = tables[${acceptingOffset}u];
  var reach: array<u32, ${positions}>;
  var classes: array<u32, ${positions}>;
  let base = i * ${cellsPerDocument}u;
  var finish = accepting_mask;
  for (var back = 0u; back < ${positions}u; back++) {
    let j = ${positions - 1}u - back;
    let code_point = documents[base + j];
    var class_index = ${classCapacity}u;
    if (code_point >= 0.0) {
      var region = 0u;
      for (var k = 0u; k < ${boundaryCapacity}u; k++) {
        region += u32(code_point >= f32(tables[k]));
      }
      class_index = tables[${boundaryCapacity}u + region];
    }
    classes[j] = class_index;
    let row_base = ${rowsOffset}u + class_index * ${states}u;
    var word = 0u;
    for (var s = 0u; s < ${states}u; s++) {
      if ((tables[row_base + s] & finish) != 0u) {
        word |= (1u << s);
      }
    }
    reach[j] = word;
    finish = accepting_mask | word;
  }
  var reached = 0u;
  var matches = 0u;
  for (var j = 0u; j < ${positions}u; j++) {
    let word = reach[j];
    var live = reached & word;
    if (live == 0u && (word & 1u) != 0u) {
      matches += 1u;
      live = 1u;
    }
    let column_base = ${columnsOffset}u + classes[j] * ${states}u;
    var next = 0u;
    for (var t = 0u; t < ${states}u; t++) {
      if ((tables[column_base + t] & live) != 0u) {
        next |= (1u << t);
      }
    }
    reached = next;
  }
  counts[i] = f32(matches);
}
`
  return {code, workgroupSize, bytes: code.length, tableLength: acceptingOffset + 1, cellsPerDocument}
}
