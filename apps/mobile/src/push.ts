import { Platform } from "react-native";
import Constants from "expo-constants";

export const ANDROID_NOTIFICATION_CHANNEL = "default";

type NotificationsModule = typeof import("expo-notifications");

/** Importing expo-notifications on Android Expo Go throws at load time (SDK 53+). */
export function isAndroidExpoGo(): boolean {
  return Platform.OS === "android" && Constants.appOwnership === "expo";
}

let notificationsCache: NotificationsModule | null | undefined;

async function loadNotifications(): Promise<NotificationsModule | null> {
  if (Platform.OS === "web" || isAndroidExpoGo()) return null;
  if (notificationsCache !== undefined) return notificationsCache;
  try {
    notificationsCache = await import("expo-notifications");
    return notificationsCache;
  } catch {
    notificationsCache = null;
    return null;
  }
}

/** Expo Go on Android cannot use remote push (SDK 53+). */
export function canUseRemotePush(): boolean {
  if (Platform.OS === "web" || isAndroidExpoGo()) return false;
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas
    ?.projectId;
  return Boolean(projectId);
}

async function ensureAndroidNotificationChannel(Notifications: NotificationsModule): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(ANDROID_NOTIFICATION_CHANNEL, {
    name: "Agent updates",
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 200, 120, 200],
  });
}

export async function ensureLocalNotificationsReady(): Promise<boolean> {
  try {
    const Notifications = await loadNotifications();
    if (!Notifications) return false;
    await ensureAndroidNotificationChannel(Notifications);
    const { status: existing } = await Notifications.getPermissionsAsync();
    const status =
      existing === "granted" ? existing : (await Notifications.requestPermissionsAsync()).status;
    return status === "granted";
  } catch {
    return false;
  }
}

export function localNotificationContent(input: {
  title: string;
  body: string;
  data: Record<string, unknown>;
}) {
  return {
    title: input.title,
    body: input.body,
    data: input.data,
    ...(Platform.OS === "android" ? { channelId: ANDROID_NOTIFICATION_CHANNEL } : {}),
  };
}

export async function scheduleLocalNotification(input: {
  title: string;
  body: string;
  data: Record<string, unknown>;
}): Promise<void> {
  const Notifications = await loadNotifications();
  if (!Notifications) return;
  if (!(await ensureLocalNotificationsReady())) return;
  await Notifications.scheduleNotificationAsync({
    content: localNotificationContent(input),
    trigger: null,
  });
}

export async function getPushToken(): Promise<{ token: string; platform: string } | null> {
  try {
    if (!canUseRemotePush()) return null;
    const Notifications = await loadNotifications();
    if (!Notifications) return null;
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas
      ?.projectId;
    if (!projectId) return null;
    const { status: existing } = await Notifications.getPermissionsAsync();
    const status =
      existing === "granted" ? existing : (await Notifications.requestPermissionsAsync()).status;
    if (status !== "granted") return null;
    await ensureAndroidNotificationChannel(Notifications);
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    return { token: token.data, platform: Platform.OS };
  } catch {
    return null;
  }
}

export function onPushTap(callback: (data: Record<string, unknown>) => void): () => void {
  if (isAndroidExpoGo()) return () => {};
  let remove = (): void => {};
  void loadNotifications().then((Notifications) => {
    if (!Notifications) return;
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Record<string, unknown> | undefined;
      if (data) callback(data);
    });
    remove = () => subscription.remove();
  });
  return () => remove();
}

export function configureForegroundBanners(): void {
  if (isAndroidExpoGo()) return;
  void loadNotifications().then((Notifications) => {
    if (!Notifications) return;
    void ensureLocalNotificationsReady();
    try {
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldPlaySound: true,
          shouldSetBadge: false,
          shouldShowBanner: true,
          shouldShowList: true,
          shouldShowAlert: true,
        }),
      });
    } catch {
      // Notifications unavailable.
    }
  });
}
