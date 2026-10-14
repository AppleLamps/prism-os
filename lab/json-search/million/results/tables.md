### Memory per layout and document count

From the `program` and `load` runs, load average 1.8 to 7.3. The page's thread holds the documents' texts in every row. A process's memory is its footprint, which counts the GPU buffers that the process owns, with the resident size from `ps` in parentheses.

| Layout | Documents | Documents on the GPU | Display kinds or scope bits | Results | GPU buffers in all | JavaScript memory | Chrome's GPU process | The page's renderer process | The run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| today's: one f32 per code point, and one f32 per display kind | 100,000 | 205 MB | 205 MB | 2 MB | 412 MB | 38 MB | 690 MB (375 MB) | 293 MB (420 MB) | ran |
| today's: one f32 per code point, and one f32 per display kind | 250,000 | 513 MB | 512 MB | 5 MB | 1.03 GB | 92 MB | 1.74 GB (693 MB) | 720 MB (849 MB) | ran |
| today's: one f32 per code point, and one f32 per display kind | 500,000 | 1.03 GB | 1.02 GB | 10 MB | 2.06 GB | 180 MB | 3.17 GB (397 MB) | 1.32 GB (605 MB) | ran |
| today's: one f32 per code point, and one f32 per display kind | 1,000,000 | 2.05 GB | 2.05 GB | 20 MB | 4.12 GB | 358 MB | 6.26 GB (1.63 GB) | 2.48 GB (1.99 GB) | ran |
| 512 bytes per document, and 2 scope bits per position | 100,000 | 51 MB | 13 MB | 400 KB | 64 MB | 35 MB | 216 MB (225 MB) | 303 MB (441 MB) | ran |
| 512 bytes per document, and 2 scope bits per position | 250,000 | 128 MB | 32 MB | 1 MB | 161 MB | 86 MB | 356 MB (277 MB) | 340 MB (492 MB) | ran |
| 512 bytes per document, and 2 scope bits per position | 500,000 | 256 MB | 64 MB | 2 MB | 322 MB | 171 MB | 527 MB (282 MB) | 440 MB (600 MB) | ran |
| 512 bytes per document, and 2 scope bits per position | 1,000,000 | 512 MB | 128 MB | 4 MB | 644 MB | 341 MB | 861 MB (291 MB) | 613 MB (780 MB) | ran |
| packed bytes with a start per document, and 2 scope bits per position | 100,000 | 30 MB | 13 MB | 400 KB | 44 MB | 35 MB | 192 MB (211 MB) | 181 MB (323 MB) | ran |
| packed bytes with a start per document, and 2 scope bits per position | 250,000 | 76 MB | 32 MB | 1 MB | 109 MB | 86 MB | 321 MB (240 MB) | 301 MB (452 MB) | ran |
| packed bytes with a start per document, and 2 scope bits per position | 500,000 | 152 MB | 64 MB | 2 MB | 218 MB | 171 MB | 487 MB (245 MB) | 406 MB (568 MB) | ran |
| packed bytes with a start per document, and 2 scope bits per position | 1,000,000 | 305 MB | 128 MB | 4 MB | 437 MB | 341 MB | 818 MB (256 MB) | 581 MB (754 MB) | ran |

- Without the texts in the page, 1,000,000 documents in the fixed layout: JavaScript 5 MB, GPU process 1.15 GB (295 MB), renderer 174 MB (355 MB).
- With the device that every browser gives without being asked, limits {"maxStorageBufferBindingSize":134217728,"maxBufferSize":268435456,"maxStorageBuffersPerShaderStage":8}: 1,000,000 documents in buffers of [128000000,128000000,128000000,128000000] bytes, 105133 documents with a match for `error`, the search in 31 ms. It ran.

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

From the `load` runs: 8 workers write the documents in pieces of 25,000, with their bytes and their scope bits, the page uploads each piece, searches the first piece when it is there, and every document after the last one. One run each, load average 2.3 to 5.0.

| Layout | Documents | The page's script starts | The kernel is compiled | The first piece arrives | The first piece's answer | The last piece arrives | Every piece uploaded | Every document searched | The workers' time, summed: writing the texts, the bytes, the scope bits | The page's writeBuffer calls | Load average |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fixed | 100,000 | 73 | 120 | 240 | 256 | 240 | 264 | 277 | 393, 39, 191 | 10 | 3.92 |
| packed | 100,000 | 62 | 71 | 223 | 238 | 226 | 244 | 257 | 376, 45, 188 | 8 | 3.12 |
| fixed | 250,000 | 54 | 128 | 272 | 293 | 415 | 417 | 431 | 1045, 108, 535 | 20 | 4.09 |
| packed | 250,000 | 55 | 127 | 256 | 276 | 401 | 404 | 421 | 1072, 122, 526 | 20 | 4.23 |
| fixed | 500,000 | 59 | 223 | 248 | 276 | 572 | 574 | 594 | 2047, 204, 1098 | 40 | 4.66 |
| packed | 500,000 | 60 | 141 | 267 | 296 | 593 | 594 | 626 | 2060, 242, 1090 | 39 | 4.4 |
| fixed | 1,000,000 | 69 | 222 | 268 | 299 | 962 | 978 | 1007 | 4188, 420, 2369 | 97 | 3.63 |
| packed | 1,000,000 | 75 | 136 | 281 | 315 | 994 | 1000 | 1054 | 4245, 478, 2351 | 67 | 3.83 |

The scope bits from the JSON highlighter's own pass on the GPU instead, from the `scopes` runs, load average 9.6 to 11.2. One time is every piece: unpack its bytes, run the highlighter, read back its summary, pack its kinds.

| Documents | Pieces | The first time, ms | Back to back, ms | After a pause of 1 s, ms | Compile ms: the highlighter, the unpacking kernel, the packing kernel | The same in plain JavaScript on one thread, ms: the table loop, and packing the bits | Scope words compared with the table loop's, and how many differ | Load average |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100,000 | 2 of 50,000 | 22.3 | 6.87 (5.63 to 14.1) | 11.5 (11.3 to 13.9) | 23.61, 1.555, 1.385 | 190 and 110 | 3,200,000, 0 | 10.54 |
| 1,000,000 | 20 of 50,000 | 68.6 | 50.9 (50.1 to 52.5) | 59.5 (57.9 to 66.4) | 52.055, 18.58, 17.26 | 1442 and 556 | 32,000,000, 0 | 9.59 |

### One search of 1,000,000 documents with a hand-written kernel, ms, the first run

From `compact-1000000`, load average 2.5 to 6.9.  One search runs from before JavaScript compiles the pattern until the results are in a JavaScript array. Back to back is at least 15 searches that follow each other, and after a pause is 9 searches. Consecutive searches use different patterns, the ones that fit the state capacity in turn.

| What runs on the GPU | The search reads | 8 states: back to back | after a pause of 200 ms | 16 states: back to back | after a pause of 200 ms | 32 states: back to back | after a pause of 200 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 28.7 (28.4 to 29.9) | 37.1 (36.9 to 37.4) | 46.8 (34.4 to 65.0) | 45.3 (40.8 to 60.0) | 63.6 (47.3 to 79.3) | 58.5 (52.7 to 77.2) |
| the same kernel on 512 bytes per document | everything | 23.1 (23.1 to 24.0) | 33.0 (32.8 to 33.4) | 30.6 (28.2 to 34.7) | 43.9 (40.7 to 50.3) | 48.4 (40.5 to 61.2) | 55.5 (50.9 to 70.9) |
| with the class of a byte from one table read | everything | 15.2 (15.1 to 16.3) | 24.2 (24.1 to 24.3) | 30.3 (24.6 to 38.1) | 32.8 (30.7 to 39.1) | 47.2 (35.9 to 59.8) | 43.8 (41.3 to 54.2) |
| the same, the documents in four buffers of 128 MiB | everything | 19.1 (17.2 to 22.6) | 27.4 (25.7 to 30.6) | 25.1 (22.3 to 30.3) | 33.2 (30.8 to 37.8) | 31.0 (30.4 to 32.6) | 41.2 (41.0 to 44.4) |
| with 2 scope bits per position | everything | 16.8 (16.4 to 18.1) | 25.6 (25.6 to 26.4) | 21.0 (20.9 to 22.0) | 31.2 (30.7 to 32.9) | 30.7 (30.5 to 32.3) | 42.1 (40.7 to 45.3) |
| with 2 scope bits per position | keys | 16.6 (16.5 to 18.1) | 25.5 (25.3 to 25.6) | 26.5 (22.0 to 33.7) | 35.9 (32.2 to 41.8) | 48.7 (34.7 to 62.4) | 43.9 (40.8 to 54.6) |
| with 2 scope bits per position | string values | 16.6 (16.4 to 18.3) | 25.7 (25.5 to 26.4) | 28.8 (24.6 to 34.5) | 36.3 (33.0 to 43.1) | 43.5 (34.5 to 56.9) | 41.9 (31.9 to 47.8) |
| packed bytes, no scope bits | everything | 36.5 (35.9 to 40.4) | 43.7 (42.9 to 46.6) | 42.9 (39.8 to 48.9) | 58.5 (49.5 to 156) | 53.4 (47.3 to 87.2) | 56.4 (52.0 to 82.9) |
| packed bytes, with scope bits | string values | 38.6 (38.1 to 44.7) | 45.0 (44.5 to 49.8) | 42.7 (41.7 to 49.4) | 57.1 (49.5 to 103) | 50.8 (46.3 to 67.2) | 59.1 (53.7 to 86.8) |
| counts, then a second pass packs them into one bit per document | everything | 15.4 (15.1 to 16.0) | 24.3 (24.2 to 24.7) | 26.8 (24.3 to 30.4) | 32.7 (30.6 to 37.8) | 38.3 (32.0 to 46.4) | 41.3 (39.8 to 48.6) |
| the reverse pass alone, one bit per document | everything | 4.23 (4.12 to 4.67) | 13.7 (13.5 to 15.1) | 10.1 (8.15 to 12.3) | 17.7 (17.4 to 19.0) | 15.5 (13.8 to 18.3) | 24.5 (24.3 to 25.7) |
| the reverse pass alone with scope bits, one bit per document | everything | 4.78 (4.71 to 4.94) | 14.2 (14.1 to 14.2) | 10.6 (8.74 to 13.2) | 18.2 (17.8 to 19.7) | 15.6 (14.3 to 16.7) | 25.0 (24.7 to 26.2) |
| the reverse pass alone with scope bits, one bit per document | keys | 4.58 (4.50 to 5.08) | 14.1 (12.9 to 16.8) | 8.01 (7.68 to 8.82) | 18.2 (17.9 to 18.8) | 14.3 (14.2 to 15.0) | 25.0 (24.6 to 25.0) |
| the reverse pass alone with scope bits, one bit per document | string values | 4.63 (4.58 to 4.76) | 14.1 (14.0 to 14.3) | 10.2 (7.99 to 14.4) | 18.3 (17.9 to 20.5) | 17.5 (14.3 to 20.9) | 25.1 (24.8 to 26.4) |
| packed bytes, the reverse pass alone with scope bits, one bit per document | everything | 5.59 (4.56 to 7.64) | 14.0 (13.8 to 14.1) | 8.74 (7.51 to 10.7) | 17.8 (17.7 to 18.3) | 15.8 (13.7 to 18.3) | 24.4 (24.2 to 25.4) |
| packed bytes, the reverse pass alone with scope bits, one bit per document | string values | 6.13 (5.30 to 7.14) | 14.0 (13.9 to 14.1) | 9.19 (8.06 to 10.8) | 17.8 (17.6 to 18.4) | 13.8 (13.7 to 14.6) | 24.3 (22.3 to 24.6) |

