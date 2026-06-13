const config = {
  entry: [
    'window-manager.ts',
    'candidate-gallery.ts',
    'learned-gallery.ts',
  ],
  // Bun otherwise discovers tests as entries before the ignore is applied.
  bun: false,
  // Test imports should not keep production exports alive.
  ignore: ['**/*.test.ts'],
  ignoreExportsUsedInFile: true,
  ignoreIssues: {
    // These names distinguish two wire views that currently share one layout.
    'photo-gallery.ts': ['duplicates'],
  },
}

export default config
