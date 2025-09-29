export default {
  packagerConfig: {
    name: "RhythmDNA",
    executableName: "RhythmDNA",
    arch: ['arm64'], // Only build for ARM64 (Apple Silicon)
    platform: ['darwin'], // Only macOS
    icon: './app/assets/icon.png', // App icon
    appBundleId: 'com.rhythmdna.app',
    appCategoryType: 'public.app-category.music',
    appVersion: '1.0.0',
    buildVersion: '1.0.0'
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
        title: 'RhythmDNA Installer',
        icon: './app/assets/icon.png',
        iconSize: 80,
        contents: [
          { x: 448, y: 344, type: 'link', path: '/Applications' },
          { x: 192, y: 344, type: 'file', path: 'RhythmDNA.app' }
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


