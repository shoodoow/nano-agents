import { expoClient } from "@better-auth/expo/client";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";

declare const process: { env: { EXPO_PUBLIC_CORE_URL?: string } };

/**
 * Talks to the core's Better Auth routes.
 * Input: none. The core URL comes from EXPO_PUBLIC_CORE_URL.
 * Output: the Google sign-in client. The session is stored on the phone.
 */
export const authClient = createAuthClient({
  baseURL: process.env.EXPO_PUBLIC_CORE_URL ?? "http://127.0.0.1:3000",
  plugins: [
    expoClient({
      scheme: "nano-agents",
      storagePrefix: "nano-agents",
      storage: SecureStore,
    }),
  ],
});
