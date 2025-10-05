export default {
  packagerConfig: {
    name: "RhythmDNA",
    executableName: "RhythmDNA",
    arch: ['arm64'],
    platform: ['darwin'],
    icon: './build/icon.icns',
    appBundleId: 'com.rhythmdna.app',
    appCategoryType: 'public.app-category.music',
      appVersion: '1.1.0',
      buildVersion: '1.1.0',
    asar: false,
    ignore: [
      /^\/app\/py\/\.venv/,  // Only exclude .venv in app/py/
      /^\/\.git/,            // Exclude .git at root
      /^\/\.DS_Store/,       // Exclude .DS_Store
      /^\/out/,              // Exclude build output
      /^\/Versions/,         // Exclude version backups
      /^\/z_FOR CLAUDE/      // Exclude documentation folder
    ]
    // DO NOT exclude node_modules - Electron needs them!
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin']
    },
    {
      name: '@electron-forge/maker-dmg',
      config: {
        name: 'RhythmDNA',
        title: 'RhythmDNA Installer',
        background: './build/dmg-background.png',
        icon: './build/icon.icns',
        iconSize: 80,
        contents: (opts) => [
          { x: 448, y: 344, type: 'link', path: '/Applications' },
          { x: 192, y: 344, type: 'file', path: opts.appPath }
        ],
        window: {
          width: 640,
          height: 480
        },
        format: 'ULFO'
      }
    }
  ]
};
