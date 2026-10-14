### The search step as each code writer writes it, 100,000 documents as one f32 per code point, ms

From `compact-100000`, load average 7.7 to 17.3.  A cell is back to back; after a pause of 200 ms, each as the median with the smallest and the largest sample.

| What runs on the GPU | The search reads | 8 states | 16 states | 32 states |
| --- | --- | --- | --- | --- |
| the program's own step, as loop-emit.ts writes it | everything | 10.3 (7.38 to 17.5); 11.4 (8.96 to 17.7) | 77.2 (68.6 to 88.6); 68.9 (67.9 to 77.7) | 1047 (1022 to 1094); 1011 (995 to 1075) |
| the same step, as bit-emit.ts writes it | everything | 3.63 (3.40 to 4.38); 10.2 (4.36 to 10.7) | 3.93 (3.60 to 4.86); 11.2 (4.25 to 11.9) | 4.61 (4.13 to 5.36); 12.3 (4.38 to 13.9) |
| rewrite 2: also the reads of one sum as one word | everything | 3.21 (2.98 to 3.87); 8.40 (3.85 to 9.38) | 3.71 (3.50 to 4.77); 10.4 (4.76 to 11.1) | 4.54 (4.00 to 5.67); 11.9 (4.85 to 13.5) |
| the step with a scope, which the demo page runs, as loop-emit.ts writes it | everything | 10.3 (7.59 to 17.8); 11.4 (9.05 to 18.1) | 78.3 (64.9 to 89.6); 70.7 (68.1 to 78.0) | 1049 (937 to 1139); 1073 (1042 to 1100) |
| the step with a scope, which the demo page runs, as loop-emit.ts writes it | string values | 10.9 (7.87 to 17.7); 13.8 (8.13 to 23.1) | 77.5 (67.9 to 87.7); 68.8 (65.6 to 80.2) | 1118 (1081 to 1216); 993 (982 to 1005) |
| the step with a scope, which the demo page runs, as loop-emit.ts writes it | keys | 11.9 (8.22 to 18.0); 12.0 (8.64 to 22.8) | 80.3 (66.5 to 90.9); 70.2 (64.9 to 78.6) | 1049 (1024 to 1106); 982 (970 to 1003) |
| the step with a scope, as bit-emit.ts writes it | everything | 4.59 (4.37 to 5.16); 11.2 (4.81 to 11.8) | 4.89 (4.51 to 5.69); 12.3 (5.57 to 14.3) | 5.43 (4.92 to 6.29); 14.5 (7.29 to 15.0) |
| the step with a scope, as bit-emit.ts writes it | string values | 4.58 (4.33 to 5.18); 10.9 (5.25 to 11.8) | 4.89 (4.49 to 5.32); 12.2 (5.53 to 12.9) | 5.17 (4.72 to 6.07); 14.3 (5.70 to 14.8) |
| the step with a scope, as bit-emit.ts writes it | keys | 4.47 (4.29 to 5.21); 10.6 (4.65 to 11.8) | 4.78 (4.50 to 6.14); 12.1 (5.26 to 13.4) | 5.01 (4.67 to 5.95); 7.54 (4.95 to 14.3) |

Compile ms at 8, 16 and 32 states, each shader with a salt that no earlier run used: the program's own step, as loop-emit.ts writes it: 54.8, 184, 642; the same step, as bit-emit.ts writes it: 21.9, 39.8, 112; rewrite 2: also the reads of one sum as one word: 16.8, 30.1, 45.4; the step with a scope, which the demo page runs, as loop-emit.ts writes it: 55.2, 166, 553; the step with a scope, as bit-emit.ts writes it: 32.0, 32.5, 44.1.

Every timed search was compared with the lab's plain JavaScript loop for every document: 5,532 searches, 553,200,000 values, 0 mismatched.

From `writers-100000`, 100,000 documents, load average 8.2 to 14.4.  Every output of bit-emit.ts's shader against loop-emit.ts's on the GPU. The highlighter's summary and display kinds: 51,600,000 values, 0 mismatched. The count and the marks of character-sets.ts's program, for 5 choices of sets: 256,500,000 values, 0 mismatched, 48,340,424 characters counted, and 0 of 500,000 counts differ from plain JavaScript's. The search step's match count of every document and mark of every position, 60 searches (each pattern at each state capacity that holds it, without a scope and with each of three scopes): 3,078,000,000 values, 0 mismatched, and 1,254,405 matches in all. In total 3,386,100,000 values, 0 mismatched.


