# A reusable photo-layout rule

This experiment learns one small function that proposes a photo's width from changing content and viewport features. The same parameters are reused for every item and every collection. It is not another collection whose inputs were optimized and then saved.

In familiar UI terms, this is learned responsive sizing. It predicts preferred widths from the available space and content; ordinary code still wraps rows and measures text. It does not invent a different page structure or choose new controls.

Run the demo with `bun lab/reusable-layout/demo.html`. Run the deterministic three-seed study with `bun lab/reusable-layout/study.ts`; add `--write` to regenerate `model.json` and `results.json`. Run focused checks with `bun test lab/reusable-layout`, `bunx tsgo -p lab/reusable-layout/tsconfig.json`, and `bunx oxlint --type-aware lab/reusable-layout/*.ts`.

## What is learned

The function receives eight numbers: viewport width, photo aspect ratio, measured caption length, importance, active item count, mean aspect ratio, reading position, and mean importance. A 12-unit ReLU hidden layer predicts one preferred width. Its 121 parameters are shared. Following `trainable-geometry.ts`, the parameters live in the numeric source table; training changes those parameters, while inference keeps them fixed and changes the feature cells.

The function runs through the repository's actual numeric circuit and backward pass: 133 operations and five dependency layers per item in this checkout. Inference reuses one compiled evaluator, evaluating the same fixed circuit once per active item, with a maximum of sixteen items. No circuit is rebuilt for a different count. Reading order is explicit data and is restored before layout. Stable IDs do not enter the learned function. Reversing storage order or renumbering IDs leaves geometry unchanged.

An ordinary deterministic JS flow layout consumes the preferred widths. Widths are bounded to 128-416 pixels and the available viewport; rows wrap without reordering items. Image height follows the supplied aspect ratio, and caption height follows measured word wrapping. Vertical scrolling is allowed. There is no visibility parameter, so the learner cannot improve its score by deleting content. Importance and captions are also outside the learner's control.

The predictor is a numeric circuit; the flow decoder, text measurement, objective, and search are JS. This is not a claim that the whole UI is compiled into affine and ReGLU operations. The result establishes transfer within this fixed flow family, not arbitrary layout synthesis.

## Where the targets come from

Targets come from an explicit authored objective, not human examples or click logs. The objective prefers image area proportional to importance, penalizes captions longer than three lines, and mildly penalizes unused row width. It does not reward hiding, cropping away captions, or changing importance. These preferences are not a model of human taste.

Per-layout search starts from ordinary wrapping, scans ten possible widths for every item twice, then refines each width in steps of 16, 8, 4, 2, and 1 pixel. This is coordinate search, not a guarantee of the global optimum. The model learns the resulting width preferences by minimizing squared prediction error. There is no gradient through wrapping and no training against the held-out collections. The model and search use the same width bounds.

The visual assets are the twelve existing local gallery photos. Those source files are square; the experiment varies explicitly chosen center-crop aspect ratios, rather than pretending the source images have different intrinsic dimensions. Captions describe the photos. The training study uses actual Arial 14 word measurements produced with macOS AppKit, saved in `font-metrics.json`; there is no synthetic character-width table. Regenerate those measurements on macOS with `bun lab/reusable-layout/measure-font.ts`. Other platforms use the checked-in values. The browser demo measures its actual Arial font with canvas and renders the resulting lines explicitly. The word wrapper is limited to the supplied ASCII caption corpus, whose words fit the minimum width; it is not a general international text engine.

## Train and test

Training uses collection seeds 1-16, four or eight items, widths 480/768/1080, short captions, and crop ratios 0.8/1/1.4/1.8. That produces 96 layouts and 576 item examples. Adam runs for 160 epochs; the three declared initialization seeds are 17, 41, and 73. The saved demo model is seed 17, selected before looking at held-out results, not the best observed run. Training took 0.8-1.0 seconds per seed in this measurement, excluding target generation.

