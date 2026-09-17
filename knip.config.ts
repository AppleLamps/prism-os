const config = {
  entry: [
    'window-manager.ts',
    'lab/candidate-gallery/candidate-gallery.ts',
    'template/main.ts',
    // The template's switch in plain JavaScript, which only template/toggle.test.ts imports.
    'template/toggle-reference.ts',
  ],
  // lab/ holds standalone experiments that run as scripts or tests, so knip only checks root modules, scripts and the template.
  project: ['*.ts', 'scripts/*.ts', 'template/*.ts'],
  // Bun otherwise discovers tests as entries before the ignore is applied.
  bun: false,
  // Test imports should not keep production exports alive.
  ignore: ['**/*.test.ts'],
  ignoreExportsUsedInFile: true,
  // scripts/check.ts runs these tools through bunx, which knip doesn't see.
  ignoreDependencies: ['@typescript/native-preview', 'oxlint', 'oxlint-tsgolint'],
  ignoreIssues: {
    // These names distinguish two wire views that currently share one layout.
    'photo-gallery.ts': ['duplicates'],
  },
}

export default config
