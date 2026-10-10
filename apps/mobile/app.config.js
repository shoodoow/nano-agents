const path = require("node:path");
const { load } = require("@expo/env");

// Load apps/mobile/.env before Metro inlines EXPO_PUBLIC_* (pnpm filter keeps cwd here).
load(path.resolve(__dirname));

const { expo } = require("./app.json");

// Plain http is only for a core on this machine (emulator or simulator). A
// build pointed at an https core ships with cleartext traffic switched off.
const coreUrl = process.env.EXPO_PUBLIC_CORE_URL ?? "";
const usesCleartextTraffic = coreUrl.startsWith("http://");

/** @type {import("expo/config").ExpoConfig} */
module.exports = {
  expo: {
    ...expo,
    android: { ...expo.android, usesCleartextTraffic },
    extra: {
      ...(expo.extra ?? {}),
      coreUrl: coreUrl || undefined,
    },
  },
};
