import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider } from "../src/session/SessionProvider";
import { AppKeyboardShell } from "../src/ui/AppKeyboardShell";
import { DotBakery } from "../src/ui/DotStage";
import { AppearanceProvider, useResolvedScheme } from "../src/theme/appearance";
import { colors } from "../src/theme/tokens";
import { sheetScreenOptions } from "../src/ui/sheet-screen";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppearanceProvider>
        <SafeAreaProvider>
          <SessionProvider>
            <AppKeyboardShell>
              <ThemedStack />
            </AppKeyboardShell>
          </SessionProvider>
        </SafeAreaProvider>
      </AppearanceProvider>
    </GestureHandlerRootView>
  );
}

function ThemedStack() {
  const dark = useResolvedScheme() === "dark";
  return (
    <>
      <StatusBar style={dark ? "light" : "dark"} />
      <DotBakery />
      <Stack
        screenOptions={{
          headerShadowVisible: false,
          headerTintColor: dark ? "#FFFFFF" : "#000000",
          headerStyle: { backgroundColor: dark ? "#000000" : "#FFFFFF" },
          headerTitleStyle: { color: dark ? "#FFFFFF" : "#000000" },
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: "Chats" }} />
        <Stack.Screen name="chat/[conversationId]" options={{ title: "Chat" }} />
        <Stack.Screen name="desktop/[agentId]" options={{ title: "Desktop" }} />
        <Stack.Screen name="profile/[agentId]" options={{ title: "Profile" }} />
        <Stack.Screen name="group/[conversationId]" options={{ title: "Group" }} />
        <Stack.Screen name="approvals" options={{ title: "Approvals" }} />
        <Stack.Screen name="account" options={sheetScreenOptions("Account")} />
        <Stack.Screen name="new-room" options={sheetScreenOptions("New chat")} />
      </Stack>
    </>
  );
}
