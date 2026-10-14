### Memory per layout and document count

From the `program` and `load` runs, load average 2.9 to 6.0. The page's thread holds the documents' texts in every row. A process's memory is its footprint, which counts the GPU buffers that the process owns, with the resident size from `ps` in parentheses.

| Layout | Documents | Documents on the GPU | Display kinds or scope bits | Results | GPU buffers in all | JavaScript memory | Chrome's GPU process | The page's renderer process | The run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| today's: one f32 per code point, and one f32 per display kind | 100,000 | 205 MB | 205 MB | 2 MB | 412 MB |  |  |  | not run |
| today's: one f32 per code point, and one f32 per display kind | 250,000 | 513 MB | 512 MB | 5 MB | 1.03 GB |  |  |  | not run |
| today's: one f32 per code point, and one f32 per display kind | 500,000 | 1.03 GB | 1.02 GB | 10 MB | 2.06 GB |  |  |  | not run |
| today's: one f32 per code point, and one f32 per display kind | 1,000,000 | 2.05 GB | 2.05 GB | 20 MB | 4.12 GB | 358 MB | 6.26 GB (2.24 GB) | 2.48 GB (2.61 GB) | ran |
| 512 bytes per document, and 2 scope bits per position | 100,000 | 51 MB | 13 MB | 400 KB | 64 MB | 35 MB | 213 MB (212 MB) | 303 MB (444 MB) | ran |
| 512 bytes per document, and 2 scope bits per position | 250,000 |  |  |  | 0 KB |  |  |  | not run |
| 512 bytes per document, and 2 scope bits per position | 500,000 |  |  |  | 0 KB |  |  |  | not run |
| 512 bytes per document, and 2 scope bits per position | 1,000,000 | 512 MB | 128 MB | 4 MB | 644 MB | 341 MB | 850 MB (283 MB) | 614 MB (781 MB) | ran |
| packed bytes with a start per document, and 2 scope bits per position | 100,000 |  |  |  | 0 KB |  |  |  | not run |
| packed bytes with a start per document, and 2 scope bits per position | 250,000 |  |  |  | 0 KB |  |  |  | not run |
| packed bytes with a start per document, and 2 scope bits per position | 500,000 |  |  |  | 0 KB |  |  |  | not run |
| packed bytes with a start per document, and 2 scope bits per position | 1,000,000 | 305 MB | 128 MB | 4 MB | 437 MB | 341 MB | 1.12 GB (247 MB) | 575 MB (747 MB) | ran |

- Without the texts in the page, 1,000,000 documents in the fixed layout: JavaScript 5 MB, GPU process 851 MB (286 MB), renderer 174 MB (355 MB).
- With the device that every browser gives without being asked, limits {"maxStorageBufferBindingSize":134217728,"maxBufferSize":268435456,"maxStorageBuffersPerShaderStage":8}: 1,000,000 documents in buffers of [128000000,128000000,128000000,128000000] bytes, 105133 documents with a match for `error`, the search in 33.595 ms. It ran.

### The device limits that each layout needs

A device binds 134,217,728 bytes per storage buffer and creates buffers of up to 268,435,456 bytes unless the page asks for more. A cell is the largest buffer of the layout at that count, and what it needs when the documents are in one buffer. The adapter of these runs, Apple M5 Max, allows 4,294,967,292 bytes per binding and per buffer.

| Buffer | 100,000 | 250,000 | 500,000 | 1,000,000 | Documents per binding of 128 MiB |
| --- | --- | --- | --- | --- | --- |
| today's: one f32 per code point, 2,052 bytes per document, and as much again for the display kinds | 205 MB: a larger binding, or 2 buffers | 513 MB: a larger binding and buffer, or 4 buffers | 1.03 GB: a larger binding and buffer, or 8 buffers | 2.05 GB: a larger binding and buffer, or 16 buffers | 65,408 |
| 512 bytes per document | 51 MB, within the defaults | 128 MB, within the defaults | 256 MB: a larger binding, or 2 buffers | 512 MB: a larger binding and buffer, or 4 buffers | 262,144 |
| packed bytes, 301 per document on average | 30 MB, within the defaults | 75 MB, within the defaults | 150 MB: a larger binding, or 2 buffers | 301 MB: a larger binding and buffer, or 3 buffers | 446,350 |
| 2 scope bits per position, 128 bytes per document | 13 MB, within the defaults | 32 MB, within the defaults | 64 MB, within the defaults | 128 MB, within the defaults | 1,048,576 |
| one match count per document, 4 bytes | 400 KB, within the defaults | 1 MB, within the defaults | 2 MB, within the defaults | 4 MB, within the defaults | 33,554,432 |

### The load, from the navigation, in ms

From the `load` runs: 8 workers write the documents in pieces of 25,000, with their bytes and their scope bits, the page uploads each piece, searches the first piece when it is there, and every document after the last one. One run each, load average 2.9 to 5.1.

| Layout | Documents | The page's script starts | The kernel is compiled | The first piece arrives | The first piece's answer | The last piece arrives | Every piece uploaded | Every document searched | The workers' time, summed: writing the texts, the bytes, the scope bits | The page's writeBuffer calls | Load average |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fixed | 100,000 | 69 | 141 | 257 | 274 | 261 | 280 | 293 | 439, 41, 220 | 8 | 5.11 |
| fixed | 1,000,000 | 57 | 207 | 236 | 271 | 855 | 873 | 900 | 3663, 394, 2153 | 78 | 3.64 |
| packed | 1,000,000 | 62 | 223 | 257 | 288 | 925 | 933 | 978 | 3916, 477, 2317 | 68 | 3.73 |

The scope bits from the JSON highlighter's own pass on the GPU instead, from the `scopes` runs, load average 4.5 to 5.9. One time is every piece: unpack its bytes, run the highlighter, read back its summary, pack its kinds.

| Documents | Pieces | The first time, ms | Back to back, ms | After a pause of 1 s, ms | Compile ms: the highlighter, the unpacking kernel, the packing kernel | The same in plain JavaScript on one thread, ms: the table loop, and packing the bits | Scope words compared with the table loop's, and how many differ | Load average |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1,000,000 | 20 of 50,000 | 83.3 | 46.6 (46.4 to 47.5) | 57.4 (52.5 to 62.4) | 40.12, 16.725, 15.26 | 1214 and 496 | 32,000,000, 0 | 5.14 |

### One search of 1,000,000 documents with a hand-written kernel, ms, the first run

From `compact-1000000`, load average 3.6 to 6.1.  One search runs from before JavaScript compiles the pattern until the results are in a JavaScript array. Back to back is at least 15 searches that follow each other, and after a pause is 9 searches. Consecutive searches use different patterns, the ones that fit the state capacity in turn.

