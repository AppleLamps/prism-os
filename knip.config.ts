const config = {
  entry: [
    'src/handwiredos/window-manager.ts',
    // The JSON highlighter's measurement, which is run by hand. src/json-highlighter has no page of its own: this
    // script and lab/json-search, which knip doesn't look at, are what import the program. So this entry is the only
    // one that reaches src/json-highlighter and src/runtime/prefix-networks.ts: without it, knip reports
    // highlighter.ts, kinds.ts, tables.ts and prefix-networks.ts as unused files. If the script is ever removed,
    // another entry takes its place, e.g. 'src/json-highlighter/highlighter.ts'.
    'scripts/measure-json-highlighter.ts',
    'lab/candidate-gallery/candidate-gallery.ts',
    'template/main.ts',
    // The template's switch in plain JavaScript, which only template/toggle.test.ts imports.
    'template/toggle-reference.ts',
  ],
  // lab/ holds standalone experiments that run as scripts or tests, so knip only checks src/, scripts/ and the template.
  project: ['*.ts', 'src/**/*.ts', 'scripts/*.ts', 'template/*.ts'],
  // Bun otherwise discovers tests as entries before the ignore is applied.
  bun: false,
  // Test imports should not keep production exports alive. An export that stays for tests/ or lab/,
  // e.g. validateGrids, has a /** @public */ comment above its declaration, which knip skips.
  ignore: ['**/*.test.ts'],
  ignoreExportsUsedInFile: true,
  // scripts/check.ts runs tsc and oxlint through bunx, which knip doesn't see, and knip never reports the typescript
  // package. Only lab/ imports pretext, e.g. lab/knuth-plass and lab/ui-exploration/text-walker/batch, and knip doesn't
  // look at lab/. typescript6 is TypeScript 6, the last version written in JavaScript, which only lab/trace-compiler
  // imports, for the compiler API that TypeScript 7 doesn't have. Its name sorts after "typescript", so Bun links
  // node_modules/.bin/tsc to TypeScript 7: of two packages with a `tsc` binary, Bun 1.4.3 links the one whose name
  // sorts first. scripts/check.ts stops if `bunx tsc` is ever another compiler than the typescript package's.
  ignoreDependencies: ['oxlint', 'oxlint-tsgolint', '@chenglou/pretext', 'typescript6'],
}

export default config
