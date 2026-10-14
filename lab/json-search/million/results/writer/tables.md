### The search step as each code writer writes it, 100,000 documents as one f32 per code point, ms

From `compact-100000-second`, load average 5.7 to 9.0.  A cell is back to back; after a pause of 200 ms, each as the median with the smallest and the largest sample.

| What runs on the GPU | The search reads | 8 states | 16 states | 32 states |
| --- | --- | --- | --- | --- |
| the program's own step, as loop-emit.ts writes it | everything | 7.18 (6.99 to 7.92); 17.2 (8.11 to 17.5) | 63.1 (61.3 to 67.6); 65.5 (62.7 to 66.9) | 944 (933 to 976); 972 (924 to 1016) |
| the same step, as bit-emit.ts writes it | everything | 3.49 (3.37 to 4.05); 9.89 (3.86 to 10.2) | 3.43 (3.25 to 4.16); 11.0 (10.7 to 11.5) | 4.42 (4.22 to 5.72); 13.5 (7.45 to 14.1) |
| rewrite 2: also the reads of one sum as one word | everything | 2.96 (2.88 to 3.75); 8.57 (8.26 to 8.86) | 3.35 (3.23 to 3.71); 10.6 (3.67 to 10.9) | 3.99 (3.89 to 5.12); 13.0 (5.38 to 13.6) |
| the step with a scope, which the demo page runs, as loop-emit.ts writes it | everything | 7.71 (7.40 to 9.34); 17.4 (7.64 to 17.8) | 65.2 (62.7 to 68.8); 65.7 (64.1 to 68.3) | 941 (933 to 1010); 994 (979 to 1037) |
| the step with a scope, which the demo page runs, as loop-emit.ts writes it | string values | 7.61 (7.33 to 8.47); 17.3 (8.02 to 17.7) | 66.1 (63.8 to 68.6); 66.4 (64.2 to 67.7) | 1045 (1008 to 1161); 1033 (985 to 1104) |
| the step with a scope, which the demo page runs, as loop-emit.ts writes it | keys | 7.56 (7.35 to 8.27); 17.2 (8.43 to 17.4) | 66.4 (63.1 to 69.3); 66.3 (63.8 to 69.7) | 1106 (1093 to 1161); 1094 (1041 to 1134) |
| the step with a scope, as bit-emit.ts writes it | everything | 4.42 (4.22 to 5.25); 11.3 (4.45 to 11.9) | 4.49 (4.32 to 4.95); 12.0 (5.29 to 12.2) | 5.55 (5.11 to 6.32); 14.1 (6.42 to 14.6) |
| the step with a scope, as bit-emit.ts writes it | string values | 4.30 (4.13 to 4.61); 11.1 (4.97 to 11.6) | 4.60 (4.33 to 5.15); 11.9 (4.63 to 12.3) | 5.62 (5.12 to 6.75); 14.2 (6.91 to 17.5) |
| the step with a scope, as bit-emit.ts writes it | keys | 4.32 (4.20 to 4.99); 11.1 (4.88 to 11.4) | 4.52 (4.36 to 6.14); 11.9 (5.03 to 12.1) | 5.53 (4.98 to 8.98); 14.2 (6.75 to 18.3) |

Compile ms at 8, 16 and 32 states, each shader with a salt that no earlier run used: the program's own step, as loop-emit.ts writes it: 47.8, 130, 543; the same step, as bit-emit.ts writes it: 20.0, 21.7, 39.3; rewrite 2: also the reads of one sum as one word: 15.6, 21.6, 26.8; the step with a scope, which the demo page runs, as loop-emit.ts writes it: 52.0, 144, 655; the step with a scope, as bit-emit.ts writes it: 21.0, 21.2, 48.7.

Every timed search was compared with the lab's plain JavaScript loop for every document: 5,743 searches, 574,300,000 values, 0 mismatched.

From `compact-100000`, load average 4.5 to 8.9.  A cell is back to back; after a pause of 200 ms, each as the median with the smallest and the largest sample.