| What runs on the GPU | The search reads | 8 states: back to back | after a pause of 200 ms | 16 states: back to back | after a pause of 200 ms | 32 states: back to back | after a pause of 200 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 28.1 (27.8 to 28.9) | 36.9 (36.8 to 37.0) | 29.8 (29.5 to 30.7) | 39.0 (38.7 to 39.4) | 40.5 (40.1 to 41.7) | 50.1 (49.9 to 51.7) |
| the same kernel on 512 bytes per document | everything | 23.1 (23.1 to 23.8) | 32.9 (32.8 to 33.0) | 28.2 (28.1 to 28.5) | 38.2 (38.0 to 42.8) | 40.0 (39.6 to 40.9) | 49.5 (40.2 to 50.4) |
| with the class of a byte from one table read | everything | 15.3 (15.2 to 15.9) | 24.3 (24.2 to 24.4) | 20.2 (20.1 to 20.7) | 30.0 (29.8 to 30.3) | 29.9 (29.5 to 31.1) | 39.6 (39.5 to 39.8) |
| the same, the documents in four buffers of 128 MiB | everything | 16.3 (16.2 to 16.8) | 25.2 (25.0 to 25.7) | 20.6 (20.5 to 21.5) | 30.3 (30.2 to 30.8) | 41.1 (32.7 to 49.7) | 43.9 (41.2 to 50.2) |
| with 2 scope bits per position | everything | 16.6 (16.5 to 17.2) | 25.6 (25.5 to 25.8) | 21.0 (21.0 to 21.9) | 30.8 (30.6 to 34.5) | 54.6 (35.6 to 69.7) | 45.1 (41.1 to 55.6) |
| with 2 scope bits per position | keys | 16.6 (16.5 to 17.3) | 25.9 (25.7 to 26.5) | 21.0 (20.9 to 21.5) | 30.8 (21.7 to 36.0) | 45.7 (35.7 to 52.2) | 43.0 (40.6 to 52.3) |
| with 2 scope bits per position | string values | 17.4 (16.8 to 17.9) | 25.9 (25.7 to 26.0) | 21.1 (21.0 to 21.6) | 30.7 (21.4 to 32.0) | 46.3 (34.3 to 56.4) | 44.3 (41.0 to 52.3) |
| packed bytes, no scope bits | everything | 37.6 (36.9 to 39.7) | 43.1 (42.9 to 43.6) | 37.2 (36.7 to 42.3) | 44.0 (43.5 to 45.6) | 50.6 (45.8 to 64.2) | 55.5 (52.1 to 78.3) |
| packed bytes, with scope bits | string values | 38.8 (37.8 to 40.0) | 45.1 (44.9 to 48.6) | 37.4 (37.1 to 40.9) | 46.9 (46.2 to 53.3) | 53.8 (47.8 to 69.1) | 59.1 (54.2 to 73.2) |
| counts, then a second pass packs them into one bit per document | everything | 15.3 (15.2 to 15.9) | 24.4 (24.3 to 25.2) | 19.9 (19.8 to 20.4) | 30.4 (30.0 to 39.1) | 47.0 (34.4 to 52.7) | 41.7 (39.8 to 48.6) |
| the reverse pass alone, one bit per document | everything | 4.38 (4.33 to 4.68) | 13.5 (8.63 to 13.8) | 7.14 (7.07 to 7.50) | 17.2 (17.0 to 17.3) | 18.8 (15.3 to 21.1) | 24.2 (22.6 to 25.1) |
| the reverse pass alone with scope bits, one bit per document | everything | 4.79 (4.72 to 5.25) | 14.2 (14.1 to 16.5) | 7.63 (7.55 to 8.09) | 17.8 (16.5 to 17.9) | 17.4 (14.7 to 19.5) | 24.9 (24.4 to 26.3) |
| the reverse pass alone with scope bits, one bit per document | keys | 4.65 (4.60 to 5.13) | 14.0 (13.9 to 16.9) | 7.74 (7.69 to 8.04) | 17.8 (17.7 to 17.9) | 14.6 (14.5 to 15.4) | 24.5 (15.5 to 34.9) |
| the reverse pass alone with scope bits, one bit per document | string values | 4.64 (4.59 to 5.24) | 14.1 (8.40 to 14.3) | 7.75 (7.71 to 7.98) | 17.7 (17.3 to 17.9) | 14.5 (14.4 to 15.1) | 24.5 (20.3 to 26.1) |
| packed bytes, the reverse pass alone with scope bits, one bit per document | everything | 4.55 (4.52 to 4.59) | 13.9 (13.6 to 14.0) | 7.50 (7.45 to 7.79) | 17.5 (16.4 to 17.6) | 18.6 (13.9 to 22.6) | 24.1 (23.8 to 26.1) |
| packed bytes, the reverse pass alone with scope bits, one bit per document | string values | 4.55 (4.52 to 4.88) | 14.0 (13.8 to 15.7) | 7.53 (7.49 to 7.78) | 17.6 (17.5 to 24.5) | 16.1 (14.1 to 18.0) | 24.1 (23.9 to 25.3) |

| What runs on the GPU | The search reads | States | Back to back | The compute pass alone, from timestamps | Copying the results out of the mapped buffer | After a pause of 200 ms | After a pause of 1 s | The first search | Compile ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 8 | 28.1 (27.8 to 28.9) | 27.6 (27.3 to 28.9) | 0.07 (0.07 to 0.08) | 36.9 (36.8 to 37.0) | 37.0 (36.7 to 39.8) | 43.6 | 9.44 |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 16 | 29.8 (29.5 to 30.7) | 29.2 (28.8 to 29.7) | 0.07 (0.06 to 0.09) | 39.0 (38.7 to 39.4) | 38.8 (35.6 to 39.9) | 49.9 | 13.2 |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 32 | 40.5 (40.1 to 41.7) | 41.3 (39.5 to 44.1) | 0.07 (0.07 to 0.08) | 50.1 (49.9 to 51.7) | 50.2 (49.9 to 53.0) | 58.6 | 14.6 |
| with the class of a byte from one table read | everything | 8 | 15.3 (15.2 to 15.9) | 14.7 (14.6 to 15.0) | 0.07 (0.06 to 0.09) | 24.3 (24.2 to 24.4) | 24.5 (22.4 to 25.2) | 15.8 | 14.0 |
| with the class of a byte from one table read | everything | 16 | 20.2 (20.1 to 20.7) | 19.6 (19.5 to 19.9) | 0.07 (0.06 to 0.10) | 30.0 (29.8 to 30.3) | 30.0 (29.9 to 39.2) | 20.7 | 14.3 |
| with the class of a byte from one table read | everything | 32 | 29.9 (29.5 to 31.1) | 29.1 (29.0 to 29.9) | 0.07 (0.06 to 0.26) | 39.6 (39.5 to 39.8) | 39.7 (39.6 to 42.9) | 30.4 | 14.1 |
| the reverse pass alone with scope bits, one bit per document | string values | 8 | 4.64 (4.59 to 5.24) | 4.24 (4.24 to 4.54) | 0.01 (0.00 to 0.03) | 14.1 (8.40 to 14.3) | 14.0 (10.8 to 14.2) | 7.00 | 12.3 |
| the reverse pass alone with scope bits, one bit per document | string values | 16 | 7.75 (7.71 to 7.98) | 7.33 (7.32 to 7.82) | 0.01 (0.01 to 0.01) | 17.7 (17.3 to 17.9) | 17.8 (17.7 to 22.9) | 13.3 | 14.3 |
| the reverse pass alone with scope bits, one bit per document | string values | 32 | 14.5 (14.4 to 15.1) | 14.0 (14.0 to 14.8) | 0.01 (0.01 to 0.02) | 24.5 (20.3 to 26.1) | 24.6 (24.4 to 36.3) | 15.2 | 16.1 |

Buffers in this run, bytes: {"fixedBytes":512000000,"scopeBytes":128000000,"packedBytes":300691804,"startsBytes":4000004,"f32Bytes":2052000000}. 

### The same again, with a rest of 2 s before each series, on a busier machine

From `compact-1000000-rested`, load average not run. not run One search runs from before JavaScript compiles the pattern until the results are in a JavaScript array. Back to back is at least 15 searches that follow each other, and after a pause is 9 searches. Consecutive searches use different patterns, the ones that fit the state capacity in turn.

| What runs on the GPU | The search reads | 8 states: back to back | after a pause of 200 ms | 16 states: back to back | after a pause of 200 ms | 32 states: back to back | after a pause of 200 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |

