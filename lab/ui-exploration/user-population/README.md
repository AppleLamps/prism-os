# Simulated user populations running the shipped window circuit

This prototype asks whether the compiled UI itself can be the population simulator for choosing behavior numbers, the way the talk's city of agents lets a policy be tried on a population before it ships. Here each agent is a simulated user and the city is the instance axis of the real compiled window circuit, so a tradeoff table describes the exact shipped behavior rather than a model of it. The behavior numbers are input's drag slop (4 px), double click interval (500 ms) and double click distance (4 px).

**Short answer.** Yes, and it's cheap. 65,536 simulated users ran input's folded window circuit for 600 frames each: 39.3 million user-frames at about 1.2 µs of circuit time each. Every user carried its own state and its own slop, interval and distance. 32 sampled users matched the one-event-at-a-time oracle on every output of every frame, and the population checks found no invariant violation in any user-frame. The tables show that the authored 4 px / 500 ms / 4 px suits low tremor and fails at high tremor: at 2.4-4 px of tremor it cancels 76% of clicks and misses 97% of double clicks. The best slop moves from 3 px to 10 px across tremor segments.

A per-segment table then went into the circuit, selected by a tremor estimate the circuit measures during holds. It adds 522 operations and no layers. After 5 s of use it cut the sum of the four mistake rates from 56.1% (best single setting) to 36.5%, close to the 34.8% of a table that knows each user's true segment, and it matched its own oracle. Two limits showed up. The hands are authored, so the numbers describe synthetic users. And realistic traffic exercises little of the circuit, so the population chooses numbers well but tests the circuit poorly: at a steady 60 fps it noticed 2 of 10 planted corruptions, where input's random trace noticed 8.

## What it is and how to run it

From the repo root:

```sh
bun test lab/ui-exploration/user-population            # 12 tests, about 2 seconds
bunx tsc -p lab/ui-exploration/user-population
bun lab/ui-exploration/user-population/report.ts        # every table below, several minutes, writes results.json (--quick for a short run)
DAWN_WEBGPU=/path/to/node_modules/webgpu/index.js node lab/ui-exploration/user-population/gpu-population.ts 256 600 max
deno run --unstable-webgpu --allow-all lab/ui-exploration/user-population/gpu-population.ts 256 600 none
```

`numeric-ui-core.ts` is imported unchanged through `../../../src/runtime/numeric-ui-core.ts`. No file outside this folder changed. Files from other folders:

- input's `kit.ts`, `events.ts` and `windows.ts` are imported from `../input/`. Until September 15, 2026 this folder held unchanged copies of them, named `kit.ts`, `events.ts` and `input-windows.ts` (`cmp` found no difference).
- codegen's `codegen.ts`, `instance.ts`, `wgsl.ts` and `gpu-runner.ts` are imported from `../codegen/`. Until September 15, 2026 this folder held unchanged copies with the same names.
- `input-traces.ts` holds input's `generateWindowsTrace` and `randomEventTimes`, copied without change except for import paths.
- `fixtures.ts` holds input's window layout plus the lifted distance.

`bunx oxlint --type-aware lab/ui-exploration/user-population` reports nothing. Until September 15, 2026, while this folder held the codegen copies, the same command reported only the `new Function` calls in those copies, which codegen's own folder also reports. `gpu-population.ts` typechecks with the folder but needs Node with Dawn, or Deno, to run, because Bun has no WebGPU. The `webgpu` package was installed in a scratch folder, as codegen's README describes.

| File | What it holds |
| --- | --- |
| `windows.ts` | input's window behaviors with the double click distance in its own cell, the folded builder exported with its per-slot values, and named circuit sections |
| `lifted.ts`, `lifted.test.ts` | the lifted build against input's original, output by output |
| `user-model.ts` | simulated users: hands, timings, tasks, outcomes, counters |
| `population.ts`, `population.test.ts` | the per-user table, state writeback, janky frames, population checks, sampled oracles, a whole run |
| `adaptive.ts`, `adaptive.test.ts` | the tremor estimate measured during holds, the per-segment table, its oracle and circuit |
| `mutation.ts` | planted corruptions and how long each check takes to notice them |
| `analysis.ts` | Pareto fronts, level thresholds, markdown tables |
| `report.ts`, `results.json` | every measurement below |
| `gpu-population.ts`, `gpu-results-dawn.json`, `gpu-results-wgpu.json` | the per-user program as a WGSL compute shader, compared with the CPU every frame |

