import { getSetCookie, normalizeCookieName } from "@better-auth/expo/client";
import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";

const COOKIE_KEY = normalizeCookieName("nano-agents_cookie");

/**
 * Android often leaves the Chrome custom tab open after OAuth even though Expo
 * already received exp://…?cookie=…. Persist cookies and dismiss the tab.
 */
export function installOAuthReturnHandler(onSignedIn: () => void): () => void {
  if (Platform.OS === "web") {
    return () => undefined;
  }

  const handleUrl = async (url: string | null) => {
    if (!url || !url.includes("cookie=")) {
      return;
    }
    let cookieParam: string | null;
    try {
      cookieParam = new URL(url).searchParams.get("cookie");
    } catch {
      return;
    }
    if (!cookieParam) {
      return;
    }
    try {
      const prev = await SecureStore.getItemAsync(COOKIE_KEY);
      const next = getSetCookie(cookieParam, prev ?? undefined);
      await SecureStore.setItemAsync(COOKIE_KEY, next);
    } catch {
      return;
    }
    try {
      await WebBrowser.dismissBrowser();
      await WebBrowser.dismissAuthSession();
    } catch {
      /* tab may already be gone */
    }
    onSignedIn();
  };

  const sub = Linking.addEventListener("url", ({ url }) => {
    void handleUrl(url);
  });
  void Linking.getInitialURL().then((url) => handleUrl(url));
  return () => sub.remove();
}