| What runs on the GPU | The search reads | States | Back to back | The compute pass alone, from timestamps | Copying the results out of the mapped buffer | After a pause of 200 ms | After a pause of 1 s | The first search | Compile ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

Buffers in this run, bytes: undefined. 

### The main kernels a third time, with a rest of 3 s before each series, and series of 15 searches

From `compact-1000000-short`, load average 3.4 to 7.9.  One search runs from before JavaScript compiles the pattern until the results are in a JavaScript array. Back to back is at least 15 searches that follow each other, and after a pause is 9 searches. Consecutive searches use different patterns, the ones that fit the state capacity in turn.

| What runs on the GPU | The search reads | 8 states: back to back | after a pause of 200 ms | 16 states: back to back | after a pause of 200 ms | 32 states: back to back | after a pause of 200 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 27.8 (27.6 to 28.0) | 36.5 (35.1 to 36.8) | 32.8 (28.9 to 42.4) | 38.5 (38.4 to 39.3) | 51.4 (40.2 to 66.8) | 50.1 (49.8 to 51.2) |
| with the class of a byte from one table read | everything | 15.2 (15.2 to 16.0) | 24.3 (22.9 to 24.8) | 20.1 (20.1 to 20.5) | 29.9 (29.8 to 30.0) | 30.1 (29.7 to 38.4) | 39.7 (39.6 to 43.8) |
| with 2 scope bits per position | everything | 17.0 (16.3 to 17.6) | 25.6 (25.6 to 25.7) | 21.0 (20.9 to 21.6) | 30.8 (30.4 to 30.9) | 32.5 (30.7 to 40.3) | 32.7 (31.5 to 40.7) |
| with 2 scope bits per position | keys | 16.7 (16.6 to 17.2) | 25.6 (24.5 to 26.0) | 22.3 (21.0 to 24.0) | 30.8 (30.8 to 31.1) | 30.7 (30.7 to 31.5) | 40.7 (40.5 to 41.7) |
| with 2 scope bits per position | string values | 16.7 (16.6 to 17.2) | 25.6 (25.5 to 25.7) | 21.0 (20.9 to 21.1) | 30.7 (29.5 to 30.9) | 30.8 (30.7 to 39.5) | 40.7 (40.6 to 40.9) |
| the reverse pass alone, one bit per document | everything | 4.32 (4.29 to 4.39) | 13.5 (13.1 to 15.3) | 7.27 (7.22 to 7.37) | 17.4 (13.4 to 22.1) | 14.0 (13.9 to 14.4) | 24.1 (23.0 to 25.4) |
| the reverse pass alone with scope bits, one bit per document | everything | 4.68 (4.66 to 4.84) | 14.2 (14.1 to 17.1) | 7.76 (7.71 to 7.92) | 17.9 (17.7 to 18.3) | 14.5 (14.4 to 14.9) | 24.5 (24.4 to 24.7) |
| the reverse pass alone with scope bits, one bit per document | keys | 4.95 (4.65 to 5.12) | 14.0 (14.0 to 14.2) | 7.75 (7.72 to 7.91) | 17.7 (17.5 to 18.0) | 14.5 (14.4 to 14.5) | 24.5 (16.8 to 24.7) |
| the reverse pass alone with scope bits, one bit per document | string values | 4.64 (4.61 to 4.68) | 14.1 (14.0 to 14.4) | 7.75 (7.73 to 7.82) | 17.8 (15.4 to 18.0) | 14.4 (14.4 to 14.5) | 24.5 (24.4 to 33.3) |

| What runs on the GPU | The search reads | States | Back to back | The compute pass alone, from timestamps | Copying the results out of the mapped buffer | After a pause of 200 ms | After a pause of 1 s | The first search | Compile ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 8 | 27.8 (27.6 to 28.0) | 27.1 (26.9 to 28.0) | 0.07 (0.07 to 0.07) | 36.5 (35.1 to 36.8) | 36.8 (36.5 to 39.3) | 43.3 | 9.02 |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 16 | 32.8 (28.9 to 42.4) | 29.5 (28.9 to 30.4) | 0.07 (0.06 to 0.07) | 38.5 (38.4 to 39.3) | 38.5 (38.4 to 40.7) | 50.3 | 13.8 |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 32 | 51.4 (40.2 to 66.8) | 40.1 (39.5 to 41.4) | 0.07 (0.07 to 0.08) | 50.1 (49.8 to 51.2) | 50.1 (49.9 to 52.5) | 62.0 | 14.0 |
| with the class of a byte from one table read | everything | 8 | 15.2 (15.2 to 16.0) | 14.7 (14.7 to 14.9) | 0.06 (0.06 to 0.07) | 24.3 (22.9 to 24.8) | 24.5 (24.3 to 35.6) | 20.9 | 14.4 |
| with the class of a byte from one table read | everything | 16 | 20.1 (20.1 to 20.5) | 19.5 (19.5 to 19.6) | 0.07 (0.06 to 0.07) | 29.9 (29.8 to 30.0) | 30.0 (29.8 to 30.0) | 26.2 | 14.0 |
| with the class of a byte from one table read | everything | 32 | 30.1 (29.7 to 38.4) | 29.1 (29.1 to 29.5) | 0.07 (0.07 to 0.07) | 39.7 (39.6 to 43.8) | 39.8 (39.7 to 51.4) | 35.6 | 14.2 |
| the reverse pass alone with scope bits, one bit per document | string values | 8 | 4.64 (4.61 to 4.68) | 4.24 (4.24 to 4.25) | 0.01 (0.01 to 0.01) | 14.1 (14.0 to 14.4) | 14.2 (14.0 to 14.3) | 7.06 | 12.0 |
| the reverse pass alone with scope bits, one bit per document | string values | 16 | 7.75 (7.73 to 7.82) | 7.33 (7.32 to 7.35) | 0.01 (0.01 to 0.02) | 17.8 (15.4 to 18.0) | 17.9 (14.7 to 18.0) | 8.49 | 15.5 |
| the reverse pass alone with scope bits, one bit per document | string values | 32 | 14.4 (14.4 to 14.5) | 14.0 (14.0 to 14.0) | 0.01 (0.01 to 0.02) | 24.5 (24.4 to 33.3) | 24.6 (24.0 to 25.5) | 15.2 | 17.2 |

Buffers in this run, bytes: {"fixedBytes":512000000,"scopeBytes":128000000,"packedBytes":300691804,"startsBytes":4000004,"f32Bytes":2052000000}. 

### How steady a back to back series was: its first three and its last three searches, ms

A back to back series is at least 15 searches and 1 s. Where the last searches of a series took much longer than the first ones, the GPU got slower while the series ran, and the series' median says little: the first searches, or the smallest sample, are the better estimate of one search on a GPU that is awake.

