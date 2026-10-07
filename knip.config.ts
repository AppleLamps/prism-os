const config = {
  entry: [
    'src/handwiredos/window-manager.ts',
    'src/json-highlighter/main.ts',
    // The JSON highlighter's measurements, which are run by hand.
    'scripts/measure-json-highlighter.ts',
    'scripts/measure-json-highlighter-browser.ts',
    'lab/candidate-gallery/candidate-gallery.ts',
    'template/main.ts',
    // The template's switch in plain JavaScript, which only template/toggle.test.ts imports.
    'template/toggle-reference.ts',
  ],
  // lab/ holds standalone experiments that run as scripts or tests, so knip only checks src/, scripts/ and the template.
  project: ['*.ts', 'src/**/*.ts', 'scripts/*.ts', 'template/*.ts'],
  // Bun otherwise discovers tests as entries before the ignore is applied.
  bun: false,
  // Test imports should not keep production exports alive.
  ignore: ['**/*.test.ts'],
  ignoreExportsUsedInFile: true,
  // scripts/check.ts runs these tools through bunx, which knip doesn't see.
  ignoreDependencies: ['@typescript/native-preview', 'oxlint', 'oxlint-tsgolint'],
  ignoreIssues: {
    // These names distinguish two wire views that currently share one layout.
    'src/handwiredos/photo-gallery.ts': ['duplicates'],
  },
}

export default config