## What was built

### Lifting the three behavior numbers

input's folded window circuit already kept the slop and the double click interval in source cells, and it read the slop cell a second time as the double click distance. `windows.ts` adds a separate `doubleClickDistance` cell with a declared range of whole pixels in 0..64, and the oracle's double click check reads `config.doubleClickDistance`. Everything else, including the order in which operations are created, is input's. The three behavior cells are then per-user cells in the population: every simulated user can have its own slop, interval and distance without rebuilding the circuit.

### Simulated users

`user-model.ts` authors every number; none comes from people. Frames last 16.6875 ms, and in every population run 2% of frames are janky and last 3 to 7 normal frames. Each user's pointer is sampled every 8 ms at a per-user phase, and a sample becomes an event in the frame that contains it: a down, an up, or a move when the rounded position changed.

- Hands: position = intended position + tremor, rounded to whole pixels. Tremor is an AR(1) process per axis with a 40 ms correlation time. Its standard deviation is the user's tremor amplitude, drawn log-uniform in 0.5..4 px and stratified into 4 segments of equal log width: 0.50-0.84, 0.84-1.41, 1.41-2.38 and 2.38-4.00 px. A user's tempo (log-normal, median 1) scales every duration.
- Timings, log-normal: holds with a median of 95 ms, double click gaps (first up to second down) with a median of 170 ms, gaps between two separate title clicks with a median of 800 ms. The second press of a pair lands around the first with a standard deviation of 0.5 + 0.5 × tremor px per axis.
- Tasks, with weights: body clicks (10%), title clicks (15%), maximize button clicks (15%), double clicks on a title (15%), two separate title clicks meant as single clicks (10%), short nudges of 3 to 12 px along one of 8 directions (20%), and long drags of 60 to 360 px with a minimum-jerk profile (15%).
- Each press aims at what that user's own instance displays: the state columns after the previous frame's writeback, hit-tested by rank. A task's first press on the same window's title comes at least 1,000 ms after the previous task's last title press, so tasks can't pair up into double clicks with each other.

Outcomes come from the circuit's own outputs at the end of each task. A title click that moved its window is a cancelled click, and so is a button click that didn't toggle maximize. A nudge that didn't move its window is lost. A double click that didn't toggle is missed, and a pair of separate clicks that toggled is accidental. For nudges and drags, frames to effect counts frames from the frame where the intended movement begins to the first frame the window follows the pointer. A window that already followed tremor before the movement began counts as 0 frames and as an early drag. Tasks whose down landed outside the intended part (at most 1.3% of tasks for any setting and segment, at the highest tremor) are counted separately and left out of the rates.

### The population harness

`population.ts` splits the source table into per-user cells and shared cells. Per user: every state cell (44), the three behavior cells, and the live cells of the 16 event slots (kind bits, x, y and time), 143 columns in all. Shared: window sizes, the workspace, the title and button sizes, the frame duration, and the unused key bits. codegen's generated instance loop runs the per-user program over blocks of 1,024 users. After every frame the host copies each user's 44 next-state outputs back into that user's state columns, which sit first in the table in output order. This is the part codegen's instance axis never did: state carried across frames per instance. A janky frame changes the shared frame duration cell, so the shared values are computed again for that frame.

Every run also:

- compares 32 sampled users, spread over settings and tremor segments, with the one-event-at-a-time oracle every frame, on every output (state, rectangles, drag owner) with `Object.is`;
- checks every user every frame: one-hot bits exact and mass at most 1 for pressWindow, focus, lastClickWindow and the drag owner outputs, ranks a permutation, and no displayed window outside the workspace. input's promise that at most one of title focus and key focus is set belongs to its combined app, which has no counterpart here.

### The hardened per-segment table

`adaptive.ts` puts the table into the circuit. The circuit measures tremor during holds and selects the slop and double click distance per user:

- For every press, 3 bits record whether the pointer reached 2, 3 or 5 px (Chebyshev, from the press point) among moves at most 100 ms after the down. The bits carry across frames while the press lasts.
- At each release, counter `tremorCount[level]` goes up by 1 when the press reached that level and down by 1 otherwise, clamped to 0..8. A counter at 4 or more means more than half of recent presses reached the level. A press that reaches a higher level also reaches every lower one, so the counters never cross, and the bits `[count >= 4]` read as a thermometer whose sum is the estimated segment.
- The segment's one-hot reads `segmentSlop[segment]` and `segmentDistance[segment]` from table cells through gather reads, once per evaluation, from the counters at the start of the frame. Counters only change at a release, so a press never sees its threshold change.

`adaptiveOracleFrame` is a separate one-event-at-a-time reference. The level thresholds come from the simulated users' own hold excursions: for each boundary, `analysis.ts` picks a level that fewer than half of the lower segment's presses reach and more than half of the upper segment's do.

### Planted corruptions

`mutation.ts` corrupts one live operation at a time, the way hn-thread's `mutation.ts` does: the first coefficient c becomes -c - 1, or the bias grows by 5 when there are no terms. The 10 targets sit at evenly spaced positions of the lifted circuit's live operation list. Three checks run against each corrupted circuit, each compared with the unchanged circuit output by output: a population of 1,024 users at a steady 60 fps, the same population with 2% janky frames, and input's random window trace. Both circuits also output the corrupted wire itself, so each check reports when the corruption first changed that operation's value (activated) and when the change first reached a state or display output (noticed). The unchanged circuit matches the oracle on these users, so a difference from it is a difference from the oracle.

### The GPU

`gpu-population.ts` emits the per-user program with codegen's WGSL emitter and runs it every frame on the same per-user table the CPU uses. It compares every output with the generated JS, with and without codegen's `max(x, lowest)` guard. The simulated users, the writeback and the metrics stay on the CPU.

## Measured results

All numbers are from `bun lab/ui-exploration/user-population/report.ts` on this checkout, saved in `results.json`, except the GPU numbers. Counts and rates are exact for these simulated users. Nanoseconds are single-core generated JS on a machine shared with other agents, so read them as rough.

### Circuit sizes

| circuit | source cells | live operations | layers | stored weights | gather reads |
| --- | ---: | ---: | ---: | ---: | ---: |
| input's folded window circuit, 16 slots, at most 2 downs | 317 | 1,494 | 55 | 6,110 | 35 |
| lifted build, same form | 318 | 1,494 | 55 | 6,110 | 35 |
| lifted build, unrolled, 16 slots | 318 | 5,129 | 142 | 22,459 | 130 |
| adaptive build (tremor estimate and per-segment table), folded | 337 | 2,016 | 55 | 7,681 | 38 |

The tremor estimate adds 522 live operations and no layers: 460 for measuring hold moves against the 3 levels in all 16 slots, 48 for the counters at each release, 12 for the segment and the two table reads, and 2 for aging the press time. It sits beside the press sessions instead of after them, because the counters only feed the next frame.

### The lifted build against input's original

Over input's 20,000-frame random trace (seed 1002, 16 slots, at most 2 downs per frame): 101,771 events, 719 maximize toggles and 383 drag commits, the same counts input's README reports. All 1,280,000 outputs were bit-identical between the two builds, and the lifted build matched the oracle in every frame.

### Stage 1: 64 settings × 1,024 users × 600 frames

Settings: slop 2, 4, 6 and 10 px × double click distance 2, 4, 8 and 16 px × interval 300, 400, 500 and 700 ms. Within each setting, users take the 4 tremor segments in turn, so every setting has 256 users per segment.

| users | frames | user-frames | janky frames | most events / downs in one frame | per-user rows / depth | circuit ns per user-frame | policy ns | checks ns | oracle comparisons (32 users) | mismatches |
| ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 65,536 | 600 | 39,321,600 | 8 | 15 / 2 | 1,494 / 52 | 1,215 | 109 | 60 | 1,228,800 | 0 |

