const config = {
  entry: [
    'src/handwiredos/window-manager.ts',
    // The JSON highlighter's measurement, which is run by hand. src/json-highlighter has no page of its own: this
    // script and lab/json-search, which knip doesn't look at, are what import the program.
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
  // scripts/check.ts runs the three tools through bunx, which knip doesn't see. Only lab/ imports pretext, e.g.
  // lab/knuth-plass and lab/ui-exploration/text-walker/batch, and knip doesn't look at lab/.
  ignoreDependencies: ['@typescript/native-preview', 'oxlint', 'oxlint-tsgolint', '@chenglou/pretext'],
  ignoreIssues: {
    // These names distinguish two wire views that currently share one layout.
    'src/handwiredos/photo-gallery.ts': ['duplicates'],
  },
}

export default config
