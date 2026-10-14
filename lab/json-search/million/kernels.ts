// Hand-written WGSL kernels for the million-document check. None of them is the repo's program: they stand in for what
// a better emitter might write from it. All of them run bit-rows.ts's automaton, a row of states as one 32-bit word,
// one invocation per document, and read the documents in a compact layout of layouts.ts.
//
// byteKernel's options, each one a row of the report's tables:
//   layout    'fixed': 128 words per document. 'packed': the documents one after the other, with a buffer of the word
//             where each document starts, and the loops run only that document's words
//   classes   'boundaries': the class of a byte from 32 comparisons, as bit-rows.ts's kernel does it. 'table': one read
//             of a table of 256 classes, which JavaScript writes per pattern
//   scope     true: the kernel also reads 2 bits per position and params.scope_mask, and a position whose bits don't
//             meet the mask gets the class that no step reads. A mask of 0 reads everything
//   output    'count': both passes, and one u32 match count per document. 'has': the reverse pass alone, and one bit per
//             document, 32 documents a word. A document has a match exactly when some position can start one, which the
//             reverse pass knows, so the forward pass, which finds where each match ends, isn't needed for that answer
import {boundaryCapacity, classCapacity} from '../search-step.ts'
import {byteAcceptingOffset, byteClassOffset, byteColumnsOffset, byteRowsOffset, positions, scopeWordsPerDocument, wordsPerDocument} from './layouts.ts'

export type ByteKernelOptions = {
  states: number
  layout: 'fixed' | 'packed'
  classes: 'boundaries' | 'table'
  scope: boolean
  output: 'count' | 'has'
  workgroupSize?: number
}

export type Kernel = {
  code: string
  workgroupSize: number
  // The bindings in the order of their numbers, for the runner.
  bindings: readonly ('params' | 'tables' | 'documents' | 'starts' | 'scopes' | 'results')[]
  // u32 values per document of `results`, or bits.
  output: 'count' | 'has'
}

// A pass runs the documents params.first to params.first + params.count - 1. params.document_base is the first document
// of the bound `documents` buffer, which is 0 unless the documents are split over several buffers, e.g. four buffers of
// 128 MiB, the size that every WebGPU device binds without being asked.
const paramsStruct = `struct Params {
  count: u32,
  first: u32,
  scope_mask: u32,
  document_base: u32,
}`