| What runs on the GPU | The search reads | States | Back to back | The compute pass alone, from timestamps | Copying the results out of the mapped buffer | After a pause of 200 ms | After a pause of 1 s | The first search | Compile ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 8 | 28.7 (28.4 to 29.9) | 28.0 (27.9 to 29.2) | 0.07 (0.06 to 0.08) | 37.1 (36.9 to 37.4) | 37.2 (37.0 to 41.6) | 73.0 | 18.4 |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 16 | 46.8 (34.4 to 65.0) | 67.0 (65.0 to 67.2) | 0.07 (0.07 to 0.08) | 45.3 (40.8 to 60.0) | 39.8 (39.3 to 40.0) | 44.5 | 13.6 |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 32 | 63.6 (47.3 to 79.3) | 88.1 (83.4 to 94.7) | 0.09 (0.07 to 0.24) | 58.5 (52.7 to 77.2) | 50.2 (50.0 to 51.5) | 58.4 | 14.2 |
| with the class of a byte from one table read | everything | 8 | 15.2 (15.1 to 16.3) | 14.6 (14.6 to 15.4) | 0.07 (0.06 to 0.20) | 24.2 (24.1 to 24.3) | 24.4 (24.3 to 25.2) | 16.0 | 13.6 |
| with the class of a byte from one table read | everything | 16 | 30.3 (24.6 to 38.1) | 37.8 (37.1 to 38.4) | 0.07 (0.07 to 0.22) | 32.8 (30.7 to 39.1) | 30.0 (29.8 to 32.7) | 23.1 | 14.5 |
| with the class of a byte from one table read | everything | 32 | 47.2 (35.9 to 59.8) | 56.8 (54.9 to 65.1) | 0.07 (0.06 to 0.09) | 43.8 (41.3 to 54.2) | 39.6 (39.5 to 40.0) | 31.6 | 13.1 |
| the reverse pass alone with scope bits, one bit per document | string values | 8 | 4.63 (4.58 to 4.76) | 4.25 (4.24 to 4.57) | 0.01 (0.01 to 0.01) | 14.1 (14.0 to 14.3) | 14.1 (14.0 to 14.2) | 7.68 | 12.3 |
| the reverse pass alone with scope bits, one bit per document | string values | 16 | 10.2 (7.99 to 14.4) | 15.5 (15.0 to 16.0) | 0.01 (0.01 to 0.02) | 18.3 (17.9 to 20.5) | 18.4 (18.0 to 18.8) | 8.63 | 26.9 |
| the reverse pass alone with scope bits, one bit per document | string values | 32 | 17.5 (14.3 to 20.9) | 19.5 (19.2 to 20.7) | 0.01 (0.00 to 0.03) | 25.1 (24.8 to 26.4) | 25.6 (24.9 to 26.2) | 15.3 | 34.6 |

Buffers in this run, bytes: {"fixedBytes":512000000,"scopeBytes":128000000,"packedBytes":300691804,"startsBytes":4000004,"f32Bytes":2052000000}. 

### The same again, with a rest of 2 s before each series, on a busier machine

From `compact-1000000-rested`, load average 6.9 to 11.5.  One search runs from before JavaScript compiles the pattern until the results are in a JavaScript array. Back to back is at least 15 searches that follow each other, and after a pause is 9 searches. Consecutive searches use different patterns, the ones that fit the state capacity in turn.

| What runs on the GPU | The search reads | 8 states: back to back | after a pause of 200 ms | 16 states: back to back | after a pause of 200 ms | 32 states: back to back | after a pause of 200 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 38.5 (32.3 to 80.7) | 44.6 (42.4 to 53.1) | 39.4 (34.1 to 81.5) | 46.6 (43.5 to 55.8) | 64.3 (44.9 to 95.9) | 57.9 (51.9 to 74.9) |
| the same kernel on 512 bytes per document | everything | 33.5 (25.4 to 64.5) | 39.9 (36.2 to 49.8) | 41.7 (30.7 to 70.7) | 35.1 (30.1 to 59.1) | 58.5 (42.4 to 82.8) | 57.4 (52.3 to 74.0) |
| with the class of a byte from one table read | everything | 19.5 (17.7 to 24.9) | 26.3 (20.6 to 28.9) | 26.6 (21.4 to 40.3) | 31.7 (25.3 to 39.7) | 47.8 (31.8 to 69.7) | 45.3 (33.6 to 56.4) |
| the same, the documents in four buffers of 128 MiB | everything | 19.8 (18.3 to 24.6) | 26.9 (25.8 to 28.7) | 26.5 (22.0 to 38.8) | 34.9 (31.7 to 42.4) | 45.4 (33.3 to 66.2) | 43.2 (35.9 to 58.7) |
| with 2 scope bits per position | everything | 21.0 (19.0 to 29.2) | 28.8 (27.4 to 30.6) | 28.4 (22.6 to 46.2) | 32.4 (25.4 to 41.7) | 50.3 (34.6 to 81.9) | 45.1 (39.6 to 62.2) |
| with 2 scope bits per position | keys | 20.8 (19.0 to 27.1) | 28.2 (19.4 to 30.3) | 30.3 (22.4 to 45.2) | 35.5 (33.4 to 40.9) | 49.6 (33.9 to 75.4) | 46.7 (42.5 to 60.6) |
| with 2 scope bits per position | string values | 20.7 (18.9 to 27.2) | 28.0 (24.5 to 29.6) | 27.8 (22.5 to 42.8) | 28.6 (24.1 to 44.9) | 48.7 (34.6 to 74.1) | 48.1 (44.2 to 60.7) |
| packed bytes, no scope bits | everything | 44.4 (42.9 to 49.8) | 47.6 (46.8 to 48.1) | 46.1 (42.1 to 52.5) | 49.3 (47.8 to 52.2) | 53.7 (47.0 to 75.8) | 57.5 (54.4 to 75.2) |
| packed bytes, with scope bits | string values | 47.1 (44.8 to 50.8) | 49.9 (49.4 to 50.2) | 44.2 (42.5 to 47.6) | 50.5 (49.5 to 53.1) | 55.9 (49.5 to 76.7) | 61.7 (50.6 to 75.9) |
| counts, then a second pass packs them into one bit per document | everything | 19.2 (17.0 to 26.4) | 26.8 (26.0 to 28.7) | 26.8 (21.4 to 44.3) | 33.3 (31.4 to 44.6) | 47.1 (32.8 to 70.2) | 46.8 (36.4 to 60.2) |
| the reverse pass alone, one bit per document | everything | 6.00 (5.11 to 7.51) | 13.8 (12.7 to 14.3) | 10.5 (7.85 to 17.6) | 17.7 (16.8 to 18.7) | 21.5 (15.0 to 31.5) | 26.3 (24.9 to 29.1) |
| the reverse pass alone with scope bits, one bit per document | everything | 5.97 (4.92 to 8.38) | 14.3 (8.69 to 17.9) | 11.2 (8.28 to 18.2) | 18.0 (9.62 to 21.5) | 22.5 (15.9 to 30.8) | 25.9 (25.0 to 29.6) |
| the reverse pass alone with scope bits, one bit per document | keys | 6.00 (4.93 to 8.74) | 14.3 (14.2 to 18.0) | 11.5 (8.38 to 19.1) | 18.1 (9.78 to 19.6) | 21.2 (15.5 to 30.4) | 27.2 (24.7 to 31.8) |
| the reverse pass alone with scope bits, one bit per document | string values | 6.12 (5.01 to 9.19) | 14.2 (8.38 to 17.9) | 11.7 (8.39 to 20.9) | 17.8 (14.8 to 20.4) | 21.7 (15.5 to 31.4) | 25.8 (25.0 to 29.6) |
| packed bytes, the reverse pass alone with scope bits, one bit per document | everything | 5.64 (4.75 to 7.53) | 14.2 (14.0 to 17.1) | 10.7 (8.03 to 16.9) | 17.8 (11.3 to 19.1) | 19.6 (14.7 to 27.0) | 25.1 (24.4 to 27.8) |
| packed bytes, the reverse pass alone with scope bits, one bit per document | string values | 6.20 (5.37 to 7.65) | 14.1 (13.7 to 14.3) | 10.5 (8.04 to 16.9) | 17.9 (15.5 to 19.9) | 19.4 (14.7 to 26.5) | 25.4 (24.4 to 28.9) |

