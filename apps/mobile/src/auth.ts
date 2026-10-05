import { expoClient } from "@better-auth/expo/client";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import { coreBaseUrl } from "./core-url";

// Required so Android/iOS can close the Chrome tab and return after OAuth deep link.
if (Platform.OS !== "web") {
  WebBrowser.maybeCompleteAuthSession();
}

/**
 * Talks to the core's Better Auth routes.
 * Input: none. The core URL comes from EXPO_PUBLIC_CORE_URL.
 * Output: the Google sign-in client. The session is stored on the phone.
 */
export const authClient = createAuthClient({
  baseURL: coreBaseUrl(),
  basePath: "/api/auth",
  plugins: [
    expoClient({
      scheme: "nano-agents",
      storagePrefix: "nano-agents",
      storage: SecureStore,
      webBrowserOptions: { createTask: false },
    }),
  ],
});