export function byteKernel(options: ByteKernelOptions): Kernel {
  const {states, layout, classes, scope, output} = options
  const workgroupSize = options.workgroupSize ?? 64
  const bindings: Kernel['bindings'][number][] = ['params', 'tables', 'documents', ...(layout === 'packed' ? ['starts' as const] : []), ...(scope ? ['scopes' as const] : []), 'results']
  const binding = (name: Kernel['bindings'][number]) => bindings.indexOf(name)
  const classOfByte = classes === 'table'
    ? [`      var class_index = tables[${byteClassOffset}u + byte];`]
    : [
      `      var class_index = ${classCapacity}u;`,
      '      if (byte != 0u) {',
      '        var region = 0u;',
      `        for (var k = 0u; k < ${boundaryCapacity}u; k++) {`,
      '          region += u32(byte >= tables[k]);',
      '        }',
      `        class_index = tables[${boundaryCapacity}u + region];`,
      '      }',
    ]
  const scopeLines = scope
    ? [
      // A scope word holds 16 positions, i.e. 4 text words.
      `      if (params.scope_mask != 0u && ((scope_word >> (((w & 3u) * 4u + b) * 2u)) & params.scope_mask) == 0u) {`,
      `        class_index = ${classCapacity}u;`,
      '      }',
    ]
    : []
  const reverseStep = [
    `      let row_base = ${byteRowsOffset}u + class_index * ${states}u;`,
    '      var word = 0u;',
    `      for (var s = 0u; s < ${states}u; s++) {`,
    '        if ((tables[row_base + s] & finish) != 0u) {',
    '          word |= (1u << s);',
    '        }',
    '      }',
  ]
  const code = [
    paramsStruct,
    `@group(0) @binding(${binding('params')}) var<uniform> params: Params;`,
    `@group(0) @binding(${binding('tables')}) var<storage, read> tables: array<u32>;`,
    `@group(0) @binding(${binding('documents')}) var<storage, read> documents: array<u32>;`,
    ...(layout === 'packed' ? [`@group(0) @binding(${binding('starts')}) var<storage, read> starts: array<u32>;`] : []),
    ...(scope ? [`@group(0) @binding(${binding('scopes')}) var<storage, read> scopes: array<u32>;`] : []),
    `@group(0) @binding(${binding('results')}) var<storage, read_write> results: array<${output === 'has' ? 'atomic<u32>' : 'u32'}>;`,
    '',
    `@compute @workgroup_size(${workgroupSize})`,
    'fn main(@builtin(global_invocation_id) id: vec3<u32>) {',
    '  if (id.x >= params.count) {',
    '    return;',
    '  }',
    '  let i: u32 = params.first + id.x;',
    `  let accepting_mask = tables[${byteAcceptingOffset(states)}u];`,
    ...(layout === 'packed'
      ? ['  let first_word = starts[i];', '  let word_count = starts[i + 1u] - first_word;']
      : [`  let first_word = (i - params.document_base) * ${wordsPerDocument}u;`, `  let word_count = ${wordsPerDocument}u;`]),
    ...(scope ? [`  let scope_base = i * ${scopeWordsPerDocument}u;`] : []),
    ...(output === 'count' ? [`  var reach: array<u32, ${positions}>;`, `  var classes: array<u32, ${positions}>;`] : ['  var any = 0u;']),
    '  var finish = accepting_mask;',
    '  for (var back = 0u; back < word_count; back++) {',
    '    let w = word_count - 1u - back;',
    '    let text_word = documents[first_word + w];',
    ...(scope ? ['    let scope_word = scopes[scope_base + (w >> 2u)];'] : []),
    '    for (var back_byte = 0u; back_byte < 4u; back_byte++) {',
    '      let b = 3u - back_byte;',
    '      let byte = (text_word >> (b * 8u)) & 255u;',
    ...classOfByte,
    ...scopeLines,
    ...reverseStep,
    ...(output === 'count' ? ['      let j = w * 4u + b;', '      classes[j] = class_index;', '      reach[j] = word;'] : ['      any |= word;']),
    '      finish = accepting_mask | word;',
    '    }',
    '  }',
    ...(output === 'count'
      ? [
        '  var reached = 0u;',
        '  var matches = 0u;',
        '  for (var j = 0u; j < word_count * 4u; j++) {',
        '    let word = reach[j];',
        '    var live = reached & word;',
        '    if (live == 0u && (word & 1u) != 0u) {',
        '      matches += 1u;',
        '      live = 1u;',
        '    }',
        `    let column_base = ${byteColumnsOffset(states)}u + classes[j] * ${states}u;`,
        '    var next = 0u;',
        `    for (var t = 0u; t < ${states}u; t++) {`,
        '      if ((tables[column_base + t] & live) != 0u) {',
        '        next |= (1u << t);',
        '      }',
        '    }',
        '    reached = next;',
        '  }',
        '  results[i] = matches;',
      ]
      : [
        // The runner clears `results` before the pass.
        '  if ((any & 1u) != 0u) {',
        '    atomicOr(&results[i >> 5u], 1u << (i & 31u));',
        '  }',
      ]),
    '}',
    '',
  ].join('\n')
  return {code, workgroupSize, bindings, output}
}

// A second pass after a 'count' kernel: one bit per document from its count, 32 documents a word, so that the readback
// is 125 KB for a million documents instead of 4 MB. Invocation w writes word w.
export function packCountsKernel(workgroupSize = 64) {
  const code = `${paramsStruct}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> counts: array<u32>;
@group(0) @binding(2) var<storage, read_write> bits: array<u32>;

@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let first = id.x * 32u;
  if (first >= params.count) {
    return;
  }
  var word = 0u;
  for (var k = 0u; k < 32u; k++) {
    if (first + k < params.count && counts[params.first + first + k] != 0u) {
      word |= (1u << k);
    }
  }
  bits[(params.first >> 5u) + id.x] = word;
}
`
  return {code, workgroupSize}
}

// Two small kernels around the JSON highlighter's own pass (json-step.ts through loop-emit.ts), which reads one f32 per
// code point and writes one f32 display kind per position. With them, the scope bits of a million documents come from
// the repo's highlighter on the GPU, a piece of the documents at a time, and only bytes are ever uploaded.
//
// unpackCellsKernel writes a piece's cells from its bytes: the code point of each byte, -1 past the text's end, and the
// text's length in the last cell. A byte of 255 becomes code point 254, which the highlighter reads like every other
// code point from 128 up. Invocation i reads document params.first + i and writes row i of `cells`.
export function unpackCellsKernel(cellsPerDocument: number, workgroupSize = 64) {
  const code = `${paramsStruct}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> documents: array<u32>;
@group(0) @binding(2) var<storage, read_write> cells: array<f32>;

@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.count) {
    return;
  }
  let first_word = (params.first + id.x) * ${wordsPerDocument}u;
  let base = id.x * ${cellsPerDocument}u;
  var length = 0u;
  for (var w = 0u; w < ${wordsPerDocument}u; w++) {
    let text_word = documents[first_word + w];
    for (var b = 0u; b < 4u; b++) {
      let byte = (text_word >> (b * 8u)) & 255u;
      cells[base + w * 4u + b] = f32(byte) - 1.0;
      length += u32(byte != 0u);
    }
  }
  cells[base + ${positions}u] = f32(length);
}
`
  return {code, workgroupSize}
}