| Run | What runs on the GPU | States | Searches | The first three | The last three | After a pause of 200 ms, for comparison | Load average |
| --- | --- | --- | --- | --- | --- | --- | --- |
| compact-1000000 | `bitRowKernel` as it is, one f32 per code point, a count per document | 8 | 35 | 28.1, 28.0, 28.0 | 28.0, 28.1, 28.0 | 36.9 (36.8 to 37.0) | 4.44 to 4.61 |
| compact-1000000 | `bitRowKernel` as it is, one f32 per code point, a count per document | 16 | 33 | 30.2, 29.8, 30.7 | 30.4, 29.8, 29.9 | 39.0 (38.7 to 39.4) | 5.16 to 4.98 |
| compact-1000000 | `bitRowKernel` as it is, one f32 per code point, a count per document | 32 | 25 | 40.5, 40.1, 40.3 | 40.3, 40.4, 40.1 | 50.1 (49.9 to 51.7) | 4.06 to 3.98 |
| compact-1000000 | with the class of a byte from one table read | 8 | 62 | 15.2, 15.3, 15.3 | 15.3, 15.3, 15.2 | 24.3 (24.2 to 24.4) | 4.64 to 4.5 |
| compact-1000000 | with the class of a byte from one table read | 16 | 48 | 20.3, 20.2, 20.3 | 20.2, 20.2, 20.2 | 30.0 (29.8 to 30.3) | 4.82 to 5.14 |
| compact-1000000 | with the class of a byte from one table read | 32 | 33 | 30.2, 30.3, 31.1 | 30.4, 29.6, 29.7 | 39.6 (39.5 to 39.8) | 4.14 to 4.18 |
| compact-1000000 | the reverse pass alone, one bit per document | 8 | 100 | 4.35, 4.38, 4.34 | 4.39, 4.37, 4.38 | 13.5 (8.63 to 13.8) | 5 to 5 |
| compact-1000000 | the reverse pass alone, one bit per document | 16 | 100 | 7.08, 7.16, 7.50 | 7.13, 7.18, 7.11 | 17.2 (17.0 to 17.3) | 5.08 to 4.91 |
| compact-1000000 | the reverse pass alone, one bit per document | 32 | 55 | 15.3, 15.3, 15.6 | 20.5, 21.1, 21.1 | 24.2 (22.6 to 25.1) | 4.59 to 4.59 |
| compact-1000000 | the reverse pass alone with scope bits, one bit per document | 8 | 100 | 4.66, 4.62, 4.63 | 4.85, 4.66, 4.75 | 14.1 (8.40 to 14.3) | 5.46 to 5.29 |
| compact-1000000 | the reverse pass alone with scope bits, one bit per document | 16 | 100 | 7.74, 7.76, 7.79 | 7.80, 7.76, 7.73 | 17.7 (17.3 to 17.9) | 4.48 to 4.07 |
| compact-1000000 | the reverse pass alone with scope bits, one bit per document | 32 | 69 | 14.4, 14.5, 14.5 | 14.4, 14.5, 14.5 | 24.5 (20.3 to 26.1) | 4.48 to 4.31 |
| compact-1000000-short | `bitRowKernel` as it is, one f32 per code point, a count per document | 8 | 15 | 27.9, 28.0, 27.9 | 27.8, 27.9, 27.8 | 36.5 (35.1 to 36.8) | 6.77 to 5.69 |
| compact-1000000-short | `bitRowKernel` as it is, one f32 per code point, a count per document | 16 | 15 | 29.1, 29.3, 28.9 | 38.5, 40.4, 42.4 | 38.5 (38.4 to 39.3) | 5.44 to 4.88 |
| compact-1000000-short | `bitRowKernel` as it is, one f32 per code point, a count per document | 32 | 15 | 40.3, 40.3, 40.2 | 64.2, 65.7, 66.8 | 50.1 (49.8 to 51.2) | 3.96 to 3.83 |
| compact-1000000-short | with the class of a byte from one table read | 8 | 15 | 15.2, 15.2, 15.2 | 16.0, 15.3, 15.3 | 24.3 (22.9 to 24.8) | 5.69 to 5.33 |
| compact-1000000-short | with the class of a byte from one table read | 16 | 15 | 20.1, 20.1, 20.1 | 20.1, 20.1, 20.1 | 29.9 (29.8 to 30.0) | 4.88 to 4.68 |
| compact-1000000-short | with the class of a byte from one table read | 32 | 15 | 29.8, 29.7, 29.8 | 36.5, 37.4, 38.4 | 39.7 (39.6 to 43.8) | 3.83 to 3.79 |
| compact-1000000-short | the reverse pass alone, one bit per document | 8 | 15 | 4.29, 4.32, 4.34 | 4.30, 4.32, 4.32 | 13.5 (13.1 to 15.3) | 5.64 to 5.59 |
| compact-1000000-short | the reverse pass alone, one bit per document | 16 | 15 | 7.29, 7.25, 7.26 | 7.22, 7.28, 7.26 | 17.4 (13.4 to 22.1) | 4.5 to 4.27 |
| compact-1000000-short | the reverse pass alone, one bit per document | 32 | 15 | 14.0, 14.0, 14.1 | 13.9, 14.0, 14.1 | 24.1 (23.0 to 25.4) | 3.69 to 3.63 |
| compact-1000000-short | the reverse pass alone with scope bits, one bit per document | 8 | 15 | 4.64, 4.61, 4.63 | 4.63, 4.65, 4.63 | 14.1 (14.0 to 14.4) | 6.08 to 5.44 |
| compact-1000000-short | the reverse pass alone with scope bits, one bit per document | 16 | 15 | 7.78, 7.78, 7.75 | 7.78, 7.75, 7.77 | 17.8 (15.4 to 18.0) | 3.93 to 3.96 |
| compact-1000000-short | the reverse pass alone with scope bits, one bit per document | 32 | 15 | 14.4, 14.5, 14.5 | 14.5, 14.4, 14.5 | 24.5 (24.4 to 33.3) | 3.67 to 4.55 |

### A search after a pause in which the GPU was kept busy, ms

| Documents | What runs on the GPU | The search reads | States | Back to back | The pause | The search after it | Load average |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1,000,000 | with the class of a byte from one table read | everything | 8 | 15.3 (15.2 to 15.9) | 200 ms, nothing in between | 24.3 (24.3 to 24.4) | 3.88 to 4.48 |
| 1,000,000 | with the class of a byte from one table read | everything | 8 | 15.3 (15.2 to 15.9) | 1000 ms, nothing in between | 24.4 (24.2 to 24.5) | 3.88 to 4.48 |
| 1,000,000 | with the class of a byte from one table read | everything | 8 | 15.3 (15.2 to 15.9) | 200 ms, a search of 64 documents every 16 ms | 23.9 (17.9 to 25.1) | 3.88 to 4.48 |
| 1,000,000 | with the class of a byte from one table read | everything | 8 | 15.3 (15.2 to 15.9) | 1000 ms, a search of 64 documents every 16 ms | 24.1 (23.9 to 24.3) | 3.88 to 4.48 |
| 1,000,000 | with the class of a byte from one table read | everything | 8 | 15.3 (15.2 to 15.9) | 1000 ms, a search of 64 documents every 50 ms | 23.1 (23.0 to 24.1) | 3.88 to 4.48 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | everything | 8 | 4.52 (4.49 to 4.66) | 200 ms, nothing in between | 14.0 (12.8 to 14.1) | 4.48 to 3.16 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | everything | 8 | 4.52 (4.49 to 4.66) | 1000 ms, nothing in between | 14.1 (13.0 to 14.3) | 4.48 to 3.16 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | everything | 8 | 4.52 (4.49 to 4.66) | 200 ms, a search of 64 documents every 16 ms | 13.6 (12.2 to 13.9) | 4.48 to 3.16 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | everything | 8 | 4.52 (4.49 to 4.66) | 1000 ms, a search of 64 documents every 16 ms | 14.0 (13.7 to 14.1) | 4.48 to 3.16 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | everything | 8 | 4.52 (4.49 to 4.66) | 1000 ms, a search of 64 documents every 50 ms | 13.2 (13.0 to 14.2) | 4.48 to 3.16 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | keys | 8 | 4.50 (4.45 to 4.77) | 200 ms, nothing in between | 13.8 (5.18 to 15.5) | 3.16 to 2.82 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | keys | 8 | 4.50 (4.45 to 4.77) | 1000 ms, nothing in between | 14.0 (13.6 to 14.3) | 3.16 to 2.82 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | keys | 8 | 4.50 (4.45 to 4.77) | 200 ms, a search of 64 documents every 16 ms | 13.7 (12.7 to 13.8) | 3.16 to 2.82 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | keys | 8 | 4.50 (4.45 to 4.77) | 1000 ms, a search of 64 documents every 16 ms | 13.7 (12.5 to 13.8) | 3.16 to 2.82 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | keys | 8 | 4.50 (4.45 to 4.77) | 1000 ms, a search of 64 documents every 50 ms | 13.7 (13.0 to 13.9) | 3.16 to 2.82 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | string values | 8 | 4.50 (4.43 to 4.72) | 200 ms, nothing in between | 13.9 (5.18 to 16.4) | 2.82 to 2.51 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | string values | 8 | 4.50 (4.43 to 4.72) | 1000 ms, nothing in between | 14.5 (14.2 to 14.8) | 2.82 to 2.51 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | string values | 8 | 4.50 (4.43 to 4.72) | 200 ms, a search of 64 documents every 16 ms | 13.7 (9.50 to 16.2) | 2.82 to 2.51 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | string values | 8 | 4.50 (4.43 to 4.72) | 1000 ms, a search of 64 documents every 16 ms | 13.7 (13.6 to 14.1) | 2.82 to 2.51 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | string values | 8 | 4.50 (4.43 to 4.72) | 1000 ms, a search of 64 documents every 50 ms | 13.6 (13.0 to 13.8) | 2.82 to 2.51 |

