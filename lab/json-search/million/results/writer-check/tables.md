### The program's step, two rewrites of it and the hand-written kernel, 100,000 documents as one f32 per code point, ms

From `compact-100000`, load average 7.6 to 20.0.  Every engine's answers were compared with the same plain JavaScript loop for every document.

| What runs on the GPU | The search reads | 8 states: back to back | after a pause of 200 ms | 16 states: back to back | after a pause of 200 ms | 32 states: back to back | after a pause of 200 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| the program's own step, as loop-emit.ts writes it | everything | 9.70 (7.01 to 12.2) | 16.8 (7.88 to 22.6) | 65.9 (64.7 to 69.3) | 68.2 (66.4 to 74.9) | 1075 (1023 to 1135) | 989 (974 to 1029) |
| rewrite 1: every 0-or-1 value as a bit, one table read per pair of states | everything | 6.45 (6.09 to 7.00) | 16.4 (6.90 to 18.6) | 34.1 (25.4 to 42.0) | 33.9 (24.3 to 39.4) | 555 (521 to 674) | 500 (467 to 568) |
| rewrite 2: also the reads of one sum as one word | everything | 2.80 (2.63 to 3.18) | 8.44 (5.16 to 8.77) | 3.59 (3.32 to 4.28) | 10.9 (4.72 to 11.7) | 4.54 (4.08 to 5.64) | 13.3 (5.19 to 13.7) |
| `bitRowKernel` as it is, one f32 per code point, a count per document | everything | 3.83 (3.48 to 4.74) | 10.8 (4.00 to 11.1) | 4.12 (3.79 to 5.89) | 12.7 (5.38 to 14.6) | 5.58 (5.04 to 7.71) | 14.4 (6.09 to 17.4) |

Compile ms at 8, 16 and 32 states: program-step: 54.1, 158, 589; rewrite-1: 37.9, 105, 538; rewrite-2: 18.1, 23.2, 54.1; f32-kernel: 9.87, 14.5, 16.8.

### The search step as each code writer writes it, 100,000 documents as one f32 per code point, ms

From `compact-100000-five-engines`, load average 5.5 to 11.9.  A cell is back to back; after a pause of 200 ms, each as the median with the smallest and the largest sample.

| What runs on the GPU | The search reads | 8 states | 16 states | 32 states |
| --- | --- | --- | --- | --- |
| the program's own step, as loop-emit.ts writes it | everything | 7.32 (6.92 to 9.77); 12.2 (7.72 to 17.4) | 66.5 (63.2 to 70.2); 67.6 (64.7 to 69.8) | 1072 (940 to 1216); 1007 (1002 to 1063) |
| the same step, as bit-emit.ts writes it | everything | 3.37 (3.25 to 4.02); 9.21 (3.98 to 10.3) | 3.71 (3.47 to 4.55); 10.9 (6.50 to 11.3) | 5.00 (4.44 to 6.42); 13.7 (5.79 to 18.0) |
| rewrite 2: also the reads of one sum as one word | everything | 2.94 (2.81 to 3.62); 8.21 (3.19 to 9.22) | 3.58 (3.33 to 4.37); 9.66 (3.92 to 10.9) | 4.05 (3.93 to 5.38); 13.2 (4.96 to 15.7) |
| the step with a scope, which the demo page runs, as loop-emit.ts writes it | everything | 7.68 (7.32 to 9.29); 11.1 (7.66 to 24.5) | 77.6 (69.2 to 94.6); 69.3 (67.6 to 70.8) | 1092 (1062 to 1174); 1026 (1003 to 1088) |
| the step with a scope, which the demo page runs, as loop-emit.ts writes it | string values | 7.64 (7.37 to 9.36); 8.82 (7.58 to 18.1) | 74.0 (67.7 to 89.2); 69.9 (67.5 to 74.4) | 1098 (1041 to 1164); 1024 (1011 to 1059) |
| the step with a scope, which the demo page runs, as loop-emit.ts writes it | keys | 9.25 (7.37 to 12.5); 10.6 (8.21 to 17.9) | 75.0 (66.5 to 91.2); 67.1 (66.0 to 72.7) | 1079 (993 to 1182); 1008 (985 to 1065) |
| the step with a scope, as bit-emit.ts writes it | everything | 4.56 (4.33 to 5.29); 10.8 (4.57 to 11.3) | 4.57 (4.31 to 5.28); 10.0 (4.81 to 12.9) | 5.26 (4.80 to 6.73); 14.0 (5.71 to 15.4) |
| the step with a scope, as bit-emit.ts writes it | string values | 4.36 (4.11 to 5.66); 11.2 (5.21 to 13.2) | 4.67 (4.38 to 5.98); 10.9 (4.78 to 12.6) | 5.13 (4.81 to 6.11); 14.5 (5.88 to 15.3) |
| the step with a scope, as bit-emit.ts writes it | keys | 4.45 (4.22 to 5.46); 10.7 (4.67 to 11.8) | 4.70 (4.43 to 5.13); 11.6 (4.97 to 12.6) | 5.71 (5.03 to 7.67); 14.0 (6.55 to 14.8) |

