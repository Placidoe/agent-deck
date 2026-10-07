module.exports = {
  appId: "ai.agentdeck.desktop",
  productName: "Agent Deck",
  electronVersion: "33.4.11",
  electronDist: "../research/labs/grokbot-desktop/node_modules/electron/dist",
  npmRebuild: true,
  directories: {
    output: "release",
  },
  files: [
    "desktop/**/*",
    "shared/**/*",
    "dist/client/**/*",
    "package.json",
  ],
  extraMetadata: {
    main: "desktop/main.cjs",
  },
  mac: {
    icon: "desktop/assets/icon.png",
    category: "public.app-category.developer-tools",
    target: ["dir"],
    artifactName: "Agent-Deck-${version}-${arch}.${ext}",
    extendInfo: {
      NSMicrophoneUsageDescription: "Agent Deck uses your microphone for real-time voice conversations with Codex.",
    },
  },
  dmg: {
    title: "Agent Deck ${version}",
  },
};