### One search by document count, 8 states, ms

From the `compact` runs, load average 100,000: 2.0 to 5.5, 250,000: not run, 500,000: not run, 1,000,000: 3.6 to 6.1. A cell is back to back; after a pause of 200 ms.

| What runs on the GPU | The search reads | States | 100,000 | 250,000 | 500,000 | 1,000,000 |
| --- | --- | --- | --- | --- | --- | --- |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 8 | 3.61 (3.35 to 3.94); 10.9 (10.8 to 12.7) |  |  | 28.1 (27.8 to 28.9); 36.9 (36.8 to 37.0) |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 16 | 3.61 (3.54 to 3.78); 11.7 (11.6 to 11.8) |  |  | 29.8 (29.5 to 30.7); 39.0 (38.7 to 39.4) |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 32 | 4.84 (4.78 to 5.34); 14.2 (8.86 to 14.6) |  |  | 40.5 (40.1 to 41.7); 50.1 (49.9 to 51.7) |
| with the class of a byte from one table read | everything | 8 | 2.15 (2.10 to 4.17); 7.21 (6.71 to 7.36) |  |  | 15.3 (15.2 to 15.9); 24.3 (24.2 to 24.4) |
| with the class of a byte from one table read | everything | 16 | 2.44 (2.39 to 2.68); 9.55 (5.26 to 9.60) |  |  | 20.2 (20.1 to 20.7); 30.0 (29.8 to 30.3) |
| with the class of a byte from one table read | everything | 32 | 3.52 (3.44 to 3.74); 11.9 (4.10 to 12.0) |  |  | 29.9 (29.5 to 31.1); 39.6 (39.5 to 39.8) |
| with 2 scope bits per position | string values | 8 | 2.27 (2.23 to 2.36); 7.82 (4.13 to 8.39) |  |  | 17.4 (16.8 to 17.9); 25.9 (25.7 to 26.0) |
| with 2 scope bits per position | string values | 16 | 2.41 (2.37 to 2.77); 9.56 (8.68 to 9.71) |  |  | 21.1 (21.0 to 21.6); 30.7 (21.4 to 32.0) |
| with 2 scope bits per position | string values | 32 | 3.58 (3.51 to 4.03); 12.1 (11.9 to 14.0) |  |  | 46.3 (34.3 to 56.4); 44.3 (41.0 to 52.3) |
| packed bytes, no scope bits | everything | 8 | 5.79 (5.42 to 7.02); 12.3 (11.9 to 13.3) |  |  | 37.6 (36.9 to 39.7); 43.1 (42.9 to 43.6) |
| packed bytes, no scope bits | everything | 16 | 5.74 (5.51 to 6.79); 12.6 (8.88 to 13.7) |  |  | 37.2 (36.7 to 42.3); 44.0 (43.5 to 45.6) |
| packed bytes, no scope bits | everything | 32 | 6.99 (6.45 to 8.29); 16.0 (15.4 to 17.5) |  |  | 50.6 (45.8 to 64.2); 55.5 (52.1 to 78.3) |
| the reverse pass alone, one bit per document | everything | 8 | 0.90 (0.77 to 1.26); 2.94 (2.92 to 3.00) |  |  | 4.38 (4.33 to 4.68); 13.5 (8.63 to 13.8) |
| the reverse pass alone, one bit per document | everything | 16 | 0.94 (0.90 to 2.38); 4.29 (4.24 to 4.33) |  |  | 7.14 (7.07 to 7.50); 17.2 (17.0 to 17.3) |
| the reverse pass alone, one bit per document | everything | 32 | 1.73 (1.64 to 1.76); 8.56 (7.78 to 8.83) |  |  | 18.8 (15.3 to 21.1); 24.2 (22.6 to 25.1) |
| the reverse pass alone with scope bits, one bit per document | string values | 8 | 0.67 (0.63 to 0.95); 3.04 (2.97 to 3.08) |  |  | 4.64 (4.59 to 5.24); 14.1 (8.40 to 14.3) |
| the reverse pass alone with scope bits, one bit per document | string values | 16 | 0.99 (0.95 to 1.16); 4.49 (2.15 to 4.66) |  |  | 7.75 (7.71 to 7.98); 17.7 (17.3 to 17.9) |
| the reverse pass alone with scope bits, one bit per document | string values | 32 | 1.76 (1.74 to 1.96); 8.04 (7.98 to 8.89) |  |  | 14.5 (14.4 to 15.1); 24.5 (20.3 to 26.1) |

### The program's own kernel, searcher.ts, as the demo page ran it when this check was made, ms

From the `program` runs. The time is `timings.totalMs` of the searcher's result, which the demo page's line shows. A search of more than 1.5 s has no pause series.

| Documents | States | The search reads | Patterns | Back to back | The compute pass alone | After a pause of 200 ms | After a pause of 1 s | Searches compared, values, mismatched | Load average |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100,000 |  |  |  | not run |  |  |  |  |  |
| 250,000 |  |  |  | not run |  |  |  |  |  |
| 500,000 |  |  |  | not run |  |  |  |  |  |
| 1,000,000 | 8 | everything | `error`, `[a-z]+Id`, `[a-z0-9.]+@[a-z.]+`, `([a-z]+)+x` | 99.2 (64.9 to 111) | 100 (97.3 to 103) | 74.0 (64.8 to 90.4) | 74.4 (74.1 to 75.9) | 46, 46,000,000, 0 | 5.91 to 5.41 |
| 1,000,000 | 8 | string values | `error`, `[a-z]+Id`, `[a-z0-9.]+@[a-z.]+`, `([a-z]+)+x` | 65.0 (64.4 to 65.9) | 63.4 (63.1 to 64.5) | 65.1 (64.8 to 74.9) | 74.5 (73.9 to 77.1) | 55, 55,000,000, 0 | 5.41 to 5.46 |
| 1,000,000 | 8 | keys | `error`, `[a-z]+Id`, `[a-z0-9.]+@[a-z.]+`, `([a-z]+)+x` | 96.7 (66.8 to 101) | 94.7 (93.3 to 96.5) | 69.7 (64.8 to 81.6) | 74.6 (74.0 to 79.7) | 47, 47,000,000, 0 | 5.46 to 5.71 |
| 1,000,000 | 16 | everything | `\d\d\d\d-\d\d-\d\d` | 594 (590 to 597) | 593 (589 to 597) | 635 (597 to 672) | 607 (598 to 632) | 43, 43,000,000, 0 | 5.71 to 4.69 |
| 1,000,000 | 32 | everything | `connection reset` | 8870 (8759 to 9097) |  |  |  | 11, 11,000,000, 0 | 4.42 to 4.78 |