Over all 39,321,600 user-frames the population checks found 0 non-exact one-hot bits, 0 one-hot masses above 1, 0 rank lists that weren't a permutation, and 0 windows outside the workspace.

How much of the queue realistic traffic used:

| events in the frame | 0 | 1 | 2 | 3 | 4 to 15 | 16 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| share of user-frames | 72.6% | 8.06% | 17.6% | 1.38% | 0.39% (155,155 user-frames) | 0 |

Only 4 of 39,321,600 user-frames carried 2 downs, and 1,016,945 carried 1. Frames with 4 or more events all came from janky frames.

Every setting with all tremor segments pooled, the best 10 by the sum of the four mistake rates, plus the authored setting and the worst:

| slop / interval / distance | cancelled clicks % | lost nudges % | missed double clicks % | accidental double clicks % | sum % | drag frames to effect | early drags % |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 6 px / 300 ms / 8 px | 11.58 | 16.93 | 24.54 | 1.90 | 54.95 | 4.09 | 14.5 |
| 6 px / 400 ms / 8 px | 11.81 | 17.52 | 20.20 | 7.60 | 57.12 | 3.86 | 16.0 |
| 6 px / 400 ms / 16 px | 13.45 | 18.92 | 18.73 | 6.51 | 57.62 | 4.07 | 13.9 |
| 6 px / 300 ms / 16 px | 12.71 | 18.42 | 25.22 | 2.48 | 58.83 | 3.80 | 17.5 |
| 6 px / 500 ms / 16 px | 12.99 | 16.64 | 18.95 | 14.86 | 63.43 | 3.92 | 16.5 |
| 6 px / 400 ms / 4 px | 12.97 | 16.51 | 30.06 | 6.49 | 66.03 | 3.78 | 18.6 |
| 6 px / 300 ms / 4 px | 13.40 | 17.65 | 33.21 | 2.51 | 66.77 | 3.92 | 16.1 |
| 6 px / 500 ms / 8 px | 13.59 | 17.82 | 21.30 | 14.51 | 67.22 | 3.83 | 17.8 |
| 10 px / 300 ms / 16 px | 1.52 | 54.96 | 9.78 | 2.63 | 68.88 | 5.81 | 1.8 |
| 10 px / 300 ms / 8 px | 1.91 | 54.35 | 12.31 | 2.92 | 71.49 | 5.61 | 2.5 |
| 4 px / 500 ms / 4 px (authored) | 27.72 | 5.47 | 41.86 | 9.94 | 85.00 | 2.69 | 32.7 |
| 2 px / 700 ms / 2 px (worst) | 56.28 | 0.10 | 68.26 | 14.92 | 139.56 | 1.09 | 62.7 |

A setting has about 3,650 single clicks, 1,660 nudges, 2,335 double clicks, 1,365 pairs of separate clicks and 1,214 long drags. So a 10% rate over 1,660 trials has a standard error of 0.74 points, and about 1.5 points within one tremor segment. Lost long drags were 0 for every setting, because a drag of 60 px or more always crosses a slop of 10 px.

The Pareto front of the four rates plus drag frames to effect holds 51 of the 64 settings, so with five objectives almost nothing is dominated and the front says little. Two objectives at a time say more: 14 settings are on the front of cancelled clicks against lost nudges, and 10 on the front of missed against accidental double clicks. `results.json` marks all three fronts for every setting.

Best setting per tremor segment in stage 1, against the authored setting and the best single setting:

| tremor segment | best for the segment | its sum % | authored 4 px / 500 ms / 4 px, sum % | best single setting 6 px / 300 ms / 8 px, sum % |
| --- | --- | ---: | ---: | ---: |
| 0.50-0.84 px | 4 px / 400 ms / 8 px | 18.79 | 27.76 | 39.30 |
| 0.84-1.41 px | 4 px / 400 ms / 8 px | 20.96 | 36.78 | 36.29 |
| 1.41-2.38 px | 6 px / 400 ms / 8 px | 35.54 | 102.97 | 37.55 |
| 2.38-4.00 px | 10 px / 400 ms / 16 px | 54.01 | 173.75 | 110.83 |

At the highest tremor, the authored setting cancels 76% of clicks and misses 97% of double clicks, and 81% of drags follow the hand before the intended movement begins.