Compile ms at 8, 16 and 32 states, each shader with a salt that no earlier run used: the program's own step, as loop-emit.ts writes it: 49.2, 150, 654; the same step, as bit-emit.ts writes it: 19.5, 32.5, 72.4; rewrite 2: also the reads of one sum as one word: 60.2, 73.3, 71.8; the step with a scope, which the demo page runs, as loop-emit.ts writes it: 47.3, 244, 868; the step with a scope, as bit-emit.ts writes it: 23.3, 25.4, 58.1.

Every timed search was compared with the lab's plain JavaScript loop for every document: 5,650 searches, 565,000,000 values, 0 mismatched.

From `compact-100000`, load average 7.6 to 20.0.  A cell is back to back; after a pause of 200 ms, each as the median with the smallest and the largest sample.

| What runs on the GPU | The search reads | 8 states | 16 states | 32 states |
| --- | --- | --- | --- | --- |
| the program's own step, as loop-emit.ts writes it | everything | 9.70 (7.01 to 12.2); 16.8 (7.88 to 22.6) | 65.9 (64.7 to 69.3); 68.2 (66.4 to 74.9) | 1075 (1023 to 1135); 989 (974 to 1029) |
| the same step, as bit-emit.ts writes it | everything | 3.31 (3.12 to 4.03); 9.81 (6.72 to 10.2) | 3.83 (3.58 to 4.87); 11.5 (4.34 to 12.0) | 4.86 (4.32 to 6.20); 13.8 (6.26 to 19.3) |
| rewrite 2: also the reads of one sum as one word | everything | 2.80 (2.63 to 3.18); 8.44 (5.16 to 8.77) | 3.59 (3.32 to 4.28); 10.9 (4.72 to 11.7) | 4.54 (4.08 to 5.64); 13.3 (5.19 to 13.7) |
| the step with a scope, which the demo page runs, as loop-emit.ts writes it | everything | 7.45 (7.13 to 10.9); 17.2 (7.64 to 26.3) | 69.9 (65.2 to 71.5); 70.8 (64.5 to 74.2) | 1078 (1019 to 1116); 1002 (979 to 1015) |
| the step with a scope, which the demo page runs, as loop-emit.ts writes it | string values | 11.1 (7.32 to 15.4); 17.4 (8.34 to 24.6) | 69.6 (66.4 to 73.9); 68.6 (65.0 to 76.9) | 1108 (1066 to 1250); 1002 (998 to 1023) |
| the step with a scope, which the demo page runs, as loop-emit.ts writes it | keys | 7.42 (7.15 to 9.16); 17.1 (7.98 to 25.1) | 71.7 (66.5 to 79.9); 69.6 (67.1 to 74.0) | 1051 (1035 to 1145); 988 (975 to 1008) |
| the step with a scope, as bit-emit.ts writes it | everything | 4.37 (4.16 to 6.24); 11.7 (4.99 to 12.6) | 4.93 (4.58 to 6.39); 11.1 (5.12 to 13.1) | 5.66 (5.24 to 8.31); 14.8 (6.36 to 15.8) |
| the step with a scope, as bit-emit.ts writes it | string values | 4.48 (4.17 to 5.36); 11.4 (4.75 to 12.6) | 5.15 (4.78 to 7.55); 12.4 (5.13 to 14.0) | 5.75 (5.11 to 6.98); 14.7 (6.09 to 15.0) |
| the step with a scope, as bit-emit.ts writes it | keys | 4.43 (4.21 to 4.99); 11.9 (4.58 to 12.3) | 4.78 (4.46 to 5.70); 10.8 (5.49 to 13.2) | 5.69 (5.07 to 8.32); 14.0 (6.51 to 15.0) |

Compile ms at 8, 16 and 32 states, each shader with a salt that no earlier run used: the program's own step, as loop-emit.ts writes it: 54.1, 158, 589; the same step, as bit-emit.ts writes it: 17.2, 24.7, 56.7; rewrite 2: also the reads of one sum as one word: 18.1, 23.2, 54.1; the step with a scope, which the demo page runs, as loop-emit.ts writes it: 46.5, 149, 641; the step with a scope, as bit-emit.ts writes it: 18.7, 28.2, 69.2.

Every timed search was compared with the lab's plain JavaScript loop for every document: 6,950 searches, 695,000,000 values, 0 mismatched.

From `writers-100000`, 100,000 documents, load average 5.8 to 6.0.  Every output of bit-emit.ts's shader against loop-emit.ts's on the GPU. The highlighter's summary and display kinds: 51,600,000 values, 0 mismatched. The count and the marks of character-sets.ts's program, for 5 choices of sets: 256,500,000 values, 0 mismatched, 48,340,424 characters counted, and 0 of 500,000 counts differ from plain JavaScript's. The search step's match count of every document and mark of every position, 60 searches (each pattern at each state capacity that holds it, without a scope and with each of three scopes): 3,078,000,000 values, 0 mismatched, and 1,254,405 matches in all. In total 3,386,100,000 values, 0 mismatched.


