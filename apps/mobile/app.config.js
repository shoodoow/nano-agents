const path = require("node:path");
const { load } = require("@expo/env");

// Load apps/mobile/.env before Metro inlines EXPO_PUBLIC_* (pnpm filter keeps cwd here).
load(path.resolve(__dirname));

const { expo } = require("./app.json");

/** @type {import("expo/config").ExpoConfig} */
module.exports = {
  expo: {
    ...expo,
    extra: {
      ...(expo.extra ?? {}),
      coreUrl: process.env.EXPO_PUBLIC_CORE_URL,
    },
  },
};