Both held-out sets use seeds 101-112, six or twelve items, and widths 420/620/900/1180: 96 layouts per set. The short-caption set keeps the training crop family while changing collections, counts, widths, and importance values. The harder set also uses previously unseen longer captions and crop ratios 0.55/0.7/1.15/1.6/2.2/2.6. Photos and their names come from the same small corpus. There is no claim of learning language or recognizing image content.

## Results

Every method retained every required item and reading order, with zero measured text overflow, horizontal overflow, and overlap across both held-out sets. These guarantees mostly come from the decoder, not from learning.

Lower preference loss is better. The shared-rule ranges below span the three declared seeds; search and wrapping are deterministic.

| Method | New counts and widths, short captions | Also new long captions and crops |
| --- | ---: | ---: |
| Ordinary 224-pixel wrapping | 0.3727 | 1.0530 |
| Per-layout search | 0.0229 | 0.1987 |
| Shared learned rule | 0.0259-0.0266 | 0.2854-0.3079 |

The shared rule transferred substantially better than ordinary wrapping, stayed close to the search objective on the easier set, and lost ground on the longer-caption/crop shift. The initial normalized training error fell from 0.0091 to 0.000080 for seed 17. That training improvement does not erase the harder held-out gap.

The wrapping baseline uses a fixed preferred width of 224 pixels, not a carefully tuned responsive formula using the same content features. These results show that a small model can approximate the per-layout search and reuse what it learned. They do not establish that a neural network is necessary or better than a hand-written sizing rule. A comparison with a width-only model would also be needed to measure how much the content features help.

| Method, saved seed 17 | Median CPU time, short / long | 95th percentile CPU time, short / long | Mean total height, short / long |
| --- | ---: | ---: | ---: |
| Wrapping | 1.8 / 2.5 microseconds | 4.4 / 4.7 microseconds | 1404 / 1901 px |
| Per-layout search | 317 / 761 microseconds | 614 / 1329 microseconds | 1110 / 1497 px |
| Shared rule | 18.3 / 14.0 microseconds | 35.1 / 16.0 microseconds | 1204 / 1543 px |

These are warm serial Bun CPU timings. They include preference computation, layout, and line breaking from prepared text, but exclude font measurement, DOM rendering, training, and target generation. Timings vary with machine load; no test pins them. Search is slower but scores better. Ordinary wrapping remains the fastest method. There is no GPU claim.

## Movement is separate

`results.json` includes movement at each held-out width and at width + 1. Those isolated samples miss many wrapping boundaries, so a second study sweeps every integer width from 360 to 1180 for seed 113 with twelve items, using both caption families: 1,640 transitions per method.

| Method, saved seed 17 | Mean movement per 1-pixel resize | Largest mean item movement | Transitions with mean movement above 10 px |
| --- | ---: | ---: | ---: |
| Wrapping | 2.01 px | 939.38 px | 6 / 1640 |
| Per-layout search | 3.84 px | 359.26 px | 53 / 1640 |
| Shared rule | 3.07 px | 369.55 px | 35 / 1640 |

All three methods reflow abruptly. The number in each transition is the mean Euclidean displacement of item top-left positions, not the largest individual displacement. Neither small average movement nor a continuous width predictor establishes a smooth transition. No spring animation is used to hide these changes.

## What to try next

The next useful change is a held-out long-caption training split or a better caption-width feature, followed by the same untouched tests on another caption corpus. The current model receives total caption width but not the widths of individual words, so it cannot exactly predict line breaks. Then test a small amount of explicitly supervised layout preference or human comparison data while keeping content-preservation checks separate. Neither step requires making the function or the operation vocabulary large first.

The tests cover full content retention, reading order, text identity, strict horizontal containment, storage permutation, ID renumbering, reference/tensor agreement, actual transfer, and exact regeneration of the saved model. `results.json` records all three seeds rather than only the favorable examples.