| What runs on the GPU | The search reads | States | Back to back | The compute pass alone, from timestamps | Copying the results out of the mapped buffer | After a pause of 200 ms | After a pause of 1 s | The first search | Compile ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 8 | 38.5 (32.3 to 80.7) | 39.7 (32.5 to 53.6) | 0.14 (0.11 to 0.17) | 44.6 (42.4 to 53.1) | 40.0 (39.6 to 43.8) | 51.4 | 59.2 |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 16 | 39.4 (34.1 to 81.5) | 49.6 (43.2 to 58.5) | 0.12 (0.10 to 0.17) | 46.6 (43.5 to 55.8) | 42.4 (41.6 to 43.4) | 72.8 | 67.8 |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 32 | 64.3 (44.9 to 95.9) | 69.9 (50.0 to 88.5) | 0.10 (0.07 to 0.12) | 57.9 (51.9 to 74.9) | 50.4 (50.2 to 54.0) | 257 | 57.4 |
| with the class of a byte from one table read | everything | 8 | 19.5 (17.7 to 24.9) | 19.8 (17.8 to 23.7) | 0.13 (0.11 to 0.18) | 26.3 (20.6 to 28.9) | 25.6 (25.4 to 25.8) | 26.4 | 76.6 |
| with the class of a byte from one table read | everything | 16 | 26.6 (21.4 to 40.3) | 26.0 (20.5 to 41.8) | 0.11 (0.09 to 0.16) | 31.7 (25.3 to 39.7) | 30.3 (30.1 to 31.0) | 22.2 | 79.9 |
| with the class of a byte from one table read | everything | 32 | 47.8 (31.8 to 69.7) | 50.1 (38.0 to 63.4) | 0.09 (0.07 to 0.10) | 45.3 (33.6 to 56.4) | 39.9 (39.3 to 40.8) | 41.8 | 57.5 |
| the reverse pass alone with scope bits, one bit per document | string values | 8 | 6.12 (5.01 to 9.19) | 6.74 (5.01 to 9.60) | 0.01 (0.01 to 0.03) | 14.2 (8.38 to 17.9) | 14.3 (14.0 to 14.5) | 8.91 | 33.7 |
| the reverse pass alone with scope bits, one bit per document | string values | 16 | 11.7 (8.39 to 20.9) | 11.4 (7.88 to 19.8) | 0.02 (0.01 to 0.04) | 17.8 (14.8 to 20.4) | 18.1 (17.8 to 22.8) | 9.71 | 39.8 |
| the reverse pass alone with scope bits, one bit per document | string values | 32 | 21.7 (15.5 to 31.4) | 21.9 (16.6 to 26.4) | 0.01 (0.01 to 0.03) | 25.8 (25.0 to 29.6) | 24.6 (24.3 to 29.4) | 15.3 | 43.2 |

Buffers in this run, bytes: {"fixedBytes":512000000,"scopeBytes":128000000,"packedBytes":300691804,"startsBytes":4000004,"f32Bytes":2052000000}. 

### The main kernels a third time, with a rest of 3 s before each series, and series of 15 searches

From `compact-1000000-short`, load average 5.1 to 9.7.  One search runs from before JavaScript compiles the pattern until the results are in a JavaScript array. Back to back is at least 15 searches that follow each other, and after a pause is 9 searches. Consecutive searches use different patterns, the ones that fit the state capacity in turn.

| What runs on the GPU | The search reads | 8 states: back to back | after a pause of 200 ms | 16 states: back to back | after a pause of 200 ms | 32 states: back to back | after a pause of 200 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 33.4 (30.9 to 37.8) | 39.4 (38.6 to 40.4) | 38.6 (35.3 to 55.4) | 37.7 (33.6 to 45.4) | 68.6 (44.5 to 127) | 61.5 (57.1 to 74.7) |
| with the class of a byte from one table read | everything | 17.2 (17.0 to 17.7) | 25.0 (24.8 to 25.4) | 22.6 (21.8 to 24.8) | 22.8 (22.0 to 41.4) | 44.5 (33.0 to 74.1) | 45.2 (41.9 to 51.7) |
| with 2 scope bits per position | everything | 18.6 (18.1 to 19.2) | 26.2 (18.2 to 36.5) | 24.3 (22.9 to 27.8) | 31.4 (22.2 to 32.1) | 47.6 (34.2 to 83.8) | 46.6 (44.3 to 52.8) |
| with 2 scope bits per position | keys | 18.4 (17.6 to 19.0) | 26.2 (26.1 to 27.6) | 24.0 (22.6 to 26.7) | 26.0 (23.9 to 30.5) | 45.7 (33.8 to 76.5) | 45.7 (43.0 to 51.0) |
| with 2 scope bits per position | string values | 18.4 (17.7 to 19.4) | 26.4 (18.3 to 36.9) | 24.1 (22.6 to 27.2) | 28.9 (21.9 to 32.4) | 41.1 (33.3 to 60.2) | 45.5 (43.5 to 50.2) |
| the reverse pass alone, one bit per document | everything | 4.62 (4.45 to 4.82) | 13.6 (5.40 to 13.8) | 8.05 (7.81 to 8.40) | 17.5 (10.4 to 19.8) | 16.4 (15.4 to 18.7) | 24.3 (23.9 to 34.8) |
| the reverse pass alone with scope bits, one bit per document | everything | 5.13 (4.88 to 5.51) | 14.1 (9.94 to 16.2) | 8.78 (8.38 to 9.14) | 17.7 (9.04 to 18.3) | 17.4 (15.7 to 20.0) | 24.9 (24.6 to 25.6) |
| the reverse pass alone with scope bits, one bit per document | keys | 5.10 (4.83 to 5.14) | 14.1 (13.4 to 14.2) | 8.34 (8.10 to 9.06) | 17.9 (14.8 to 18.0) | 17.4 (15.7 to 19.7) | 25.0 (23.9 to 32.2) |
| the reverse pass alone with scope bits, one bit per document | string values | 5.09 (4.89 to 5.27) | 14.1 (5.51 to 14.7) | 8.54 (8.16 to 8.99) | 17.9 (17.8 to 18.1) | 14.6 (14.4 to 15.4) | 24.5 (24.3 to 24.9) |

| What runs on the GPU | The search reads | States | Back to back | The compute pass alone, from timestamps | Copying the results out of the mapped buffer | After a pause of 200 ms | After a pause of 1 s | The first search | Compile ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 8 | 33.4 (30.9 to 37.8) | 30.9 (29.8 to 31.8) | 0.12 (0.10 to 0.14) | 39.4 (38.6 to 40.4) | 38.7 (38.2 to 42.5) | 58.3 | 71.0 |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 16 | 38.6 (35.3 to 55.4) | 34.1 (32.8 to 37.9) | 0.10 (0.09 to 0.12) | 37.7 (33.6 to 45.4) | 41.9 (41.2 to 43.1) | 63.4 | 48.5 |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 32 | 68.6 (44.5 to 127) | 68.0 (56.7 to 80.5) | 0.09 (0.07 to 0.11) | 61.5 (57.1 to 74.7) | 50.9 (50.2 to 96.1) | 70.4 | 49.8 |
| with the class of a byte from one table read | everything | 8 | 17.2 (17.0 to 17.7) | 15.8 (15.6 to 16.0) | 0.10 (0.09 to 0.13) | 25.0 (24.8 to 25.4) | 25.2 (22.7 to 35.2) | 28.0 | 20.9 |
| with the class of a byte from one table read | everything | 16 | 22.6 (21.8 to 24.8) | 21.0 (20.3 to 21.8) | 0.10 (0.07 to 0.12) | 22.8 (22.0 to 41.4) | 30.3 (30.1 to 33.8) | 28.6 | 60.7 |
| with the class of a byte from one table read | everything | 32 | 44.5 (33.0 to 74.1) | 41.9 (37.1 to 50.7) | 0.09 (0.07 to 0.12) | 45.2 (41.9 to 51.7) | 40.3 (39.8 to 52.2) | 38.1 | 58.6 |
| the reverse pass alone with scope bits, one bit per document | string values | 8 | 5.09 (4.89 to 5.27) | 4.56 (4.38 to 4.72) | 0.01 (0.01 to 0.02) | 14.1 (5.51 to 14.7) | 14.2 (14.1 to 14.3) | 8.13 | 13.9 |
| the reverse pass alone with scope bits, one bit per document | string values | 16 | 8.54 (8.16 to 8.99) | 7.92 (7.79 to 8.10) | 0.01 (0.01 to 0.02) | 17.9 (17.8 to 18.1) | 17.9 (17.8 to 18.0) | 8.61 | 31.6 |
| the reverse pass alone with scope bits, one bit per document | string values | 32 | 14.6 (14.4 to 15.4) | 14.1 (14.0 to 14.4) | 0.01 (0.01 to 0.02) | 24.5 (24.3 to 24.9) | 24.6 (18.3 to 25.6) | 14.9 | 30.6 |

Buffers in this run, bytes: {"fixedBytes":512000000,"scopeBytes":128000000,"packedBytes":300691804,"startsBytes":4000004,"f32Bytes":2052000000}. 

### How steady a back to back series was: its first three and its last three searches, ms

A back to back series is at least 15 searches and 1 s. Where the last searches of a series took much longer than the first ones, the GPU got slower while the series ran, and the series' median says little: the first searches, or the smallest sample, are the better estimate of one search on a GPU that is awake.

