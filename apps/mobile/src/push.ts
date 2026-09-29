import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";

/**
 * Registers this device for Expo Push and returns its token.
 * Why: isolated here so api.ts stays dependency-free (tests) and the app
 * degrades gracefully — no EAS projectId, denied permission, or web runtime
 * all resolve to null instead of crashing, leaving SSE/polling as fallback.
 * Input: none (reads extra.eas.projectId from app config). Output: token or null.
 */
export async function getPushToken(): Promise<{ token: string; platform: string } | null> {
  try {
    if (Platform.OS === "web") return null;
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
    if (!projectId) return null;
    const { status: existing } = await Notifications.getPermissionsAsync();
    const status =
      existing === "granted" ? existing : (await Notifications.requestPermissionsAsync()).status;
    if (status !== "granted") return null;
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "default",
        importance: Notifications.AndroidImportance.MAX,
      });
    }
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    return { token: token.data, platform: Platform.OS };
  } catch {
    return null;
  }
}

/**
 * Listens for taps on push notifications.
 * Why: a tap carries {conversationId} from the relay — the app opens that
 * exact room instead of dumping the user on the inbox.
 * Input: callback receiving the push data payload. Output: unsubscribe fn.
 */
export function onPushTap(callback: (data: Record<string, unknown>) => void): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data as Record<string, unknown> | undefined;
    if (data) callback(data);
  });
  return () => subscription.remove();
}

/**
 * Shows incoming pushes as in-app banners while foregrounded.
 * Why: default iOS behavior suppresses foreground pushes — the user staring
 * at another room still sees the ping. Call once at startup.
 * Input: none. Output: nothing.
 */
export function configureForegroundBanners(): void {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
  } catch {
    // Notifications unavailable (web/tests); banners simply stay off.
  }
}