### Stage 2: slop and distance per segment

48 settings × 1,024 users × 600 frames: 29,491,200 user-frames, 13 janky frames, 1,302 ns per user-frame, 0 mismatches over 1,228,800 oracle comparisons, clean checks. Slop 1 to 10, 12 and 14 px × distance 3, 6, 10 and 16 px, at 300 ms, the interval of stage 1's best single setting.

Sum of the four mistake rates (%) per slop, at each segment's best distance:

| slop px | 0.50-0.84 px | 0.84-1.41 px | 1.41-2.38 px | 2.38-4.00 px |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 102.4 | 176.3 | 196.1 | 199.4 |
| 2 | 24.6 | 99.1 | 176.1 | 196.1 |
| 3 | **11.4** | 44.0 | 129.9 | 188.6 |
| 4 | 16.9 | **20.8** | 84.7 | 171.4 |
| 5 | 38.2 | 24.2 | 53.8 | 140.4 |
| 6 | 37.0 | 37.0 | 41.7 | 120.2 |
| 7 | 50.9 | 42.6 | **39.7** | 85.9 |
| 8 | 63.7 | 57.1 | 41.7 | 67.5 |
| 9 | 66.9 | 65.4 | 49.8 | 63.9 |
| 10 | 84.3 | 72.5 | 62.2 | **61.9** |
| 12 | 101.0 | 94.9 | 82.4 | 65.5 |
| 14 | 110.4 | 105.1 | 94.1 | 79.8 |

The per-segment table: slop 3, 4, 7 and 10 px with distance 16, 16, 10 and 16 px. The best single setting of stage 2 is 7 px / 300 ms / 16 px.

Share of presses whose moves within 100 ms of the down reach at least L px from the press point:

| L px | 0.50-0.84 px | 0.84-1.41 px | 1.41-2.38 px | 2.38-4.00 px |
| ---: | ---: | ---: | ---: | ---: |
| 2 | 39.1% | 83.0% | 98.2% | 99.9% |
| 3 | 4.5% | 36.4% | 82.5% | 98.2% |
| 4 | 0.7% | 10.2% | 53.9% | 91.3% |
| 5 | 0.4% | 2.4% | 28.6% | 77.5% |
| 6 | 0.3% | 0.7% | 13.3% | 60.1% |

The chosen level thresholds are 2, 3 and 5 px.

### Closed loop: the table inside the circuit

Three runs with the same 16,384 users, seed and frame schedule, 900 frames each (22 janky frames):

1. Everyone at the best single setting from stage 2 (7 px / 300 ms / 16 px), in the lifted circuit.
2. Each user at its true segment's table row, in the lifted circuit, as if the segment were known.
3. The adaptive circuit with the table (interval 300 ms, levels 2, 3 and 5 px, hold window 100 ms). Every user's counters start in segment 1, the row nearest the best single setting, and the circuit estimates the segment from holds.

| run | circuit ns per user-frame | oracle comparisons (32 users) | mismatches |
| --- | ---: | ---: | ---: |
| best single setting | 1,296 | 1,843,200 | 0 |
| true segment's row | 1,589 | 1,843,200 | 0 |
| adaptive circuit | 2,092 (1,610 over the last 100 frames) | 2,044,800 | 0 |

The population checks were clean in all three runs. Over all 14,745,600 user-frames of the adaptive run, 0 counters left 0..8 or stopped being whole, 0 counters crossed, and 0 hold levels were anything but exact bits.

Sum of the four mistake rates (%), over tasks that end at frame 300 or later (after about 5 s of use):

| tremor segment | best single setting | true segment's row | adaptive circuit |
| --- | ---: | ---: | ---: |
| 0.50-0.84 px | 50.14 | 13.92 | 15.87 |
| 0.84-1.41 px | 44.85 | 23.77 | 26.82 |
| 1.41-2.38 px | 40.28 | 40.38 | 42.38 |
| 2.38-4.00 px | 90.54 | 60.75 | 60.55 |
| all | 56.05 | 34.79 | 36.46 |
| all, every task including the first 5 s | 56.13 | 34.79 | 38.38 |