Creating the searcher on the page's thread: 1,000,000: the texts 3057 ms, their cells 417 ms, the upload, the highlighter's compile and its pass 918 ms, in all with the search shader 1449 ms.

### The program's step, two rewrites of it and the hand-written kernel, 100,000 documents as one f32 per code point, ms

From `compact-100000`, load average 2.0 to 5.5.  Every engine's answers were compared with the same plain JavaScript loop for every document.

| What runs on the GPU | The search reads | 8 states: back to back | after a pause of 200 ms | 16 states: back to back | after a pause of 200 ms | 32 states: back to back | after a pause of 200 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| the program's own step, as loop-emit.ts writes it | everything | 6.94 (6.87 to 7.50) | 16.9 (13.7 to 17.1) | 64.3 (62.5 to 67.2) | 76.0 (74.3 to 77.4) | 887 (866 to 901) | 904 (873 to 1006) |
| rewrite 1: every 0-or-1 value as a bit, one table read per pair of states | everything | 6.15 (6.01 to 7.09) | 16.2 (12.8 to 18.1) | 22.7 (22.4 to 24.1) | 33.6 (33.0 to 35.0) | 431 (421 to 510) | 437 (428 to 515) |
| rewrite 2: also the reads of one sum as one word | everything | 2.68 (2.62 to 2.92) | 8.18 (4.42 to 8.26) | 3.20 (3.10 to 3.59) | 11.2 (6.12 to 11.8) | 3.82 (3.77 to 4.05) | 13.8 (12.7 to 16.6) |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 3.61 (3.35 to 3.94) | 10.9 (10.8 to 12.7) | 3.61 (3.54 to 3.78) | 11.7 (11.6 to 11.8) | 4.84 (4.78 to 5.34) | 14.2 (8.86 to 14.6) |
| with the class of a byte from one table read | everything | 2.15 (2.10 to 4.17) | 7.21 (6.71 to 7.36) | 2.44 (2.39 to 2.68) | 9.55 (5.26 to 9.60) | 3.52 (3.44 to 3.74) | 11.9 (4.10 to 12.0) |
| the reverse pass alone, one bit per document | everything | 0.90 (0.77 to 1.26) | 2.94 (2.92 to 3.00) | 0.94 (0.90 to 2.38) | 4.29 (4.24 to 4.33) | 1.73 (1.64 to 1.76) | 8.56 (7.78 to 8.83) |

Compile ms at 8, 16 and 32 states: program-step: 96.4, 265, 993; rewrite-1: 95.5, 229, 1404; rewrite-2: 47.7, 64.8, 76.2; f32-kernel: 10.4, 12.8, 13.6.

### Regular JavaScript on one thread, ms

1,000,000 documents, from `js-1000000`, load average 3.2 to 7.7.  Each cell is 9 runs after one run of warmup.

| Pattern | Documents with a match | `texts.filter(text => pattern.test(text)).length` | A walk over objects parsed once: string values | keys | Arrays of strings collected once: string values | keys | The whole-text filter in 8 workers, which isn't what Cheng asked about |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `error` | 105,133 | 185 (184 to 186) | 253 (249 to 255) | 240 (239 to 248) | 135 (133 to 140) | 137 (135 to 138) | 24.6 (24.3 to 25.0) |
| `[a-z]+Id` | 238,302 | 200 (200 to 201) | 272 (270 to 274) | 197 (194 to 199) | 145 (142 to 147) | 109 (108 to 110) | 26.2 (26.1 to 26.4) |
| `[a-z0-9.]+@[a-z.]+` | 143,808 | 315 (312 to 316) | 273 (264 to 276) | 276 (273 to 295) | 148 (147 to 150) | 156 (154 to 163) | 43.7 (42.9 to 43.9) |
| `\d\d\d\d-\d\d-\d\d` | 275,094 | 58.0 (57.2 to 58.4) | 196 (190 to 211) | 232 (227 to 250) | 74.4 (72.2 to 78.0) | 99.2 (97.5 to 103) | 8.54 (8.35 to 8.72) |
| `([a-z]+)+x` | 474,433 | 14929 (14691 to 15504) | 4259 (4241 to 4309) | 15831 (15792 to 15895) | 4152 (4090 to 4269) | 16267 (15990 to 17320) | 1854 (1829 to 1886) |
| `connection reset` | 14,271 | 73.4 (72.7 to 74.6) | 195 (192 to 197) | 214 (208 to 242) | 86.5 (83.0 to 90.8) | 93.2 (92.2 to 96.7) | 10.3 (10.2 to 10.4) |

- `JSON.parse` of every document in a `try`: 609 (601 to 650) ms, 1,000,000 valid.
- Once: writing the texts 3051 ms, parsing and keeping every object 728 ms, collecting 7,122,892 string values and 12,808,102 keys 250 ms, and the 8 workers writing their own share of the texts 472 ms.
- JavaScript memory: the texts: 335 MB, renderer process 471 MB (605 MB). the texts and the parsed objects: 599 MB, renderer process 682 MB (824 MB). the texts, the parsed objects and the collected strings: 828 MB, renderer process 925 MB (1.08 GB). the texts in the page and in the workers: 945 MB, renderer process 1.13 GB (1.31 GB).

100,000 documents: not run

### The whole-text search after a pause of 200 ms, 1,000,000 documents, ms

From `js-pause-1000000`, load average 2.3 to 4.8.  A search of more than 1.5 s has no series after a pause.

| Pattern | One thread, one run after the other | One thread, after a pause | 8 workers, one request after the other | 8 workers, after a pause |
| --- | --- | --- | --- | --- |
| `error` | 184 (182 to 187) | 186 (183 to 188) | 24.2 (24.0 to 24.8) | 40.0 (27.5 to 44.3) |
| `[a-z]+Id` | 197 (196 to 199) | 205 (202 to 220) | 26.5 (26.4 to 26.9) | 40.8 (32.6 to 43.0) |
| `[a-z0-9.]+@[a-z.]+` | 309 (296 to 316) | 315 (310 to 318) | 44.0 (43.2 to 44.4) | 59.1 (45.2 to 64.0) |
| `\d\d\d\d-\d\d-\d\d` | 58.0 (57.6 to 58.3) | 77.8 (65.1 to 81.6) | 8.38 (8.26 to 8.76) | 16.0 (11.8 to 21.4) |
| `([a-z]+)+x` | 14456 (13972 to 14661) |  | 1804 (1756 to 1827) |  |
| `connection reset` | 72.2 (71.8 to 72.5) | 91.2 (74.5 to 94.5) | 10.3 (9.89 to 10.6) | 20.2 (11.0 to 22.5) |

### What was compared

Every timed search's results were compared with the plain JavaScript loop over the same automaton (`createBitRowSearch`), for every document of the run: the match count of each document where the kernel returns counts, and whether each document has a match where it returns bits. For a scope, the loop reads `table-loop.ts`'s display kinds as its mask.

| Run | Searches compared | Values compared | Mismatched | Problems |
| --- | --- | --- | --- | --- |
| compact-100000 | 20,187 | 2,018,700,000 | 0 | none |
| compact-1000000-short | 1,906 | 1,906,000,000 | 0 | none |
| compact-1000000 | 7,346 | 7,346,000,000 | 0 | none |
| program-1000000 | 202 | 202,000,000 | 0 | none |
| warm-1000000 | 1,194 | 1,194,000,000 | 0 | none |
| in all | 30,835 | 12,666,700,000 | 0 |  |