| Run | What runs on the GPU | States | Searches | The first three | The last three | After a pause of 200 ms, for comparison | Load average |
| --- | --- | --- | --- | --- | --- | --- | --- |
| compact-1000000 | `bitRowKernel` as it is, one f32 per code point, a count per document | 8 | 35 | 29.6, 28.9, 28.8 | 29.0, 29.9, 29.6 | 37.1 (36.9 to 37.4) | 6.54 to 5.96 |
| compact-1000000 | `bitRowKernel` as it is, one f32 per code point, a count per document | 16 | 21 | 34.4, 35.7, 36.1 | 62.7, 64.9, 65.0 | 45.3 (40.8 to 60.0) | 5.4 to 4.87 |
| compact-1000000 | `bitRowKernel` as it is, one f32 per code point, a count per document | 32 | 16 | 47.3, 48.8, 50.3 | 74.0, 76.4, 79.3 | 58.5 (52.7 to 77.2) | 4.44 to 4.68 |
| compact-1000000 | with the class of a byte from one table read | 8 | 62 | 15.2, 15.5, 15.4 | 15.2, 15.1, 15.1 | 24.2 (24.1 to 24.3) | 5.72 to 5.3 |
| compact-1000000 | with the class of a byte from one table read | 16 | 32 | 24.6, 24.9, 25.4 | 36.0, 36.2, 38.1 | 32.8 (30.7 to 39.1) | 4.8 to 4.7 |
| compact-1000000 | with the class of a byte from one table read | 32 | 22 | 35.9, 37.9, 37.2 | 53.0, 53.7, 59.8 | 43.8 (41.3 to 54.2) | 4.78 to 4.38 |
| compact-1000000 | the reverse pass alone, one bit per document | 8 | 100 | 4.36, 4.32, 4.55 | 4.24, 4.25, 4.19 | 13.7 (13.5 to 15.1) | 4.66 to 4.66 |
| compact-1000000 | the reverse pass alone, one bit per document | 16 | 99 | 8.15, 8.26, 8.24 | 12.3, 12.0, 12.1 | 17.7 (17.4 to 19.0) | 4.25 to 4.31 |
| compact-1000000 | the reverse pass alone, one bit per document | 32 | 64 | 13.8, 13.9, 14.2 | 18.3, 17.5, 17.2 | 24.5 (24.3 to 25.7) | 4.08 to 3.91 |
| compact-1000000 | the reverse pass alone with scope bits, one bit per document | 8 | 100 | 4.62, 4.63, 4.63 | 4.64, 4.61, 4.58 | 14.1 (14.0 to 14.3) | 5.14 to 5.56 |
| compact-1000000 | the reverse pass alone with scope bits, one bit per document | 16 | 94 | 7.99, 7.99, 8.04 | 14.3, 14.2, 14.4 | 18.3 (17.9 to 20.5) | 4.49 to 4.54 |
| compact-1000000 | the reverse pass alone with scope bits, one bit per document | 32 | 58 | 14.4, 14.3, 14.3 | 20.6, 20.5, 20.6 | 25.1 (24.8 to 26.4) | 3.94 to 3.59 |
| compact-1000000-rested | `bitRowKernel` as it is, one f32 per code point, a count per document | 8 | 24 | 32.3, 33.2, 32.9 | 61.6, 69.1, 80.7 | 44.6 (42.4 to 53.1) | 10.22 to 10.57 |
| compact-1000000-rested | `bitRowKernel` as it is, one f32 per code point, a count per document | 16 | 22 | 34.4, 34.4, 34.1 | 67.2, 73.9, 81.5 | 46.6 (43.5 to 55.8) | 9.38 to 9.15 |
| compact-1000000-rested | `bitRowKernel` as it is, one f32 per code point, a count per document | 32 | 15 | 44.9, 45.1, 46.8 | 94.1, 87.8, 95.9 | 57.9 (51.9 to 74.9) | 8.43 to 7.21 |
| compact-1000000-rested | with the class of a byte from one table read | 8 | 46 | 17.9, 17.9, 17.9 | 24.4, 24.5, 24.9 | 26.3 (20.6 to 28.9) | 10.86 to 11.12 |
| compact-1000000-rested | with the class of a byte from one table read | 16 | 34 | 21.4, 22.0, 22.0 | 38.1, 38.7, 40.3 | 31.7 (25.3 to 39.7) | 9.28 to 8.92 |
| compact-1000000-rested | with the class of a byte from one table read | 32 | 21 | 31.8, 32.8, 33.2 | 67.0, 67.1, 69.7 | 45.3 (33.6 to 56.4) | 6.65 to 7.05 |
| compact-1000000-rested | the reverse pass alone, one bit per document | 8 | 100 | 5.18, 5.13, 5.15 | 7.51, 7.43, 7.37 | 13.8 (12.7 to 14.3) | 11.21 to 11.43 |
| compact-1000000-rested | the reverse pass alone, one bit per document | 16 | 88 | 7.91, 7.85, 8.11 | 17.6, 17.4, 17.6 | 17.7 (16.8 to 18.7) | 8.58 to 8.87 |
| compact-1000000-rested | the reverse pass alone, one bit per document | 32 | 46 | 15.0, 15.3, 15.5 | 30.3, 31.5, 31.2 | 26.3 (24.9 to 29.1) | 9.27 to 9.77 |
| compact-1000000-rested | the reverse pass alone with scope bits, one bit per document | 8 | 100 | 5.03, 5.01, 5.20 | 8.94, 9.04, 9.19 | 14.2 (8.38 to 17.9) | 9.29 to 9.08 |
| compact-1000000-rested | the reverse pass alone with scope bits, one bit per document | 16 | 79 | 8.41, 8.39, 8.55 | 20.9, 19.8, 20.9 | 17.8 (14.8 to 20.4) | 9.04 to 8.96 |
| compact-1000000-rested | the reverse pass alone with scope bits, one bit per document | 32 | 45 | 15.5, 15.6, 15.8 | 30.1, 30.1, 31.4 | 25.8 (25.0 to 29.6) | 9.84 to 9 |
| compact-1000000-short | `bitRowKernel` as it is, one f32 per code point, a count per document | 8 | 15 | 30.9, 31.1, 31.8 | 37.2, 37.6, 37.8 | 39.4 (38.6 to 40.4) | 9.66 to 9.5 |
| compact-1000000-short | `bitRowKernel` as it is, one f32 per code point, a count per document | 16 | 15 | 35.6, 35.3, 36.6 | 47.8, 51.1, 55.4 | 37.7 (33.6 to 45.4) | 7.45 to 7.68 |
| compact-1000000-short | `bitRowKernel` as it is, one f32 per code point, a count per document | 32 | 15 | 44.5, 45.7, 47.1 | 115, 127, 125 | 61.5 (57.1 to 74.7) | 6.81 to 6.58 |
| compact-1000000-short | with the class of a byte from one table read | 8 | 15 | 17.7, 17.0, 17.0 | 17.4, 17.4, 17.3 | 25.0 (24.8 to 25.4) | 9.5 to 9.5 |
| compact-1000000-short | with the class of a byte from one table read | 16 | 15 | 21.8, 21.9, 22.4 | 23.7, 24.5, 24.8 | 22.8 (22.0 to 41.4) | 7.68 to 7.64 |
| compact-1000000-short | with the class of a byte from one table read | 32 | 15 | 33.0, 33.9, 34.8 | 64.5, 68.6, 74.1 | 45.2 (41.9 to 51.7) | 6.58 to 6.61 |
| compact-1000000-short | the reverse pass alone, one bit per document | 8 | 15 | 4.45, 4.59, 4.52 | 4.74, 4.69, 4.82 | 13.6 (5.40 to 13.8) | 8.35 to 8.24 |
| compact-1000000-short | the reverse pass alone, one bit per document | 16 | 15 | 7.86, 7.81, 7.88 | 8.29, 8.27, 8.40 | 17.5 (10.4 to 19.8) | 7.77 to 7.65 |
| compact-1000000-short | the reverse pass alone, one bit per document | 32 | 15 | 15.4, 15.4, 15.6 | 18.0, 18.2, 18.7 | 24.3 (23.9 to 34.8) | 6.92 to 6.71 |
| compact-1000000-short | the reverse pass alone with scope bits, one bit per document | 8 | 15 | 5.26, 4.95, 5.27 | 5.21, 5.12, 5.17 | 14.1 (5.51 to 14.7) | 7.66 to 7.45 |
| compact-1000000-short | the reverse pass alone with scope bits, one bit per document | 16 | 15 | 8.20, 8.22, 8.16 | 8.76, 8.71, 8.83 | 17.9 (17.8 to 18.1) | 6.46 to 6.81 |
| compact-1000000-short | the reverse pass alone with scope bits, one bit per document | 32 | 15 | 14.5, 14.5, 14.5 | 15.4, 15.1, 15.4 | 24.5 (24.3 to 24.9) | 6.61 to 6.37 |

### A search after a pause in which the GPU was kept busy, ms

