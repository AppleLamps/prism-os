# Gallery source fixture

`index.ts.txt` and `data.ts.txt` are copied from `chenglou/chenglou.github.io`, commit `f315d5864a21b9e10126b741456e232d8ece681e` (June 20, 2026, "Require finite photo gallery container width"). This is the last committed revision of those files before the July compiler experiment. Its statement locations and photo count match the historical report. The experiment did not record a content hash at the time, so the fixture's provenance is this Git revision, not a claim that an unrecorded July working tree was identical.

The `.txt` suffix keeps the browser application out of this lab's type checking. Tests parse the contents as TypeScript; they do not start the application. Native validation includes only the declarations used by each tested function or statement slice.

The copies have the same Git blob hashes as that revision: `index.ts` is `d7a859358d0a6a406b5d068c87803fdc57e1bc24`, and `data.ts` is `d26a64ccb3e077e48292579d0501652a905acf94`.

Default tests and reports use these fixtures. `bun lab/trace-compiler/report.ts --live` separately checks the current files in `~/github/chenglou.github.io`; source changes may make that optional check reject. Update a fixture only when deliberately measuring a new source revision, and preserve its provenance here.