The patterns over the 1,000,000 documents, and the documents where regular JavaScript answers "does this document have a match" differently from the loop:

| Pattern | States | Runs on the program for | The same matches on bytes | Documents with a match: everything | keys | string values | `pattern.test(text)` differs | The walk over keys differs | The walk over string values differs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `error` | 6 | 8 | yes | 105,133 | 95,748 | 28,169 | 0 | 0 | 0 |
| `[a-z]+Id` | 4 | 8 | yes | 238,302 | 238,302 | 0 | 0 | 0 | 0 |
| `[a-z0-9.]+@[a-z.]+` | 4 | 8 | yes | 143,808 | 0 | 143,808 | 0 | 0 | 0 |
| `\d\d\d\d-\d\d-\d\d` | 11 | 16 | yes | 275,094 | 0 | 275,094 | 0 | 0 | 0 |
| `([a-z]+)+x` | 3 | 8 | yes | 474,433 | 214,835 | 332,460 | 0 | 0 | 0 |
| `connection reset` | 17 | 32 | yes | 14,271 | 0 | 14,271 | 0 | 0 | 0 |

### Painting the map from one search's results, ms

1,000,000 documents, 11 paints each after 3 of warmup, alternating between two searches' results:

| What is painted | Canvas pixels | Writing the pixels | `putImageData` | Both | From the start until the second animation frame after it |
| --- | --- | --- | --- | --- | --- |
| one pixel per document, from counts | 1000 by 1000 | 1.62 (0.94 to 1.68) | 0.07 (0.07 to 0.14) | 1.69 (1.00 to 1.81) | 33.4 (33.0 to 34.2) |
| one pixel per document, from bits | 1000 by 1000 | 1.72 (1.06 to 1.83) | 0.07 (0.06 to 0.15) | 1.78 (1.13 to 1.91) | 33.3 (32.6 to 33.4) |
| 2 by 2 pixels per document, from bits | 2000 by 2000 | 2.63 (1.96 to 2.92) | 0.24 (0.23 to 0.26) | 2.88 (2.21 to 3.17) | 33.3 (32.6 to 33.6) |
| the demo page's paintCells, with its gaps | 1000 by 3999 | 6.15 (4.97 to 6.81) | 0.25 (0.24 to 0.26) | 6.40 (5.22 to 7.06) | 33.5 (32.7 to 34.3) |

Counting the documents with a match: 1.47 (0.81 to 3.60) ms from 1,000,000 counts, 0.57 (0.39 to 0.94) ms from bits.

100,000 documents, 11 paints each after 3 of warmup, alternating between two searches' results:

| What is painted | Canvas pixels | Writing the pixels | `putImageData` | Both | From the start until the second animation frame after it |
| --- | --- | --- | --- | --- | --- |
| one pixel per document, from counts | 317 by 317 | 0.34 (0.18 to 0.64) | 0.03 (0.02 to 0.06) | 0.36 (0.21 to 0.68) | 33.3 (32.6 to 34.3) |
| one pixel per document, from bits | 317 by 317 | 0.34 (0.18 to 0.42) | 0.03 (0.01 to 0.04) | 0.36 (0.21 to 0.46) | 33.3 (33.1 to 34.1) |
| 2 by 2 pixels per document, from bits | 634 by 634 | 0.69 (0.35 to 1.36) | 0.07 (0.05 to 0.10) | 0.74 (0.40 to 1.47) | 33.4 (33.3 to 34.3) |
| the demo page's paintCells, with its gaps | 1000 by 399 | 0.96 (0.64 to 2.36) | 0.04 (0.03 to 0.15) | 1.00 (0.67 to 2.52) | 33.3 (33.0 to 34.2) |

Counting the documents with a match: 0.28 (0.10 to 0.55) ms from 100,000 counts, 0.06 (0.01 to 0.11) ms from bits.


### The report's tables

**1. Memory at 1,000,000 documents, one run each.** A process's memory is its footprint once every document is on the GPU, and the largest footprint it had until then.

| Layout | Bytes per document | GPU buffers: documents + kinds or scope bits + results | JavaScript | Chrome's GPU process | The page's renderer process, with its workers | Documents per buffer under WebGPU's default limits |
| --- | --- | --- | --- | --- | --- | --- |
| today's, through searcher.ts, with the texts in the page | 2,052 + 2,048 | 2.05 GB + 2.05 GB + 20 MB | 358 MB | 6.26 GB, at most 8.09 GB | 2.48 GB, at most 4.61 GB | 65,408 |
| bytes, 512 per document, with the texts in the page | 512 + 128 | 512 MB + 128 MB + 4 MB | 341 MB | 850 MB, at most 1.64 GB | 614 MB, at most 1.53 GB | 262,144, so four buffers |
| bytes, packed, with the texts in the page | 301 on average + 4 + 128 | 305 MB + 128 MB + 4 MB | 341 MB | 1.12 GB, at most 1.59 GB | 575 MB, at most 1.55 GB | 445,000 on average |
| bytes, 512 per document, no texts in the page | 512 + 128 | 512 MB + 128 MB + 4 MB | 5 MB | 851 MB, at most 1.67 GB | 174 MB, at most 1.50 GB |  |

**2. The load, ms from the navigation, 512 bytes per document, 8 workers, one run each.**

| Documents | The kernel is compiled | The first piece of 25,000 arrives | Its answer is in JavaScript | The last piece arrives | Every document searched | The workers' time, summed: texts, bytes, scope bits | Load average |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100,000 | 141 | 257 | 274 | 261 | 293 | 439, 41, 220 | 5.11 |
| 1,000,000 | 207 | 236 | 271 | 855 | 900 | 3663, 394, 2153 | 3.64 |

**3. One search of 1,000,000 documents, ms.** A kernel's cell is back to back; after a pause of 200 ms, each as the median with the smallest and the largest sample. From `compact-1000000-short`, where a series is 15 searches after a rest of 3 s (load average 3.4 to 7.9), `program-1000000` (3.9 to 6.0) and `js-1000000` (3.2 to 7.7).

| What runs on the GPU | Patterns of up to 8 states | up to 16 states | up to 32 states |
| --- | --- | --- | --- |
| hand-written kernel on bytes: which documents match, with a scope (string values) | 4.64 (4.61 to 4.68); 14.1 (14.0 to 14.4) | 7.75 (7.73 to 7.82); 17.8 (15.4 to 18.0) | 14.4 (14.4 to 14.5); 24.5 (24.4 to 33.3) |
| the same without a scope | 4.32 (4.29 to 4.39); 13.5 (13.1 to 15.3) | 7.27 (7.22 to 7.37); 17.4 (13.4 to 22.1) | 14.0 (13.9 to 14.4); 24.1 (23.0 to 25.4) |
| hand-written kernel on bytes: a match count per document, with a scope (string values) | 16.7 (16.6 to 17.2); 25.6 (25.5 to 25.7) | 21.0 (20.9 to 21.1); 30.7 (29.5 to 30.9) | 30.8 (30.7 to 39.5); 40.7 (40.6 to 40.9) |
| the same without a scope | 15.2 (15.2 to 16.0); 24.3 (22.9 to 24.8) | 20.1 (20.1 to 20.5); 29.9 (29.8 to 30.0) | 30.1 (29.7 to 38.4); 39.7 (39.6 to 43.8) |
| the lab's `bitRowKernel` as it is, one f32 per code point, a count per document | 27.8 (27.6 to 28.0); 36.5 (35.1 to 36.8) | 32.8 (28.9 to 42.4); 38.5 (38.4 to 39.3) | 51.4 (40.2 to 66.8); 50.1 (49.8 to 51.2) |
| searcher.ts with loop-emit.ts's shaders, the program as the page ran it when this check was made, one f32 per code point, a count per document | 99.2 (64.9 to 111); 74.0 (64.8 to 90.4) | 594 (590 to 597); 635 (597 to 672) | 8870 (8759 to 9097);  |