| Documents | What runs on the GPU | The search reads | States | Back to back | The pause | The search after it | Load average |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1,000,000 | with the class of a byte from one table read | everything | 8 | 19.1 (16.9 to 26.8) | 200 ms, nothing in between | 28.7 (19.0 to 37.3) | 10.95 to 11.16 |
| 1,000,000 | with the class of a byte from one table read | everything | 8 | 19.1 (16.9 to 26.8) | 1000 ms, nothing in between | 25.3 (25.2 to 28.2) | 10.95 to 11.16 |
| 1,000,000 | with the class of a byte from one table read | everything | 8 | 19.1 (16.9 to 26.8) | 200 ms, a search of 64 documents every 16 ms | 22.6 (17.8 to 28.4) | 10.95 to 11.16 |
| 1,000,000 | with the class of a byte from one table read | everything | 8 | 19.1 (16.9 to 26.8) | 1000 ms, a search of 64 documents every 16 ms | 25.0 (23.7 to 25.8) | 10.95 to 11.16 |
| 1,000,000 | with the class of a byte from one table read | everything | 8 | 19.1 (16.9 to 26.8) | 1000 ms, a search of 64 documents every 50 ms | 24.4 (22.4 to 25.2) | 10.95 to 11.16 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | everything | 8 | 6.74 (5.17 to 10.8) | 200 ms, nothing in between | 14.3 (11.2 to 14.5) | 11.16 to 10.09 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | everything | 8 | 6.74 (5.17 to 10.8) | 1000 ms, nothing in between | 14.3 (10.2 to 14.5) | 11.16 to 10.09 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | everything | 8 | 6.74 (5.17 to 10.8) | 200 ms, a search of 64 documents every 16 ms | 14.0 (13.2 to 15.8) | 11.16 to 10.09 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | everything | 8 | 6.74 (5.17 to 10.8) | 1000 ms, a search of 64 documents every 16 ms | 14.0 (10.7 to 14.2) | 11.16 to 10.09 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | everything | 8 | 6.74 (5.17 to 10.8) | 1000 ms, a search of 64 documents every 50 ms | 13.2 (8.88 to 14.2) | 11.16 to 10.09 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | keys | 8 | 6.32 (5.04 to 10.0) | 200 ms, nothing in between | 14.3 (8.69 to 15.7) | 10.09 to 8.61 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | keys | 8 | 6.32 (5.04 to 10.0) | 1000 ms, nothing in between | 14.2 (13.2 to 14.5) | 10.09 to 8.61 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | keys | 8 | 6.32 (5.04 to 10.0) | 200 ms, a search of 64 documents every 16 ms | 13.9 (13.1 to 16.3) | 10.09 to 8.61 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | keys | 8 | 6.32 (5.04 to 10.0) | 1000 ms, a search of 64 documents every 16 ms | 14.0 (13.8 to 16.3) | 10.09 to 8.61 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | keys | 8 | 6.32 (5.04 to 10.0) | 1000 ms, a search of 64 documents every 50 ms | 14.0 (13.0 to 14.0) | 10.09 to 8.61 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | string values | 8 | 6.26 (5.07 to 9.54) | 200 ms, nothing in between | 14.2 (10.3 to 14.8) | 8.61 to 8.69 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | string values | 8 | 6.26 (5.07 to 9.54) | 1000 ms, nothing in between | 14.8 (14.6 to 14.9) | 8.61 to 8.69 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | string values | 8 | 6.26 (5.07 to 9.54) | 200 ms, a search of 64 documents every 16 ms | 13.9 (8.05 to 15.9) | 8.61 to 8.69 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | string values | 8 | 6.26 (5.07 to 9.54) | 1000 ms, a search of 64 documents every 16 ms | 14.0 (13.8 to 14.1) | 8.61 to 8.69 |
| 1,000,000 | the reverse pass alone with scope bits, one bit per document | string values | 8 | 6.26 (5.07 to 9.54) | 1000 ms, a search of 64 documents every 50 ms | 13.9 (13.2 to 14.2) | 8.61 to 8.69 |

### One search by document count, 8 states, ms

From the `compact` runs, load average 100,000: 2.7 to 5.3, 250,000: 1.4 to 7.2, 500,000: 3.1 to 7.3, 1,000,000: 2.5 to 6.9. A cell is back to back; after a pause of 200 ms.

| What runs on the GPU | The search reads | States | 100,000 | 250,000 | 500,000 | 1,000,000 |
| --- | --- | --- | --- | --- | --- | --- |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 8 | 3.33 (3.23 to 3.98); 11.0 (10.7 to 11.5) | 9.63 (7.87 to 15.4); 17.1 (13.7 to 24.5) | 15.1 (14.9 to 16.6); 24.1 (15.6 to 30.2) | 28.7 (28.4 to 29.9); 37.1 (36.9 to 37.4) |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 16 | 3.55 (3.50 to 4.70); 11.6 (11.5 to 11.7) | 8.08 (7.75 to 9.71); 17.8 (17.5 to 24.5) | 16.2 (15.8 to 18.1); 25.1 (16.4 to 28.4) | 46.8 (34.4 to 65.0); 45.3 (40.8 to 60.0) |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 32 | 4.77 (4.70 to 6.01); 14.2 (14.0 to 14.3) | 10.8 (10.6 to 11.4); 21.1 (14.7 to 22.1) | 21.6 (20.5 to 24.8); 30.4 (21.7 to 32.6) | 63.6 (47.3 to 79.3); 58.5 (52.7 to 77.2) |
| with the class of a byte from one table read | everything | 8 | 2.02 (1.98 to 2.10); 7.85 (7.39 to 8.00) | 4.15 (4.07 to 4.83); 12.4 (5.34 to 14.0) | 8.19 (7.97 to 8.51); 17.3 (8.12 to 17.9) | 15.2 (15.1 to 16.3); 24.2 (24.1 to 24.3) |
| with the class of a byte from one table read | everything | 16 | 2.38 (2.35 to 3.31); 9.61 (9.37 to 10.2) | 5.36 (5.25 to 5.62); 14.7 (6.03 to 15.2) | 10.5 (10.4 to 10.9); 20.1 (11.0 to 20.5) | 30.3 (24.6 to 38.1); 32.8 (30.7 to 39.1) |
| with the class of a byte from one table read | everything | 32 | 3.50 (3.43 to 3.60); 11.9 (11.7 to 12.0) | 8.83 (7.83 to 9.69); 18.1 (17.9 to 18.9) | 20.0 (16.4 to 24.6); 26.4 (17.6 to 30.8) | 47.2 (35.9 to 59.8); 43.8 (41.3 to 54.2) |
| with 2 scope bits per position | string values | 8 | 2.16 (2.13 to 2.32); 7.82 (7.65 to 7.88) | 4.43 (4.38 to 5.03); 13.1 (12.3 to 13.8) | 8.88 (8.65 to 10.1); 17.8 (9.47 to 18.2) | 16.6 (16.4 to 18.3); 25.7 (25.5 to 26.4) |
| with 2 scope bits per position | string values | 16 | 2.54 (2.49 to 2.71); 9.72 (9.64 to 10.4) | 5.78 (5.59 to 7.12); 15.6 (13.0 to 16.3) | 11.7 (10.9 to 13.7); 20.8 (17.2 to 21.6) | 28.8 (24.6 to 34.5); 36.3 (33.0 to 43.1) |
| with 2 scope bits per position | string values | 32 | 3.58 (3.52 to 4.57); 12.1 (12.1 to 13.8) | 8.29 (8.10 to 8.98); 18.9 (18.3 to 19.2) | 27.3 (17.3 to 45.6); 27.1 (21.8 to 37.8) | 43.5 (34.5 to 56.9); 41.9 (31.9 to 47.8) |
| packed bytes, no scope bits | everything | 8 | 5.51 (5.32 to 7.92); 12.2 (11.9 to 13.3) | 10.5 (10.1 to 13.9); 19.7 (18.4 to 21.2) | 22.5 (19.8 to 28.5); 29.2 (23.8 to 33.7) | 36.5 (35.9 to 40.4); 43.7 (42.9 to 46.6) |
| packed bytes, no scope bits | everything | 16 | 5.88 (5.63 to 7.90); 12.8 (12.3 to 13.9) | 12.8 (11.2 to 17.7); 19.3 (12.9 to 26.4) | 20.1 (19.6 to 26.0); 28.0 (27.6 to 33.3) | 42.9 (39.8 to 48.9); 58.5 (49.5 to 156) |
| packed bytes, no scope bits | everything | 32 | 6.92 (6.42 to 7.59); 14.9 (14.2 to 16.0) | 13.1 (12.6 to 15.5); 21.9 (14.2 to 23.0) | 29.8 (25.6 to 49.2); 36.1 (30.3 to 49.6) | 53.4 (47.3 to 87.2); 56.4 (52.0 to 82.9) |
| the reverse pass alone, one bit per document | everything | 8 | 0.65 (0.63 to 0.74); 2.90 (2.52 to 3.23) | 1.28 (1.23 to 1.41); 5.63 (5.58 to 5.74) | 2.36 (2.27 to 2.88); 9.67 (4.80 to 9.79) | 4.23 (4.12 to 4.67); 13.7 (13.5 to 15.1) |
| the reverse pass alone, one bit per document | everything | 16 | 0.93 (0.90 to 0.96); 4.38 (3.99 to 4.42) | 2.13 (2.02 to 2.42); 9.73 (8.73 to 10.2) | 4.03 (3.77 to 4.78); 12.9 (12.6 to 13.2) | 10.1 (8.15 to 12.3); 17.7 (17.4 to 19.0) |
| the reverse pass alone, one bit per document | everything | 32 | 1.67 (1.63 to 1.74); 7.71 (7.63 to 7.91) | 3.75 (3.69 to 3.94); 12.9 (12.7 to 13.8) | 11.9 (7.99 to 19.4); 17.2 (11.3 to 17.5) | 15.5 (13.8 to 18.3); 24.5 (24.3 to 25.7) |
| the reverse pass alone with scope bits, one bit per document | string values | 8 | 0.69 (0.67 to 0.93); 2.96 (2.79 to 3.10) | 1.40 (1.33 to 2.10); 6.21 (6.03 to 6.86) | 2.51 (2.44 to 2.79); 9.95 (4.11 to 10.3) | 4.63 (4.58 to 4.76); 14.1 (14.0 to 14.3) |
| the reverse pass alone with scope bits, one bit per document | string values | 16 | 1.02 (1.00 to 1.06); 4.59 (4.54 to 5.05) | 2.20 (2.11 to 2.27); 9.73 (8.66 to 10.6) | 4.24 (3.90 to 5.41); 13.4 (13.1 to 13.5) | 10.2 (7.99 to 14.4); 18.3 (17.9 to 20.5) |
| the reverse pass alone with scope bits, one bit per document | string values | 32 | 1.78 (1.66 to 2.01); 8.52 (7.43 to 9.42) | 3.85 (3.83 to 3.98); 13.9 (13.2 to 15.9) | 7.63 (7.50 to 7.95); 17.5 (8.06 to 17.6) | 17.5 (14.3 to 20.9); 25.1 (24.8 to 26.4) |

### The program's own kernel, searcher.ts, what the demo page runs today, ms

From the `program` runs. The time is `timings.totalMs` of the searcher's result, which the demo page's line shows. A search of more than 1.5 s has no pause series.