| What runs on the GPU | The search reads | 8 states | 16 states | 32 states |
| --- | --- | --- | --- | --- |
| the program's own step, as loop-emit.ts writes it | everything | 7.68 (7.04 to 9.80); 11.5 (7.43 to 26.1) | 65.0 (63.2 to 67.4); 67.8 (64.3 to 70.5) | 919 (903 to 925); 1015 (998 to 1071) |
| the same step, as bit-emit.ts writes it | everything | 3.52 (3.15 to 4.43); 6.62 (4.21 to 11.1) | 3.66 (3.37 to 4.42); 9.41 (4.08 to 12.1) | 4.78 (4.24 to 6.66); 8.79 (4.55 to 14.7) |
| rewrite 2: also the reads of one sum as one word | everything | 3.01 (2.63 to 3.62); 8.46 (3.36 to 10.0) | 3.67 (3.29 to 4.46); 10.3 (3.75 to 11.2) | 4.36 (3.96 to 5.41); 6.32 (4.55 to 13.9) |
| the step with a scope, which the demo page runs, as loop-emit.ts writes it | everything | 7.82 (7.48 to 9.29); 16.1 (8.41 to 19.5) | 67.2 (65.8 to 70.6); 68.5 (66.7 to 69.9) | 1133 (1053 to 1193); 1069 (1037 to 1128) |
| the step with a scope, which the demo page runs, as loop-emit.ts writes it | string values | 8.28 (7.47 to 10.7); 9.30 (7.66 to 18.5) | 66.3 (65.3 to 69.0); 67.1 (66.3 to 68.4) | 1178 (1109 to 1272); 1117 (1090 to 1163) |
| the step with a scope, which the demo page runs, as loop-emit.ts writes it | keys | 7.64 (7.24 to 8.04); 12.8 (7.82 to 18.4) | 66.8 (66.0 to 69.1); 67.6 (66.6 to 72.8) | 1118 (1077 to 1351); 1037 (1009 to 1080) |
| the step with a scope, as bit-emit.ts writes it | everything | 4.43 (4.04 to 5.34); 11.1 (5.04 to 11.9) | 4.75 (4.38 to 5.17); 11.6 (5.40 to 12.8) | 5.50 (4.88 to 6.87); 14.3 (11.1 to 15.0) |
| the step with a scope, as bit-emit.ts writes it | string values | 4.48 (4.10 to 4.95); 6.26 (4.75 to 11.7) | 4.75 (4.41 to 5.78); 6.26 (5.17 to 13.6) | 5.80 (5.24 to 8.76); 14.1 (7.93 to 14.4) |
| the step with a scope, as bit-emit.ts writes it | keys | 4.59 (4.20 to 5.36); 10.7 (5.71 to 12.3) | 4.93 (4.33 to 5.97); 11.7 (5.48 to 13.4) | 5.70 (5.15 to 7.12); 14.1 (7.75 to 14.3) |

Compile ms at 8, 16 and 32 states, each shader with a salt that no earlier run used: the program's own step, as loop-emit.ts writes it: 43.9, 138, 612; the same step, as bit-emit.ts writes it: 17.4, 32.3, 37.9; rewrite 2: also the reads of one sum as one word: 15.4, 25.3, 28.0; the step with a scope, which the demo page runs, as loop-emit.ts writes it: 46.0, 148, 568; the step with a scope, as bit-emit.ts writes it: 84.0, 61.9, 169.

Every timed search was compared with the lab's plain JavaScript loop for every document: 5,676 searches, 567,600,000 values, 0 mismatched.

From `writers-100000`, 100,000 documents, load average 10.1 to 24.9.  Every output of bit-emit.ts's shader against loop-emit.ts's on the GPU. The highlighter's summary and display kinds: 51,600,000 values, 0 mismatched. The search step's match count of every document and mark of every position, 60 searches (each pattern at each state capacity that holds it, without a scope and with each of three scopes): 3,078,000,000 values, 0 mismatched, and 1,254,405 matches in all. In total 3,129,600,000 values, 0 mismatched.