Pooled over segments after 5 s, the best single setting cancels 8.37% of clicks, loses 25.84% of nudges and misses 19.69% of double clicks. The adaptive circuit gives 2.96%, 18.40% and 12.81%, and the known-segment row 3.23%, 16.06% and 13.24%. Accidental double clicks stay near 2.2% in all three, since the interval is the same. Early drags drop from 10.2% to 3.9%, and drag frames to effect stay near 4.3. The 1.41-2.38 px segment gains nothing, because its row (7 px / 10 px) is nearly the best single setting.

So after 5 s the adaptive circuit recovers 19.6 of the 21.3 points between the best single setting and the known-segment table. Over the whole run, including the start where every user begins in segment 1, it recovers 17.8 points.

Where users spend their user-frames from frame 300 on, as shares of each true segment:

| true segment | estimated 0.50-0.84 px | estimated 0.84-1.41 px | estimated 1.41-2.38 px | estimated 2.38-4.00 px |
| --- | ---: | ---: | ---: | ---: |
| 0.50-0.84 px | 66.6% | 33.3% | 0 | 0 |
| 0.84-1.41 px | 1.7% | 73.2% | 25.1% | 0 |
| 1.41-2.38 px | 0 | 2.8% | 83.1% | 14.2% |
| 2.38-4.00 px | 0 | 0 | 5.9% | 94.1% |

Every misestimate lands in a neighboring segment, mostly the next one up. That's cheap, because users near a boundary have nearly the same best setting.

### Planted corruptions

1,024 users over the 64 stage 1 settings, up to 600 frames per population, and input's random trace up to 20,000 frames:

| wire | section where it was created | corruption | population at a steady 60 fps | population with 2% janky frames | input's random trace |
| ---: | --- | --- | --- | --- | --- |
| 407 | fold: prefix counts and session bits | affine, first coefficient 1 becomes -2 | activated for all users at frame 0, never noticed | noticed at frame 44 by 53 users | frame 229 |
| 613 | fold: session reads | relu, bias grows by 5 | never activated | never activated | never activated |
| 858 | fold: session reads | relu, bias grows by 5 | never activated | never activated | never activated |
| 1,152 | fold: press points and slop crossings | relu, bias grows by 5 | activated, never noticed | frame 44, 342 users | frame 40 |
| 1,349 | fold: press points and slop crossings | product, first coefficient 1 becomes -2 | activated, never noticed | activated, never noticed | frame 8,713 (44,204 events) |
| 1,554 | session 1: down | relu, bias grows by 5 | frame 0, 882 users, median frame 120 | frame 0, 908 users | frame 42 |
| 1,777 | session 1: down | affine, first coefficient 1 becomes -2 | activated for 918 users, never noticed | frame 44, 15 users | frame 1 |
| 1,982 | session 2: down | relu, bias grows by 5 | activated, never noticed | activated, never noticed | frame 40 |
| 2,202 | session 2: down | affine, first coefficient 1 becomes -2 | frame 1, all 1,024 users, median frame 12 | frame 1, all users | frame 1 |
| 2,383 | fold: final pointer and slop latch | relu, bias grows by 5 | never activated | frame 104, 162 users | frame 1 |