| Documents | States | The search reads | Patterns | Back to back | The compute pass alone | After a pause of 200 ms | After a pause of 1 s | Searches compared, values, mismatched | Load average |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100,000 | 8 | everything | `error`, `[a-z]+Id`, `[a-z0-9.]+@[a-z.]+`, `([a-z]+)+x` | 7.38 (7.15 to 8.20) | 6.95 (6.78 to 7.56) | 16.8 (8.03 to 17.7) | 17.5 (16.8 to 18.2) | 270, 27,000,000, 0 | 5.25 to 5.32 |
| 100,000 | 8 | string values | `error`, `[a-z]+Id`, `[a-z0-9.]+@[a-z.]+`, `([a-z]+)+x` | 7.30 (7.14 to 8.64) | 6.94 (6.82 to 8.53) | 17.4 (17.3 to 18.0) | 17.4 (17.3 to 18.1) | 273, 27,300,000, 0 | 5.32 to 5.82 |
| 100,000 | 8 | keys | `error`, `[a-z]+Id`, `[a-z0-9.]+@[a-z.]+`, `([a-z]+)+x` | 7.46 (7.29 to 7.79) | 6.89 (6.79 to 8.80) | 17.4 (17.3 to 17.5) | 17.7 (16.1 to 19.4) | 271, 27,100,000, 0 | 5.82 to 6.22 |
| 100,000 | 16 | everything | `\d\d\d\d-\d\d-\d\d` | 65.7 (62.5 to 69.5) | 65.2 (61.2 to 68.4) | 67.4 (65.2 to 72.1) | 76.1 (73.5 to 86.7) | 58, 5,800,000, 0 | 6.22 to 6.51 |
| 100,000 | 32 | everything | `connection reset` | 887 (875 to 899) | 917 (878 to 1007) | 916 (896 to 1011) | 930 (896 to 1043) | 43, 4,300,000, 0 | 6.51 to 6.35 |
| 250,000 | 8 | everything | `error`, `[a-z]+Id`, `[a-z0-9.]+@[a-z.]+`, `([a-z]+)+x` | 16.9 (16.8 to 17.2) | 16.3 (16.2 to 17.0) | 20.7 (17.5 to 31.5) | 26.9 (25.2 to 27.6) | 156, 39,000,000, 0 | 2.83 to 3.07 |
| 250,000 | 8 | string values | `error`, `[a-z]+Id`, `[a-z0-9.]+@[a-z.]+`, `([a-z]+)+x` | 17.1 (16.8 to 17.6) | 16.5 (16.2 to 17.3) | 27.0 (17.4 to 27.5) | 27.0 (26.3 to 27.9) | 156, 39,000,000, 0 | 3.07 to 2.82 |
| 250,000 | 8 | keys | `error`, `[a-z]+Id`, `[a-z0-9.]+@[a-z.]+`, `([a-z]+)+x` | 17.0 (16.7 to 18.0) | 16.3 (16.2 to 17.4) | 23.6 (17.5 to 33.7) | 27.2 (26.7 to 29.3) | 158, 39,500,000, 0 | 2.82 to 3.21 |
| 250,000 | 16 | everything | `\d\d\d\d-\d\d-\d\d` | 153 (153 to 156) | 153 (151 to 158) | 154 (151 to 164) | 166 (163 to 205) | 43, 10,750,000, 0 | 3.21 to 4 |
| 250,000 | 32 | everything | `connection reset` | 2239 (2206 to 2487) |  |  |  | 12, 3,000,000, 0 | 4 to 4.19 |
| 500,000 | 8 | everything | `error`, `[a-z]+Id`, `[a-z0-9.]+@[a-z.]+`, `([a-z]+)+x` | 50.1 (33.0 to 59.1) | 61.7 (55.6 to 62.8) | 42.6 (33.9 to 45.0) | 43.2 (42.8 to 81.9) | 66, 33,000,000, 0 | 5.95 to 5.14 |
| 500,000 | 8 | string values | `error`, `[a-z]+Id`, `[a-z0-9.]+@[a-z.]+`, `([a-z]+)+x` | 43.8 (32.8 to 50.2) | 46.8 (45.7 to 49.8) | 43.6 (40.7 to 48.7) | 43.4 (42.5 to 43.7) | 74, 37,000,000, 0 | 5.14 to 4.44 |
| 500,000 | 8 | keys | `error`, `[a-z]+Id`, `[a-z0-9.]+@[a-z.]+`, `([a-z]+)+x` | 49.8 (33.0 to 52.7) | 47.7 (46.9 to 49.8) | 42.6 (35.6 to 47.6) | 42.6 (42.5 to 43.1) | 71, 35,500,000, 0 | 4.44 to 3.97 |
| 500,000 | 16 | everything | `\d\d\d\d-\d\d-\d\d` | 334 (327 to 341) | 331 (327 to 336) | 314 (311 to 324) | 313 (311 to 317) | 43, 21,500,000, 0 | 3.97 to 3.16 |
| 500,000 | 32 | everything | `connection reset` | 4356 (4299 to 4548) |  |  |  | 11, 5,500,000, 0 | 3.39 to 2.79 |
| 1,000,000 | 8 | everything | `error`, `[a-z]+Id`, `[a-z0-9.]+@[a-z.]+`, `([a-z]+)+x` | 66.1 (64.6 to 67.1) | 64.0 (63.2 to 65.0) | 74.1 (73.9 to 76.0) | 75.5 (74.7 to 76.8) | 55, 55,000,000, 0 | 3.66 to 3.14 |
| 1,000,000 | 8 | string values | `error`, `[a-z]+Id`, `[a-z0-9.]+@[a-z.]+`, `([a-z]+)+x` | 64.7 (64.3 to 68.3) | 63.3 (63.2 to 66.4) | 75.2 (74.3 to 76.9) | 76.1 (75.3 to 77.2) | 55, 55,000,000, 0 | 3.14 to 2.81 |
| 1,000,000 | 8 | keys | `error`, `[a-z]+Id`, `[a-z0-9.]+@[a-z.]+`, `([a-z]+)+x` | 66.0 (64.5 to 66.7) | 63.7 (63.1 to 65.3) | 76.3 (75.0 to 76.6) | 76.3 (74.5 to 81.3) | 55, 55,000,000, 0 | 2.81 to 2.4 |
| 1,000,000 | 16 | everything | `\d\d\d\d-\d\d-\d\d` | 608 (605 to 616) | 604 (597 to 608) | 615 (603 to 632) | 612 (607 to 619) | 43, 43,000,000, 0 | 2.4 to 2.44 |
| 1,000,000 | 32 | everything | `connection reset` | 9071 (8594 to 9335) |  |  |  | 11, 11,000,000, 0 | 2.37 to 2.71 |

Creating the searcher on the page's thread: 100,000: the texts 370 ms, their cells 42.4 ms, the upload, the highlighter's compile and its pass 92.4 ms, in all with the search shader 184 ms. 250,000: the texts 746 ms, their cells 108 ms, the upload, the highlighter's compile and its pass 157 ms, in all with the search shader 312 ms. 500,000: the texts 1505 ms, their cells 215 ms, the upload, the highlighter's compile and its pass 358 ms, in all with the search shader 621 ms. 1,000,000: the texts 3014 ms, their cells 413 ms, the upload, the highlighter's compile and its pass 1185 ms, in all with the search shader 1653 ms.

### The program's step, two rewrites of it and the hand-written kernel, 100,000 documents as one f32 per code point, ms

From `compact-100000`, load average 2.7 to 5.3.  Every engine's answers were compared with the same plain JavaScript loop for every document.

| What runs on the GPU | The search reads | 8 states: back to back | after a pause of 200 ms | 16 states: back to back | after a pause of 200 ms | 32 states: back to back | after a pause of 200 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| the program's own step, as loop-emit.ts writes it | everything | 6.83 (6.79 to 8.79) | 16.9 (16.7 to 17.1) | 63.6 (62.6 to 65.1) | 73.1 (61.3 to 76.5) | 879 (863 to 902) | 906 (878 to 924) |
| rewrite 1: every 0-or-1 value as a bit, one table read per pair of states | everything | 6.08 (6.00 to 6.36) | 16.2 (16.0 to 16.3) | 22.6 (22.3 to 24.6) | 32.6 (32.2 to 33.4) | 432 (416 to 509) | 430 (420 to 539) |
| rewrite 2: also the reads of one sum as one word | everything | 2.68 (2.65 to 2.79) | 8.19 (8.09 to 8.23) | 3.33 (3.25 to 3.63) | 10.2 (10.1 to 11.3) | 3.79 (3.74 to 4.17) | 12.5 (12.4 to 12.6) |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 3.33 (3.23 to 3.98) | 11.0 (10.7 to 11.5) | 3.55 (3.50 to 4.70) | 11.6 (11.5 to 11.7) | 4.77 (4.70 to 6.01) | 14.2 (14.0 to 14.3) |
| with the class of a byte from one table read | everything | 2.02 (1.98 to 2.10) | 7.85 (7.39 to 8.00) | 2.38 (2.35 to 3.31) | 9.61 (9.37 to 10.2) | 3.50 (3.43 to 3.60) | 11.9 (11.7 to 12.0) |
| the reverse pass alone, one bit per document | everything | 0.65 (0.63 to 0.74) | 2.90 (2.52 to 3.23) | 0.93 (0.90 to 0.96) | 4.38 (3.99 to 4.42) | 1.67 (1.63 to 1.74) | 7.71 (7.63 to 7.91) |

Compile ms at 8, 16 and 32 states: program-step: 42.7, 124, 486; rewrite-1: 33.7, 93.1, 361; rewrite-2: 17.1, 20.7, 26.8; f32-kernel: 8.09, 11.7, 12.5.

### Regular JavaScript on one thread, ms

1,000,000 documents, from `js-1000000`, load average 2.8 to 7.4.  Each cell is 9 runs after one run of warmup.

