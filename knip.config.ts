const config = {
  entry: [
    'window-manager.ts',
    'candidate-gallery.ts',
    'learned-gallery.ts',
    'hard-attend.ts',
  ],
  // lab/ and exp/ hold standalone experiments that run as scripts or tests, so knip only checks root modules and scripts.
  project: ['*.ts', 'scripts/*.ts'],
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
