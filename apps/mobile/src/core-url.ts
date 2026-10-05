import Constants from "expo-constants";

declare const process: { env: { EXPO_PUBLIC_CORE_URL?: string } };

/**
 * Core API base URL for this device (from apps/mobile/.env → EXPO_PUBLIC_CORE_URL).
 * Tunnel / physical phone: https://api.example.com. Android emulator + local core: http://10.0.2.2:3000.
 */
export function coreBaseUrl(): string {
  const fromExtra = Constants.expoConfig?.extra?.coreUrl;
  const raw =
    (typeof fromExtra === "string" ? fromExtra : process.env.EXPO_PUBLIC_CORE_URL)?.trim();
  if (raw) return raw.replace(/\/$/, "");
  return "http://127.0.0.1:3000";
}