| Pattern | Documents with a match | `texts.filter(text => pattern.test(text)).length` | A walk over objects parsed once: string values | keys | Arrays of strings collected once: string values | keys | The whole-text filter in 8 workers, which isn't what Cheng asked about |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `error` | 105,133 | 189 (189 to 190) | 281 (269 to 286) | 271 (237 to 285) | 152 (145 to 160) | 143 (141 to 145) | 24.2 (24.1 to 24.7) |
| `[a-z]+Id` | 238,302 | 217 (215 to 218) | 290 (283 to 295) | 202 (193 to 212) | 169 (164 to 175) | 118 (117 to 123) | 28.6 (28.2 to 29.0) |
| `[a-z0-9.]+@[a-z.]+` | 143,808 | 331 (323 to 338) | 263 (256 to 292) | 277 (264 to 295) | 165 (157 to 173) | 155 (152 to 158) | 46.3 (45.9 to 47.4) |
| `\d\d\d\d-\d\d-\d\d` | 275,094 | 68.1 (67.5 to 68.7) | 191 (174 to 199) | 226 (216 to 243) | 80.1 (76.9 to 87.6) | 98.5 (96.2 to 99.3) | 9.53 (9.28 to 9.61) |
| `([a-z]+)+x` | 474,433 | 14510 (14024 to 14742) | 4542 (4270 to 4562) | 16562 (16262 to 16802) | 4186 (4096 to 4305) | 15397 (15018 to 15948) | 1773 (1746 to 1797) |
| `connection reset` | 14,271 | 74.0 (73.0 to 74.6) | 222 (203 to 238) | 225 (214 to 242) | 83.3 (77.5 to 87.8) | 93.7 (92.7 to 94.4) | 10.2 (10.2 to 10.3) |

- `JSON.parse` of every document in a `try`: 701 (630 to 720) ms, 1,000,000 valid.
- Once: writing the texts 3219 ms, parsing and keeping every object 792 ms, collecting 7,122,892 string values and 12,808,102 keys 255 ms, and the 8 workers writing their own share of the texts 446 ms.
- JavaScript memory: the texts: 335 MB, renderer process 472 MB (605 MB). the texts and the parsed objects: 599 MB, renderer process 683 MB (810 MB). the texts, the parsed objects and the collected strings: 828 MB, renderer process 927 MB (1.05 GB). the texts in the page and in the workers: 945 MB, renderer process 1.13 GB (1.29 GB).

100,000 documents, from `js-100000`, load average 7.3 to 11.7.  Each cell is 9 runs after one run of warmup.

| Pattern | Documents with a match | `texts.filter(text => pattern.test(text)).length` | A walk over objects parsed once: string values | keys | Arrays of strings collected once: string values | keys | The whole-text filter in 8 workers, which isn't what Cheng asked about |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `error` | 10,559 | 25.6 (24.4 to 25.7) | 31.7 (31.0 to 32.5) | 30.8 (30.5 to 31.5) | 17.4 (17.0 to 18.1) | 16.8 (16.7 to 17.4) | 3.81 (3.48 to 4.61) |
| `[a-z]+Id` | 23,795 | 29.4 (28.8 to 29.7) | 34.8 (34.0 to 36.1) | 24.6 (23.9 to 26.1) | 19.4 (19.0 to 19.7) | 13.7 (13.6 to 14.3) | 4.47 (4.34 to 5.13) |
| `[a-z0-9.]+@[a-z.]+` | 14,481 | 45.7 (44.4 to 52.0) | 35.3 (34.4 to 35.5) | 34.7 (32.9 to 36.8) | 19.8 (19.6 to 20.2) | 20.5 (19.4 to 21.2) | 7.33 (7.01 to 8.31) |
| `\d\d\d\d-\d\d-\d\d` | 27,803 | 8.95 (8.83 to 9.45) | 27.3 (26.0 to 28.4) | 32.8 (30.3 to 33.6) | 10.2 (9.61 to 10.6) | 11.6 (11.5 to 12.5) | 1.50 (1.42 to 1.61) |
| `([a-z]+)+x` | 47,577 | 1721 (1696 to 1874) | 536 (518 to 609) | 2024 (1948 to 2331) | 558 (513 to 615) | 2091 (2022 to 2133) | 260 (222 to 282) |
| `connection reset` | 1,440 | 9.13 (9.06 to 9.37) | 27.0 (26.6 to 27.1) | 30.3 (29.7 to 31.3) | 11.7 (11.4 to 11.9) | 12.0 (11.9 to 12.2) | 1.66 (1.61 to 1.82) |

- `JSON.parse` of every document in a `try`: 82.5 (78.0 to 87.0) ms, 100,000 valid.
- Once: writing the texts 481 ms, parsing and keeping every object 97.2 ms, collecting 713,215 string values and 1,281,001 keys 41.1 ms, and the 8 workers writing their own share of the texts 76.6 ms.
- JavaScript memory: the texts: 35 MB, renderer process 142 MB (265 MB). the texts and the parsed objects: 62 MB, renderer process 109 MB (234 MB). the texts, the parsed objects and the collected strings: 85 MB, renderer process 133 MB (262 MB). the texts in the page and in the workers: 103 MB, renderer process 275 MB (416 MB).


### The whole-text search after a pause of 200 ms, 1,000,000 documents, ms

From `js-pause-1000000`, load average 8.7 to 11.9.  A search of more than 1.5 s has no series after a pause.

| Pattern | One thread, one run after the other | One thread, after a pause | 8 workers, one request after the other | 8 workers, after a pause |
| --- | --- | --- | --- | --- |
| `error` | 231 (229 to 241) | 226 (224 to 248) | 38.7 (37.9 to 39.8) | 30.0 (29.0 to 35.3) |
| `[a-z]+Id` | 273 (271 to 277) | 267 (264 to 276) | 41.2 (36.7 to 44.5) | 42.0 (39.4 to 43.7) |
| `[a-z0-9.]+@[a-z.]+` | 393 (390 to 402) | 404 (379 to 412) | 71.6 (69.9 to 79.8) | 68.7 (63.8 to 70.1) |
| `\d\d\d\d-\d\d-\d\d` | 83.5 (80.1 to 84.3) | 80.4 (78.6 to 82.5) | 13.9 (12.5 to 22.8) | 12.6 (11.8 to 13.4) |
| `([a-z]+)+x` | 18245 (17236 to 19563) |  | 2565 (2441 to 2628) |  |
| `connection reset` | 92.1 (89.2 to 100) | 92.6 (89.3 to 109) | 14.7 (14.1 to 15.0) | 10.7 (10.4 to 13.0) |

### What was compared

Every timed search's results were compared with the plain JavaScript loop over the same automaton (`createBitRowSearch`), for every document of the run: the match count of each document where the kernel returns counts, and whether each document has a match where it returns bits. For a scope, the loop reads `table-loop.ts`'s display kinds as its mask.

| Run | Searches compared | Values compared | Mismatched | Problems |
| --- | --- | --- | --- | --- |
| compact-100000 | 20,718 | 2,071,800,000 | 0 | none |
| compact-1000000-rested | 6,208 | 6,208,000,000 | 0 | none |
| compact-1000000-short | 1,856 | 1,856,000,000 | 0 | none |
| compact-1000000 | 6,816 | 6,816,000,000 | 0 | none |
| compact-250000 | 13,758 | 3,439,500,000 | 0 | none |
| compact-500000 | 9,770 | 4,885,000,000 | 0 | none |
| program-100000 | 915 | 91,500,000 | 0 | none |
| program-1000000 | 219 | 219,000,000 | 0 | none |
| program-250000 | 525 | 131,250,000 | 0 | none |
| program-500000 | 265 | 132,500,000 | 0 | none |
| warm-1000000 | 967 | 967,000,000 | 0 | none |
| in all | 62,017 | 26,817,550,000 | 0 |  |

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
| one pixel per document, from counts | 1000 by 1000 | 3.57 (2.54 to 5.17) | 0.12 (0.10 to 0.13) | 3.69 (2.66 to 5.28) | 33.3 (33.3 to 33.4) |
| one pixel per document, from bits | 1000 by 1000 | 4.64 (2.58 to 5.44) | 0.11 (0.09 to 0.12) | 4.76 (2.69 to 5.55) | 33.3 (32.9 to 33.4) |
| 2 by 2 pixels per document, from bits | 2000 by 2000 | 5.45 (2.59 to 7.20) | 0.42 (0.30 to 0.59) | 5.92 (2.90 to 7.58) | 33.3 (32.9 to 33.4) |
| the demo page's paintCells, with its gaps | 1000 by 3999 | 9.81 (7.44 to 11.2) | 0.36 (0.33 to 0.38) | 10.2 (7.77 to 11.6) | 33.3 (33.3 to 33.4) |

Counting the documents with a match: 1.76 (0.97 to 3.25) ms from 1,000,000 counts, 0.62 (0.42 to 1.57) ms from bits.

100,000 documents, 11 paints each after 3 of warmup, alternating between two searches' results:

| What is painted | Canvas pixels | Writing the pixels | `putImageData` | Both | From the start until the second animation frame after it |
| --- | --- | --- | --- | --- | --- |
| one pixel per document, from counts | 317 by 317 | 0.41 (0.29 to 0.66) | 0.04 (0.02 to 0.06) | 0.45 (0.31 to 0.69) | 33.3 (33.3 to 33.4) |
| one pixel per document, from bits | 317 by 317 | 0.47 (0.24 to 0.67) | 0.04 (0.03 to 0.04) | 0.49 (0.27 to 0.71) | 33.3 (32.6 to 33.4) |
| 2 by 2 pixels per document, from bits | 634 by 634 | 0.88 (0.36 to 1.34) | 0.07 (0.04 to 0.23) | 0.95 (0.40 to 1.43) | 33.3 (32.5 to 34.2) |
| the demo page's paintCells, with its gaps | 1000 by 399 | 2.18 (1.19 to 2.96) | 0.07 (0.05 to 0.11) | 2.23 (1.25 to 3.06) | 33.3 (32.7 to 33.6) |

Counting the documents with a match: 0.53 (0.19 to 1.10) ms from 100,000 counts, 0.13 (0.07 to 0.32) ms from bits.


### The report's tables

**1. Memory at 1,000,000 documents, one run each.** A process's memory is its footprint, with the resident size from `ps` in parentheses.

