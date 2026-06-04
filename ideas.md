do not change this before asking the user

1. Make behavior numeric, not just state numeric.
Current demo proves dynamic state:

click x/y changes
focused rectangle changes
viewport changes
Next prove dynamic behavior:

layoutMode = 0 -> 2x2 grid
layoutMode = 1 -> horizontal row
layoutMode = 2 -> vertical stack
Same fixed executor. Same compiled circuit. Only table numbers change.

2. Move app constants into the table.
Things like gap, focused padding, columns, enabled flags, maybe colors-as-ids should become table cells. The circuit should contain fewer app-specific baked biases. This tests your “underivable sources and constants in the table” rule more honestly.

3. Add a tiny behavior panel.
Not because UI controls matter, but because it forces clarity:

layoutMode
focusEnabled
gap
visible0..visible3
Changing controls should mutate table numbers only. No new branches, no recompilation.

4. Test behavior combinations exhaustively.
For four rectangles, we can brute-force small modes:

3 layout modes
focus on/off
visibility masks
click/no click
This becomes a crisp proof that the fixed numeric machine covers a small dynamic UI space.

5. Define table cell classes.
Still all numbers, but conceptually separate:

environment: viewport, pointer
state: focused id, click latch
constants: gap, fixed dimensions
behavior: layout mode, focus enabled, visibility mask
This helps answer the dynamic state vs dynamic behavior question without adding traditional names to runtime.

6. Generate UI by editing numbers, not code.
Give an agent a target such as:

put these four rectangles in a row
hide rectangle 3
clicking rectangle 2 should reveal rectangle 3
Then let it modify only behavior cells in the table. The executor never changes. This tests the thesis directly: can an agent make a UI by manipulating numeric state rather than emitting JavaScript?

7. Store relations, not just properties.
Your `n*n` idea becomes useful when it means something concrete:

row i, column j = how much item i is affected by item j
Examples:

j covers i
j pushes i in layout
clicking j reveals i
j is the next keyboard-focus item after i
For four rectangles that is a tiny fixed relation table. Then the same executor could derive occlusion, grouping, navigation, reveal behavior, and perhaps layout pressure from numeric relationships.

That is more interesting than merely storing left, top, visible.

8. Make one UI whose structure changes through relations.
A good demo could start as four independent rectangles, then by changing numbers only become:

a stack where one covers another
a row where items push each other
tabs where selecting one reveals its panel
a parent item that reveals two children
No tree objects. No app-specific helper names. Just slots plus relation numbers plus the universal executor.

9. Batch possible futures.
This is particularly machine-friendly: evaluate several possible next tables at once.

candidate 0 = focus item 1
candidate 1 = focus item 2
candidate 2 = expand group
candidate 3 = change layout
An agent or scoring rule picks one result. That begins to resemble model-style inference: propose several numeric futures, score them, commit one.

10. Add hard validity channels.
If an agent is editing raw numbers, the machine should compute whether the resulting UI is valid:

no negative sizes
no forbidden overlap
one focused item maximum
click targets visible
content remains on screen
This is important: the format becomes editable by machines only if wrong edits are quickly detectable.

11. Try inverse layout.
Instead of coding “row layout,” specify desired output:

rectangle centers should be evenly spaced
all visible rectangles should fit in viewport
selected rectangle should occupy most area