The same searches in `compact-1000000`, where a series is at least 15 searches and 1 s, with no rest before it (load average 3.6 to 6.1), again back to back; after a pause of 200 ms. Which documents match, with a scope: 4.64 (4.59 to 5.24); 14.1 (8.40 to 14.3) at 8 states, 7.75 (7.71 to 7.98); 17.7 (17.3 to 17.9) at 16, and 14.5 (14.4 to 15.1); 24.5 (20.3 to 26.1) at 32. Without a scope: 4.38 (4.33 to 4.68); 13.5 (8.63 to 13.8) at 8 states, 7.14 (7.07 to 7.50); 17.2 (17.0 to 17.3) at 16, and 18.8 (15.3 to 21.1); 24.2 (22.6 to 25.1) at 32. A count per document, with a scope: 17.4 (16.8 to 17.9); 25.9 (25.7 to 26.0) at 8 states, 21.1 (21.0 to 21.6); 30.7 (21.4 to 32.0) at 16, and 46.3 (34.3 to 56.4); 44.3 (41.0 to 52.3) at 32. Without a scope: 15.3 (15.2 to 15.9); 24.3 (24.2 to 24.4) at 8 states, 20.2 (20.1 to 20.7); 30.0 (29.8 to 30.3) at 16, and 29.9 (29.5 to 31.1); 39.6 (39.5 to 39.8) at 32. `bitRowKernel`: 28.1 (27.8 to 28.9); 36.9 (36.8 to 37.0) at 8 states, 29.8 (29.5 to 30.7); 39.0 (38.7 to 39.4) at 16, and 40.5 (40.1 to 41.7); 50.1 (49.9 to 51.7) at 32.

| Regular JavaScript on one thread, 9 runs each | The five ordinary patterns, the smallest and the largest median | `([a-z]+)+x` |
| --- | --- | --- |
| `texts.filter(text => pattern.test(text)).length`, whole text | 58.0 to 315 | 14929 (14691 to 15504) |
| a walk over objects that were parsed once: string values, and keys | 195 to 273, and 197 to 276 | 4259 (4241 to 4309), and 15831 (15792 to 15895) |
| arrays of strings that were collected once: string values, and keys | 74.4 to 148, and 93.2 to 156 | 4152 (4090 to 4269), and 16267 (15990 to 17320) |
| the whole-text filter in 8 workers, which isn't what Cheng asked about | 8.54 to 43.7 | 1854 (1829 to 1886) |
| `JSON.parse` of every document, the validation at load | 609 (601 to 650) |  |

The same searches after a pause of 200 ms, from the runs that time each search both ways, as the smallest and the largest median of the five ordinary patterns. `js-pause-1000000` (load average 2.3 to 4.8): 77.8 to 315 ms on one thread after a pause against 58.0 to 309 ms without one, and 16.0 to 59.1 ms in 8 workers against 8.38 to 44.0 ms. `js-pause-1000000-ordinary` (load average 2.5 to 3.5): 61.6 to 317 ms on one thread after a pause against 57.9 to 313 ms without one, and 8.96 to 46.0 ms in 8 workers against 8.79 to 45.2 ms. `js-pause-1000000-ordinary-2` (load average 2.8 to 3.7): 61.8 to 312 ms on one thread after a pause against 58.7 to 306 ms without one, and 8.98 to 47.2 ms in 8 workers against 8.48 to 46.2 ms.

Every RegExp above has no flag, as in `/error/`. Other plain ways to write the whole-text search, from `js-forms-1000000` (load average 2.7 to 4.9): the same filter, the filter with the u flag, a loop that counts instead of `filter`, and `text.includes(word)` for a plain word took 188, 188, 188, 186 ms for `error`; 204, 220, 197 ms for `[a-z]+Id`; 310, 345, 313 ms for `[a-z0-9.]+@[a-z.]+`; 59.4, 67.8, 54.7 ms for `\d\d\d\d-\d\d-\d\d`; 14459, 14866, 14118 ms for `([a-z]+)+x`; 73.8, 72.8, 68.9, 69.3 ms for `connection reset`.

**4. What was compared.** Every timed search of the 5 kernel and program runs, 30,835 searches, was compared with the lab's plain JavaScript loop over the same automaton for every document of its run: the match count per document where the kernel returns counts, and whether the document has a match where it returns bits, with `table-loop.ts`'s display kinds as the mask for a scope. 12,666,700,000 values, 0 mismatched. Over the 1,000,000 documents and the 6 patterns, `pattern.test(text)`, the walk over keys and the walk over string values say "this document has a match" for exactly the same documents as the loop. The scope bits from the highlighter's pass on the GPU: 32,000,000 words compared with the table loop's, 0 mismatched. The review's independent count, which shares only the document generator with the above, compared what the main kernels returned over everything, string values and keys with `RegExp` over the whole text and over every string value and key of the parsed document. The report's six patterns: 54 searches, 54,000,000 documents' answers, 0 differ. `"[^"]+"` and `Müller`: 10 searches over the whole text, 10,000,000 answers, 0 differ. 8 searches inside string values or keys, 8,000,000 answers, of which 3,780,726 differ from the parsed values and 2,796 from the string tokens as written. A kernel's scope reads the text as written, with its quotes and escapes, which is where the two added patterns differ, see independent.txt.

**5. The map of 1,000,000 documents, ms, 11 paints each.**

| What is painted | Canvas pixels | Writing the pixels and `putImageData` |
| --- | --- | --- |
| one pixel per document, from counts | 1000 by 1000 | 1.72 (1.05 to 1.89) |
| one pixel per document, from bits | 1000 by 1000 | 1.83 (1.14 to 1.91) |
| 2 by 2 pixels per document, from bits | 2000 by 2000 | 2.88 (2.17 to 3.42) |
| the demo page's paintCells, with its gaps | 1000 by 3999 | 6.38 (5.21 to 7.37) |

**6. The program's step and what a rewrite of its operations gives, 100,000 documents as one f32 per code point, ms.** Back to back; after a pause of 200 ms. From `compact-100000`, load average 2.0 to 5.5.

| What runs on the GPU | 8 states | 16 states | 32 states |
| --- | --- | --- | --- |
| the program's own step, as loop-emit.ts writes it | 6.94 (6.87 to 7.50); 16.9 (13.7 to 17.1) | 64.3 (62.5 to 67.2); 76.0 (74.3 to 77.4) | 887 (866 to 901); 904 (873 to 1006) |
| rewrite 1: every 0-or-1 value as a bit, one table read per pair of states | 6.15 (6.01 to 7.09); 16.2 (12.8 to 18.1) | 22.7 (22.4 to 24.1); 33.6 (33.0 to 35.0) | 431 (421 to 510); 437 (428 to 515) |
| rewrite 2: also the reads of one sum as one word | 2.68 (2.62 to 2.92); 8.18 (4.42 to 8.26) | 3.20 (3.10 to 3.59); 11.2 (6.12 to 11.8) | 3.82 (3.77 to 4.05); 13.8 (12.7 to 16.6) |
| `bitRowKernel` as it is, one f32 per code point, a count per document | 3.61 (3.35 to 3.94); 10.9 (10.8 to 12.7) | 3.61 (3.54 to 3.78); 11.7 (11.6 to 11.8) | 4.84 (4.78 to 5.34); 14.2 (8.86 to 14.6) |