// packKindsKernel writes a piece's scope bits from the highlighter's display kinds: 2 bits per position, bit 0 for a
// key's character and bit 1 for a string value's. Invocation i reads row i of `kinds` and writes document
// params.first + i of `scopes`.
export function packKindsKernel(keyKind: number, stringKind: number, workgroupSize = 64) {
  const code = `${paramsStruct}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> kinds: array<f32>;
@group(0) @binding(2) var<storage, read_write> scopes: array<u32>;

@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.count) {
    return;
  }
  let kind_base = id.x * ${positions}u;
  let scope_base = (params.first + id.x) * ${scopeWordsPerDocument}u;
  for (var w = 0u; w < ${scopeWordsPerDocument}u; w++) {
    var bits = 0u;
    for (var k = 0u; k < 16u; k++) {
      let kind = kinds[kind_base + w * 16u + k];
      if (kind == ${keyKind}.0) {
        bits |= (1u << (k * 2u));
      } else if (kind == ${stringKind}.0) {
        bits |= (2u << (k * 2u));
      }
    }
    scopes[scope_base + w] = bits;
  }
}
`
  return {code, workgroupSize}
}

// What a mechanical rewrite of the program's own search step (search-step.ts, as loop-emit.ts writes it) would give,
// written out by this function instead of by an emitter, for the same f32 documents of 513 cells. Every operation of
// the step is still there, one statement each, in the program's order. What changes is how a value is held:
//   level 1   a value that the builder knows to be 0 or 1 is one bit: a comparison of two whole numbers is `u32(a >= b)`
//             instead of two ReLU gates, a ReLU gate over bits is an AND, an OR or a test against 0, and the registers
//             and the fields are words of bits. A table read of a transition stays one read per pair of states, from a
//             table of one u32 per cell: transitions[class][from][to] & bit.
//   level 2   level 1, and the S reads that feed one sum become one read and one AND: the emitter packs the S cells
//             transitions[class][from][0..S-1] into one word per class and state, and the same cells by column for the
//             forward step. That needs the emitter to see that the S reads have the same index and neighboring tables,
//             and to pack the pattern's cells when they are uploaded.
// The tables are bit-rows.ts's for level 2. For level 1 they are one u32 per cell, see cellTables below. The class of a
// code point is the program's 33 comparisons and one read at either level.
export function rewriteKernel(states: number, level: 1 | 2, cellsPerDocument: number, workgroupSize = 64) {
  const rowsOffset = 2 * boundaryCapacity + 1
  // Level 1: transitions[class][from][to] at rowsOffset + (class * states + from) * states + to, then the accepting
  // states, one cell each. Class 16 has no cells: the program reads 0 past the table, and so does this kernel.
  const acceptingOffset = level === 1 ? rowsOffset + classCapacity * states * states : rowsOffset + 2 * (classCapacity + 1) * states
  const columnsOffset = rowsOffset + (classCapacity + 1) * states
  const lines: string[] = []
  const stateList = Array.from({length: states}, (_, state) => state)
  // JS: region = [codePoint >= 0] + boundaries.filter(boundary => codePoint >= boundary).length
  lines.push(
    '    let code_point = documents[base + j];',
    `    let region = u32(code_point >= 0.0)${Array.from({length: boundaryCapacity}, (_, index) => ` + u32(code_point >= f32(tables[${index}u]))`).join('')};`,
    // The program's regionClasses has a cell 0 for -1, the class that no step reads.
    `    let class_index = select(tables[${boundaryCapacity - 1}u + region], ${classCapacity}u, region == 0u);`,
  )
  if (level === 1) {
    lines.push(`    let has_class = class_index < ${classCapacity}u;`, `    let cell_base = ${rowsOffset}u + min(class_index, ${classCapacity - 1}u) * ${states * states}u;`)
    // notReach[from] = none of transitions[class][from][to] && !notFinish[to]
    for (const from of stateList) {
      lines.push(`    let hits_${from} = ${stateList.map(to => `(tables[cell_base + ${from * states + to}u] & ((finish >> ${to}u) & 1u))`).join(' | ')};`)
    }
    lines.push(`    let word = select(0u, ${stateList.map(from => `(hits_${from} << ${from}u)`).join(' | ')}, has_class);`)
  } else {
    lines.push(`    let row_base = ${rowsOffset}u + class_index * ${states}u;`)
    lines.push(`    let word = ${stateList.map(from => `(u32((tables[row_base + ${from}u] & finish) != 0u) << ${from}u)`).join(' | ')};`)
  }
  const reverse = [...lines, '    classes[j] = class_index;', '    reach[j] = word;', '    finish = accepting_mask | word;']
  const forward: string[] = [
    '    let word = reach[j];',
    '    let class_index = classes[j];',
    // JS: continues = reached & reach, start = continues === 0 && reach[0], live = continues | start
    '    let continues = reached & word;',
    '    let start = u32(continues == 0u) & (word & 1u);',
    '    let live = continues | start;',
  ]
  if (level === 1) {
    forward.push(`    let has_class = class_index < ${classCapacity}u;`, `    let cell_base = ${rowsOffset}u + min(class_index, ${classCapacity - 1}u) * ${states * states}u;`)
    for (const to of stateList) {
      forward.push(`    let next_${to} = ${stateList.map(from => `(tables[cell_base + ${from * states + to}u] & ((live >> ${from}u) & 1u))`).join(' | ')};`)
    }
    forward.push(`    reached = select(0u, ${stateList.map(to => `(next_${to} << ${to}u)`).join(' | ')}, has_class);`)
  } else {
    forward.push(`    let column_base = ${columnsOffset}u + class_index * ${states}u;`)
    forward.push(`    reached = ${stateList.map(to => `(u32((tables[column_base + ${to}u] & live) != 0u) << ${to}u)`).join(' | ')};`)
  }
  forward.push('    matches += start;')
  const code = [
    paramsStruct,
    '@group(0) @binding(0) var<uniform> params: Params;',
    '@group(0) @binding(1) var<storage, read> tables: array<u32>;',
    '@group(0) @binding(2) var<storage, read> documents: array<f32>;',
    '@group(0) @binding(3) var<storage, read_write> results: array<u32>;',
    '',
    `@compute @workgroup_size(${workgroupSize})`,
    'fn main(@builtin(global_invocation_id) id: vec3<u32>) {',
    '  if (id.x >= params.count) {',
    '    return;',
    '  }',
    '  let i: u32 = params.first + id.x;',
    level === 1
      ? `  let accepting_mask = ${stateList.map(state => `(tables[${acceptingOffset + state}u] << ${state}u)`).join(' | ')};`
      : `  let accepting_mask = tables[${acceptingOffset}u];`,
    `  var reach: array<u32, ${positions}>;`,
    `  var classes: array<u32, ${positions}>;`,
    `  let base = i * ${cellsPerDocument}u;`,
    '  var finish = accepting_mask;',
    `  for (var back = 0u; back < ${positions}u; back++) {`,
    `    let j = ${positions - 1}u - back;`,
    ...reverse,
    '  }',
    '  var reached = 0u;',
    '  var matches = 0u;',
    `  for (var j = 0u; j < ${positions}u; j++) {`,
    ...forward,
    '  }',
    '  results[i] = matches;',
    '}',
    '',
  ].join('\n')
  const bindings: Kernel['bindings'] = ['params', 'tables', 'documents', 'results']
  return {code, workgroupSize, bindings, output: 'count' as const, tableLength: level === 1 ? acceptingOffset + states : acceptingOffset + 1}
}

// Level 1's tables from bit-rows.ts's: the boundaries and the region classes as they are, then one u32 per transition
// cell, and one per accepting state.
export function cellTables(tables: Uint32Array, states: number): Uint32Array<ArrayBuffer> {
  const rowsOffset = 2 * boundaryCapacity + 1
  const bitRowAccepting = rowsOffset + 2 * (classCapacity + 1) * states
  const acceptingOffset = rowsOffset + classCapacity * states * states
  const result = new Uint32Array(acceptingOffset + states)
  result.set(tables.subarray(0, rowsOffset))
  for (let classIndex = 0; classIndex < classCapacity; classIndex++) {
    for (let from = 0; from < states; from++) {
      const row = tables[rowsOffset + classIndex * states + from]!
      for (let to = 0; to < states; to++) result[rowsOffset + (classIndex * states + from) * states + to] = (row >>> to) & 1
    }
  }
  for (let state = 0; state < states; state++) result[acceptingOffset + state] = (tables[bitRowAccepting]! >>> state) & 1
  return result
}