| Layout | Bytes per document | GPU buffers: documents + kinds or scope bits + results | JavaScript, with the texts in the page | Chrome's GPU process | The page's renderer process | Documents per buffer under WebGPU's default limits |
| --- | --- | --- | --- | --- | --- | --- |
| today's, through searcher.ts | 2,052 + 2,048 | 2.05 GB + 2.05 GB + 20 MB | 358 MB | 6.26 GB (1.63 GB) | 2.48 GB (1.99 GB) | 65,408 |
| bytes, 512 per document | 512 + 128 | 512 MB + 128 MB + 4 MB | 341 MB | 861 MB (291 MB) | 613 MB (780 MB) | 262,144, so four buffers |
| bytes, packed | 301 on average + 4 + 128 | 305 MB + 128 MB + 4 MB | 341 MB | 818 MB (256 MB) | 581 MB (754 MB) | 445,000 on average |
| bytes, 512 per document, no texts in the page | 512 + 128 | 512 MB + 128 MB + 4 MB | 5 MB | 1.15 GB (295 MB) | 174 MB (355 MB) |  |

**2. The load, ms from the navigation, 512 bytes per document, 8 workers, one run each.**

| Documents | The kernel is compiled | The first piece of 25,000 arrives | Its answer is in JavaScript | The last piece arrives | Every document searched | The workers' time, summed: texts, bytes, scope bits | Load average |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100,000 | 120 | 240 | 256 | 240 | 277 | 393, 39, 191 | 3.92 |
| 1,000,000 | 222 | 268 | 299 | 962 | 1007 | 4188, 420, 2369 | 3.63 |

**3. One search of 1,000,000 documents, ms.** A kernel's cell is back to back; after a pause of 200 ms, each as the median with the smallest and the largest sample. From `compact-1000000` (load average 2.5 to 6.9), `program-1000000` (2.3 to 4.0) and `js-1000000` (2.8 to 7.4).

| What runs on the GPU | Patterns of up to 8 states | up to 16 states | up to 32 states |
| --- | --- | --- | --- |
| hand-written kernel on bytes: which documents match, with a scope (string values) | 4.63 (4.58 to 4.76); 14.1 (14.0 to 14.3) | 10.2 (7.99 to 14.4); 18.3 (17.9 to 20.5) | 17.5 (14.3 to 20.9); 25.1 (24.8 to 26.4) |
| the same without a scope | 4.23 (4.12 to 4.67); 13.7 (13.5 to 15.1) | 10.1 (8.15 to 12.3); 17.7 (17.4 to 19.0) | 15.5 (13.8 to 18.3); 24.5 (24.3 to 25.7) |
| hand-written kernel on bytes: a match count per document, with a scope (string values) | 16.6 (16.4 to 18.3); 25.7 (25.5 to 26.4) | 28.8 (24.6 to 34.5); 36.3 (33.0 to 43.1) | 43.5 (34.5 to 56.9); 41.9 (31.9 to 47.8) |
| the same without a scope | 15.2 (15.1 to 16.3); 24.2 (24.1 to 24.3) | 30.3 (24.6 to 38.1); 32.8 (30.7 to 39.1) | 47.2 (35.9 to 59.8); 43.8 (41.3 to 54.2) |
| the same on packed bytes | 36.5 (35.9 to 40.4); 43.7 (42.9 to 46.6) | 42.9 (39.8 to 48.9); 58.5 (49.5 to 156) | 53.4 (47.3 to 87.2); 56.4 (52.0 to 82.9) |
| the lab's `bitRowKernel` as it is, one f32 per code point, a count per document | 28.7 (28.4 to 29.9); 37.1 (36.9 to 37.4) | 46.8 (34.4 to 65.0); 45.3 (40.8 to 60.0) | 63.6 (47.3 to 79.3); 58.5 (52.7 to 77.2) |
| searcher.ts, the program as the page runs it today, one f32 per code point, a count per document | 66.1 (64.6 to 67.1); 74.1 (73.9 to 76.0) | 608 (605 to 616); 615 (603 to 632) | 9071 (8594 to 9335);  |

The same searches in a third run, `compact-1000000-short`, where a series is 15 searches after a rest of 3 s (load average 5.1 to 9.7), again back to back; after a pause of 200 ms. Which documents match, with a scope: 5.09 (4.89 to 5.27); 14.1 (5.51 to 14.7) at 8 states, 8.54 (8.16 to 8.99); 17.9 (17.8 to 18.1) at 16, and 14.6 (14.4 to 15.4); 24.5 (24.3 to 24.9) at 32. A count per document, with a scope: 18.4 (17.7 to 19.4); 26.4 (18.3 to 36.9) at 8 states, 24.1 (22.6 to 27.2); 28.9 (21.9 to 32.4) at 16, and 41.1 (33.3 to 60.2); 45.5 (43.5 to 50.2) at 32.

| Regular JavaScript on one thread, 9 runs each | The five ordinary patterns, the smallest and the largest median | `([a-z]+)+x` |
| --- | --- | --- |
| `texts.filter(text => pattern.test(text)).length`, whole text | 68.1 to 331 | 14510 (14024 to 14742) |
| a walk over objects that were parsed once: string values, and keys | 191 to 290, and 202 to 277 | 4542 (4270 to 4562), and 16562 (16262 to 16802) |
| arrays of strings that were collected once: string values, and keys | 80.1 to 169, and 93.7 to 155 | 4186 (4096 to 4305), and 15397 (15018 to 15948) |
| the whole-text filter in 8 workers, which isn't what Cheng asked about | 9.53 to 46.3 | 1773 (1746 to 1797) |
| `JSON.parse` of every document, the validation at load | 701 (630 to 720) |  |

A pause of 200 ms before the search doesn't change JavaScript's time. In a second run, on a busier machine (`js-pause-1000000`, load average 8.7 to 11.9), the five ordinary patterns took 80.4 to 404 ms on one thread after a pause against 83.5 to 393 ms without one, and 10.7 to 68.7 ms in 8 workers against 13.9 to 71.6 ms.

**4. What was compared.** Every timed search of the 11 kernel and program runs, 62,017 searches, was compared with the lab's plain JavaScript loop over the same automaton for every document of its run: the match count per document where the kernel returns counts, and whether the document has a match where it returns bits, with `table-loop.ts`'s display kinds as the mask for a scope. 26,817,550,000 values, 0 mismatched. Over the 1,000,000 documents and the 6 patterns, `pattern.test(text)`, the walk over keys and the walk over string values say "this document has a match" for exactly the same documents as the loop. The scope bits from the highlighter's pass on the GPU: 32,000,000 words compared with the table loop's, 0 mismatched.

**5. The map of 1,000,000 documents, ms, 11 paints each.**

| What is painted | Canvas pixels | Writing the pixels and `putImageData` |
| --- | --- | --- |
| one pixel per document, from counts | 1000 by 1000 | 3.69 (2.66 to 5.28) |
| one pixel per document, from bits | 1000 by 1000 | 4.76 (2.69 to 5.55) |
| 2 by 2 pixels per document, from bits | 2000 by 2000 | 5.92 (2.90 to 7.58) |
| the demo page's paintCells, with its gaps | 1000 by 3999 | 10.2 (7.77 to 11.6) |

**6. The program's step and what a rewrite of its operations gives, 100,000 documents as one f32 per code point, ms.** Back to back; after a pause of 200 ms. From `compact-100000`, load average 2.7 to 5.3.

| What runs on the GPU | 8 states | 16 states | 32 states |
| --- | --- | --- | --- |
| the program's own step, as loop-emit.ts writes it | 6.83 (6.79 to 8.79); 16.9 (16.7 to 17.1) | 63.6 (62.6 to 65.1); 73.1 (61.3 to 76.5) | 879 (863 to 902); 906 (878 to 924) |
| rewrite 1: every 0-or-1 value as a bit, one table read per pair of states | 6.08 (6.00 to 6.36); 16.2 (16.0 to 16.3) | 22.6 (22.3 to 24.6); 32.6 (32.2 to 33.4) | 432 (416 to 509); 430 (420 to 539) |
| rewrite 2: also the reads of one sum as one word | 2.68 (2.65 to 2.79); 8.19 (8.09 to 8.23) | 3.33 (3.25 to 3.63); 10.2 (10.1 to 11.3) | 3.79 (3.74 to 4.17); 12.5 (12.4 to 12.6) |
| `bitRowKernel` as it is, one f32 per code point, a count per document | 3.33 (3.23 to 3.98); 11.0 (10.7 to 11.5) | 3.55 (3.50 to 4.70); 11.6 (11.5 to 11.7) | 4.77 (4.70 to 6.01); 14.2 (14.0 to 14.3) |

### The documents and the patterns, from stats.ts

1,000,000 documents, written and measured in 14.5 s
- 299,197,444 UTF-16 units, 299,197,444 code points, 299.2 per document, the longest 512
- 251,885 documents hold a code point past U+007F, and 46,600 hold one past U+00FD, which a byte stores as 255
- as UTF-8: 299,958,257 bytes, the longest document 528 bytes, 1,492 documents longer than 512 bytes
- one f32 per code point: 2052 MB, and as much again for the display kinds
- 512 bytes per document: 512 MB. Packed, each document padded to 4 bytes: 301 MB, and 4 MB for where each document starts
- 2 scope bits per position: 128 MB. One match count per document: 4 MB. One bit per document: 125 KB

| Pattern | States | Classes | Class boundaries | The largest boundary | The same matches on bytes |
| --- | --- | --- | --- | --- | --- |
| `error` | 6 | 3 | 6 | U+0073 | yes |
| `[a-z]+Id` | 4 | 3 | 6 | U+007B | yes |
| `[a-z0-9.]+@[a-z.]+` | 4 | 3 | 8 | U+007B | yes |
| `\d\d\d\d-\d\d-\d\d` | 11 | 2 | 4 | U+003A | yes |
| `([a-z]+)+x` | 3 | 2 | 4 | U+007B | yes |
| `connection reset` | 17 | 9 | 15 | U+0075 | yes |
| `"[^"]+"` | 4 | 2 | 2 | U+0023 | yes |
| `Müller` | 7 | 5 | 10 | U+00FD | yes |
| `.+` | 2 | 1 | 6 | U+202A | no |
| `東京` | 3 | 2 | 4 | U+6772 | no |

`東京` has a match in 23,115 documents. On bytes, where both of its code points are 255, a kernel could at best find two neighbors of 255, which 34,396 documents have.

