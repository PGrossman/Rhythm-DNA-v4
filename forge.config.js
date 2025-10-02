export default {
  packagerConfig: {
    name: "RhythmDNA",
    executableName: "RhythmDNA",
    arch: ['arm64'], // Only build for ARM64 (Apple Silicon)
    platform: ['darwin'], // Only macOS
    icon: './build/icon.icns', // App icon (macOS requires .icns format)
    appBundleId: 'com.rhythmdna.app',
    appCategoryType: 'public.app-category.music',
    appVersion: '2.0.0',
    buildVersion: '2.0.0'
    // Note: Code signing disabled for now - you can add osxSign config if you have a developer certificate
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
        format: 'ULFO' // Compressed format
      }
    }
  ]
};