The steady population noticed 2 of the 10 corruptions within 600 frames, the population with janky frames 6, and input's random trace 8 within 20,000 frames. The two corruptions that no check activated are relus in the session reads. A relu there can stay at 0 for every legal stream, e.g. the lower relu of "event i is a down in session s" is relu(down + inSession - 2), which never rises above 0 for exact bits, and scaling it changes nothing. Five corruptions changed their own operation's value for every user from the first frame and still never reached an output in the steady population. Four of them did show up once frames carried more events (janky frames) or two downs (input's random trace), which points at later slots and the second press session, though I didn't trace each one to its slot. In these runs a user put at most 3 events and 1 down into a frame at a steady 60 fps, and 15 events and 1 down with janky frames. Section names say where an operation was first created. The builder reuses identical operations, so an operation created while building session 2, e.g. wire 2,202, can also feed session 1, which is why that corruption shows up at once.

### GPU

`gpu-population.ts` ran 16,384 users (64 settings × 256 users) × 600 frames with 2% janky frames on this machine's Apple GPU, through Node 23.10 with Dawn and through Deno 1.42.4 with wgpu, one guard per process. In all four runs the shader matched the generated JS on all 629,145,600 outputs, so 2,516,582,400 outputs without a differing bit. The shader has 2,141 statements, plus 5,882 `max(x, lowest)` guards when guarded. Every product in this circuit is an exact integer, so the contraction and reordering that broke codegen's life calendar and candidate-gallery shaders without the guard change no bits here, like codegen's ownership map.

| stack | guard | upload of the 9.4 MB per-user table, ms per frame | dispatch and readback, ms per frame | shader compile, ms |
| --- | --- | ---: | ---: | ---: |
| Dawn (Node) | max | 2.38 | 1.10 | 113 |
| Dawn (Node) | none | 2.36 | 0.85 | 89 |
| wgpu (Deno) | max | 1.83 | 15.11 | 1,421 |
| wgpu (Deno) | none | 1.92 | 15.32 | 716 |

These are medians over the second half of each run, with the other stack's run on the machine at the same time. Deno's readback takes about 15 ms regardless of size, as codegen measured. The CPU instance loop took about 75-85 ms per frame for the same users in these runs, but it shared the CPU with the other process, so compare orders of magnitude only. An earlier Dawn process that ran both guards back to back at this size crashed with a segmentation fault (exit 139) after about 29 s, like the crash codegen's README describes; with one guard per process both runs passed. `gpu-results-dawn.json` and `gpu-results-wgpu.json` hold the four runs.

## What this shows about how far the approach goes

### What fit well

- **The instance axis carries state across frames with no new builder concepts.** A user is a row of 143 cells, the program is the same 1,494 operations, and the writeback is a copy of 44 values per user. codegen's instance loop, copied unchanged, ran 39.3 million user-frames at about 1.2 µs each.
- **Behavior numbers in cells turn a search into a table write.** 64 settings ran in one compiled program with no rebuild, and giving the double click distance its own cell cost 0 operations.
- **The results describe the shipped behavior, including interactions a model of the behavior would miss.** For example, a cancelled first click turns into a missed double click, windows follow a trembling hand before the drag begins (81% of drags at the authored setting for the highest tremor), and a 3 or 4 px nudge can never cross a 4 px slop (about 11-13% lost nudges even at the lowest tremor).
- **Invariant checks over a population are cheap.** One-hot exactness, rank permutations and workspace bounds for every user every frame cost about 60 ns per user-frame, and found nothing over 39.3 million user-frames. The sampled oracle comparisons add almost nothing.
- **Search results harden into the circuit.** The table became 8 cells plus a 522-operation estimate at no added depth, checked closed loop against a separate oracle, and recovered about 92% of the gap between one setting for everyone and a table that knows each user's segment.
- **Integer decisions are GPU-exact without the guard.** The per-user program ran through WGSL on two WebGPU stacks for 16,384 users × 600 frames, 2.5 billion outputs, with 0 differing bits with and without the guard. Through Dawn, uploading the per-user table and reading every output back took about 3.5 ms per frame.

### What got awkward

- **The hands are authored, like lab/user-effort's simulator.** Every rate says what this behavior does to these synthetic hands. A different tremor correlation, nudge distance or double click gap would move the optima, and no observation of people backs any number here.
- **The objective is a judgment call.** The mistake sum weights four rates equally, and the separate-clicks task exists to produce accidental double clicks. With five objectives the Pareto front held 51 of 64 settings, so the front alone chooses almost nothing. Someone still has to say how much a lost nudge costs against a cancelled click.
- **The two-stage search fixed the interval too early.** Stage 2 used 300 ms, the interval of stage 1's best single setting, while every per-segment optimum in stage 1 used 400 ms. For the 1.41-2.38 px segment, the best sum was 35.5% at 400 ms in stage 1 against 39.7% at 300 ms in stage 2. The space is small enough to search the interval per segment too; I didn't.
- **Sampling noise is close to the differences between neighboring settings.** A rate has about 0.7 points of standard error per setting pooled and 1.5 within a segment. For the highest tremor, slop 9 and 10 px differ by 2 points (63.9% and 61.9%).
- **Realistic traffic covers little of the circuit.** 72.6% of user-frames carry no events, 0.39% carry 4 or more, and 4 in 39 million carry 2 downs. That makes the population a poor test generator: corruptions in later slots and in the second press session went unnoticed, while input's random trace noticed most of them within 40 frames. The population answers "which numbers should ship", random traces answer "is the circuit right", and neither replaces the other.
- **Generated code warms up per run.** Small runs pay several µs per user-frame, e.g. about 6-8 µs over 1,024 users × 400 frames in the quick report, where large runs settle near 1.2 µs.
- **The adaptive table is a new behavior with its own oracle, written twice.** The hold window, level thresholds and counter limits are more numbers to choose; only the thresholds were derived from data, and none were searched.
- **The estimate lags and selects at frame starts.** Counters start in one segment and need several presses to move: over the whole run the adaptive sum was 38.4%, against 36.5% after 5 s. The slop comes from the counters at the start of a frame, so a press that begins in the same frame as a release still uses the older segment. The oracle defines the behavior that way, and the next frame picks it up.
- **GPU round trips, and one crash.** The simulated users live on the CPU, so every frame uploads the whole 9.4 MB per-user table and reads every output back. One Dawn process that ran both guards back to back at 16,384 users × 600 frames segfaulted after about 29 s, while one guard per process passed at the same size.

### What stayed outside the circuit

- The simulated users: aiming, tremor, timings and task outcomes are JS reading the circuit's outputs, about 110-230 ns per user-frame.
- The search: choosing settings, fronts and level thresholds is JS over counters. Only the result became cells.
- Frame splitting: the user model delays a third down in one frame by one sample, as input's JS splitter would split the frame.
- On the GPU, uploads, readback and the writeback copy.

## How it connects to the talk

The talk imagines a city of 100,000 agents where one policy is applied to all of them and its consequences measured before anyone ships it. Here the agents are simulated users and the city is the compiled UI's instance axis: 65,536 users tried 64 policies, and the consequences were measured on the program that would ship, not on a stand-in.

That only works because of homogeneity. The window manager is one numeric program over a table, so "run it for 65,536 users with different numbers" is the same operation as running it for one, the way a shader is the same function for every pixel. No part of the harness knows what a window, a slop or a double click is; that knowledge lives in the circuit and in the simulated hands.

The smaller unit shows up in the numbers themselves. A behavior number stops being a constant in code and becomes a cell, so it can be searched, patched, and differ per user. The hardened table goes one step further: the segment is runtime state the UI measures about its user. The behaviors worth directing only exist at the population level. The U-shaped curves whose minima move from 3 to 10 px appear across many users, and no single interaction shows them.

The talk's warning about premature compression applies twice. "A UI is one instance" hid the population axis, and "a behavior number is part of the code" hid the search. And like the city of agents, the result is only as good as the agents' model of people, which here is authored.

## Open questions and next steps

- **Observed traces instead of authored hands.** Recorded pointer streams, with consent, could replace the motor model, or fit its tremor and timing distributions per person.
- **Search the interval per segment, and put a judgment on the objectives.** Also search the hold window and the level thresholds with the same harness, e.g. with successive halving over settings instead of full grids.
- **Keep state on the GPU.** A second compute pass could do the writeback, so a frame would upload only the event cells and read back only what the simulated users look at.
- **Coverage-guided populations.** Mixing realistic users with bursty users (several downs per frame), or steering users toward operations that were never activated, would make a population a better test generator.
- **How many press sessions per evaluation realistic traffic needs.** 4 of 39.3 million user-frames carried 2 downs. A circuit built for 1 down per evaluation, with JS splitting the rare frames with more, would drop one press session (427 operations and 17 layers in input's measurements).
- **Other doctrine numbers.** Spring stiffness and damping, flick velocity thresholds and overscan in a virtualized list are all cells that a population could choose.
- **The estimate as a setting.** A person could see and override the estimated segment, e.g. as an accessibility setting, and the same counters could estimate tempo for the double click interval.
